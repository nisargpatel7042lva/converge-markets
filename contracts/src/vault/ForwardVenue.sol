// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Static-analysis review (forge lint, slither): every `forge-lint: disable` in this file was reviewed.
// - unsafe-typecast: each cast is of a value bounded by a check, a constant or a library guarantee
//   (price > 0, config ranges validated in the setters, WAD math with explicit clamps).
// - calls-loop / require-revert-in-loop: loops run over the registry, which is bounded by
//   MAX_MARKETS (16) and MAX_ASSETS (8), or over the at most MAX_LEVELS (4) ladder levels.
// - reentrancy-*: every entry point that moves value is nonReentrant, and the external calls
//   go to the immutable asset, the factory's own Market/OutcomeToken clones, the immutable
//   verifier proxy, or the owner-timelocked venue.
// - incorrect-strict-equality: exact comparisons of token balances against zero or against each
//   other are the intent (nothing to burn/pay; excess exists).
// - weak-prng / divide-before-multiply: epoch alignment arithmetic and tick-grid flooring.

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {Market} from "../Market.sol";
import {DataStreamsResolver} from "../resolvers/DataStreamsResolver.sol";
import {IVerifierProxy, ReportV3} from "../interfaces/IVerifierProxy.sol";
import {ConvergeVault} from "./ConvergeVault.sol";
import {QuoteMath} from "./QuoteMath.sol";
import {ReportLib} from "./ReportLib.sol";

/// @title ForwardVenue
/// @notice Forward-priced two-step swaps against the Converge vault (docs/adr/ADR-004).
///         1. A taker places an order at time t: side, size, a limit price, an escrow and a prepaid
///            execution reward. There is no cancellation.
///         2. Once, at T = t + `execDelay`, anyone executes it with the Data Streams report whose
///            window contains T (validFrom <= T <= observationsTimestamp). The price comes from
///            that report and the vault's on-chain quote at time T, not from when or by whom the
///            order is executed. An order not executed within `maxLateness` of T is refunded.
/// @dev The venue holds only takers' escrow; it never holds LP funds. Every fill goes through
///      `ConvergeVault.venueFill`, which re-checks the loss ceiling, the price bounds and the free
///      liquidity, so a bug here is capped by the vault's own limits.
///      Orders are never iterated: no loop in this contract depends on the number of orders.
contract ForwardVenue is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Kind {
        BUY_UP, // taker pays collateral, receives UP
        SELL_UP, // taker gives UP, receives collateral
        BUY_DOWN,
        SELL_DOWN
    }

    enum Status {
        NONE,
        OPEN,
        DONE
    }

    struct Order {
        address taker;
        Kind kind;
        Status status;
        uint64 execAt;
        Market market;
        uint128 shares; // asset-unit token amount
        uint128 limit; // WAD price per share: a buyer's maximum, a seller's minimum
        uint128 escrow; // collateral (buys) or tokens (sells)
        uint128 reward; // native token for the executor
    }

    ConvergeVault public immutable vault;
    IERC20 public immutable asset;
    DataStreamsResolver public immutable streams;
    IVerifierProxy public immutable verifier;
    /// @notice Seconds between placing an order and its pricing time.
    uint32 public immutable execDelay;
    /// @notice Seconds after the pricing time during which the order may still be executed.
    uint32 public immutable maxLateness;
    uint256 internal immutable SCALE;

    uint256 public constant MAX_REWARD = 1 ether;
    /// @notice Longest allowed window after the pricing time in which an order may still be
    ///         executed. Inside it the executor decides whether to execute (an option worth the
    ///         price drift), so it is kept to a few seconds.
    uint32 public constant MAX_LATENESS = 10;
    /// @notice Fills below this many asset units are skipped: at that size rounding the premium to a
    ///         whole unit would distort the implied price.
    uint256 public constant MIN_FILL = 1_000;
    /// @dev Rounding slack added to a buyer's escrow (one unit per ladder level), refunded.
    uint256 internal constant ESCROW_SLACK = QuoteMath.MAX_LEVELS;

    uint256 public minReward;
    uint256 public nextOrderId = 1;
    mapping(uint256 => Order) public orders;

    event OrderPlaced(
        uint256 indexed id,
        address indexed taker,
        address indexed market,
        Kind kind,
        uint256 shares,
        uint256 limit,
        uint64 execAt,
        uint256 reward
    );
    event OrderExecuted(
        uint256 indexed id,
        address indexed executor,
        uint256 filled,
        uint256 premium,
        uint256 reportPrice,
        uint32 reportValidFrom,
        uint32 reportObservations
    );
    event OrderExpired(uint256 indexed id, address indexed caller);
    event MinRewardSet(uint256 minReward);

    error NotVaultOwner();
    error ZeroAmount();
    error LimitOutOfRange(uint256 limit);
    error RewardTooLow(uint256 sent, uint256 minimum);
    error RewardTooHigh(uint256 sent);
    error MarketNotTradable(address market);
    error NotOpen(uint256 id);
    error TooEarly(uint64 execAt);
    error TooLate(uint64 deadline);
    error NotExpired(uint64 deadline);
    error ReportNotCanonical(uint64 execAt, uint32 validFrom, uint32 observations);
    error NativeTransferFailed();
    error InvalidConfig();

    constructor(ConvergeVault vault_, uint32 execDelay_, uint32 maxLateness_, uint256 minReward_) {
        if (address(vault_) == address(0) || execDelay_ == 0 || maxLateness_ == 0) {
            revert InvalidConfig();
        }
        if (minReward_ > MAX_REWARD || maxLateness_ > MAX_LATENESS) revert InvalidConfig();
        vault = vault_;
        asset = vault_.asset();
        streams = vault_.streams();
        verifier = vault_.verifier();
        execDelay = execDelay_;
        maxLateness = maxLateness_;
        minReward = minReward_;
        SCALE = vault_.unitScale();
    }

    /// @notice The vault's owner sets the minimum execution reward (native token).
    function setMinReward(uint256 v) external {
        if (msg.sender != vault.owner()) revert NotVaultOwner();
        if (v > MAX_REWARD) revert InvalidConfig();
        minReward = v;
        emit MinRewardSet(v);
    }

    // ------------------------------------------------------------------ placing

    /// @notice Places an order. `msg.value` is the executor's reward (at least `minReward`).
    /// @param shares Token amount in asset units (6 dp for USDC).
    /// @param limit WAD price per share (a buyer's maximum or a seller's minimum), in (0, 1).
    function placeOrder(Market m, Kind kind, uint256 shares, uint256 limit)
        external
        payable
        nonReentrant
        returns (uint256 id)
    {
        if (shares == 0 || shares > type(uint128).max) revert ZeroAmount();
        if (limit == 0 || limit >= 1e18) revert LimitOutOfRange(limit);
        if (msg.value < minReward) revert RewardTooLow(msg.value, minReward);
        if (msg.value > MAX_REWARD) revert RewardTooHigh(msg.value);
        if (!vault.isRegistered(address(m)) || vault.quotingPaused()) {
            revert MarketNotTradable(address(m));
        }
        uint256 escrow;
        if (kind == Kind.BUY_UP || kind == Kind.BUY_DOWN) {
            escrow = F.mulDivUp(shares, limit, 1e18) + ESCROW_SLACK;
            asset.safeTransferFrom(msg.sender, address(this), escrow);
        } else {
            escrow = shares;
            _token(m, kind).safeTransferFrom(msg.sender, address(this), shares);
        }
        id = nextOrderId++;
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 execAt = uint64(block.timestamp + execDelay);
        // Bounds checked above (shares, limit < 2^128), escrow <= shares * 1 + slack, reward <= 1 ether.
        // forge-lint: disable-start(unsafe-typecast)
        orders[id] = Order(
            msg.sender,
            kind,
            Status.OPEN,
            execAt,
            m,
            uint128(shares),
            uint128(limit),
            uint128(escrow),
            uint128(msg.value)
        );
        // forge-lint: disable-end(unsafe-typecast)
        // forge-lint: disable-next-line(reentrancy-events)
        emit OrderPlaced(id, msg.sender, address(m), kind, shares, limit, execAt, msg.value);
    }

    // ------------------------------------------------------------------ executing

    /// @notice Executes an order against the report whose window contains its pricing time. Anyone
    ///         may call, once, between T and T + maxLateness. The executor is paid the reward
    ///         whether or not the limit price was met.
    /// @return filled Tokens exchanged. @return premium Collateral exchanged.
    function executeOrder(uint256 id, bytes calldata report)
        external
        nonReentrant
        returns (uint256 filled, uint256 premium)
    {
        Order memory o = orders[id];
        if (o.status != Status.OPEN) revert NotOpen(id);
        if (block.timestamp < o.execAt) revert TooEarly(o.execAt);
        if (block.timestamp > uint256(o.execAt) + maxLateness) {
            revert TooLate(o.execAt + maxLateness);
        }
        orders[id].status = Status.DONE;

        bytes32 feed = streams.feedIdOf(o.market.assetId());
        ReportV3 memory r = ReportLib.verify(verifier, streams.parameterPayload(), report, feed);
        if (r.validFromTimestamp > o.execAt || r.observationsTimestamp < o.execAt) {
            revert ReportNotCanonical(o.execAt, r.validFromTimestamp, r.observationsTimestamp);
        }

        (filled, premium) = _fill(o, r);
        _refund(o, filled, premium);
        _payReward(o.reward);
        // r.price > 0 (ReportLib).
        // forge-lint: disable-start(reentrancy-events, unsafe-typecast)
        emit OrderExecuted(
            id,
            msg.sender,
            filled,
            premium,
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256(uint192(r.price)),
            r.validFromTimestamp,
            r.observationsTimestamp
        );
        // forge-lint: disable-end(reentrancy-events, unsafe-typecast)
    }

    /// @notice Refunds an order nobody executed in time. Anyone may call; the caller takes the
    ///         reward. Always available (a paused vault, a dead feed or a halted market cannot
    ///         strand an escrow).
    function expireOrder(uint256 id) external nonReentrant {
        Order memory o = orders[id];
        if (o.status != Status.OPEN) revert NotOpen(id);
        uint64 deadline = o.execAt + maxLateness;
        if (block.timestamp <= deadline) revert NotExpired(deadline);
        orders[id].status = Status.DONE;
        _refund(o, 0, 0);
        _payReward(o.reward);
        // forge-lint: disable-next-line(reentrancy-events)
        emit OrderExpired(id, msg.sender);
    }

    /// @dev Prices the order at its pricing time. Prices come only from the report, the market,
    ///      the vault's stored sigma and NAV, and the position: never from the caller.
    function _fill(Order memory o, ReportV3 memory r)
        internal
        returns (uint256 filled, uint256 premium)
    {
        Market m = o.market;
        ConvergeVault.VenueView memory v = vault.venueView(m);
        if (!v.tradable || m.state() != Market.State.OPEN) return (0, 0);
        uint256 end = m.endTime();
        if (o.execAt >= end) return (0, 0);
        // r.price > 0 (ReportLib); strike > 0 once the market is OPEN.
        // forge-lint: disable-start(unsafe-typecast)
        QuoteMath.Quote memory q = QuoteMath.quote(
            uint256(int256(r.price)),
            uint256(m.strike()),
            v.sigma,
            end - o.execAt,
            end - m.startTime(),
            v.navWad,
            v.pos,
            vault.quoteParams()
        );
        // forge-lint: disable-end(unsafe-typecast)
        if (!q.quoting) return (0, 0);

        bool buy = o.kind == Kind.BUY_UP || o.kind == Kind.BUY_DOWN; // the taker buys
        bool upToken = o.kind == Kind.BUY_UP || o.kind == Kind.SELL_UP;
        // One UP curve: UP asks serve buyers of UP, UP bids serve sellers of UP; DOWN is the
        // complement (a DOWN ask at 1 - UP bid, a DOWN bid at 1 - UP ask).
        return _walk(o, upToken == buy ? q.asks : q.bids, upToken, buy, r);
    }

    function _walk(
        Order memory o,
        QuoteMath.Level[] memory levels,
        bool upToken,
        bool buy,
        ReportV3 memory r
    ) internal returns (uint256 filled, uint256 premium) {
        uint256 remaining = o.shares;
        for (uint256 i = 0; i < levels.length && remaining != 0; i++) {
            uint256 p = upToken ? levels[i].price : 1e18 - levels[i].price;
            if (buy ? p > o.limit : p < o.limit) break; // later levels are worse for the taker
            uint256 take = F.min(remaining, levels[i].size / SCALE);
            // forge-lint: disable-next-line(calls-loop)
            take = F.min(take, vault.fillRoom(o.market, upToken, buy, p));
            if (take < MIN_FILL) continue;
            // A buyer's premium can never exceed its own escrow (the escrow carries slack for the
            // per-level rounding), so one order can not draw on another order's collateral.
            if (buy && premium + F.mulDivUp(take, p, 1e18) > o.escrow) break;
            uint256 prem = _swap(o, upToken, buy, take, p, r);
            remaining -= take;
            filled += take;
            premium += prem;
        }
    }

    /// @dev One ladder level: approves exactly what the vault will pull, then fills.
    function _swap(
        Order memory o,
        bool upToken,
        bool buy,
        uint256 take,
        uint256 p,
        ReportV3 memory r
    ) internal returns (uint256 prem) {
        prem = buy ? F.mulDivUp(take, p, 1e18) : F.mulDiv(take, p, 1e18);
        if (buy) asset.forceApprove(address(vault), prem);
        else _tokenOf(o.market, upToken).forceApprove(address(vault), take);
        // r.price > 0 (ReportLib).
        // forge-lint: disable-start(calls-loop, reentrancy-no-eth, unsafe-typecast)
        vault.venueFill(
            ConvergeVault.FillParams(
                o.market,
                upToken,
                buy,
                take,
                prem,
                o.taker,
                // forge-lint: disable-next-line(unsafe-typecast)
                uint192(r.price),
                r.observationsTimestamp
            )
        );
        // forge-lint: disable-end(calls-loop, reentrancy-no-eth, unsafe-typecast)
    }

    function _refund(Order memory o, uint256 filled, uint256 premium) internal {
        bool buy = o.kind == Kind.BUY_UP || o.kind == Kind.BUY_DOWN;
        if (buy) {
            uint256 back = o.escrow - premium;
            if (back != 0) asset.safeTransfer(o.taker, back);
        } else {
            uint256 back = o.escrow - filled;
            if (back != 0) _token(o.market, o.kind).safeTransfer(o.taker, back);
        }
    }

    /// @dev Pays the caller (the executor or whoever expires the order): never another address.
    // The destination is always msg.sender (the executor who is owed the prepaid reward).
    // slither-disable-start arbitrary-send-eth
    function _payReward(uint256 amount) internal {
        if (amount == 0) return;
        // forge-lint: disable-next-line(arbitrary-send-eth, reentrancy-eth)
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }
    // slither-disable-end arbitrary-send-eth

    function _token(Market m, Kind kind) internal view returns (IERC20) {
        return _tokenOf(m, kind == Kind.BUY_UP || kind == Kind.SELL_UP);
    }

    function _tokenOf(Market m, bool up) internal view returns (IERC20) {
        // forge-lint: disable-next-line(calls-loop)
        return up ? IERC20(address(m.up())) : IERC20(address(m.down()));
    }

    // ------------------------------------------------------------------ views

    /// @notice The vault's UP ladder for a market at pricing time `at` and spot `spot` (same
    ///         decimals as the market's strike), for UIs and tests.
    function quoteAt(Market m, uint256 spot, uint64 at)
        external
        view
        returns (QuoteMath.Quote memory q)
    {
        ConvergeVault.VenueView memory v = vault.venueView(m);
        if (!v.tradable || m.state() != Market.State.OPEN) return q;
        uint256 end = m.endTime();
        if (at >= end) return q;
        // strike > 0 once OPEN.
        // forge-lint: disable-next-line(unsafe-typecast)
        q = QuoteMath.quote(
            spot,
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256(m.strike()),
            v.sigma,
            end - at,
            end - m.startTime(),
            v.navWad,
            v.pos,
            vault.quoteParams()
        );
    }
}
