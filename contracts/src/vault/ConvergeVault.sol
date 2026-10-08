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

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {Market} from "../Market.sol";
import {MarketFactory} from "../MarketFactory.sol";
import {DataStreamsResolver} from "../resolvers/DataStreamsResolver.sol";
import {IVerifierProxy, ReportV3} from "../interfaces/IVerifierProxy.sol";
import {QuoteMath} from "./QuoteMath.sol";
import {ReportLib} from "./ReportLib.sol";
import {Series} from "../libraries/Series.sol";
import {IPartnerRegistry} from "../partners/IPartnerRegistry.sol";

/// @title ConvergeVault
/// @notice LP vault for the Converge outcome markets (docs/adr/ADR-005, docs/security/threat-model.md).
///         ERC-20 shares, ERC-7540-style asynchronous requests settled once per epoch, a two-sided
///         conservative NAV, a performance fee over a high-water mark, a daily drawdown breaker, and
///         a trading venue (ADR-004) that can only act through bounded fill primitives.
/// @dev Trust model in one paragraph. The KEEPER can do exactly three things: set a volatility
///      inside an owner band at a bounded rate (`setSigma`), and split collateral into / merge pairs
///      back out of factory markets of enabled assets (`splitForInventory`, `mergeInventory`). Both
///      conversions are value-neutral (a pair is always worth 1) and can never send anything out of
///      the vault. Trades happen only through the VENUE (owner-set, timelocked), and every fill is
///      re-checked here against the loss ceiling, the price bounds and the free liquidity, so even a
///      faulty venue can lose at most the configured per-market and total at-risk caps. Share
///      prices are two-sided: deposits mint at the upper NAV and redemptions pay the lower NAV, with
///      marks taken only from verified Data Streams reports (never from the keeper).
contract ConvergeVault is ERC20, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types

    struct Epoch {
        uint128 depositAssets; // requested
        uint128 redeemShares; // requested
        bool settled;
        bool depositRejected; // deposits refunded instead of minted (empty NAV or dust)
        uint128 sharesMinted; // claimable by depositors (held by the vault until claimed)
        uint128 redeemFilled; // shares burned
        uint128 redeemAssetsPaid; // assets reserved for redeemers
    }

    struct AssetCfg {
        bool enabled;
        bytes32 feedId;
        uint128 sigma; // keeper-set annual vol, WAD (0 = never set)
        uint64 sigmaUpdatedAt;
        uint128 sigmaMin; // owner band
        uint128 sigmaMax;
    }

    struct LastMark {
        uint192 price;
        uint64 obsTs;
    }

    /// @dev Accounting for a registered inventory market (asset units; signed).
    struct Position {
        int256 basis; // collateral split minus collateral merged back
        int256 cash; // premium received from takers minus premium paid in fills
    }

    /// @dev Per-asset mark for one valuation (memory, aligned with `assetIds`).
    struct Mark {
        bool known;
        uint192 price;
        uint64 obsTs;
    }

    enum MarkMode {
        STRICT, // a missing mark that is needed reverts, an unresolved ended round reverts (settlement)
        LAST_KNOWN // a missing mark falls back to the last verified one (breaker, auto-checkpoint)
    }

    /// @dev What the venue needs to price one market.
    struct VenueView {
        bool tradable;
        uint256 navWad;
        uint256 sigma;
        QuoteMath.Pos pos;
    }

    // ------------------------------------------------------------------ constants

    uint256 public constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint256 public constant MAX_MARKETS = 16;
    uint256 public constant MAX_ASSETS = 8;
    /// @notice Registry slots (of MAX_MARKETS) that partner markets can use, so that partner
    ///         markets can never crowd the core rounds out of the vault.
    uint256 public constant MAX_PARTNER_MARKETS = 6;
    /// @notice Registry slots one partner can hold at a time, so that a single partner cannot take
    ///         all of `MAX_PARTNER_MARKETS`.
    uint256 public constant MAX_MARKETS_PER_PARTNER = 3;
    /// @notice A registered market holding at most this many outcome-token units (0.001 of a 6
    ///         decimal collateral) counts as empty and can be pruned. Without it, anyone could pin
    ///         a registry slot for the life of a market by donating one wei of a token. What is
    ///         left behind is worth at most this much and is not part of the NAV.
    uint256 public constant DUST_TOKENS = 1_000;
    /// @notice Hard ceiling for `maxPartnerFraction`.
    uint256 public constant MAX_PARTNER_FRACTION = 0.3e18;
    uint256 public constant MAX_FEE_BPS = 2_000; // 20%
    uint256 public constant VENUE_DELAY = 2 days;
    /// @dev While trading continues the vault re-values itself at most this often (seconds), and
    ///      only from a venue report no older than AUTO_MARK_MAX_AGE.
    uint256 public constant AUTO_CHECKPOINT_INTERVAL = 60;
    uint256 public constant AUTO_MARK_MAX_AGE = 60;
    /// @dev A last known mark older than this is no information (the breaker then values excess
    ///      at 1/2 plus or minus the band instead of a stale price).
    uint256 public constant MAX_LAST_MARK_AGE = 1 hours;
    /// @dev Shares permanently locked at the first settlement (donation-inflation defense).
    uint256 public constant DEAD_SHARES = 1_000;
    address internal constant DEAD = address(0xdEaD);

    // ------------------------------------------------------------------ immutables

    IERC20 public immutable asset;
    MarketFactory public immutable factory;
    DataStreamsResolver public immutable streams;
    IVerifierProxy public immutable verifier;
    uint64 public immutable epochLength;
    uint64 public immutable genesis;
    /// @notice Smallest deposit request (asset units); always above DEAD_SHARES.
    uint256 public immutable minRequest;
    uint8 internal immutable _dec;
    /// @dev 10^(18 - assetDecimals): asset units to WAD.
    uint256 internal immutable SCALE;

    // ------------------------------------------------------------------ roles

    address public guardian;
    address public keeper;
    address public treasury;
    address public venue;
    address public pendingVenue;
    uint64 public pendingVenueEta;

    // ------------------------------------------------------------------ configuration

    uint256 public tvlCap;
    uint16 public performanceFeeBps = 1_000;
    /// @notice A report older than this (seconds) is not a usable mark.
    uint32 public maxMarkAge = 10;
    /// @notice Extra haircut around every mark, WAD (covers price movement during maxMarkAge).
    uint64 public markBand = 0.05e18;
    /// @notice Seconds after an epoch ends during which it can be settled (60 s up to, not
    ///         including, one round of 15 minutes). Marks are the reports that contain the epoch's
    ///         end time, and epoch ends and round ends share one 15 minute grid, so no round that
    ///         was still running at the epoch end can have ended inside the window: waiting reveals
    ///         nothing. An epoch not settled in time expires: deposits are refunded and redemption
    ///         requests are queued again, nothing is priced late.
    uint32 public settleWindow = 10 minutes;
    /// @notice Daily drawdown limit on the lower share price, in bps.
    uint16 public breakerBps = 500;
    uint16 public maxSigmaStepBps = 2_000;
    uint32 public sigmaMinInterval = 30;
    uint32 public sigmaMaxAge = 15 minutes;
    /// @notice Quoting stops when the stored NAV is older than this.
    uint32 public navMaxAge = 30 minutes;
    /// @notice Largest basis in one market, and in total, as a fraction of the lower NAV (WAD).
    uint64 public maxPairFraction = 0.3e18;
    uint64 public maxInventoryFraction = 0.5e18;
    QuoteMath.Params internal _params;

    // ------------------------------------------------------------------ state

    bytes32[] public assetIds;
    /// @notice The asset a Data Streams feed id was enabled for (one feed, one asset: a report is
    ///         matched to exactly one asset, so a duplicate would make the second one unsettleable).
    mapping(bytes32 feedId => bytes32 assetId) public assetOfFeed;
    mapping(bytes32 => AssetCfg) public assetCfg;
    mapping(bytes32 => LastMark) public lastMark;

    mapping(uint256 => Epoch) public epochs;
    mapping(uint256 => mapping(address => uint256)) public depositRequest;
    mapping(uint256 => mapping(address => uint256)) public redeemRequest;
    /// @notice Assets of unsettled deposit requests (held, not part of NAV).
    uint256 public pendingDeposits;
    /// @notice Assets owed to settled redeemers and refunded depositors (held, not part of NAV).
    uint256 public claimableAssets;

    /// @dev Lower NAV and lower price per share (WAD) at the last settlement or checkpoint.
    uint256 public quoteNavLower;
    uint256 public lastNavUpper;
    uint64 public navUpdatedAt;
    uint256 public lastPpsLower;
    uint256 public hwmPps = WAD;
    uint256 public dayStartPps;
    uint64 public dayStart;
    bool public quotingPaused;
    /// @notice The keeper's own off switch (Phase 5): it pulls every quote at once when its price
    ///         sources or its risk checks fail and puts them back when they recover. It is
    ///         independent of `quotingPaused` (guardian, owner and breaker), which the keeper can
    ///         never clear.
    bool public keeperHalt;

    /// @notice The PartnerRegistry whose markets the vault may also quote (ADR-008); set once.
    IPartnerRegistry public partnerRegistry;
    /// @notice Largest basis in ALL partner markets together, as a fraction of the lower NAV
    ///         (WAD). It applies on top of the registry's per-partner and global caps, so that a
    ///         registry misconfiguration can never allocate more than this.
    uint64 public maxPartnerFraction = 0.1e18;
    /// @dev The partner of a registered partner market (zero for core markets).
    mapping(address => address) internal _partnerOf;
    uint256 internal _partnerMarkets;
    mapping(address => uint256) internal _partnerCount;

    address[] internal _markets;
    mapping(address => uint256) internal _slot; // index + 1
    mapping(address => Position) internal _pos;

    // ------------------------------------------------------------------ events

    event DepositRequested(uint256 indexed epochId, address indexed owner, uint256 assets);
    event RedeemRequested(
        uint256 indexed epochId, address indexed owner, uint256 shares, bool requeued
    );
    event EpochSettled(
        uint256 indexed epochId,
        uint256 navLower,
        uint256 navUpper,
        uint256 supplyBefore,
        uint256 sharesMinted,
        uint256 sharesBurned,
        uint256 assetsPaid,
        uint256 depositsAccepted,
        bool depositRejected
    );
    event DepositClaimed(
        uint256 indexed epochId,
        address indexed owner,
        address receiver,
        uint256 shares,
        uint256 refunded
    );
    event RedeemClaimed(
        uint256 indexed epochId,
        address indexed owner,
        address receiver,
        uint256 assets,
        uint256 requeuedShares
    );
    event NavSnapshot(
        uint256 navLower, uint256 navUpper, uint256 ppsLower, uint256 supply, bool settlement
    );
    event EpochExpired(uint256 indexed epochId, uint256 depositsRefunded, uint256 redeemShares);
    event PerformanceFee(uint256 feeShares, uint256 feeAssets, uint256 newHwm);
    event Fill(
        address indexed market,
        bool upToken,
        bool vaultSells,
        uint256 units,
        uint256 premium,
        address indexed taker,
        int256 basis,
        int256 cash
    );
    event SigmaSet(bytes32 indexed assetId, uint256 sigma);
    event InventorySplit(address indexed market, uint256 amount);
    event InventoryMerged(address indexed market, uint256 amount);
    event MarketRegistered(address indexed market, bytes32 indexed assetId);
    event PartnerMarketRegistered(address indexed market, address indexed partner);
    event PartnerRegistrySet(address indexed registry);
    event PartnerFractionSet(uint256 fraction);
    event MarketUnregistered(address indexed market);
    event ResolvedRedeemed(address indexed market, uint256 pairsMerged, uint256 payout);
    event QuotingPaused(address indexed by);
    event BreakerTripped(uint256 ppsLower, uint256 dayStartPps);
    event QuotingResumed(address indexed by);
    event QuotingHalted(address indexed keeper, bytes32 reason);
    event QuotingUnhalted(address indexed keeper);
    event AssetEnabled(bytes32 indexed assetId, bytes32 feedId, uint256 sigmaMin, uint256 sigmaMax);
    event SigmaBandSet(bytes32 indexed assetId, uint256 sigmaMin, uint256 sigmaMax);
    event TvlCapSet(uint256 cap);
    event FeeSet(uint256 bps);
    event KeeperSet(address indexed keeper);
    event GuardianSet(address indexed guardian);
    event TreasurySet(address indexed treasury);
    event VenueProposed(address indexed venue, uint64 eta);
    event VenueSet(address indexed venue);
    event VenueCancelled(address indexed venue);
    event ParamsSet(QuoteMath.Params params);
    event RiskConfigSet(
        uint256 maxMarkAge,
        uint256 markBand,
        uint256 settleWindow,
        uint256 breakerBps,
        uint256 maxPairFraction,
        uint256 maxInventoryFraction
    );
    event SigmaConfigSet(
        uint256 maxStepBps, uint256 minInterval, uint256 maxAge, uint256 navMaxAge
    );

    // ------------------------------------------------------------------ errors

    error ZeroAddress();
    error OnlyKeeper();
    error OnlyVenue();
    error OnlyGuardianOrOwner();
    error BelowMinimum(uint256 amount, uint256 minimum);
    error TvlCapExceeded(uint256 requested, uint256 room);
    error FeeOnTransferNotSupported();
    error EpochNotEnded(uint256 epochId);
    error AlreadySettled(uint256 epochId);
    error NothingToSettle(uint256 epochId);
    error NotSettled(uint256 epochId);
    error NothingToClaim();
    error AssetNotEnabled(bytes32 assetId);
    error AssetAlreadyEnabled(bytes32 assetId);
    error TooManyAssets();
    error UnsupportedAsset(bytes32 assetId);
    error UnknownReportFeed(bytes32 feedId);
    error DuplicateReport(bytes32 assetId);
    error StaleReport(uint32 obsTs, uint256 nowTs);
    error MarkMissing(bytes32 assetId);
    error MarketNotResolved(address market);
    error ReportNotCanonical(uint64 at, uint32 validFrom, uint32 observations);
    error NotFactoryMarket(address market);
    error PartnerRegistryAlreadySet();
    error PartnerInactive(address market);
    error PartnerCapExceeded(address partner, uint256 total, uint256 cap);
    error PartnerGlobalCapExceeded(uint256 total, uint256 cap);
    error TooManyPartnerMarkets();
    error TooManyMarketsForPartner(address partner);
    error MarketNotRegistered(address market);
    error TooManyMarkets();
    error WrongMarketState(uint8 state);
    error InNoQuoteWindow();
    error QuotingIsPaused();
    error QuotingHalt();
    error PairCapExceeded(uint256 basis, uint256 cap);
    error InventoryCapExceeded(uint256 total, uint256 cap);
    error NotEnoughPairs(uint256 have, uint256 want);
    error SigmaOutOfBand(uint256 sigma, uint256 min, uint256 max);
    error SigmaStepTooLarge(uint256 sigma, uint256 previous);
    error SigmaTooSoon(uint64 availableAt);
    error InvalidConfig();
    error FeeTooHigh(uint256 bps);
    error VenueNotProposed();
    error VenueTimelock(uint64 eta);
    error VenueAlreadySet();
    error NotTradable();
    error PriceOutOfBounds(uint256 price);
    error RiskLimitExceeded(uint256 units, uint256 room);
    error LossAboveCeiling(uint256 loss, uint256 ceiling);
    error SettlementPending();
    error InsufficientLiquidity(uint256 need, uint256 free);
    error NotEmpty();
    error FeedAlreadyUsed(bytes32 feedId);
    error MarketUnresolved();
    error ZeroAmount();

    // ------------------------------------------------------------------ modifiers

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert OnlyKeeper();
        _;
    }

    modifier onlyVenue() {
        if (msg.sender != venue || msg.sender == address(0)) revert OnlyVenue();
        _;
    }

    // ------------------------------------------------------------------ construction

    // Not randomness: block.timestamp is used to align epochs and UTC days.
    // slither-disable-start weak-prng
    constructor(
        IERC20 asset_,
        MarketFactory factory_,
        DataStreamsResolver streams_,
        address owner_,
        address guardian_,
        address keeper_,
        address treasury_,
        uint64 epochLength_,
        uint256 minRequest_,
        uint256 tvlCap_,
        QuoteMath.Params memory params_
    ) ERC20("Converge Vault Share", "cvLP") Ownable(owner_) {
        if (
            address(asset_) == address(0) || address(factory_) == address(0)
                || address(streams_) == address(0) || guardian_ == address(0)
                || keeper_ == address(0) || treasury_ == address(0)
        ) revert ZeroAddress();
        // Epoch ends must fall on the round grid (15 min), so that no round can end inside a
        // settlement window (which is shorter than a round): see settleWindow.
        if (epochLength_ % Series.FIFTEEN_MINUTES != 0 || minRequest_ <= DEAD_SHARES) {
            revert InvalidConfig();
        }
        if (address(factory_.collateral()) != address(asset_)) revert InvalidConfig();
        uint8 d = IERC20Metadata(address(asset_)).decimals();
        if (d > 18) revert InvalidConfig();
        asset = asset_;
        factory = factory_;
        streams = streams_;
        verifier = streams_.verifier();
        epochLength = epochLength_;
        // uint64 holds timestamps for hundreds of billions of years.
        // forge-lint: disable-next-line(unsafe-typecast, weak-prng)
        genesis = uint64(block.timestamp - (block.timestamp % epochLength_));
        minRequest = minRequest_;
        _dec = d;
        SCALE = 10 ** (18 - d);
        guardian = guardian_;
        keeper = keeper_;
        treasury = treasury_;
        tvlCap = tvlCap_;
        _validateParams(params_);
        _params = params_;
        dayStartPps = WAD;
        lastPpsLower = WAD;
        emit ParamsSet(params_);
    }
    // slither-disable-end weak-prng

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    // ================================================================== LP flows

    /// @notice Epoch id of `ts`.
    function epochOf(uint256 ts) public view returns (uint256) {
        return (ts - genesis) / epochLength;
    }

    function currentEpoch() public view returns (uint256) {
        return epochOf(block.timestamp);
    }

    /// @notice First second after epoch `epochId`.
    function epochEnd(uint256 epochId) public view returns (uint256) {
        return uint256(genesis) + (epochId + 1) * epochLength;
    }

    /// @notice Queues `assets` for the current epoch. Settled (minted at the upper NAV) once the
    ///         epoch has ended; claim shares with `claimDeposit`.
    /// @dev The cap is checked against the last settled upper NAV plus every pending deposit.
    function requestDeposit(uint256 assets) external nonReentrant returns (uint256 epochId) {
        if (assets < minRequest) revert BelowMinimum(assets, minRequest);
        uint256 used = lastNavUpper + pendingDeposits;
        if (used + assets > tvlCap) {
            revert TvlCapExceeded(assets, tvlCap > used ? tvlCap - used : 0);
        }
        epochId = currentEpoch();
        uint256 before = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), assets);
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (asset.balanceOf(address(this)) - before != assets) revert FeeOnTransferNotSupported();
        depositRequest[epochId][msg.sender] += assets;
        // Bounded by the asset's total supply in practice; checked cast.
        epochs[epochId].depositAssets += _u128(assets);
        pendingDeposits += assets;
        emit DepositRequested(epochId, msg.sender, assets);
    }

    /// @notice Escrows `shares` for redemption in the current epoch (paid at the lower NAV).
    /// @dev Never blocked by a pause or the breaker.
    function requestRedeem(uint256 shares) external nonReentrant returns (uint256 epochId) {
        if (shares == 0) revert ZeroAmount();
        epochId = currentEpoch();
        _transfer(msg.sender, address(this), shares);
        redeemRequest[epochId][msg.sender] += shares;
        epochs[epochId].redeemShares += _u128(shares);
        emit RedeemRequested(epochId, msg.sender, shares, false);
    }

    /// @dev Working values of one settlement (a struct keeps the stack shallow).
    struct Settlement {
        uint256 lo;
        uint256 hi;
        uint256 supply0; // supply before this epoch's deposits and redemptions (fee shares included)
        uint256 minted;
        uint256 accepted;
        uint256 burned;
        uint256 paid;
        bool rejected;
    }

    /// @notice Settles an ended epoch at one lower and one upper NAV. Anyone may call, within
    ///         `settleWindow` of the epoch's end; later the call expires the epoch instead
    ///         (deposits refundable, redemption requests queued again, no price is struck).
    /// @param reports One Data Streams report per asset listed by `settlementPlan(epochId)`: the
    ///        report whose window contains the epoch's end time (validFrom <= T <= observations),
    ///        the same canonical rule as the resolver and the venue. The NAV is therefore a
    ///        function of the price AT the epoch end; the settler chooses nothing about it.
    ///        Every round that had ended by T must already be resolved (anyone can resolve it).
    // All entry points are nonReentrant; the external calls go to the factory's own Market clones, the immutable asset or the immutable verifier proxy.
    // slither-disable-next-line reentrancy-no-eth
    function settleEpoch(uint256 epochId, bytes[] calldata reports) external nonReentrant {
        if (epochId >= currentEpoch()) revert EpochNotEnded(epochId);
        Epoch storage e = epochs[epochId];
        if (e.settled) revert AlreadySettled(epochId);
        if (e.depositAssets == 0 && e.redeemShares == 0) revert NothingToSettle(epochId);
        uint256 end = epochEnd(epochId);
        if (block.timestamp > end + settleWindow) {
            _expire(e, epochId);
            return;
        }

        Settlement memory z = Settlement(0, 0, 0, 0, 0, 0, 0, false);
        {
            Mark[] memory marks = _collectMarks(reports, end);
            (z.lo, z.hi) = _navs(marks, MarkMode.STRICT, end);
            _recordMarks(marks);
        }
        uint256 supplyBefore = totalSupply();
        z.supply0 = supplyBefore;
        if (supplyBefore != 0 && z.lo != 0) z.supply0 += _performanceFee(z.lo, supplyBefore);
        // Exact comparison is intended: a zero check on a computed amount, or an enum/identifier match.
        // slither-disable-next-line incorrect-equality
        uint256 ppsLo = z.supply0 == 0 ? WAD : F.mulDiv(z.lo, WAD, z.supply0);

        _settleDeposits(e, z);
        _settleRedemptions(e, z);

        e.settled = true;
        e.sharesMinted = _u128(z.minted);
        e.redeemFilled = _u128(z.burned);
        e.redeemAssetsPaid = _u128(z.paid);

        lastNavUpper = z.hi + z.accepted - z.paid;
        quoteNavLower = z.lo + z.accepted - z.paid;
        // forge-lint: disable-next-line(unsafe-typecast)
        navUpdatedAt = uint64(block.timestamp);
        _updateBreaker(ppsLo);
        // forge-lint: disable-start(reentrancy-events)
        emit EpochSettled(
            epochId, z.lo, z.hi, supplyBefore, z.minted, z.burned, z.paid, z.accepted, z.rejected
        );
        // forge-lint: disable-end(reentrancy-events)
        // forge-lint: disable-next-line(reentrancy-events)
        emit NavSnapshot(z.lo, z.hi, ppsLo, totalSupply(), true);
    }

    /// @dev An epoch nobody settled in time: no price is struck, so nothing can be gamed by waiting.
    ///      Deposits come back through `claimDeposit`; redemption requests are queued again by
    ///      `claimRedeem` (nothing filled).
    function _expire(Epoch storage e, uint256 epochId) internal {
        uint256 d = e.depositAssets;
        pendingDeposits -= d;
        if (d != 0) {
            claimableAssets += d;
            e.depositRejected = true;
        }
        e.settled = true;
        emit EpochExpired(epochId, d, e.redeemShares);
    }

    /// @dev Deposits mint at the upper NAV (rounded down). The first deposit mints 1 share per
    ///      asset unit and locks DEAD_SHARES forever. A deposit that cannot be priced (empty NAV,
    ///      or a dust deposit) is refunded through `claimDeposit`.
    function _settleDeposits(Epoch storage e, Settlement memory z) internal {
        uint256 d = e.depositAssets;
        pendingDeposits -= d;
        if (d == 0) return;
        // Exact comparison is intended: a zero check on a computed amount, or an enum/identifier match.
        // slither-disable-next-line incorrect-equality
        if (z.supply0 == 0) {
            // minRequest > DEAD_SHARES (constructor), so the first deposit always covers them.
            _mint(DEAD, DEAD_SHARES);
            z.minted = d - DEAD_SHARES;
            _mint(address(this), z.minted);
            // Exact comparison is intended: a zero check on a computed amount, or an enum/identifier match.
            // slither-disable-next-line incorrect-equality
        } else if (z.hi == 0) {
            z.rejected = true;
        } else {
            z.minted = F.mulDiv(d, z.supply0, z.hi);
            // Exact comparison is intended: a zero check on a computed amount, or an enum/identifier match.
            // slither-disable-next-line incorrect-equality
            if (z.minted == 0) z.rejected = true;
            else _mint(address(this), z.minted);
        }
        if (z.rejected) {
            claimableAssets += d;
            e.depositRejected = true;
        } else {
            z.accepted = d;
        }
    }

    /// @dev Redemptions pay the lower NAV per pre-deposit share (rounded down), pro rata to the
    ///      free liquidity. What is not filled is queued again at claim time.
    function _settleRedemptions(Epoch storage e, Settlement memory z) internal {
        uint256 r = e.redeemShares;
        // Exact comparison is intended: a zero check on a computed amount, or an enum/identifier match.
        // slither-disable-next-line incorrect-equality
        if (r == 0 || z.supply0 == 0 || z.lo == 0) return;
        uint256 want = F.mulDiv(r, z.lo, z.supply0);
        uint256 free = _freeLiquidity();
        if (want <= free) {
            z.burned = r;
            z.paid = want;
        } else {
            z.burned = F.mulDiv(r, free, want);
            z.paid = F.mulDiv(z.burned, z.lo, z.supply0);
        }
        if (z.burned != 0) _burn(address(this), z.burned);
        claimableAssets += z.paid;
    }

    /// @notice Pays out an epoch's deposit request as shares (or refunds a rejected one).
    function claimDeposit(uint256 epochId, address receiver) external nonReentrant {
        Epoch storage e = epochs[epochId];
        if (!e.settled) revert NotSettled(epochId);
        if (receiver == address(0)) revert ZeroAddress();
        uint256 a = depositRequest[epochId][msg.sender];
        if (a == 0) revert NothingToClaim();
        delete depositRequest[epochId][msg.sender];
        if (e.depositRejected) {
            claimableAssets -= a;
            asset.safeTransfer(receiver, a);
            emit DepositClaimed(epochId, msg.sender, receiver, 0, a);
            return;
        }
        uint256 s = F.mulDiv(a, e.sharesMinted, e.depositAssets);
        _transfer(address(this), receiver, s);
        // forge-lint: disable-next-line(reentrancy-events)
        emit DepositClaimed(epochId, msg.sender, receiver, s, 0);
    }

    /// @notice Pays out an epoch's redemption request. The part that could not be filled (the
    ///         vault was short of liquid assets) is queued again in the current epoch.
    function claimRedeem(uint256 epochId, address receiver) external nonReentrant {
        Epoch storage e = epochs[epochId];
        if (!e.settled) revert NotSettled(epochId);
        if (receiver == address(0)) revert ZeroAddress();
        uint256 s = redeemRequest[epochId][msg.sender];
        if (s == 0) revert NothingToClaim();
        delete redeemRequest[epochId][msg.sender];
        uint256 requested = e.redeemShares;
        uint256 out = F.mulDiv(s, e.redeemAssetsPaid, requested);
        uint256 rest = F.mulDiv(s, requested - e.redeemFilled, requested);
        claimableAssets -= out;
        if (rest != 0) {
            uint256 cur = currentEpoch();
            redeemRequest[cur][msg.sender] += rest;
            epochs[cur].redeemShares += _u128(rest);
            // forge-lint: disable-next-line(reentrancy-events)
            emit RedeemRequested(cur, msg.sender, rest, true);
        }
        if (out != 0) asset.safeTransfer(receiver, out);
        // forge-lint: disable-next-line(reentrancy-events)
        emit RedeemClaimed(epochId, msg.sender, receiver, out, rest);
    }

    /// @dev Shares held by the vault for unclaimed requests are real outstanding shares.
    function _performanceFee(uint256 lo, uint256 supply) internal returns (uint256 feeShares) {
        uint256 pps = F.mulDiv(lo, WAD, supply);
        if (pps <= hwmPps || performanceFeeBps == 0) {
            if (pps > hwmPps) hwmPps = pps;
            return 0;
        }
        uint256 feeAssets = F.mulDiv(F.mulDiv(pps - hwmPps, supply, WAD), performanceFeeBps, BPS);
        // Exact comparison is intended: a zero check on a computed amount, or an enum/identifier match.
        // slither-disable-next-line incorrect-equality
        if (feeAssets == 0 || feeAssets >= lo) return 0;
        feeShares = F.mulDiv(feeAssets, supply, lo - feeAssets);
        // Exact comparison is intended: a zero check on a computed amount, or an enum/identifier match.
        // slither-disable-next-line incorrect-equality
        if (feeShares == 0) return 0;
        _mint(treasury, feeShares);
        hwmPps = F.mulDiv(lo, WAD, supply + feeShares);
        // forge-lint: disable-next-line(reentrancy-events)
        emit PerformanceFee(feeShares, feeAssets, hwmPps);
    }

    // ================================================================== NAV

    /// @dev Liquid collateral not owed to anyone: balance minus unsettled deposits and unclaimed
    ///      payouts.
    function _freeLiquidity() internal view returns (uint256) {
        uint256 bal = asset.balanceOf(address(this));
        uint256 reserved = pendingDeposits + claimableAssets;
        return bal > reserved ? bal - reserved : 0;
    }

    /// @notice Verifies the reports and returns one mark per enabled asset (aligned with
    ///         `assetIds`). Each report is checked against the asset's configured feed.
    /// @param at 0: fresh marks (no older than `maxMarkAge`, used by the breaker). Otherwise the
    ///        canonical report for time `at` (its window contains `at`), recorded as a mark at `at`.
    function _collectMarks(bytes[] calldata reports, uint256 at)
        internal
        returns (Mark[] memory marks)
    {
        marks = new Mark[](assetIds.length);
        bytes memory param = streams.parameterPayload();
        for (uint256 i = 0; i < reports.length; i++) {
            bytes32 feed = ReportLib.feedOf(reports[i]);
            uint256 idx = type(uint256).max;
            for (uint256 j = 0; j < assetIds.length; j++) {
                // Exact comparison is intended: a zero check on a computed amount, or an enum/identifier match.
                // slither-disable-next-line incorrect-equality
                if (assetCfg[assetIds[j]].feedId == feed) {
                    idx = j;
                    break;
                }
            }
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (idx == type(uint256).max) revert UnknownReportFeed(feed);
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (marks[idx].known) revert DuplicateReport(assetIds[idx]);
            ReportV3 memory r = ReportLib.verify(verifier, param, reports[i], feed);
            // price > 0 is checked by the library, so the cast cannot truncate a negative.
            // forge-lint: disable-next-line(unsafe-typecast)
            marks[idx] = Mark(true, uint192(r.price), _markTime(r, at));
        }
    }

    /// @dev The timestamp a verified report is a mark for: `at` if the report is canonical for it,
    ///      or its own observation time if it is fresh.
    // `at == 0` selects the fresh-mark mode; it is a flag, not a balance.
    // slither-disable-start incorrect-equality
    function _markTime(ReportV3 memory r, uint256 at) internal view returns (uint64) {
        if (at == 0) {
            if (
                r.observationsTimestamp > block.timestamp
                    || block.timestamp - r.observationsTimestamp > maxMarkAge
            ) {
                // forge-lint: disable-next-line(require-revert-in-loop)
                revert StaleReport(r.observationsTimestamp, block.timestamp);
            }
            return r.observationsTimestamp;
        }
        if (r.validFromTimestamp > at || r.observationsTimestamp < at) {
            // forge-lint: disable-next-line(unsafe-typecast, require-revert-in-loop)
            revert ReportNotCanonical(uint64(at), r.validFromTimestamp, r.observationsTimestamp);
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(at);
    }

    // slither-disable-end incorrect-equality

    /// @dev Keeps the newest verified mark per asset (the breaker reads it when a report is omitted).
    function _recordMarks(Mark[] memory marks) internal {
        for (uint256 i = 0; i < marks.length; i++) {
            if (marks[i].known && marks[i].obsTs > lastMark[assetIds[i]].obsTs) {
                lastMark[assetIds[i]] = LastMark(marks[i].price, marks[i].obsTs);
            }
        }
    }

    /// @notice Lower and upper NAV (asset units) of the vault as of time `at`.
    /// @dev lower = free collateral + pairs + excess tokens at the lowest plausible value;
    ///      upper = the same at the highest. Matched UP+DOWN pairs are worth exactly 1 (merge never
    ///      fails). A round that had ended by `at` is valued exactly from its outcome (net of the
    ///      redeem fee); a round still running at `at` is valued from the mark at `at`, even if it
    ///      has been resolved since, so settling later reveals nothing.
    function _navs(Mark[] memory marks, MarkMode mode, uint256 at)
        internal
        view
        returns (uint256 lo, uint256 hi)
    {
        lo = hi = _freeLiquidity();
        uint256 n = _markets.length;
        for (uint256 i = 0; i < n; i++) {
            (uint256 l, uint256 h) = _marketValue(Market(_markets[i]), marks, mode, at);
            lo += l;
            hi += h;
        }
    }

    function _marketValue(Market m, Mark[] memory marks, MarkMode mode, uint256 at)
        internal
        view
        returns (uint256 lo, uint256 hi)
    {
        // forge-lint: disable-next-line(calls-loop)
        uint256 u = IERC20(address(m.up())).balanceOf(address(this));
        // forge-lint: disable-next-line(calls-loop)
        uint256 d = IERC20(address(m.down())).balanceOf(address(this));
        lo = hi = F.min(u, d);
        // An excess of at most DUST_TOKENS (a donation, or a rounding remainder) is worth under a
        // thousandth of a dollar and needs no mark: it must not make settlement depend on one.
        uint256 diff = u > d ? u - d : d - u;
        if (diff <= DUST_TOKENS) return (lo, hi);
        (uint256 el, uint256 eh) = _excessValue(m, u > d, diff, marks, mode, at);
        return (lo + el, hi + eh);
    }

    /// @dev Value (lower, upper) of `excess` tokens of one side, as of `at`.
    function _excessValue(
        Market m,
        bool upExcess,
        uint256 excess,
        Mark[] memory marks,
        MarkMode mode,
        uint256 at
    ) internal view returns (uint256 el, uint256 eh) {
        // forge-lint: disable-next-line(calls-loop)
        Market.State s = m.state();
        if (s == Market.State.INVALID) {
            uint256 half = excess / 2;
            // forge-lint: disable-next-line(calls-loop)
            el = half - F.mulDivUp(half, m.redeemFeeBps(), BPS);
            eh = F.mulDivUp(excess, 1, 2);
            return (el, eh);
        }
        // forge-lint: disable-next-line(calls-loop)
        uint256 end = m.endTime();
        if (end <= at) {
            // The round was over at `at`.
            if (s == Market.State.RESOLVED_UP || s == Market.State.RESOLVED_DOWN) {
                return _settledExcess(m, s == Market.State.RESOLVED_UP, upExcess, excess);
            }
            // Ended but unresolved: a settlement waits for the resolution (anyone can submit it);
            // the breaker values it from the last verified mark (never at zero).
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (mode == MarkMode.STRICT) revert MarketNotResolved(address(m));
        }
        // A round that had not started at `at` has no strike yet: its sides are worth 1/2 each,
        // whatever happened to it since (a strike struck after `at` is information from after `at`).
        // forge-lint: disable-next-line(calls-loop)
        if (m.startTime() > at) s = Market.State.CREATED;
        (uint256 pLo, uint256 pHi) = _upBand(m, s, marks, mode, end);
        if (upExcess) return (F.mulWad(excess, pLo), F.mulWadUp(excess, pHi));
        return (F.mulWad(excess, WAD - pHi), F.mulWadUp(excess, WAD - pLo));
    }

    /// @dev A winning excess pays 1 minus the redeem fee (rounded against the vault in the lower
    ///      value), a losing excess pays nothing.
    function _settledExcess(Market m, bool upWins, bool upExcess, uint256 excess)
        internal
        view
        returns (uint256 el, uint256 eh)
    {
        if (upWins != upExcess) return (0, 0);
        // forge-lint: disable-next-line(calls-loop)
        uint256 fee = m.redeemFeeBps();
        return (excess - F.mulDivUp(excess, fee, BPS), excess);
    }

    /// @dev Lowest and highest plausible UP value of a market that is still unresolved at the
    ///      valuation time (WAD): the extremes of the fair value over {keeper sigma, sigmaMin,
    ///      sigmaMax}, widened by `markBand`. Without a strike (not opened) both sides are 1/2.
    function _upBand(Market m, Market.State s, Mark[] memory marks, MarkMode mode, uint256 end)
        internal
        view
        returns (uint256 pLo, uint256 pHi)
    {
        uint256 band = markBand;
        uint256 halfLo = WAD / 2 > band ? WAD / 2 - band : 0;
        uint256 halfHi = F.min(WAD, WAD / 2 + band);
        if (s == Market.State.CREATED) return (halfLo, halfHi);
        // forge-lint: disable-next-line(calls-loop)
        bytes32 a = m.assetId();
        (bool ok, uint256 spot, uint256 obs) = _markOf(a, marks, mode);
        if (!ok) return (halfLo, halfHi); // never marked: no information either way
        AssetCfg storage c = assetCfg[a];
        // forge-lint: disable-next-line(calls-loop, unsafe-typecast)
        uint256 strike = uint256(m.strike());
        uint256 tau = end > obs ? end - obs : 1; // a mark at or after the end: the outcome is all but decided
        (pLo, pHi) = (WAD, 0);
        uint256[3] memory sg = [uint256(c.sigma), uint256(c.sigmaMin), uint256(c.sigmaMax)];
        for (uint256 k = 0; k < 3; k++) {
            if (sg[k] == 0) continue;
            uint256 p = QuoteMath.normCdf(QuoteMath.d2(spot, strike, sg[k], tau));
            if (p < pLo) pLo = p;
            if (p > pHi) pHi = p;
        }
        pLo = pLo > band ? pLo - band : 0;
        pHi = F.min(WAD, pHi + band);
    }

    function _markOf(bytes32 a, Mark[] memory marks, MarkMode mode)
        internal
        view
        returns (bool ok, uint256 price, uint256 obs)
    {
        for (uint256 i = 0; i < assetIds.length; i++) {
            if (assetIds[i] != a) continue;
            if (marks[i].known) return (true, marks[i].price, marks[i].obsTs);
            break;
        }
        if (mode == MarkMode.LAST_KNOWN) {
            LastMark memory lm = lastMark[a];
            bool usable = lm.price != 0 && block.timestamp <= uint256(lm.obsTs) + MAX_LAST_MARK_AGE;
            return (usable, lm.price, lm.obsTs);
        }
        // forge-lint: disable-next-line(require-revert-in-loop)
        revert MarkMissing(a);
    }

    /// @notice What `settleEpoch(epochId, ...)` needs: the feeds whose canonical report at the
    ///         epoch's end time is required (a registered round that was still running then holds
    ///         excess of one side), and the registered rounds that had ended but are not resolved
    ///         yet (resolve them first; the settlement reverts otherwise).
    function settlementPlan(uint256 epochId)
        external
        view
        returns (bytes32[] memory feeds, address[] memory unresolved)
    {
        uint256 at = epochEnd(epochId);
        bytes32[] memory tmp = new bytes32[](assetIds.length);
        address[] memory pending = new address[](_markets.length);
        uint256 n = 0;
        uint256 k = 0;
        for (uint256 i = 0; i < _markets.length; i++) {
            Market m = Market(_markets[i]);
            (bool needs, bool awaiting) = _planOf(m, at);
            if (awaiting) pending[k++] = address(m);
            if (!needs) continue;
            // forge-lint: disable-next-line(calls-loop)
            bytes32 f = assetCfg[m.assetId()].feedId;
            bool seen = false;
            for (uint256 j = 0; j < n; j++) {
                // Exact comparison is intended: a zero check on a computed amount, or an enum/identifier match.
                // slither-disable-next-line incorrect-equality
                if (tmp[j] == f) seen = true;
            }
            if (!seen) tmp[n++] = f;
        }
        feeds = new bytes32[](n);
        for (uint256 j = 0; j < n; j++) {
            feeds[j] = tmp[j];
        }
        unresolved = new address[](k);
        for (uint256 j = 0; j < k; j++) {
            unresolved[j] = pending[j];
        }
    }

    /// @dev (needs a mark at `at`, ended but unresolved at `at`) for one registered market.
    // Comparing two token balances for equality is the intent: equal means no excess.
    // slither-disable-start incorrect-equality
    function _planOf(Market m, uint256 at) internal view returns (bool needs, bool awaiting) {
        // Bounded loop caller (MAX_MARKETS); balances are compared for inequality on purpose.
        // forge-lint: disable-start(calls-loop, incorrect-strict-equality)
        uint256 u = IERC20(address(m.up())).balanceOf(address(this));
        uint256 d = IERC20(address(m.down())).balanceOf(address(this));
        uint256 diff = u > d ? u - d : d - u;
        if (diff <= DUST_TOKENS) return (false, false);
        Market.State s = m.state();
        if (s == Market.State.INVALID) return (false, false);
        if (m.endTime() <= at) {
            awaiting = s == Market.State.OPEN || s == Market.State.CREATED;
            return (false, awaiting);
        }
        needs = s != Market.State.CREATED && m.startTime() <= at;
        // forge-lint: disable-end(calls-loop, incorrect-strict-equality)
    }

    // slither-disable-end incorrect-equality

    /// @notice Re-values the vault with fresh reports (last verified marks for assets without
    ///         one), stores the lower NAV used for sizing and runs the daily drawdown breaker.
    ///         Anyone may call. An omitted report can never trip the breaker: the last verified
    ///         mark is used instead of a worst-case value.
    function checkpoint(bytes[] calldata reports) external nonReentrant {
        uint256 supply = totalSupply();
        // Exact comparison is intended: a zero check on a computed amount, or an enum/identifier match.
        // slither-disable-next-line incorrect-equality
        if (supply == 0) return;
        Mark[] memory marks = _collectMarks(reports, 0);
        (uint256 lo, uint256 hi) = _navs(marks, MarkMode.LAST_KNOWN, block.timestamp);
        _recordMarks(marks);
        quoteNavLower = lo;
        lastNavUpper = hi;
        // forge-lint: disable-next-line(unsafe-typecast)
        navUpdatedAt = uint64(block.timestamp);
        uint256 ppsLo = F.mulDiv(lo, WAD, supply);
        _updateBreaker(ppsLo);
        // forge-lint: disable-next-line(reentrancy-events)
        emit NavSnapshot(lo, hi, ppsLo, supply, false);
    }

    // Not randomness: block.timestamp is used to align epochs and UTC days.
    // slither-disable-start weak-prng
    function _updateBreaker(uint256 ppsLo) internal {
        lastPpsLower = ppsLo;
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 today = uint64(block.timestamp - (block.timestamp % 1 days));
        if (dayStart != today) {
            dayStart = today;
            dayStartPps = ppsLo;
        } else if (!quotingPaused && ppsLo < F.mulDiv(dayStartPps, BPS - breakerBps, BPS)) {
            quotingPaused = true;
            // forge-lint: disable-next-line(reentrancy-events)
            emit BreakerTripped(ppsLo, dayStartPps);
            // forge-lint: disable-next-line(reentrancy-events)
            emit QuotingPaused(address(this));
        }
    }

    // slither-disable-end weak-prng

    // ================================================================== keeper actions

    /// @notice Sets the annual volatility used for quoting an asset (WAD). Inside the owner band,
    ///         at most `maxSigmaStepBps` away from a fresh previous value, at most once per
    ///         `sigmaMinInterval`. It cannot move the NAV: marks use the whole owner band.
    function setSigma(bytes32 assetId, uint256 sigma) external onlyKeeper {
        AssetCfg storage c = assetCfg[assetId];
        if (!c.enabled) revert AssetNotEnabled(assetId);
        if (sigma < c.sigmaMin || sigma > c.sigmaMax) {
            revert SigmaOutOfBand(sigma, c.sigmaMin, c.sigmaMax);
        }
        if (c.sigma != 0) {
            if (block.timestamp < uint256(c.sigmaUpdatedAt) + sigmaMinInterval) {
                revert SigmaTooSoon(c.sigmaUpdatedAt + sigmaMinInterval);
            }
            bool fresh = block.timestamp <= uint256(c.sigmaUpdatedAt) + sigmaMaxAge;
            if (fresh) {
                uint256 prev = c.sigma;
                uint256 diff = sigma > prev ? sigma - prev : prev - sigma;
                if (diff * BPS > prev * maxSigmaStepBps) revert SigmaStepTooLarge(sigma, prev);
            }
        }
        c.sigma = _u128(sigma);
        // forge-lint: disable-next-line(unsafe-typecast)
        c.sigmaUpdatedAt = uint64(block.timestamp);
        emit SigmaSet(assetId, sigma);
    }

    /// @notice Turns `amount` of collateral into UP+DOWN pairs in a factory market of an enabled
    ///         asset (registering the market on first use). A pair is always worth 1 (it can be
    ///         merged at any time), so this does not change the NAV.
    function splitForInventory(Market m, uint256 amount) external nonReentrant onlyKeeper {
        if (amount == 0) revert ZeroAmount();
        if (quotingPaused) revert QuotingIsPaused();
        address partner = _checkMarket(m);
        Market.State s = m.state();
        if (s != Market.State.CREATED && s != Market.State.OPEN) revert WrongMarketState(uint8(s));
        if (block.timestamp + _params.noQuoteWindowSec >= m.endTime()) revert InNoQuoteWindow();
        // Collateral owed to depositors (pending) and to claimants (settled) is not the keeper's to
        // lock into pairs: without this bound a split could leave the vault unable to pay a claim
        // until someone merges (found by the 10,000-run invariant campaign, audit F9-18).
        uint256 free = _freeLiquidity();
        if (amount > free) revert InsufficientLiquidity(amount, free);
        if (_slot[address(m)] == 0) _register(m, partner);
        Position storage p = _pos[address(m)];
        uint256 navU = quoteNavLower;
        uint256 pairCap = F.mulWad(maxPairFraction, navU);
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 newBasis = p.basis + int256(amount);
        // forge-lint: disable-next-line(unsafe-typecast)
        if (newBasis > int256(pairCap)) revert PairCapExceeded(uint256(newBasis), pairCap);
        uint256 total = amount;
        uint256 partnerTotal = amount; // this partner's basis
        uint256 allPartners = amount; // every partner's basis
        for (uint256 i = 0; i < _markets.length; i++) {
            int256 b = _pos[_markets[i]].basis;
            if (b <= 0) continue;
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 ub = uint256(b);
            total += ub;
            address owner_ = _partnerOf[_markets[i]];
            if (owner_ != address(0)) {
                allPartners += ub;
                if (partner != address(0) && owner_ == partner) partnerTotal += ub;
            }
        }
        uint256 invCap = F.mulWad(maxInventoryFraction, navU);
        if (total > invCap) revert InventoryCapExceeded(total, invCap);
        if (partner != address(0)) _checkPartnerCaps(m, partner, partnerTotal, allPartners, navU);
        p.basis = newBasis;
        asset.forceApprove(address(m), amount);
        // forge-lint: disable-next-line(reentrancy-no-eth)
        m.split(amount);
        asset.forceApprove(address(m), 0);
        // forge-lint: disable-next-line(reentrancy-events)
        emit InventorySplit(address(m), amount);
    }

    /// @notice Merges `amount` complete pairs back into collateral. Works while paused and after
    ///         resolution.
    // All entry points are nonReentrant; the external calls go to the factory's own Market clones, the immutable asset or the immutable verifier proxy.
    // slither-disable-next-line reentrancy-no-eth
    function mergeInventory(Market m, uint256 amount) external nonReentrant {
        // Merging is value-neutral. The keeper, the owner and the guardian may always do it, and
        // anyone may while quoting is paused, so a dead or hostile keeper can never keep
        // liquidity locked in pairs while LPs wait to exit.
        if (
            msg.sender != keeper && msg.sender != owner() && msg.sender != guardian
                && !quotingPaused
        ) revert OnlyKeeper();
        if (amount == 0) revert ZeroAmount();
        if (_slot[address(m)] == 0) revert MarketNotRegistered(address(m));
        _merge(m, amount);
        _pruneIfEmpty(m);
    }

    function _merge(Market m, uint256 amount) internal {
        uint256 have = F.min(
            IERC20(address(m.up())).balanceOf(address(this)),
            IERC20(address(m.down())).balanceOf(address(this))
        );
        if (amount > have) revert NotEnoughPairs(have, amount);
        // forge-lint: disable-next-line(unsafe-typecast)
        _pos[address(m)].basis -= int256(amount);
        // forge-lint: disable-next-line(reentrancy-no-eth)
        m.merge(amount);
        // forge-lint: disable-next-line(reentrancy-events)
        emit InventoryMerged(address(m), amount);
    }

    /// @notice Pulls a resolved (or invalid) registered market's value back into the vault: merges
    ///         complete pairs (no fee), redeems the rest. Anyone may call.
    // The stale value only selects the revert branch; the Market is a trusted factory clone and this function is nonReentrant.
    // slither-disable-next-line reentrancy-balance,reentrancy-no-eth
    function redeemResolved(Market m) external nonReentrant {
        if (_slot[address(m)] == 0) revert MarketNotRegistered(address(m));
        // A market that ended after the epoch end is valued from the mark in the epoch's settlement;
        // realising it first would let a requester pick the better of mark and outcome.
        if (_settlementPending()) revert SettlementPending();
        Market.State s = m.state();
        if (s == Market.State.CREATED || s == Market.State.OPEN) revert MarketUnresolved();
        IERC20 up = IERC20(address(m.up()));
        IERC20 down = IERC20(address(m.down()));
        uint256 pairs = F.min(up.balanceOf(address(this)), down.balanceOf(address(this)));
        if (pairs != 0) _merge(m, pairs);
        uint256 payout = 0;
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (up.balanceOf(address(this)) != 0 || down.balanceOf(address(this)) != 0) {
            uint256 before = asset.balanceOf(address(this));
            // forge-lint: disable-next-line(reentrancy-no-eth)
            m.redeem();
            payout = asset.balanceOf(address(this)) - before;
            // Exact comparison is intended: a zero check on a computed amount, or an enum/identifier match.
            // slither-disable-next-line incorrect-equality
        }
        // forge-lint: disable-next-line(reentrancy-events)
        emit ResolvedRedeemed(address(m), pairs, payout);
        _unregister(m);
    }

    // ================================================================== registry

    /// @dev A market is acceptable if the core factory made it, or (once a registry is set) if the
    ///      PartnerRegistry made it. Returns the partner (zero for a core market). The market's real
    ///      `assetId` is used for both, so a partner market is priced, marked and settled exactly like
    ///      a core one.
    function _checkMarket(Market m) internal view returns (address partner) {
        bytes32 a = m.assetId();
        if (!assetCfg[a].enabled) revert AssetNotEnabled(a);
        uint64 s = m.startTime();
        uint64 e = m.endTime();
        if (factory.getMarket(a, e - s, s) == address(m)) return address(0);
        if (address(partnerRegistry) == address(0)) revert NotFactoryMarket(address(m));
        IPartnerRegistry.Limits memory l = partnerRegistry.limits(address(m));
        if (!l.exists) revert NotFactoryMarket(address(m));
        partner = l.partner;
    }

    /// @dev Caps on new allocation to a partner market. The registry says what the owner allows
    ///      (per partner, all partners); the vault adds its own fraction of NAV on top.
    function _checkPartnerCaps(
        Market m,
        address partner,
        uint256 partnerTotal,
        uint256 allPartners,
        uint256 navU
    ) internal view {
        IPartnerRegistry.Limits memory l = partnerRegistry.limits(address(m));
        if (!l.active) revert PartnerInactive(address(m));
        if (partnerTotal > l.partnerCap) {
            revert PartnerCapExceeded(partner, partnerTotal, l.partnerCap);
        }
        uint256 g = F.min(l.globalCap, F.mulWad(maxPartnerFraction, navU));
        if (allPartners > g) revert PartnerGlobalCapExceeded(allPartners, g);
    }

    /// @dev Whether a registered partner market may be quoted right now.
    function _partnerActive(address m) internal view returns (bool) {
        return partnerRegistry.limits(m).active;
    }

    function _register(Market m, address partner) internal {
        if (_markets.length >= MAX_MARKETS) revert TooManyMarkets();
        if (partner != address(0)) {
            if (_partnerMarkets >= MAX_PARTNER_MARKETS) revert TooManyPartnerMarkets();
            if (_partnerCount[partner] >= MAX_MARKETS_PER_PARTNER) {
                revert TooManyMarketsForPartner(partner);
            }
            _partnerMarkets += 1;
            _partnerCount[partner] += 1;
            _partnerOf[address(m)] = partner;
            emit PartnerMarketRegistered(address(m), partner);
        }
        _markets.push(address(m));
        _slot[address(m)] = _markets.length;
        emit MarketRegistered(address(m), m.assetId());
    }

    function _unregister(Market m) internal {
        uint256 slot = _slot[address(m)];
        if (slot == 0) return;
        uint256 last = _markets.length;
        if (slot != last) {
            address moved = _markets[last - 1];
            _markets[slot - 1] = moved;
            _slot[moved] = slot;
        }
        _markets.pop();
        delete _slot[address(m)];
        if (_partnerOf[address(m)] != address(0)) {
            _partnerMarkets -= 1;
            _partnerCount[_partnerOf[address(m)]] -= 1;
            delete _partnerOf[address(m)];
        }
        // The position (basis and cash) is kept on purpose: a market that is flattened and split
        // again carries the loss it already realised, so room can not be restored by cycling.
        // forge-lint: disable-next-line(reentrancy-events)
        emit MarketUnregistered(address(m));
    }

    // Exact zero check on both balances is the intent.
    // slither-disable-start incorrect-equality
    /// @notice Drops a registered market that holds no tokens from the registry (it frees a slot;
    ///         its realised loss stays on record). Anyone may call.
    function pruneEmpty(Market m) external nonReentrant {
        if (_slot[address(m)] == 0) revert MarketNotRegistered(address(m));
        uint256 u = IERC20(address(m.up())).balanceOf(address(this));
        uint256 d = IERC20(address(m.down())).balanceOf(address(this));
        if (u + d > DUST_TOKENS) revert NotEmpty();
        _pruneDust(m, u, d);
    }

    function _pruneIfEmpty(Market m) internal {
        uint256 u = IERC20(address(m.up())).balanceOf(address(this));
        uint256 d = IERC20(address(m.down())).balanceOf(address(this));
        if (u + d <= DUST_TOKENS) _pruneDust(m, u, d);
    }

    /// @dev Unregisters a market that holds at most DUST_TOKENS units. Complete pairs among them
    ///      are merged first, so the value-neutral round trip split -> merge loses nothing; only an
    ///      unmatched remainder (a donation) stays behind, worth at most DUST_TOKENS and outside
    ///      the NAV.
    function _pruneDust(Market m, uint256 u, uint256 d) internal {
        uint256 pairs = F.min(u, d);
        if (pairs != 0) _merge(m, pairs);
        _unregister(m);
    }
    // slither-disable-end incorrect-equality

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function marketAt(uint256 i) external view returns (address) {
        return _markets[i];
    }

    /// @notice The partner behind a registered partner market (zero for a core market).
    function partnerOf(address m) external view returns (address) {
        return _partnerOf[m];
    }

    /// @notice Registered partner markets (of MAX_PARTNER_MARKETS).
    function partnerMarketCount() external view returns (uint256) {
        return _partnerMarkets;
    }

    function isRegistered(address m) external view returns (bool) {
        return _slot[m] != 0;
    }

    function positionOf(address m) external view returns (int256 basis, int256 cash) {
        Position storage p = _pos[m];
        return (p.basis, p.cash);
    }

    // ================================================================== venue interface

    /// @notice 10^(18 - assetDecimals): converts asset units to WAD.
    function unitScale() external view returns (uint256) {
        return SCALE;
    }

    function quoteParams() external view returns (QuoteMath.Params memory) {
        return _params;
    }

    /// @dev Position of a registered market in WAD, with live token balances.
    function _posWad(address m) internal view returns (QuoteMath.Pos memory p) {
        Position storage q = _pos[m];
        Market mk = Market(m);
        // forge-lint: disable-next-line(unsafe-typecast)
        p.basis = q.basis * int256(SCALE);
        // forge-lint: disable-next-line(unsafe-typecast)
        p.cash = q.cash * int256(SCALE);
        // forge-lint: disable-next-line(calls-loop)
        p.up = IERC20(address(mk.up())).balanceOf(address(this)) * SCALE;
        // forge-lint: disable-next-line(calls-loop)
        p.down = IERC20(address(mk.down())).balanceOf(address(this)) * SCALE;
    }

    /// @notice Everything the venue needs to price one market.
    function venueView(Market m) external view returns (VenueView memory v) {
        if (_slot[address(m)] == 0 || quotingPaused || keeperHalt || venue == address(0)) return v;
        if (block.timestamp > uint256(navUpdatedAt) + navMaxAge) return v;
        if (_settlementPending()) return v;
        if (_partnerOf[address(m)] != address(0) && !_partnerActive(address(m))) return v;
        AssetCfg storage c = assetCfg[m.assetId()];
        if (c.sigma == 0 || block.timestamp > uint256(c.sigmaUpdatedAt) + sigmaMaxAge) return v;
        v.tradable = true;
        v.navWad = quoteNavLower * SCALE;
        v.sigma = c.sigma;
        v.pos = _posWad(address(m));
    }

    /// @dev True while the epoch that just ended has requests and can still be settled. The
    ///      settlement values the inventory as it is when the epoch is settled, at the prices of
    ///      the epoch end, so no fill may change it inside that window (a fill after the epoch
    ///      end would be a trade at a later price valued at the earlier one).
    function _settlementPending() internal view returns (bool) {
        uint256 cur = currentEpoch();
        // Exact comparison is intended: epoch 0 has no predecessor.
        // slither-disable-next-line incorrect-equality
        if (cur == 0) return false;
        Epoch storage e = epochs[cur - 1];
        // Exact comparison is intended: a zero check on a computed amount, or an enum/identifier match.
        // slither-disable-next-line incorrect-equality
        if (e.settled || (e.depositAssets == 0 && e.redeemShares == 0)) return false;
        return block.timestamp <= epochEnd(cur - 1) + settleWindow;
    }

    /// @dev Loss ceiling of market `m` given the other markets' current losses.
    function _ceiling(address m, QuoteMath.Pos memory p) internal view returns (uint256) {
        uint256 other = 0;
        for (uint256 i = 0; i < _markets.length; i++) {
            if (_markets[i] == m) continue;
            other += QuoteMath.loss(_posWad(_markets[i]));
        }
        return QuoteMath.lossCeiling(p, quoteNavLower * SCALE, other, _params);
    }

    /// @notice Largest fill (asset-unit tokens) the vault will accept in `m` at `priceWad`, in the
    ///         given direction: the loss-ceiling room, capped by the vault's own balance (sells)
    ///         or free collateral (buys).
    function fillRoom(Market m, bool upToken, bool vaultSells, uint256 priceWad)
        public
        view
        returns (uint256 units)
    {
        if (_slot[address(m)] == 0) return 0;
        QuoteMath.Pos memory p = _posWad(address(m));
        return _roomAt(upToken, vaultSells, priceWad, p, _ceiling(address(m), p));
    }

    function _roomAt(
        bool upToken,
        bool vaultSells,
        uint256 priceWad,
        QuoteMath.Pos memory p,
        uint256 ceiling
    ) internal view returns (uint256 units) {
        uint256 own = upToken ? p.up : p.down;
        uint256 other = upToken ? p.down : p.up;
        uint256 room = vaultSells
            ? QuoteMath.sellRoom(p.basis, p.cash, own, other, priceWad, ceiling)
            : QuoteMath.buyRoom(p.basis, p.cash, own, other, priceWad, ceiling);
        units = room / SCALE;
        if (!vaultSells) {
            uint256 maxByCash = priceWad == 0 ? 0 : F.mulDiv(_freeLiquidity(), WAD, priceWad);
            units = F.min(units, maxByCash);
        }
    }

    /// @notice One fill requested by the venue.
    /// @dev `vaultSells`: the taker buys `units` tokens and pays `premium` (pulled from the venue);
    ///      otherwise the taker sells `units` tokens (pulled from the venue) and is paid `premium`
    ///      from the vault. `refPrice`/`refObs` are the verified report the venue priced from; they
    ///      only refresh the last known mark used by the breaker (settlement never reads them).
    struct FillParams {
        Market market;
        bool upToken;
        bool vaultSells;
        uint256 units;
        uint256 premium;
        address taker;
        uint192 refPrice;
        uint64 refObs;
    }

    /// @notice Executes one fill on behalf of the venue. All risk checks are repeated here.
    function venueFill(FillParams calldata f) external nonReentrant onlyVenue {
        if (f.units == 0) revert ZeroAmount();
        if (f.taker == address(0) || f.taker == address(this)) revert ZeroAddress();
        if (_slot[address(f.market)] == 0) revert MarketNotRegistered(address(f.market));
        if (quotingPaused) revert QuotingIsPaused();
        if (keeperHalt) revert QuotingHalt();
        if (block.timestamp > uint256(navUpdatedAt) + navMaxAge) revert NotTradable();
        if (_settlementPending()) revert SettlementPending();
        if (_partnerOf[address(f.market)] != address(0) && !_partnerActive(address(f.market))) {
            revert PartnerInactive(address(f.market));
        }

        // Price bounds on amounts (premium and units share a scale), with rounding that lets the
        // venue's own rounding at the bound pass: floor at the minimum, ceiling at the maximum.
        if (
            f.premium < F.mulDiv(f.units, _params.priceMin, WAD)
                || f.premium > F.mulDivUp(f.units, _params.priceMax, WAD)
        ) revert PriceOutOfBounds(F.mulDiv(f.premium, WAD, f.units));
        // Conservative implied price for the room: lower when the vault sells, higher when it buys.
        uint256 price =
            f.vaultSells ? F.mulDiv(f.premium, WAD, f.units) : F.mulDivUp(f.premium, WAD, f.units);
        // The ceiling is struck on the position BEFORE the trade and the exact loss after it must
        // respect it: an independent check of the closed-form room.
        QuoteMath.Pos memory pre = _posWad(address(f.market));
        uint256 ceilingPre = _ceiling(address(f.market), pre);
        uint256 room = _roomAt(f.upToken, f.vaultSells, price, pre, ceilingPre);
        if (f.units > room) revert RiskLimitExceeded(f.units, room);

        _moveFill(f);

        bytes32 a = f.market.assetId();
        if (f.refObs > lastMark[a].obsTs && f.refObs <= block.timestamp) {
            lastMark[a] = LastMark(f.refPrice, f.refObs);
        }
        uint256 l = QuoteMath.loss(_posWad(address(f.market)));
        if (l > ceilingPre) revert LossAboveCeiling(l, ceilingPre);
        Position storage pos = _pos[address(f.market)];
        // forge-lint: disable-start(reentrancy-events)
        emit Fill(
            address(f.market),
            f.upToken,
            f.vaultSells,
            f.units,
            f.premium,
            f.taker,
            pos.basis,
            pos.cash
        );
        // forge-lint: disable-end(reentrancy-events)
        if (block.timestamp >= uint256(navUpdatedAt) + AUTO_CHECKPOINT_INTERVAL) {
            _autoCheckpoint(a, f.refPrice, f.refObs);
        }
    }

    /// @dev The breaker must not depend on someone calling `checkpoint`: while trading goes on the
    ///      vault re-values itself at most once a minute, using the verified report the venue just
    ///      priced from (other assets at their last verified mark). It can only LOWER the NAV used
    ///      for sizing and it can trip the breaker; it never raises either.
    function _autoCheckpoint(bytes32 a, uint192 price, uint64 obs) internal {
        uint256 supply = totalSupply();
        // Exact comparison is intended: a zero check on a computed amount, or an enum/identifier match.
        // slither-disable-next-line incorrect-equality
        if (supply == 0 || obs > block.timestamp || block.timestamp - obs > AUTO_MARK_MAX_AGE) {
            return;
        }
        Mark[] memory marks = new Mark[](assetIds.length);
        for (uint256 i = 0; i < marks.length; i++) {
            if (assetIds[i] == a) marks[i] = Mark(true, price, obs);
        }
        (uint256 lo, uint256 hi) = _navs(marks, MarkMode.LAST_KNOWN, block.timestamp);
        if (lo < quoteNavLower) quoteNavLower = lo;
        // forge-lint: disable-next-line(unsafe-typecast)
        navUpdatedAt = uint64(block.timestamp);
        uint256 ppsLo = F.mulDiv(lo, WAD, supply);
        _updateBreaker(ppsLo);
        // forge-lint: disable-next-line(reentrancy-events)
        emit NavSnapshot(lo, hi, ppsLo, supply, false);
    }

    function _moveFill(FillParams calldata f) internal {
        Position storage pos = _pos[address(f.market)];
        IERC20 tok = f.upToken ? IERC20(address(f.market.up())) : IERC20(address(f.market.down()));
        if (f.vaultSells) {
            uint256 before = asset.balanceOf(address(this));
            asset.safeTransferFrom(msg.sender, address(this), f.premium);
            // forge-lint: disable-next-line(incorrect-strict-equality)
            if (asset.balanceOf(address(this)) - before != f.premium) {
                revert FeeOnTransferNotSupported();
            }
            // forge-lint: disable-next-line(unsafe-typecast)
            pos.cash += int256(f.premium);
            tok.safeTransfer(f.taker, f.units);
        } else {
            uint256 free = _freeLiquidity();
            if (f.premium > free) revert InsufficientLiquidity(f.premium, free);
            uint256 before = tok.balanceOf(address(this));
            tok.safeTransferFrom(msg.sender, address(this), f.units);
            // forge-lint: disable-next-line(incorrect-strict-equality)
            if (tok.balanceOf(address(this)) - before != f.units) {
                revert FeeOnTransferNotSupported();
            }
            // forge-lint: disable-next-line(unsafe-typecast)
            pos.cash -= int256(f.premium);
            asset.safeTransfer(f.taker, f.premium);
        }
    }

    // ================================================================== guardian / owner

    /// @notice Stops all new trading and splitting. Requests, settlement, claims, merges and
    ///         redemptions of resolved markets keep working.
    function pauseQuoting() external {
        if (msg.sender != guardian && msg.sender != owner()) revert OnlyGuardianOrOwner();
        quotingPaused = true;
        emit QuotingPaused(msg.sender);
    }

    /// @notice The keeper pulls every quote: no fill happens until it calls `unhaltQuoting`.
    ///         Requests, settlement, claims, merges and redemption are untouched. `reason` is a
    ///         short code for the indexer and the alerts.
    function haltQuoting(bytes32 reason) external onlyKeeper {
        keeperHalt = true;
        emit QuotingHalted(msg.sender, reason);
    }

    /// @notice The keeper puts its quotes back. It does not touch `quotingPaused`.
    function unhaltQuoting() external onlyKeeper {
        keeperHalt = false;
        emit QuotingUnhalted(msg.sender);
    }

    /// @notice Resumes trading. The breaker keeps the UTC day's baseline: if the drawdown limit is
    ///         still breached the next evaluation pauses again, so a tripped day resumes for real
    ///         only at the next UTC day (or after the owner raises the limit).
    function resumeQuoting() external onlyOwner {
        quotingPaused = false;
        emit QuotingResumed(msg.sender);
    }

    function setTvlCap(uint256 cap) external onlyOwner {
        tvlCap = cap;
        emit TvlCapSet(cap);
    }

    /// @notice Connects the PartnerRegistry. Once: the registry decides which extra markets the
    ///         vault may quote, so it cannot be swapped under LPs (a new registry is a new vault).
    function setPartnerRegistry(IPartnerRegistry registry) external onlyOwner {
        if (address(partnerRegistry) != address(0)) revert PartnerRegistryAlreadySet();
        if (address(registry) == address(0)) revert ZeroAddress();
        partnerRegistry = registry;
        emit PartnerRegistrySet(address(registry));
    }

    /// @notice Largest basis in all partner markets together, as a fraction of the lower NAV.
    function setPartnerFraction(uint256 fraction) external onlyOwner {
        if (fraction > MAX_PARTNER_FRACTION) revert InvalidConfig();
        // forge-lint: disable-next-line(unsafe-typecast)
        maxPartnerFraction = uint64(fraction);
        emit PartnerFractionSet(fraction);
    }

    function setPerformanceFee(uint256 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh(bps);
        // forge-lint: disable-next-line(unsafe-typecast)
        performanceFeeBps = uint16(bps);
        emit FeeSet(bps);
    }

    /// @notice Rotates the keeper key. The old key's volatility values are discarded and quoting is
    ///         halted until the new key sets fresh values and unhalts, so a compromised key cannot
    ///         leave a hostile sigma behind (and does not constrain the new key's first step).
    function setKeeper(address k) external onlyOwner {
        if (k == address(0)) revert ZeroAddress();
        keeper = k;
        for (uint256 i = 0; i < assetIds.length; i++) {
            assetCfg[assetIds[i]].sigma = 0;
        }
        keeperHalt = true;
        emit KeeperSet(k);
        emit QuotingHalted(k, "KEEPER_ROTATED");
    }

    function setGuardian(address g) external onlyOwner {
        if (g == address(0)) revert ZeroAddress();
        guardian = g;
        emit GuardianSet(g);
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
        emit TreasurySet(t);
    }

    /// @notice Whitelists an asset: it must be a Data Streams asset of the factory. The sigma band
    ///         bounds both the keeper's volatility and the NAV marks.
    function enableAsset(bytes32 assetId, uint256 sigmaMin, uint256 sigmaMax) external onlyOwner {
        AssetCfg storage c = assetCfg[assetId];
        if (c.enabled) revert AssetAlreadyEnabled(assetId);
        if (assetIds.length >= MAX_ASSETS) revert TooManyAssets();
        MarketFactory.Asset memory fa = factory.asset(assetId);
        bytes32 feed = streams.feedIdOf(assetId);
        if (!fa.enabled || address(fa.resolver) != address(streams) || feed == bytes32(0)) {
            revert UnsupportedAsset(assetId);
        }
        if (assetOfFeed[feed] != bytes32(0)) revert FeedAlreadyUsed(feed);
        _checkBand(sigmaMin, sigmaMax);
        c.enabled = true;
        c.feedId = feed;
        assetOfFeed[feed] = assetId;
        c.sigmaMin = _u128(sigmaMin);
        c.sigmaMax = _u128(sigmaMax);
        assetIds.push(assetId);
        emit AssetEnabled(assetId, feed, sigmaMin, sigmaMax);
    }

    function setSigmaBand(bytes32 assetId, uint256 sigmaMin, uint256 sigmaMax) external onlyOwner {
        AssetCfg storage c = assetCfg[assetId];
        if (!c.enabled) revert AssetNotEnabled(assetId);
        _checkBand(sigmaMin, sigmaMax);
        c.sigmaMin = _u128(sigmaMin);
        c.sigmaMax = _u128(sigmaMax);
        if (c.sigma != 0 && (c.sigma < sigmaMin || c.sigma > sigmaMax)) c.sigma = 0; // forces a fresh in-band value
        emit SigmaBandSet(assetId, sigmaMin, sigmaMax);
    }

    function _checkBand(uint256 lo, uint256 hi) internal pure {
        // 1% to 1000% annual volatility, lo <= hi.
        if (lo < 0.01e18 || hi > 10e18 || lo > hi) revert InvalidConfig();
    }

    function setQuoteParams(QuoteMath.Params calldata p) external onlyOwner {
        _validateParams(p);
        _params = p;
        emit ParamsSet(p);
    }

    /// @dev Hard limits the owner cannot exceed (CLAUDE.md defaults: per-market 5%, total 40%).
    function _validateParams(QuoteMath.Params memory p) internal pure {
        if (
            p.tick == 0 || p.tick > 0.05e18 || p.levels == 0 || p.levels > QuoteMath.MAX_LEVELS
                || p.minHalfSpread < 0.02e18 || p.minHalfSpread > p.maxHalfSpread
                || p.maxHalfSpread > 0.5e18 || p.priceMin < 0.01e18 || p.priceMax > 0.99e18
                || p.priceMin >= p.priceMax || p.priceMin + p.priceMax != WAD
                || p.minRangeTicks == 0 || p.minRangeTicks > p.baseRangeTicks
                || p.liquidityNavFraction > 0.5e18 || p.perMarketMaxFraction == 0
                || p.perMarketMaxFraction > 0.05e18 || p.totalAtRiskMaxFraction > 0.4e18
                || p.totalAtRiskMaxFraction < p.perMarketMaxFraction || p.inventorySkewMax > 0.5e18
                || p.noQuoteWindowSec < 10
        ) revert InvalidConfig();
    }

    function setRiskConfig(
        uint256 maxMarkAge_,
        uint256 markBand_,
        uint256 settleWindow_,
        uint256 breakerBps_,
        uint256 maxPairFraction_,
        uint256 maxInventoryFraction_
    ) external onlyOwner {
        if (
            maxMarkAge_ == 0 || maxMarkAge_ > 60 || markBand_ > 0.3e18 || settleWindow_ < 60
                || settleWindow_ >= Series.FIFTEEN_MINUTES || breakerBps_ == 0
                || breakerBps_ > 2_500 || maxPairFraction_ > WAD || maxInventoryFraction_ > WAD
        ) revert InvalidConfig();
        // forge-lint: disable-next-line(unsafe-typecast)
        maxMarkAge = uint32(maxMarkAge_);
        // forge-lint: disable-next-line(unsafe-typecast)
        markBand = uint64(markBand_);
        // forge-lint: disable-next-line(unsafe-typecast)
        settleWindow = uint32(settleWindow_);
        // forge-lint: disable-next-line(unsafe-typecast)
        breakerBps = uint16(breakerBps_);
        // forge-lint: disable-next-line(unsafe-typecast)
        maxPairFraction = uint64(maxPairFraction_);
        // forge-lint: disable-next-line(unsafe-typecast)
        maxInventoryFraction = uint64(maxInventoryFraction_);
        emit RiskConfigSet(
            maxMarkAge_,
            markBand_,
            settleWindow_,
            breakerBps_,
            maxPairFraction_,
            maxInventoryFraction_
        );
    }

    function setSigmaConfig(
        uint256 maxStepBps,
        uint256 minInterval,
        uint256 maxAge,
        uint256 navMaxAge_
    ) external onlyOwner {
        if (
            maxStepBps == 0 || maxStepBps > BPS || minInterval == 0 || maxAge < minInterval
                || navMaxAge_ < 60 || maxAge > 1 hours || navMaxAge_ > 2 hours
        ) revert InvalidConfig();
        // forge-lint: disable-next-line(unsafe-typecast)
        maxSigmaStepBps = uint16(maxStepBps);
        // forge-lint: disable-next-line(unsafe-typecast)
        sigmaMinInterval = uint32(minInterval);
        // forge-lint: disable-next-line(unsafe-typecast)
        sigmaMaxAge = uint32(maxAge);
        // forge-lint: disable-next-line(unsafe-typecast)
        navMaxAge = uint32(navMaxAge_);
        emit SigmaConfigSet(maxStepBps, minInterval, maxAge, navMaxAge_);
    }

    /// @notice First venue: no delay while none is set. Replacements go through the timelock.
    function setInitialVenue(address v) external onlyOwner {
        if (venue != address(0)) revert VenueAlreadySet();
        if (v == address(0)) revert ZeroAddress();
        venue = v;
        emit VenueSet(v);
    }

    function proposeVenue(address v) external onlyOwner {
        if (v == address(0)) revert ZeroAddress();
        pendingVenue = v;
        // forge-lint: disable-next-line(unsafe-typecast)
        pendingVenueEta = uint64(block.timestamp + VENUE_DELAY);
        emit VenueProposed(v, pendingVenueEta);
    }

    function acceptVenue() external onlyOwner {
        address v = pendingVenue;
        if (v == address(0)) revert VenueNotProposed();
        if (block.timestamp < pendingVenueEta) revert VenueTimelock(pendingVenueEta);
        venue = v;
        delete pendingVenue;
        delete pendingVenueEta;
        emit VenueSet(v);
    }

    function cancelVenue() external onlyOwner {
        emit VenueCancelled(pendingVenue);
        delete pendingVenue;
        delete pendingVenueEta;
    }

    /// @dev One-step renouncing would strand a paused vault with no way to resume or to rotate
    ///      the keeper.
    function renounceOwnership() public view override onlyOwner {
        revert InvalidConfig();
    }

    // ================================================================== helpers

    function _u128(uint256 x) internal pure returns (uint128) {
        // Asset amounts here are far below 2^128; a larger value is a bug or an attack.
        if (x > type(uint128).max) revert InvalidConfig();
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(x);
    }

    /// @notice Lower price per share at the last settlement or checkpoint (WAD; 1e18 = 1.0).
    function pricePerShareLower() external view returns (uint256) {
        return lastPpsLower;
    }
}
