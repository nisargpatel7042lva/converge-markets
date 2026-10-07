// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceResolver} from "../interfaces/IPriceResolver.sol";

/// @title ThresholdResolver
/// @notice The resolver of one price-threshold market (docs/adr/ADR-008). It answers the START
///         boundary of the market with a fixed strike chosen by the market's creator, and forwards
///         every other boundary (the END price) to the asset's real resolver. The end price is
///         therefore decided by exactly the audited oracle path (canonical Data Streams report,
///         finalization window, UNRESOLVABLE to INVALID); the only thing this contract adds is the
///         strike.
/// @dev Deployed as an EIP-1167 clone per market by the PartnerRegistry, initialized in the same
///      transaction. The implementation locks itself. Everything here is permissionless and
///      stateless apart from the three immutable-after-init values: `checkpoint` and `submit` on
///      the base resolver are permissionless anyway, so forwarding them gives nobody new power.
contract ThresholdResolver is IPriceResolver {
    /// @notice The resolver that decides every boundary except the start.
    IPriceResolver public base;
    /// @notice The fixed strike, in the base resolver's price scale (Data Streams v3: 18 decimals).
    int256 public strike;
    /// @notice The only boundary this contract answers itself.
    uint64 public startTime;

    event Initialized(address indexed base, int256 strike, uint64 startTime);

    error AlreadyInitialized();
    error InvalidStrike(int256 strike);
    error InvalidStart();
    error ZeroAddress();
    error StartBoundaryIsFixed();

    /// @dev Locks the implementation.
    constructor() {
        startTime = type(uint64).max;
    }

    /// @notice One-time setup by the creating registry, in the clone's creation transaction.
    function initialize(IPriceResolver base_, int256 strike_, uint64 startTime_) external {
        if (startTime != 0) revert AlreadyInitialized();
        if (address(base_) == address(0)) revert ZeroAddress();
        if (strike_ <= 0) revert InvalidStrike(strike_);
        if (startTime_ == 0) revert InvalidStart();
        base = base_;
        strike = strike_;
        startTime = startTime_;
        emit Initialized(address(base_), strike_, startTime_);
    }

    /// @inheritdoc IPriceResolver
    /// @dev The start boundary has nothing to submit (it is fixed); every other boundary is
    ///      forwarded with the oracle fee, if any.
    function submit(bytes32 assetId, uint64 timestamp, bytes calldata data) external payable {
        if (timestamp == startTime) revert StartBoundaryIsFixed();
        // The destination is the base resolver fixed at initialization; only the oracle fee is forwarded.
        // forge-lint: disable-next-line(arbitrary-send-eth)
        base.submit{value: msg.value}(assetId, timestamp, data);
    }

    /// @inheritdoc IPriceResolver
    function checkpoint(bytes32 assetId, uint64 timestamp)
        external
        returns (Status status, int256 price)
    {
        if (timestamp == startTime) return (Status.FINAL, strike);
        return base.checkpoint(assetId, timestamp);
    }

    /// @inheritdoc IPriceResolver
    function priceAt(bytes32 assetId, uint64 timestamp)
        external
        view
        returns (Status status, int256 price)
    {
        if (timestamp == startTime) return (Status.FINAL, strike);
        return base.priceAt(assetId, timestamp);
    }

    /// @inheritdoc IPriceResolver
    function supportsAsset(bytes32 assetId) external view returns (bool) {
        return base.supportsAsset(assetId);
    }
}
