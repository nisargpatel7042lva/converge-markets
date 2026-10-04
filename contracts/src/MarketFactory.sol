// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPriceResolver} from "./interfaces/IPriceResolver.sol";
import {Market} from "./Market.sol";
import {OutcomeToken} from "./OutcomeToken.sol";
import {Series} from "./libraries/Series.sol";
import {MarketNaming} from "./libraries/MarketNaming.sol";

/// @title MarketFactory
/// @notice Creates outcome markets (Market + UP/DOWN OutcomeToken clones) and keeps the registry
///         (asset, duration, startTime) => market.
/// @dev Roles: DEFAULT_ADMIN_ROLE (Safe multisig on mainnet) configures assets, fees and roles and
///      unpauses; CREATOR_ROLE creates markets; GUARDIAN_ROLE can only pause.
///      Pause stops market creation and Market.split only. It never blocks merge/redeem/resolve.
contract MarketFactory is AccessControl, Pausable {
    bytes32 public constant CREATOR_ROLE = keccak256("CREATOR_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    /// @notice Hard cap on the redeem fee: 1%.
    uint16 public constant MAX_REDEEM_FEE_BPS = 100;

    struct Asset {
        IPriceResolver resolver;
        string label; // e.g. "BTC", used in token names
        bool enabled;
    }

    IERC20 public immutable collateral;
    uint8 public immutable collateralDecimals;
    address public immutable marketImplementation;
    address public immutable tokenImplementation;

    /// @notice Redeem fee for markets created from now on (snapshotted per market). Default 0.
    uint16 public redeemFeeBps;
    /// @notice Receives redeem fees. Fees are skipped while this is zero.
    address public feeRecipient;
    uint256 public marketCount;

    mapping(bytes32 assetId => Asset) private _assets;
    mapping(bytes32 key => address market) public marketByKey;

    event AssetSet(bytes32 indexed assetId, address resolver, string label, bool enabled);
    event RedeemFeeSet(uint16 bps);
    event FeeRecipientSet(address recipient);
    /// @notice Emitted once per market. `params` holds every immutable market parameter
    ///         (factory, assetId, resolver, collateral, up, down, startTime, endTime, redeemFeeBps);
    ///         token names/symbols are readable from the tokens.
    event MarketCreated(
        address indexed market,
        bytes32 indexed assetId,
        uint64 indexed startTime,
        uint64 duration,
        Market.Params params
    );

    error ZeroAddress();
    error EmptyLabel();
    error ResolverDoesNotSupportAsset(bytes32 assetId);
    error AssetNotEnabled(bytes32 assetId);
    error AssetResolverFixed(bytes32 assetId);
    error UnsupportedDuration(uint64 duration);
    error NotAligned(uint64 startTime, uint64 duration);
    error StartInPast(uint64 startTime);
    error MarketExists(address market);
    error FeeTooHigh(uint16 bps);

    constructor(IERC20 collateral_, address admin) {
        if (address(collateral_) == address(0) || admin == address(0)) revert ZeroAddress();
        collateral = collateral_;
        collateralDecimals = IERC20Metadata(address(collateral_)).decimals();
        marketImplementation = address(new Market());
        tokenImplementation = address(new OutcomeToken());
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ admin

    /// @notice Registers an asset or toggles it. The resolver of an asset can never change once
    ///         set (existing and future markets of that asset keep one oracle); only `enabled`
    ///         and the label can be updated.
    function setAsset(bytes32 assetId, IPriceResolver resolver, string calldata label, bool enabled)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (address(resolver) == address(0)) revert ZeroAddress();
        if (bytes(label).length == 0) revert EmptyLabel();
        Asset storage a = _assets[assetId];
        if (address(a.resolver) != address(0) && a.resolver != resolver) {
            revert AssetResolverFixed(assetId);
        }
        if (!resolver.supportsAsset(assetId)) revert ResolverDoesNotSupportAsset(assetId);
        a.resolver = resolver;
        a.label = label;
        a.enabled = enabled;
        emit AssetSet(assetId, address(resolver), label, enabled);
    }

    /// @notice Sets the redeem fee for future markets. Capped at 1%.
    function setRedeemFee(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_REDEEM_FEE_BPS) revert FeeTooHigh(bps);
        redeemFeeBps = bps;
        emit RedeemFeeSet(bps);
    }

    /// @notice Zero is allowed on purpose: it disables redeem fees (markets skip the fee).
    // forge-lint: disable-next-line(missing-zero-check)
    function setFeeRecipient(address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        feeRecipient = recipient;
        emit FeeRecipientSet(recipient);
    }

    /// @notice Guardian (or admin via the guardian role) pauses creation and split.
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    /// @notice Only the admin can unpause.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ------------------------------------------------------------------ creation

    /// @notice Creates the market for (asset, duration, startTime).
    /// @param duration 15 minutes or 1 hour.
    /// @param startTime Aligned UTC boundary, not in the past.
    function createMarket(bytes32 assetId, uint64 duration, uint64 startTime)
        external
        onlyRole(CREATOR_ROLE)
        whenNotPaused
        returns (address market)
    {
        Asset memory a = _assets[assetId];
        if (!a.enabled) revert AssetNotEnabled(assetId);
        if (!Series.isSupportedDuration(duration)) revert UnsupportedDuration(duration);
        if (!Series.isAligned(startTime, duration)) revert NotAligned(startTime, duration);
        if (startTime < block.timestamp) revert StartInPast(startTime);
        bytes32 key = marketKey(assetId, duration, startTime);
        if (marketByKey[key] != address(0)) revert MarketExists(marketByKey[key]);

        market = Clones.cloneDeterministic(marketImplementation, key);
        marketByKey[key] = market;
        marketCount += 1;

        // Every field is assigned below (struct literal hits stack-too-deep).
        // slither-disable-next-line uninitialized-local
        Market.Params memory p;
        p.factory = address(this);
        p.assetId = assetId;
        p.resolver = a.resolver;
        p.collateral = collateral;
        p.startTime = startTime;
        p.endTime = startTime + duration;
        p.redeemFeeBps = redeemFeeBps;
        p.up = _deployToken(market, a.label, true, startTime);
        p.down = _deployToken(market, a.label, false, startTime);
        _initialize(market, duration, p);
    }

    function _initialize(address market, uint64 duration, Market.Params memory p) private {
        Market(market).initialize(p);
        // Call target is a clone we just deployed (our own code).
        // forge-lint: disable-next-line(reentrancy-events)
        emit MarketCreated(market, p.assetId, p.startTime, duration, p);
    }

    function _deployToken(address market, string memory label, bool isUp, uint64 startTime)
        private
        returns (OutcomeToken token)
    {
        token = OutcomeToken(Clones.clone(tokenImplementation));
        token.initialize(
            market,
            MarketNaming.tokenName(label, isUp, startTime),
            MarketNaming.tokenSymbol(label, isUp, startTime),
            collateralDecimals
        );
    }

    // ------------------------------------------------------------------ views

    /// @notice Registry key for (asset, duration, startTime); also the market's CREATE2 salt.
    function marketKey(bytes32 assetId, uint64 duration, uint64 startTime)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(assetId, duration, startTime));
    }

    /// @notice Market for (asset, duration, startTime), or zero.
    function getMarket(bytes32 assetId, uint64 duration, uint64 startTime)
        external
        view
        returns (address)
    {
        return marketByKey[marketKey(assetId, duration, startTime)];
    }

    /// @notice Predicted market address (deterministic clone).
    function predictMarket(bytes32 assetId, uint64 duration, uint64 startTime)
        external
        view
        returns (address)
    {
        return Clones.predictDeterministicAddress(
            marketImplementation, marketKey(assetId, duration, startTime)
        );
    }

    function asset(bytes32 assetId) external view returns (Asset memory) {
        return _assets[assetId];
    }

    /// @notice Exposes Pausable.paused() for markets (IMarketFactoryView).
    function paused() public view override returns (bool) {
        return super.paused();
    }
}
