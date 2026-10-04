// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPriceResolver} from "./interfaces/IPriceResolver.sol";
import {OutcomeToken} from "./OutcomeToken.sol";

/// @notice What a Market needs from its factory.
interface IMarketFactoryView {
    function paused() external view returns (bool);
    function feeRecipient() external view returns (address);
}

/// @title Market
/// @notice One UP/DOWN outcome round on one asset, deployed as an EIP-1167 clone.
///         1 collateral <-> 1 UP + 1 DOWN (split/merge). After the round:
///         - UP wins if endPrice >= strike (a tie goes UP), DOWN wins otherwise;
///         - if a boundary price can never be determined the market is INVALID and every UP and
///           every DOWN token redeems for 0.5 collateral.
/// @dev Exits are never pausable: the factory's pause blocks only `split` (and new markets).
///      merge, open, resolve, invalidate and redeem always work.
///      Collateral must be a plain ERC-20 (no fee-on-transfer/rebasing); split rejects any
///      transfer that delivers less than requested.
contract Market is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State {
        CREATED, // strike not yet known
        OPEN, // strike known, waiting for endTime
        RESOLVED_UP,
        RESOLVED_DOWN,
        INVALID
    }

    /// @notice Initialization parameters (all immutable after initialize).
    struct Params {
        address factory;
        bytes32 assetId;
        IPriceResolver resolver;
        IERC20 collateral;
        OutcomeToken up;
        OutcomeToken down;
        uint64 startTime;
        uint64 endTime;
        uint16 redeemFeeBps;
    }

    uint256 internal constant BPS = 10_000;

    address public factory;
    bytes32 public assetId;
    IPriceResolver public resolver;
    IERC20 public collateral;
    OutcomeToken public up;
    OutcomeToken public down;
    uint64 public startTime;
    uint64 public endTime;
    /// @notice Fee on redeem payouts, fixed at creation (factory caps it at 1%).
    uint16 public redeemFeeBps;

    State public state;
    /// @notice P(asset, startTime); set when OPEN.
    int256 public strike;
    /// @notice P(asset, endTime); set when resolved.
    int256 public endPrice;

    event Split(address indexed account, uint256 amount);
    event Merged(address indexed account, uint256 amount);
    event Opened(int256 strike);
    event Resolved(State indexed outcome, int256 strike, int256 endPrice);
    event Invalidated(uint64 indexed boundary);
    event Redeemed(
        address indexed account, uint256 upBurned, uint256 downBurned, uint256 payout, uint256 fee
    );

    error AlreadyInitialized();
    error OnlyFactory();
    error ZeroAmount();
    error SplitPaused();
    error WrongState(State current);
    error TooEarly(uint64 availableAt);
    error PriceNotFinal();
    error NotUnresolvable();
    error FeeOnTransferNotSupported(uint256 expected, uint256 received);
    error NothingToRedeem();

    /// @dev Locks the implementation.
    constructor() {
        factory = address(0xdead);
    }

    /// @notice One-time setup by the factory, in the same transaction as the clone.
    function initialize(Params calldata p) external {
        if (factory != address(0)) revert AlreadyInitialized();
        if (msg.sender != p.factory) revert OnlyFactory();
        factory = p.factory;
        assetId = p.assetId;
        resolver = p.resolver;
        collateral = p.collateral;
        up = p.up;
        down = p.down;
        startTime = p.startTime;
        endTime = p.endTime;
        redeemFeeBps = p.redeemFeeBps;
    }

    // ------------------------------------------------------------------ split / merge

    /// @notice Deposits `amount` collateral and mints `amount` UP and `amount` DOWN to the caller.
    /// @dev Blocked while the factory is paused and once the market has an outcome.
    function split(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (IMarketFactoryView(factory).paused()) revert SplitPaused();
        if (state != State.CREATED && state != State.OPEN) revert WrongState(state);
        emit Split(msg.sender, amount);
        uint256 before = collateral.balanceOf(address(this));
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = collateral.balanceOf(address(this)) - before;
        if (received != amount) revert FeeOnTransferNotSupported(amount, received);
        // Trusted calls: our own OutcomeToken clones (no hooks); function is nonReentrant.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        up.mint(msg.sender, amount);
        // forge-lint: disable-next-line(reentrancy-no-eth)
        down.mint(msg.sender, amount);
    }

    /// @notice Burns `amount` UP and `amount` DOWN from the caller and returns `amount` collateral.
    /// @dev Works in every state, including while paused and after resolution (a complete pair
    ///      is always worth exactly 1). No fee.
    function merge(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        emit Merged(msg.sender, amount);
        // Trusted calls: our own OutcomeToken clones; function is nonReentrant.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        up.burn(msg.sender, amount);
        // forge-lint: disable-next-line(reentrancy-no-eth)
        down.burn(msg.sender, amount);
        collateral.safeTransfer(msg.sender, amount);
    }

    // ------------------------------------------------------------------ lifecycle

    /// @notice Sets the strike from P(asset, startTime). Anyone may call after startTime.
    /// @param data Optional resolver evidence (round proof or signed report) submitted first;
    ///        pass empty bytes if the boundary was already submitted.
    /// @dev If the boundary is UNRESOLVABLE the market becomes INVALID instead. If it is still
    ///      PENDING: reverts PriceNotFinal when no evidence was passed; returns without a state
    ///      change when evidence was passed (so the submission is kept).
    // slither-disable-next-line reentrancy-no-eth
    function open(bytes calldata data) external nonReentrant {
        if (state != State.CREATED) revert WrongState(state);
        if (block.timestamp < startTime) revert TooEarly(startTime);
        // Trusted call: resolver is fixed at creation by the admin-registered asset config;
        // state is re-checked from the resolver after the call; function is nonReentrant.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        if (data.length != 0) resolver.submit(assetId, startTime, data);
        (IPriceResolver.Status s, int256 price) = resolver.priceAt(assetId, startTime);
        if (s == IPriceResolver.Status.FINAL) {
            strike = price;
            state = State.OPEN;
            // forge-lint: disable-next-line(reentrancy-events)
            emit Opened(price);
        } else if (s == IPriceResolver.Status.UNRESOLVABLE) {
            _invalidate(startTime);
        } else if (data.length == 0) {
            revert PriceNotFinal();
        }
        // PENDING after a submission: keep the submission (e.g. a Data Streams finalization
        // window just started) and return; call again once FINAL.
    }

    /// @notice Settles from P(asset, endTime). UP if endPrice >= strike (ties go UP).
    /// @param data Optional resolver evidence, as in `open`.
    /// @dev If the boundary is UNRESOLVABLE the market becomes INVALID instead.
    // slither-disable-next-line reentrancy-no-eth
    function resolve(bytes calldata data) external nonReentrant {
        if (state != State.OPEN) revert WrongState(state);
        if (block.timestamp < endTime) revert TooEarly(endTime);
        // Trusted call (see open).
        // forge-lint: disable-next-line(reentrancy-no-eth)
        if (data.length != 0) resolver.submit(assetId, endTime, data);
        (IPriceResolver.Status s, int256 price) = resolver.priceAt(assetId, endTime);
        if (s == IPriceResolver.Status.FINAL) {
            endPrice = price;
            State outcome = price >= strike ? State.RESOLVED_UP : State.RESOLVED_DOWN;
            state = outcome;
            // forge-lint: disable-next-line(reentrancy-events)
            emit Resolved(outcome, strike, price);
        } else if (s == IPriceResolver.Status.UNRESOLVABLE) {
            _invalidate(endTime);
        } else if (data.length == 0) {
            revert PriceNotFinal();
        }
        // PENDING after a submission: see `open`.
    }

    /// @notice Marks the market INVALID when the boundary it is waiting on (startTime if not
    ///         open, endTime if open) can never be determined. Anyone may call.
    // slither-disable-next-line unused-return
    function invalidate() external nonReentrant {
        State s0 = state;
        if (s0 != State.CREATED && s0 != State.OPEN) revert WrongState(s0);
        uint64 boundary = s0 == State.CREATED ? startTime : endTime;
        // The price is irrelevant here; only the status matters.
        // forge-lint: disable-next-line(unused-return)
        (IPriceResolver.Status s,) = resolver.priceAt(assetId, boundary);
        if (s != IPriceResolver.Status.UNRESOLVABLE) revert NotUnresolvable();
        _invalidate(boundary);
    }

    /// @notice Burns all of the caller's UP and DOWN and pays: winners 1:1, losers 0,
    ///         INVALID 0.5 per token (rounded down on the total). A fee of `redeemFeeBps` is
    ///         taken from the payout.
    // slither-disable-next-line divide-before-multiply
    function redeem() external nonReentrant {
        State s = state;
        if (s != State.RESOLVED_UP && s != State.RESOLVED_DOWN && s != State.INVALID) {
            revert WrongState(s);
        }
        uint256 upBal = up.balanceOf(msg.sender);
        uint256 downBal = down.balanceOf(msg.sender);
        // Exact zero checks on our own token balances are intended (nothing to burn/pay).
        // slither-disable-next-line incorrect-equality
        if (upBal == 0 && downBal == 0) revert NothingToRedeem();

        uint256 payout;
        if (s == State.RESOLVED_UP) payout = upBal;
        else if (s == State.RESOLVED_DOWN) payout = downBal;
        else payout = (upBal + downBal) / 2;
        // Halving above is the INVALID payout itself, not an intermediate; fee rounds down.
        // forge-lint: disable-next-line(divide-before-multiply)
        uint256 fee = payout * redeemFeeBps / BPS;
        // slither-disable-next-line incorrect-equality
        address recipient = fee == 0 ? address(0) : IMarketFactoryView(factory).feeRecipient();
        if (recipient == address(0)) fee = 0;

        emit Redeemed(msg.sender, upBal, downBal, payout - fee, fee);
        // Trusted calls: our own OutcomeToken clones; function is nonReentrant.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        if (upBal != 0) up.burn(msg.sender, upBal);
        // forge-lint: disable-next-line(reentrancy-no-eth)
        if (downBal != 0) down.burn(msg.sender, downBal);
        if (payout - fee != 0) collateral.safeTransfer(msg.sender, payout - fee);
        if (fee != 0) collateral.safeTransfer(recipient, fee);
    }

    /// @notice Collateral owed to a holder if they redeemed now (before fee). 0 before outcome.
    function claimable(address account) external view returns (uint256) {
        State s = state;
        if (s == State.RESOLVED_UP) return up.balanceOf(account);
        if (s == State.RESOLVED_DOWN) return down.balanceOf(account);
        if (s == State.INVALID) return (up.balanceOf(account) + down.balanceOf(account)) / 2;
        return 0;
    }

    function _invalidate(uint64 boundary) private {
        state = State.INVALID;
        // Callers only read the resolver (trusted) before reaching here.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Invalidated(boundary);
    }
}
