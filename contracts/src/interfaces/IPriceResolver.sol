// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPriceResolver
/// @notice Source of boundary prices P(asset, T) for outcome markets (ADR-002).
/// @dev A market's strike is P(asset, startTime) and its settlement price is P(asset, endTime).
///      Adjacent rounds share the boundary record, so one unresolvable boundary voids both rounds
///      touching it. Implementations must be permissionless to submit to and must never let a
///      submitter choose between several valid prices for the same boundary.
interface IPriceResolver {
    /// @notice Resolution status of a boundary price.
    enum Status {
        PENDING, // not yet known; may still become FINAL or UNRESOLVABLE
        FINAL, // price is final and will never change
        UNRESOLVABLE // can never become FINAL; markets touching this boundary become INVALID
    }

    /// @notice Submits evidence for P(assetId, timestamp). Permissionless.
    /// @param assetId Asset identifier (e.g. keccak256("BTC/USD")).
    /// @param timestamp Aligned UTC boundary.
    /// @param data Resolver-specific evidence (abi-encoded roundId, or a signed report).
    function submit(bytes32 assetId, uint64 timestamp, bytes calldata data) external;

    /// @notice Current status and price of P(assetId, timestamp).
    /// @return status PENDING, FINAL or UNRESOLVABLE.
    /// @return price The boundary price (only meaningful when FINAL). Same decimals for every
    ///         boundary of one asset, so strike and settlement are directly comparable.
    function priceAt(bytes32 assetId, uint64 timestamp)
        external
        view
        returns (Status status, int256 price);

    /// @notice Whether this resolver is configured for an asset (used by the factory).
    function supportsAsset(bytes32 assetId) external view returns (bool);
}
