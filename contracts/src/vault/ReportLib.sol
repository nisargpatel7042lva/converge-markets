// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifierProxy, ReportV3} from "../interfaces/IVerifierProxy.sol";

/// @title ReportLib
/// @notice Verification of one Chainlink Data Streams v3 report, shared by the vault (NAV marks)
///         and the venue (execution prices). Same decoding as `DataStreamsResolver.submit`.
library ReportLib {
    error UnsupportedReportVersion(uint16 version);
    error WrongFeed(bytes32 expected, bytes32 actual);
    error InvalidPrice(int192 price);
    error ReportExpired(uint32 expiresAt);

    /// @notice Verifies `payload` with the verifier proxy and returns the decoded report.
    /// @dev No value is forwarded (subscription billing). Reverts on a wrong feed, a non-positive
    ///      price or an expired report. The caller checks the timestamps it needs.
    function verify(
        IVerifierProxy verifier,
        bytes memory parameterPayload,
        bytes calldata payload,
        bytes32 expectedFeed
    ) internal returns (ReportV3 memory r) {
        (, bytes memory reportData) = abi.decode(payload, (bytes32[3], bytes));
        if (reportData.length < 2) revert UnsupportedReportVersion(0);
        uint16 version = (uint16(uint8(reportData[0])) << 8) | uint16(uint8(reportData[1]));
        if (version != 3) revert UnsupportedReportVersion(version);
        r = abi.decode(verifier.verify(payload, parameterPayload), (ReportV3));
        if (r.feedId != expectedFeed) revert WrongFeed(expectedFeed, r.feedId);
        if (r.price <= 0) revert InvalidPrice(r.price);
        if (r.expiresAt < block.timestamp) revert ReportExpired(r.expiresAt);
    }

    /// @notice Decodes only the feed id of a payload (no verification), to route a report to its
    ///         asset before verifying it.
    function feedOf(bytes calldata payload) internal pure returns (bytes32 feedId) {
        (, bytes memory reportData) = abi.decode(payload, (bytes32[3], bytes));
        if (reportData.length < 32) revert UnsupportedReportVersion(0);
        assembly {
            feedId := mload(add(reportData, 32))
        }
    }
}
