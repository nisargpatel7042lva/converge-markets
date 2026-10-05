// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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
        STRICT, // a missing mark that is needed reverts (settlement)
        LAST_KNOWN, // a missing mark falls back to the last verified one (breaker)
        BOUNDS // a missing mark means excess tokens are worth 0 (lower) or 1 (upper)
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
    uint256 public constant MAX_FEE_BPS = 2_000; // 20%
    uint256 public constant VENUE_DELAY = 2 days;
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
    /// @notice Seconds after an epoch ends before it may settle without a mark for every market
    ///         with unresolved exposure (a feed outage must not freeze exits).
    uint32 public markGrace = 10 minutes;
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
    event MarketUnregistered(address indexed market);
    event ResolvedRedeemed(address indexed market, uint256 pairsMerged, uint256 payout);
    event QuotingPaused(address indexed by);
    event BreakerTripped(uint256 ppsLower, uint256 dayStartPps);
    event QuotingResumed(address indexed by);
    event AssetEnabled(bytes32 indexed assetId, bytes32 feedId, uint256 sigmaMin, uint256 sigmaMax);
    event SigmaBandSet(bytes32 indexed assetId, uint256 sigmaMin, uint256 sigmaMax);
    event TvlCapSet(uint256 cap);
    event FeeSet(uint256 bps);
    event KeeperSet(address indexed keeper);
    event GuardianSet(address indexed guardian);
    event TreasurySet(address indexed treasury);
    event VenueProposed(address indexed venue, uint64 eta);
    event VenueSet(address indexed venue);
    event ParamsSet(QuoteMath.Params params);
    event RiskConfigSet(
        uint256 maxMarkAge,
        uint256 markBand,
        uint256 markGrace,
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
    error NotFactoryMarket(address market);
    error MarketNotRegistered(address market);
    error TooManyMarkets();
    error WrongMarketState(uint8 state);
    error InNoQuoteWindow();
    error QuotingIsPaused();
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
    error InsufficientLiquidity(uint256 need, uint256 free);
    error NothingToRedeem();
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
        if (epochLength_ < 60 || minRequest_ <= DEAD_SHARES) revert InvalidConfig();
        if (address(factory_.collateral()) != address(asset_)) revert InvalidConfig();
        uint8 d = IERC20Metadata(address(asset_)).decimals();
        if (d > 18) revert InvalidConfig();
        asset = asset_;
        factory = factory_;
        streams = streams_;
        verifier = streams_.verifier();
        epochLength = epochLength_;
        // uint64 holds timestamps for hundreds of billions of years.
        // forge-lint: disable-next-line(unsafe-typecast)
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

    /// @notice Settles an ended epoch at one lower and one upper NAV. Anyone may call.
    /// @param reports Data Streams reports (one per asset whose markets carry unresolved
    ///        exposure; see `marksNeeded`), each no older than `maxMarkAge`. After `markGrace`
    ///        a missing mark is valued at the bounds (0 / 1) instead of reverting.
    function settleEpoch(uint256 epochId, bytes[] calldata reports) external nonReentrant {
        if (epochId >= currentEpoch()) revert EpochNotEnded(epochId);
        Epoch storage e = epochs[epochId];
        if (e.settled) revert AlreadySettled(epochId);
        if (e.depositAssets == 0 && e.redeemShares == 0) revert NothingToSettle(epochId);

        Settlement memory z;
        {
            Mark[] memory marks = _collectMarks(reports);
            MarkMode mode = block.timestamp >= epochEnd(epochId) + markGrace
                ? MarkMode.BOUNDS
                : MarkMode.STRICT;
            (z.lo, z.hi) = _navs(marks, mode);
            _recordMarks(marks);
        }
        uint256 supplyBefore = totalSupply();
        z.supply0 = supplyBefore;
        if (supplyBefore != 0 && z.lo != 0) z.supply0 += _performanceFee(z.lo, supplyBefore);
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
        emit EpochSettled(
            epochId, z.lo, z.hi, supplyBefore, z.minted, z.burned, z.paid, z.accepted, z.rejected
        );
        emit NavSnapshot(z.lo, z.hi, ppsLo, totalSupply(), true);
    }

    /// @dev Deposits mint at the upper NAV (rounded down). The first deposit mints 1 share per
    ///      asset unit and locks DEAD_SHARES forever. A deposit that cannot be priced (empty NAV,
    ///      or a dust deposit) is refunded through `claimDeposit`.
    function _settleDeposits(Epoch storage e, Settlement memory z) internal {
        uint256 d = e.depositAssets;
        pendingDeposits -= d;
        if (d == 0) return;
        if (z.supply0 == 0) {
            // minRequest > DEAD_SHARES (constructor), so the first deposit always covers them.
            _mint(DEAD, DEAD_SHARES);
            z.minted = d - DEAD_SHARES;
            _mint(address(this), z.minted);
        } else if (z.hi == 0) {
            z.rejected = true;
        } else {
            z.minted = F.mulDiv(d, z.supply0, z.hi);
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
            emit RedeemRequested(cur, msg.sender, rest, true);
        }
        if (out != 0) asset.safeTransfer(receiver, out);
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
        if (feeAssets == 0 || feeAssets >= lo) return 0;
        feeShares = F.mulDiv(feeAssets, supply, lo - feeAssets);
        if (feeShares == 0) return 0;
        _mint(treasury, feeShares);
        hwmPps = F.mulDiv(lo, WAD, supply + feeShares);
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
    function _collectMarks(bytes[] calldata reports) internal returns (Mark[] memory marks) {
        marks = new Mark[](assetIds.length);
        bytes memory param = streams.parameterPayload();
        for (uint256 i = 0; i < reports.length; i++) {
            bytes32 feed = ReportLib.feedOf(reports[i]);
            uint256 idx = type(uint256).max;
            for (uint256 j = 0; j < assetIds.length; j++) {
                if (assetCfg[assetIds[j]].feedId == feed) {
                    idx = j;
                    break;
                }
            }
            if (idx == type(uint256).max) revert UnknownReportFeed(feed);
            if (marks[idx].known) revert DuplicateReport(assetIds[idx]);
            ReportV3 memory r = ReportLib.verify(verifier, param, reports[i], feed);
            if (
                r.observationsTimestamp > block.timestamp
                    || block.timestamp - r.observationsTimestamp > maxMarkAge
            ) {
                revert StaleReport(r.observationsTimestamp, block.timestamp);
            }
            // price > 0 is checked by the library, so the cast cannot truncate a negative.
            // forge-lint: disable-next-line(unsafe-typecast)
            marks[idx] = Mark(true, uint192(r.price), r.observationsTimestamp);
        }
    }

    function _recordMarks(Mark[] memory marks) internal {
        for (uint256 i = 0; i < marks.length; i++) {
            if (marks[i].known) lastMark[assetIds[i]] = LastMark(marks[i].price, marks[i].obsTs);
        }
    }

    /// @notice Lower and upper NAV (asset units) under the given marks.
    /// @dev lower = free collateral + pairs + excess tokens at the lowest plausible value;
    ///      upper = the same at the highest. Matched UP+DOWN pairs are worth exactly 1 (merge never
    ///      fails). Resolved markets are valued exactly (net of the redeem fee).
    function _navs(Mark[] memory marks, MarkMode mode)
        internal
        view
        returns (uint256 lo, uint256 hi)
    {
        lo = hi = _freeLiquidity();
        uint256 n = _markets.length;
        for (uint256 i = 0; i < n; i++) {
            (uint256 l, uint256 h) = _marketValue(Market(_markets[i]), marks, mode);
            lo += l;
            hi += h;
        }
    }

    function _marketValue(Market m, Mark[] memory marks, MarkMode mode)
        internal
        view
        returns (uint256 lo, uint256 hi)
    {
        uint256 u = IERC20(address(m.up())).balanceOf(address(this));
        uint256 d = IERC20(address(m.down())).balanceOf(address(this));
        uint256 pairs = F.min(u, d);
        lo = hi = pairs;
        uint256 excess = u > d ? u - d : d - u;
        if (excess == 0) return (lo, hi);
        bool upExcess = u > d;
        Market.State s = m.state();
        if (s == Market.State.RESOLVED_UP || s == Market.State.RESOLVED_DOWN) {
            bool upWins = s == Market.State.RESOLVED_UP;
            if (upWins == upExcess) {
                uint256 fee = m.redeemFeeBps();
                lo += excess - F.mulDivUp(excess, fee, BPS);
                hi += excess;
            }
            return (lo, hi);
        }
        if (s == Market.State.INVALID) {
            uint256 half = excess / 2;
            lo += half - F.mulDivUp(half, m.redeemFeeBps(), BPS);
            hi += F.mulDivUp(excess, 1, 2);
            return (lo, hi);
        }
        // Unresolved: price the excess side.
        (uint256 pLo, uint256 pHi) = _upBand(m, s, marks, mode);
        if (upExcess) {
            lo += F.mulWad(excess, pLo);
            hi += F.mulWadUp(excess, pHi);
        } else {
            lo += F.mulWad(excess, WAD - pHi);
            hi += F.mulWadUp(excess, WAD - pLo);
        }
    }

    /// @dev Lowest and highest plausible UP value of an unresolved market (WAD).
    function _upBand(Market m, Market.State s, Mark[] memory marks, MarkMode mode)
        internal
        view
        returns (uint256 pLo, uint256 pHi)
    {
        uint256 band = markBand;
        if (s == Market.State.CREATED) {
            // No strike yet: both sides are worth 1/2 by symmetry.
            return (WAD / 2 > band ? WAD / 2 - band : 0, F.min(WAD, WAD / 2 + band));
        }
        uint256 end = m.endTime();
        if (block.timestamp >= end) return (0, WAD); // awaiting resolution
        bytes32 a = m.assetId();
        (bool ok, uint256 spot, uint256 obs) = _markOf(a, marks, mode);
        if (!ok || obs >= end) return (0, WAD);
        AssetCfg storage c = assetCfg[a];
        // The market must have a strike here (OPEN); read it.
        uint256 strike = uint256(m.strike());
        uint256 tau = end - obs;
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
            return (lm.price != 0, lm.price, lm.obsTs);
        }
        if (mode == MarkMode.STRICT) revert MarkMissing(a);
        return (false, 0, 0);
    }

    /// @notice Assets whose Data Streams feed needs a fresh report to settle now (a registered,
    ///         unresolved, open market holds excess of one side). Use it to build `reports`.
    function marksNeeded() external view returns (bytes32[] memory feeds) {
        bytes32[] memory tmp = new bytes32[](assetIds.length);
        uint256 n;
        for (uint256 i = 0; i < _markets.length; i++) {
            Market m = Market(_markets[i]);
            if (!_needsMark(m)) continue;
            bytes32 f = assetCfg[m.assetId()].feedId;
            bool seen;
            for (uint256 j = 0; j < n; j++) {
                if (tmp[j] == f) seen = true;
            }
            if (!seen) tmp[n++] = f;
        }
        feeds = new bytes32[](n);
        for (uint256 j = 0; j < n; j++) {
            feeds[j] = tmp[j];
        }
    }

    function _needsMark(Market m) internal view returns (bool) {
        Market.State s = m.state();
        if (s != Market.State.OPEN || block.timestamp >= m.endTime()) return false;
        return IERC20(address(m.up())).balanceOf(address(this))
            != IERC20(address(m.down())).balanceOf(address(this));
    }

    /// @notice Re-values the vault with fresh reports (last verified marks for assets without
    ///         one), stores the lower NAV used for sizing and runs the daily drawdown breaker.
    ///         Anyone may call. An omitted report can never trip the breaker: the last verified
    ///         mark is used instead of a worst-case value.
    function checkpoint(bytes[] calldata reports) external nonReentrant {
        uint256 supply = totalSupply();
        if (supply == 0) return;
        Mark[] memory marks = _collectMarks(reports);
        (uint256 lo, uint256 hi) = _navs(marks, MarkMode.LAST_KNOWN);
        _recordMarks(marks);
        quoteNavLower = lo;
        lastNavUpper = hi;
        navUpdatedAt = uint64(block.timestamp);
        uint256 ppsLo = F.mulDiv(lo, WAD, supply);
        _updateBreaker(ppsLo);
        emit NavSnapshot(lo, hi, ppsLo, supply, false);
    }

    function _updateBreaker(uint256 ppsLo) internal {
        lastPpsLower = ppsLo;
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 today = uint64(block.timestamp - (block.timestamp % 1 days));
        if (dayStart != today) {
            dayStart = today;
            dayStartPps = ppsLo;
        } else if (!quotingPaused && ppsLo < F.mulDiv(dayStartPps, BPS - breakerBps, BPS)) {
            quotingPaused = true;
            emit BreakerTripped(ppsLo, dayStartPps);
            emit QuotingPaused(address(this));
        }
    }

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
        c.sigmaUpdatedAt = uint64(block.timestamp);
        emit SigmaSet(assetId, sigma);
    }

    /// @notice Turns `amount` of collateral into UP+DOWN pairs in a factory market of an enabled
    ///         asset (registering the market on first use). A pair is always worth 1 (it can be
    ///         merged at any time), so this does not change the NAV.
    function splitForInventory(Market m, uint256 amount) external onlyKeeper nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (quotingPaused) revert QuotingIsPaused();
        _checkMarket(m);
        Market.State s = m.state();
        if (s != Market.State.CREATED && s != Market.State.OPEN) revert WrongMarketState(uint8(s));
        if (block.timestamp + _params.noQuoteWindowSec >= m.endTime()) revert InNoQuoteWindow();
        if (_slot[address(m)] == 0) _register(m);
        Position storage p = _pos[address(m)];
        uint256 navU = quoteNavLower;
        uint256 pairCap = F.mulWad(maxPairFraction, navU);
        int256 newBasis = p.basis + int256(amount);
        if (newBasis > int256(pairCap)) revert PairCapExceeded(uint256(newBasis), pairCap);
        uint256 total = amount;
        for (uint256 i = 0; i < _markets.length; i++) {
            int256 b = _pos[_markets[i]].basis;
            if (b > 0) total += uint256(b);
        }
        uint256 invCap = F.mulWad(maxInventoryFraction, navU);
        if (total > invCap) revert InventoryCapExceeded(total, invCap);
        p.basis = newBasis;
        asset.forceApprove(address(m), amount);
        m.split(amount);
        asset.forceApprove(address(m), 0);
        emit InventorySplit(address(m), amount);
    }

    /// @notice Merges `amount` complete pairs back into collateral. Works while paused and after
    ///         resolution.
    function mergeInventory(Market m, uint256 amount) external onlyKeeper nonReentrant {
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
        _pos[address(m)].basis -= int256(amount);
        m.merge(amount);
        emit InventoryMerged(address(m), amount);
    }

    /// @notice Pulls a resolved (or invalid) registered market's value back into the vault: merges
    ///         complete pairs (no fee), redeems the rest. Anyone may call.
    function redeemResolved(Market m) external nonReentrant {
        if (_slot[address(m)] == 0) revert MarketNotRegistered(address(m));
        Market.State s = m.state();
        if (s == Market.State.CREATED || s == Market.State.OPEN) revert MarketUnresolved();
        IERC20 up = IERC20(address(m.up()));
        IERC20 down = IERC20(address(m.down()));
        uint256 pairs = F.min(up.balanceOf(address(this)), down.balanceOf(address(this)));
        if (pairs != 0) _merge(m, pairs);
        uint256 payout;
        if (up.balanceOf(address(this)) != 0 || down.balanceOf(address(this)) != 0) {
            uint256 before = asset.balanceOf(address(this));
            m.redeem();
            payout = asset.balanceOf(address(this)) - before;
        } else if (pairs == 0) {
            revert NothingToRedeem();
        }
        emit ResolvedRedeemed(address(m), pairs, payout);
        _unregister(m);
    }

    // ================================================================== registry

    function _checkMarket(Market m) internal view {
        bytes32 a = m.assetId();
        if (!assetCfg[a].enabled) revert AssetNotEnabled(a);
        uint64 s = m.startTime();
        uint64 e = m.endTime();
        if (factory.getMarket(a, e - s, s) != address(m)) revert NotFactoryMarket(address(m));
    }

    function _register(Market m) internal {
        if (_markets.length >= MAX_MARKETS) revert TooManyMarkets();
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
        delete _pos[address(m)];
        emit MarketUnregistered(address(m));
    }

    function _pruneIfEmpty(Market m) internal {
        if (
            IERC20(address(m.up())).balanceOf(address(this)) == 0
                && IERC20(address(m.down())).balanceOf(address(this)) == 0
        ) _unregister(m);
    }

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function marketAt(uint256 i) external view returns (address) {
        return _markets[i];
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
        p.basis = q.basis * int256(SCALE);
        p.cash = q.cash * int256(SCALE);
        p.up = IERC20(address(mk.up())).balanceOf(address(this)) * SCALE;
        p.down = IERC20(address(mk.down())).balanceOf(address(this)) * SCALE;
    }

    /// @notice Everything the venue needs to price one market.
    function venueView(Market m) external view returns (VenueView memory v) {
        if (_slot[address(m)] == 0 || quotingPaused || venue == address(0)) return v;
        if (block.timestamp > uint256(navUpdatedAt) + navMaxAge) return v;
        AssetCfg storage c = assetCfg[m.assetId()];
        if (c.sigma == 0 || block.timestamp > uint256(c.sigmaUpdatedAt) + sigmaMaxAge) return v;
        v.tradable = true;
        v.navWad = quoteNavLower * SCALE;
        v.sigma = c.sigma;
        v.pos = _posWad(address(m));
    }

    /// @dev Loss ceiling of market `m` given the other markets' current losses.
    function _ceiling(address m, QuoteMath.Pos memory p) internal view returns (uint256) {
        uint256 other;
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
        uint256 ceiling = _ceiling(address(m), p);
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
    function venueFill(FillParams calldata f) external onlyVenue nonReentrant {
        if (f.units == 0) revert ZeroAmount();
        if (f.taker == address(0) || f.taker == address(this)) revert ZeroAddress();
        if (_slot[address(f.market)] == 0) revert MarketNotRegistered(address(f.market));
        if (quotingPaused) revert QuotingIsPaused();
        if (block.timestamp > uint256(navUpdatedAt) + navMaxAge) revert NotTradable();

        // Price bounds on amounts (premium and units share a scale), with rounding that lets the
        // venue's own rounding at the bound pass: floor at the minimum, ceiling at the maximum.
        if (
            f.premium < F.mulDiv(f.units, _params.priceMin, WAD)
                || f.premium > F.mulDivUp(f.units, _params.priceMax, WAD)
        ) revert PriceOutOfBounds(F.mulDiv(f.premium, WAD, f.units));
        // Conservative implied price for the room: lower when the vault sells, higher when it buys.
        uint256 price =
            f.vaultSells ? F.mulDiv(f.premium, WAD, f.units) : F.mulDivUp(f.premium, WAD, f.units);
        uint256 room = fillRoom(f.market, f.upToken, f.vaultSells, price);
        if (f.units > room) revert RiskLimitExceeded(f.units, room);

        _moveFill(f);

        bytes32 a = f.market.assetId();
        if (f.refObs > lastMark[a].obsTs && f.refObs <= block.timestamp) {
            lastMark[a] = LastMark(f.refPrice, f.refObs);
        }
        // Belt and braces: the exact post-trade loss must respect the ceiling.
        QuoteMath.Pos memory post = _posWad(address(f.market));
        uint256 ceiling = _ceiling(address(f.market), post);
        uint256 l = QuoteMath.loss(post);
        if (l > ceiling) revert LossAboveCeiling(l, ceiling);
        Position storage pos = _pos[address(f.market)];
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
    }

    function _moveFill(FillParams calldata f) internal {
        Position storage pos = _pos[address(f.market)];
        IERC20 tok = f.upToken ? IERC20(address(f.market.up())) : IERC20(address(f.market.down()));
        if (f.vaultSells) {
            uint256 before = asset.balanceOf(address(this));
            asset.safeTransferFrom(msg.sender, address(this), f.premium);
            if (asset.balanceOf(address(this)) - before != f.premium) {
                revert FeeOnTransferNotSupported();
            }
            pos.cash += int256(f.premium);
            tok.safeTransfer(f.taker, f.units);
        } else {
            uint256 free = _freeLiquidity();
            if (f.premium > free) revert InsufficientLiquidity(f.premium, free);
            uint256 before = tok.balanceOf(address(this));
            tok.safeTransferFrom(msg.sender, address(this), f.units);
            if (tok.balanceOf(address(this)) - before != f.units) {
                revert FeeOnTransferNotSupported();
            }
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

    /// @notice Resumes trading and restarts the breaker from the current share price.
    function resumeQuoting() external onlyOwner {
        quotingPaused = false;
        dayStartPps = lastPpsLower;
        emit QuotingResumed(msg.sender);
    }

    function setTvlCap(uint256 cap) external onlyOwner {
        tvlCap = cap;
        emit TvlCapSet(cap);
    }

    function setPerformanceFee(uint256 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh(bps);
        performanceFeeBps = uint16(bps);
        emit FeeSet(bps);
    }

    function setKeeper(address k) external onlyOwner {
        if (k == address(0)) revert ZeroAddress();
        keeper = k;
        emit KeeperSet(k);
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
        _checkBand(sigmaMin, sigmaMax);
        c.enabled = true;
        c.feedId = feed;
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
                || p.minHalfSpread == 0 || p.minHalfSpread > p.maxHalfSpread
                || p.maxHalfSpread > 0.5e18 || p.priceMin < 0.01e18 || p.priceMax > 0.99e18
                || p.priceMin >= p.priceMax || p.minRangeTicks == 0
                || p.minRangeTicks > p.baseRangeTicks || p.liquidityNavFraction > 0.5e18
                || p.perMarketMaxFraction == 0 || p.perMarketMaxFraction > 0.05e18
                || p.totalAtRiskMaxFraction > 0.4e18
                || p.totalAtRiskMaxFraction < p.perMarketMaxFraction || p.inventorySkewMax > 0.5e18
                || p.noQuoteWindowSec < 10
        ) revert InvalidConfig();
    }

    function setRiskConfig(
        uint256 maxMarkAge_,
        uint256 markBand_,
        uint256 markGrace_,
        uint256 breakerBps_,
        uint256 maxPairFraction_,
        uint256 maxInventoryFraction_
    ) external onlyOwner {
        if (
            maxMarkAge_ == 0 || maxMarkAge_ > 60 || markBand_ > 0.3e18 || markGrace_ < 60
                || markGrace_ > 1 days || breakerBps_ == 0 || breakerBps_ > 2_500
                || maxPairFraction_ > WAD || maxInventoryFraction_ > WAD
        ) revert InvalidConfig();
        maxMarkAge = uint32(maxMarkAge_);
        markBand = uint64(markBand_);
        markGrace = uint32(markGrace_);
        breakerBps = uint16(breakerBps_);
        maxPairFraction = uint64(maxPairFraction_);
        maxInventoryFraction = uint64(maxInventoryFraction_);
        emit RiskConfigSet(
            maxMarkAge_, markBand_, markGrace_, breakerBps_, maxPairFraction_, maxInventoryFraction_
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
                || navMaxAge_ < 60
        ) revert InvalidConfig();
        maxSigmaStepBps = uint16(maxStepBps);
        sigmaMinInterval = uint32(minInterval);
        sigmaMaxAge = uint32(maxAge);
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
        delete pendingVenue;
        delete pendingVenueEta;
    }

    // ================================================================== helpers

    function _u128(uint256 x) internal pure returns (uint128) {
        // Asset amounts here are far below 2^128; a larger value is a bug or an attack.
        if (x > type(uint128).max) revert InvalidConfig();
        return uint128(x);
    }

    /// @notice Lower price per share at the last settlement or checkpoint (WAD; 1e18 = 1.0).
    function pricePerShareLower() external view returns (uint256) {
        return lastPpsLower;
    }
}
