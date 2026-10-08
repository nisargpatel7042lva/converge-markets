// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IPriceResolver} from "../interfaces/IPriceResolver.sol";
import {Market, IMarketFactoryView} from "../Market.sol";
import {MarketFactory} from "../MarketFactory.sol";
import {OutcomeToken} from "../OutcomeToken.sol";
import {MarketNaming} from "../libraries/MarketNaming.sol";
import {ThresholdResolver} from "../resolvers/ThresholdResolver.sol";
import {IPartnerRegistry} from "./IPartnerRegistry.sol";

/// @notice The two vault facts the registry checks when a feed is onboarded.
interface IVaultAssets {
    function assetCfg(bytes32 assetId)
        external
        view
        returns (
            bool enabled,
            bytes32 feedId,
            uint128 sigma,
            uint64 sigmaUpdatedAt,
            uint128 sigmaMin,
            uint128 sigmaMax
        );
}

/// @title PartnerRegistry
/// @notice Liquidity-as-a-service (docs/adr/ADR-008, docs/partners.md). Third-party apps ("partners")
///         create price-threshold markets ("will ASSET be at or above STRIKE at END?") from an
///         approved template and the Converge Vault quotes them, within hard caps.
/// @dev Governance (documented, not decentralised in v1): the OWNER (a Safe on mainnet) approves
///      partners and sets each partner's exposure cap, fee share and feed allowlist; sets the global
///      exposure cap, the minimum bond and the fee; may slash a partner's bond for invalid markets
///      and void a market. The GUARDIAN can only pause creation and suspend a partner. A partner
///      cannot choose anything the owner has not allowed: the feed (an asset already configured on
///      the oracle resolver, the core factory and the vault), the duration (15 minutes to 7 days)
///      and the strike (any positive value, which is exactly what the bond is for).
///      This contract is the `factory` of the markets it creates (it answers `paused()` and
///      `feeRecipient()` like MarketFactory). It never holds user funds: it holds bonds and the
///      redeem fees that markets pay to it, which it passes on at once or on claim.
///      Nothing here can touch `Market.merge` or `Market.redeem`: users always exit.
contract PartnerRegistry is
    Ownable2Step,
    Pausable,
    ReentrancyGuard,
    IMarketFactoryView,
    IPartnerRegistry
{
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ constants

    uint256 public constant BPS = 10_000;
    uint64 public constant MIN_DURATION = 15 minutes;
    uint64 public constant MAX_DURATION = 7 days;
    /// @notice Notice a partner must give before withdrawing bond.
    uint64 public constant WITHDRAW_DELAY = 7 days;
    /// @notice After the end of the partner's last market the bond stays locked this long, so that
    ///         every market it created can still be judged and slashed.
    uint64 public constant CHALLENGE_PERIOD = 1 days;
    uint16 public constant MAX_REDEEM_FEE_BPS = 100;
    /// @notice Most markets one partner can have running (not yet ended) at a time.
    uint256 public constant MAX_LIVE_PER_PARTNER = 8;
    uint256 public constant MAX_PARTNERS = 64;
    /// @notice A market stays in `liveMarkets()` this long after its end, so that the keeper can
    ///         still find it and submit the end price.
    uint64 public constant RESOLVE_WINDOW = 1 hours;
    uint256 internal constant PRICE_SCALE = 1e18;
    bytes1 internal constant ZERO_CHAR = 0x30; // "0"

    // ------------------------------------------------------------------ types

    struct Partner {
        bool approved;
        bool suspended;
        uint16 feeShareBps; // share of the redeem fee paid to the partner
        uint128 exposureCap; // most collateral (asset units) the vault may have split into this partner's markets
        uint128 bond;
        uint128 pendingWithdrawal;
        uint64 withdrawableAt;
        uint64 lastMarketEnd;
        uint32 marketsCreated;
    }

    struct MarketInfo {
        address partner;
        bool voided;
        uint16 feeShareBps; // snapshot at creation
        uint64 endTime;
    }

    // ------------------------------------------------------------------ immutables

    IERC20 public immutable collateral;
    uint8 public immutable collateralDecimals;
    MarketFactory public immutable core;
    address public immutable marketImplementation;
    address public immutable tokenImplementation;
    address public immutable thresholdImplementation;

    // ------------------------------------------------------------------ configuration

    address public guardian;
    /// @notice Receives the owner's share of redeem fees.
    address public treasury;
    /// @notice Receives slashed bonds (the vault, so that LPs are compensated, or the treasury).
    address public slashRecipient;
    /// @notice The vault that must have enabled a feed before it can be onboarded; set once.
    address public vault;
    uint256 public minBond;
    /// @notice Most collateral the vault may have split into ALL partner markets together.
    uint256 public globalExposureCap;
    /// @notice Redeem fee for partner markets created from now on (snapshotted per market).
    uint16 public redeemFeeBps;

    // ------------------------------------------------------------------ state

    mapping(address partner => Partner) internal _partners;
    mapping(address partner => mapping(bytes32 assetId => bool)) public allowedFeed;
    mapping(bytes32 assetId => bool) public feedEnabled;
    mapping(address market => MarketInfo) internal _info;
    mapping(address partner => address[]) internal _live;
    mapping(address partner => uint256) public feesOwed;
    mapping(address partner => bool) private _listed;
    /// @notice Collateral the registry owes: all bonds, pending withdrawals and credited fees.
    ///         Anything above it is a stray (a direct `Market.claimFees`), see `sweepStray`.
    uint256 public liabilities;
    address[] public partnerList;
    address[] public markets;

    // ------------------------------------------------------------------ events

    /// @notice Same shape as MarketFactory.MarketCreated, so one indexer handler serves both.
    event MarketCreated(
        address indexed market,
        bytes32 indexed assetId,
        uint64 indexed startTime,
        uint64 duration,
        Market.Params params
    );
    event PartnerMarketCreated(
        address indexed market,
        address indexed partner,
        bytes32 indexed assetId,
        int256 strike,
        uint64 startTime,
        uint64 endTime,
        address resolver,
        uint16 feeShareBps
    );
    event PartnerApproved(
        address indexed partner, uint256 exposureCap, uint16 feeShareBps, bytes32[] assets
    );
    event PartnerTermsSet(address indexed partner, uint256 exposureCap, uint16 feeShareBps);
    event PartnerFeedSet(address indexed partner, bytes32 indexed assetId, bool allowed);
    event PartnerSuspended(address indexed partner, bool suspended, address indexed by);
    event BondPosted(address indexed partner, uint256 amount, uint256 bond);
    event BondWithdrawalRequested(address indexed partner, uint256 amount, uint64 withdrawableAt);
    event BondWithdrawalCancelled(address indexed partner, uint256 amount);
    event BondWithdrawn(address indexed partner, uint256 amount);
    event Slashed(address indexed partner, uint256 amount, address recipient, bytes32 reason);
    event MarketVoided(address indexed market, address indexed partner, bytes32 reason);
    event FeedSet(bytes32 indexed assetId, bool enabled);
    event FeesCollected(
        address indexed market, address indexed partner, uint256 partnerShare, uint256 treasuryShare
    );
    event FeesWithdrawn(address indexed partner, address indexed to, uint256 amount);
    event StraySwept(uint256 amount);
    event ConfigSet(
        uint256 minBond,
        uint256 globalExposureCap,
        uint16 redeemFeeBps,
        address treasury,
        address slashRecipient
    );
    event GuardianSet(address indexed guardian);
    event VaultSet(address indexed vault);

    // ------------------------------------------------------------------ errors

    error ZeroAddress();
    error OnlyGuardianOrOwner();
    error NotApproved(address partner);
    error PartnerIsSuspended(address partner);
    error BondTooLow(uint256 bond, uint256 minimum);
    error FeedNotAllowed(address partner, bytes32 assetId);
    error FeedNotEnabled(bytes32 assetId);
    error FeedHasNoDepth(bytes32 assetId);
    error InvalidStrike(int256 strike);
    error InvalidDuration(uint64 duration);
    error TooManyLiveMarkets(address partner);
    error TooManyPartners();
    error FeeTooHigh(uint256 bps);
    error InvalidTerms();
    error VaultAlreadySet();
    error NothingToWithdraw();
    error WithdrawalNotReady(uint64 availableAt);
    error WithdrawalPending();
    error InsufficientBond(uint256 have, uint256 want);
    error UnknownMarket(address market);
    error ZeroAmount();
    error FeeOnTransferNotSupported();

    // ------------------------------------------------------------------ construction

    constructor(MarketFactory core_, address owner_, address guardian_, address treasury_)
        Ownable(owner_)
    {
        if (address(core_) == address(0) || guardian_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        core = core_;
        collateral = core_.collateral();
        collateralDecimals = core_.collateralDecimals();
        marketImplementation = core_.marketImplementation();
        tokenImplementation = core_.tokenImplementation();
        thresholdImplementation = address(new ThresholdResolver());
        guardian = guardian_;
        treasury = treasury_;
        slashRecipient = treasury_;
    }

    // ================================================================== owner

    /// @notice Approves a partner with its terms. Re-approving an existing partner replaces its
    ///         terms and feed allowlist additions (it never removes a feed; use `setPartnerFeed`).
    /// @param exposureCap Most collateral (asset units) the vault may have split into this
    ///        partner's markets at any time.
    /// @param feeShareBps Share of the redeem fee paid to the partner (the rest goes to the treasury).
    function approvePartner(
        address partner,
        uint256 exposureCap,
        uint16 feeShareBps,
        bytes32[] calldata assets
    ) external onlyOwner {
        if (partner == address(0)) revert ZeroAddress();
        if (feeShareBps > BPS) revert InvalidTerms();
        Partner storage p = _partners[partner];
        if (!p.approved) {
            if (partnerList.length >= MAX_PARTNERS) revert TooManyPartners();
            if (!_listed[partner]) {
                _listed[partner] = true;
                partnerList.push(partner);
            }
            p.approved = true;
        }
        p.exposureCap = _u128(exposureCap);
        p.feeShareBps = feeShareBps;
        for (uint256 i = 0; i < assets.length; i++) {
            // PartnerFeedSet is emitted below.
            // forge-lint: disable-next-line(missing-events-access-control)
            allowedFeed[partner][assets[i]] = true;
            emit PartnerFeedSet(partner, assets[i], true);
        }
        emit PartnerApproved(partner, exposureCap, feeShareBps, assets);
    }

    /// @notice Changes an approved partner's cap and fee share. A lowered cap never forces
    ///         anything: existing inventory is merged by the keeper, new allocation stops at the cap.
    function setPartnerTerms(address partner, uint256 exposureCap, uint16 feeShareBps)
        external
        onlyOwner
    {
        if (!_partners[partner].approved) revert NotApproved(partner);
        if (feeShareBps > BPS) revert InvalidTerms();
        _partners[partner].exposureCap = _u128(exposureCap);
        _partners[partner].feeShareBps = feeShareBps;
        emit PartnerTermsSet(partner, exposureCap, feeShareBps);
    }

    function setPartnerFeed(address partner, bytes32 assetId, bool allowed) external onlyOwner {
        if (!_partners[partner].approved) revert NotApproved(partner);
        // PartnerFeedSet is emitted below.
        // forge-lint: disable-next-line(missing-events-access-control)
        allowedFeed[partner][assetId] = allowed;
        emit PartnerFeedSet(partner, assetId, allowed);
    }

    /// @notice Onboards (or removes) a feed for the template. The asset must already be enabled in
    ///         the core factory (label, oracle resolver) and, once the vault is set, in the vault
    ///         (otherwise a market would have no depth).
    function setFeed(bytes32 assetId, bool enabled) external onlyOwner {
        if (enabled) {
            MarketFactory.Asset memory a = core.asset(assetId);
            if (!a.enabled || !a.resolver.supportsAsset(assetId)) revert FeedNotEnabled(assetId);
            if (vault != address(0)) {
                // Only the first field (enabled) matters here.
                // slither-disable-next-line unused-return
                (bool vaultEnabled,,,,,) = IVaultAssets(vault).assetCfg(assetId); // forge-lint: disable-line(unused-return)
                if (!vaultEnabled) revert FeedHasNoDepth(assetId);
            }
        }
        feedEnabled[assetId] = enabled;
        emit FeedSet(assetId, enabled);
    }

    /// @notice Takes `amount` of the partner's bond (the locked bond first, then a pending
    ///         withdrawal) and sends it to `slashRecipient`. `reason` is a hash of the public
    ///         write-up (docs/partners.md, "Governance").
    function slash(address partner, uint256 amount, bytes32 reason)
        external
        nonReentrant
        onlyOwner
    {
        Partner storage p = _partners[partner];
        if (amount == 0) revert ZeroAmount();
        uint256 total = uint256(p.bond) + p.pendingWithdrawal;
        if (amount > total) revert InsufficientBond(total, amount);
        uint256 fromBond = amount > p.bond ? p.bond : amount;
        // forge-lint: disable-next-line(unsafe-typecast)
        p.bond -= uint128(fromBond);
        // The remainder is below pendingWithdrawal by the check above.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (amount > fromBond) p.pendingWithdrawal -= uint128(amount - fromBond);
        liabilities -= amount;
        emit Slashed(partner, amount, slashRecipient, reason);
        collateral.safeTransfer(slashRecipient, amount);
    }

    /// @notice Stops the vault from quoting or allocating to one market (a market that misdescribes
    ///         its feed or strike, say). It cannot change the market or stop anyone from merging or
    ///         redeeming; the keeper merges the vault's inventory as usual.
    function voidMarket(address market, bytes32 reason) external onlyOwner {
        MarketInfo storage m = _info[market];
        if (m.partner == address(0)) revert UnknownMarket(market);
        m.voided = true;
        emit MarketVoided(market, m.partner, reason);
    }

    function setConfig(
        uint256 minBond_,
        uint256 globalExposureCap_,
        uint16 redeemFeeBps_,
        address treasury_,
        address slashRecipient_
    ) external onlyOwner {
        if (redeemFeeBps_ > MAX_REDEEM_FEE_BPS) {
            revert FeeTooHigh(redeemFeeBps_);
        }
        if (treasury_ == address(0) || slashRecipient_ == address(0)) revert ZeroAddress();
        minBond = minBond_;
        globalExposureCap = globalExposureCap_;
        redeemFeeBps = redeemFeeBps_;
        treasury = treasury_;
        slashRecipient = slashRecipient_;
        emit ConfigSet(minBond_, globalExposureCap_, redeemFeeBps_, treasury_, slashRecipient_);
    }

    function setGuardian(address g) external onlyOwner {
        if (g == address(0)) revert ZeroAddress();
        guardian = g;
        emit GuardianSet(g);
    }

    /// @notice Sets the vault once (feeds are checked against it from then on).
    function setVault(address v) external onlyOwner {
        if (vault != address(0)) revert VaultAlreadySet();
        if (v == address(0)) revert ZeroAddress();
        vault = v;
        emit VaultSet(v);
    }

    function pause() external {
        if (msg.sender != guardian && msg.sender != owner()) revert OnlyGuardianOrOwner();
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice The guardian or the owner suspends a partner (no new markets, no new allocation,
    ///         no quoting of its markets, no bond withdrawal); only the owner lifts it.
    function suspendPartner(address partner) external {
        if (msg.sender != guardian && msg.sender != owner()) revert OnlyGuardianOrOwner();
        _partners[partner].suspended = true;
        emit PartnerSuspended(partner, true, msg.sender);
    }

    function unsuspendPartner(address partner) external onlyOwner {
        _partners[partner].suspended = false;
        emit PartnerSuspended(partner, false, msg.sender);
    }

    // ================================================================== partner: bond

    /// @notice Adds `amount` to the caller's bond. The caller must be an approved partner.
    function postBond(uint256 amount) external nonReentrant {
        Partner storage p = _partners[msg.sender];
        if (!p.approved) revert NotApproved(msg.sender);
        if (amount == 0) revert ZeroAmount();
        uint256 before = collateral.balanceOf(address(this));
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (collateral.balanceOf(address(this)) - before != amount) {
            revert FeeOnTransferNotSupported();
        }
        p.bond += _u128(amount);
        liabilities += amount;
        emit BondPosted(msg.sender, amount, p.bond);
    }

    /// @notice Starts a bond withdrawal. The amount leaves the active bond at once (creating
    ///         markets needs the rest to stay above `minBond`) and becomes payable after
    ///         `WITHDRAW_DELAY` and after the challenge period that follows the partner's last market.
    function requestBondWithdrawal(uint256 amount) external {
        Partner storage p = _partners[msg.sender];
        if (amount == 0 || amount > p.bond) revert InsufficientBond(p.bond, amount);
        if (p.pendingWithdrawal != 0) revert WithdrawalPending();
        // forge-lint: disable-next-line(unsafe-typecast)
        p.bond -= uint128(amount);
        // forge-lint: disable-next-line(unsafe-typecast)
        p.pendingWithdrawal = uint128(amount);
        // uint64 holds timestamps for hundreds of billions of years.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 a = uint64(block.timestamp) + WITHDRAW_DELAY;
        uint64 b = p.lastMarketEnd + CHALLENGE_PERIOD;
        p.withdrawableAt = a > b ? a : b;
        emit BondWithdrawalRequested(msg.sender, amount, p.withdrawableAt);
    }

    /// @notice Puts a pending withdrawal back into the active bond.
    function cancelBondWithdrawal() external {
        Partner storage p = _partners[msg.sender];
        uint128 amount = p.pendingWithdrawal;
        if (amount == 0) revert NothingToWithdraw();
        p.bond += amount;
        p.pendingWithdrawal = 0;
        p.withdrawableAt = 0;
        emit BondWithdrawalCancelled(msg.sender, amount);
    }

    function executeBondWithdrawal(address to) external nonReentrant {
        Partner storage p = _partners[msg.sender];
        uint128 amount = p.pendingWithdrawal;
        if (amount == 0) revert NothingToWithdraw();
        if (p.suspended) revert PartnerIsSuspended(msg.sender);
        if (block.timestamp < p.withdrawableAt) revert WithdrawalNotReady(p.withdrawableAt);
        if (to == address(0)) revert ZeroAddress();
        p.pendingWithdrawal = 0;
        p.withdrawableAt = 0;
        liabilities -= amount;
        emit BondWithdrawn(msg.sender, amount);
        collateral.safeTransfer(to, amount);
    }

    // ================================================================== partner: markets

    /// @notice Creates a price-threshold market: UP wins iff the asset's oracle price at `endTime`
    ///         is at or above `strike` (a tie goes UP). The market starts now, is OPEN at once and
    ///         is resolved by the asset's real oracle path.
    /// @param assetId A feed the owner onboarded and allowed for the caller.
    /// @param strike The threshold in the oracle's price scale (Data Streams v3: 18 decimals).
    /// @param endTime `now + 15 minutes` to `now + 7 days`.
    function createThresholdMarket(bytes32 assetId, int256 strike, uint64 endTime)
        external
        nonReentrant
        whenNotPaused
        returns (address market)
    {
        Partner storage p = _partners[msg.sender];
        if (!p.approved) revert NotApproved(msg.sender);
        if (p.suspended) revert PartnerIsSuspended(msg.sender);
        if (p.bond < minBond) revert BondTooLow(p.bond, minBond);
        if (!allowedFeed[msg.sender][assetId]) revert FeedNotAllowed(msg.sender, assetId);
        if (!feedEnabled[assetId]) revert FeedNotEnabled(assetId);
        // A strike above int192.max could never be reached by an oracle report (int192) and is
        // user input that downstream math must not have to survive.
        if (strike <= 0 || strike > type(int192).max) revert InvalidStrike(strike);
        // uint64 holds timestamps for hundreds of billions of years.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 nowTs = uint64(block.timestamp);
        if (endTime <= nowTs) revert InvalidDuration(0);
        uint64 duration = endTime - nowTs;
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert InvalidDuration(duration);
        _reserveLiveSlot(msg.sender, nowTs);

        MarketFactory.Asset memory a = core.asset(assetId);
        market = Clones.clone(marketImplementation);
        address pin = Clones.clone(thresholdImplementation);

        // Effects first: the registry knows the market before any call goes out.
        _info[market] = MarketInfo(msg.sender, false, p.feeShareBps, endTime);
        markets.push(market);
        _live[msg.sender].push(market);
        p.marketsCreated += 1;
        if (endTime > p.lastMarketEnd) p.lastMarketEnd = endTime;

        // Trusted calls: clones of our own implementations, set up in this transaction; the
        // function is nonReentrant.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        ThresholdResolver(pin).initialize(a.resolver, strike, nowTs);
        // Every field is assigned below (a struct literal hits stack-too-deep).
        // slither-disable-next-line uninitialized-local
        Market.Params memory mp;
        mp.factory = address(this);
        mp.assetId = assetId;
        mp.resolver = IPriceResolver(pin);
        mp.collateral = collateral;
        mp.startTime = nowTs;
        mp.endTime = endTime;
        mp.redeemFeeBps = redeemFeeBps;
        string memory title = string.concat(a.label, " >=", _price(strike));
        mp.up = _deployToken(market, title, true, endTime);
        mp.down = _deployToken(market, title, false, endTime);
        // forge-lint: disable-next-line(reentrancy-no-eth)
        Market(market).initialize(mp);
        // The events come BEFORE the market opens, so that an indexer that registers the clone
        // from MarketCreated also sees its Opened event (same transaction).
        // forge-lint: disable-start(reentrancy-events)
        emit MarketCreated(market, assetId, nowTs, duration, mp);
        emit PartnerMarketCreated(
            market, msg.sender, assetId, strike, nowTs, endTime, pin, p.feeShareBps
        );
        // forge-lint: disable-end(reentrancy-events)
        // The strike is pinned, so the market opens in its creation transaction.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        Market(market).open("");
    }

    function _deployToken(address market, string memory title, bool isUp, uint64 endTime)
        private
        returns (OutcomeToken token)
    {
        token = OutcomeToken(Clones.clone(tokenImplementation));
        // forge-lint: disable-start(reentrancy-no-eth)
        token.initialize(
            market,
            MarketNaming.tokenName(title, isUp, endTime),
            MarketNaming.tokenSymbol(title, isUp, endTime),
            collateralDecimals
        );
        // forge-lint: disable-end(reentrancy-no-eth)
    }

    /// @dev Drops markets that ended more than RESOLVE_WINDOW ago from the partner's list, then
    ///      requires a free slot among the markets that have not ended.
    function _reserveLiveSlot(address partner, uint64 nowTs) private {
        address[] storage live = _live[partner];
        uint256 i = 0;
        uint256 running = 0;
        while (i < live.length) {
            uint64 end = _info[live[i]].endTime;
            if (end + RESOLVE_WINDOW <= nowTs) {
                live[i] = live[live.length - 1];
                live.pop();
            } else {
                if (end > nowTs) running++;
                i++;
            }
        }
        if (running >= MAX_LIVE_PER_PARTNER) revert TooManyLiveMarkets(partner);
    }

    /// @dev "3000" or "0.031542": whole units plus up to six decimals, trailing zeros trimmed.
    function _price(int256 strike) private pure returns (string memory) {
        // strike > 0 is checked by the caller.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 s = uint256(strike);
        uint256 whole = s / PRICE_SCALE;
        uint256 frac = (s % PRICE_SCALE) / 1e12;
        if (frac == 0) return Strings.toString(whole);
        bytes memory digits = bytes(Strings.toString(frac));
        bytes memory padded = new bytes(6);
        uint256 offset = 6 - digits.length;
        for (uint256 i = 0; i < 6; i++) {
            padded[i] = i < offset ? ZERO_CHAR : digits[i - offset];
        }
        uint256 end = 6;
        while (end > 0 && padded[end - 1] == ZERO_CHAR) end--;
        bytes memory out = new bytes(end);
        for (uint256 i = 0; i < end; i++) {
            out[i] = padded[i];
        }
        return string.concat(Strings.toString(whole), ".", string(out));
    }

    // ================================================================== fees

    /// @inheritdoc IMarketFactoryView
    function feeRecipient() external view override returns (address) {
        return address(this);
    }

    /// @inheritdoc IMarketFactoryView
    function paused() public view override(Pausable, IMarketFactoryView) returns (bool) {
        return super.paused();
    }

    /// @notice Pulls the redeem fees a partner market has accrued and splits them: the partner's
    ///         share (snapshotted at creation) is credited to `feesOwed`, the rest is credited to
    ///         the treasury (both are pulled with `withdrawFees`, so a blocked address can never
    ///         stop anyone else's money). Anyone may call. The credit is the amount the market
    ///         reports as accrued, so fees claimed directly on the market (`Market.claimFees` is
    ///         permissionless) cannot be mis-attributed: they are strays, see `sweepStray`.
    function collectFees(Market market) external nonReentrant {
        MarketInfo storage m = _info[address(market)];
        if (m.partner == address(0)) revert UnknownMarket(address(market));
        uint256 accrued = market.feesAccrued();
        if (accrued == 0) revert NothingToWithdraw();
        // Trusted call: a market this registry created; the function is nonReentrant.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        market.claimFees();
        uint256 partnerShare = accrued * m.feeShareBps / BPS;
        uint256 treasuryShare = accrued - partnerShare;
        feesOwed[m.partner] += partnerShare;
        feesOwed[treasury] += treasuryShare;
        liabilities += accrued;
        // forge-lint: disable-next-line(reentrancy-events)
        emit FeesCollected(address(market), m.partner, partnerShare, treasuryShare);
    }

    /// @notice Credits collateral nobody is owed (someone called `Market.claimFees` directly, which
    ///         pays the registry without telling it whose fee it was) to the treasury. A partner
    ///         who wants its share should collect before anyone else claims; the griefer gains
    ///         nothing. Anyone may call.
    function sweepStray() external nonReentrant {
        uint256 bal = collateral.balanceOf(address(this));
        if (bal <= liabilities) revert NothingToWithdraw();
        uint256 stray = bal - liabilities;
        feesOwed[treasury] += stray;
        liabilities += stray;
        emit StraySwept(stray);
    }

    /// @notice A partner withdraws the fees credited to it.
    function withdrawFees(address to) external nonReentrant {
        uint256 amount = feesOwed[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        if (to == address(0)) revert ZeroAddress();
        feesOwed[msg.sender] = 0;
        liabilities -= amount;
        emit FeesWithdrawn(msg.sender, to, amount);
        collateral.safeTransfer(to, amount);
    }

    // ================================================================== views

    function partnerOf(address partner) external view returns (Partner memory) {
        return _partners[partner];
    }

    function infoOf(address market) external view returns (MarketInfo memory) {
        return _info[market];
    }

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    function partnerCount() external view returns (uint256) {
        return partnerList.length;
    }

    /// @notice A partner's markets that have not ended, plus those that ended less than
    ///         RESOLVE_WINDOW ago (the list is pruned when the partner creates again).
    function liveMarketsOf(address partner) external view returns (address[] memory) {
        return _live[partner];
    }

    /// @notice Every partner market that is running or ended less than RESOLVE_WINDOW ago, across
    ///         all partners: the keeper's candidate list in one call. Running markets come first
    ///         (a caller that reads only the head of the list never starves a live market behind
    ///         ended ones). Bounded by the live limit.
    function liveMarkets() external view returns (address[] memory out) {
        uint256 n = 0;
        for (uint256 pass = 0; pass < 2; pass++) {
            if (pass == 1) out = new address[](n);
            uint256 k = 0;
            for (uint256 phase = 0; phase < 2; phase++) {
                for (uint256 i = 0; i < partnerList.length; i++) {
                    address[] storage live = _live[partnerList[i]];
                    for (uint256 j = 0; j < live.length; j++) {
                        uint64 end = _info[live[j]].endTime;
                        bool running = end > block.timestamp;
                        bool recent = !running && end + RESOLVE_WINDOW > block.timestamp;
                        if ((phase == 0 && running) || (phase == 1 && recent)) {
                            if (pass == 1) out[k] = live[j];
                            k++;
                        }
                    }
                }
            }
            n = k;
        }
    }

    /// @notice Everything the vault needs about a market, in one call. `active` means new
    ///         allocation and quoting are allowed: not voided, partner approved, not suspended and
    ///         the bond at or above `minBond`. `partnerCap` is 0 when inactive.
    function limits(address market) external view returns (Limits memory l) {
        MarketInfo storage m = _info[market];
        l.partner = m.partner;
        l.exists = l.partner != address(0);
        if (!l.exists) return l;
        Partner storage p = _partners[l.partner];
        l.active = !m.voided && p.approved && !p.suspended && p.bond >= minBond;
        l.partnerCap = l.active ? p.exposureCap : 0;
        l.globalCap = globalExposureCap;
    }

    function _u128(uint256 x) internal pure returns (uint128) {
        if (x > type(uint128).max) revert InvalidTerms();
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(x);
    }

    /// @dev One-step renouncing would strand the registry without an owner.
    function renounceOwnership() public view override onlyOwner {
        revert InvalidTerms();
    }
}
