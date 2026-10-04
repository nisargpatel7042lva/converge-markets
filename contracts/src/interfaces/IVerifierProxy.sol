// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IVerifierProxy
/// @notice Chainlink Data Streams verifier proxy (subset).
/// @dev Copied from https://docs.chain.link/data-streams/tutorials/evm-onchain-report-verification
///      (read 2026-10-04). `parameterPayload` is empty under subscription billing.
///      Monad mainnet proxy: 0xEd813D895457907399E41D36Ec0bE103E32148c8 ("VerifierProxy 2.0.0").
interface IVerifierProxy {
    /// @notice Verifies a full report payload (header + signed report) and returns the report data.
    function verify(bytes calldata payload, bytes calldata parameterPayload)
        external
        payable
        returns (bytes memory verifierResponse);
}

/// @notice Data Streams report schema v3 (crypto), per
///         https://docs.chain.link/data-streams/reference/report-schema-v3 (read 2026-10-04).
struct ReportV3 {
    bytes32 feedId;
    uint32 validFromTimestamp;
    uint32 observationsTimestamp;
    uint192 nativeFee;
    uint192 linkFee;
    uint32 expiresAt;
    int192 price;
    int192 bid;
    int192 ask;
}
