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
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (reportData.length < 2) revert UnsupportedReportVersion(0);
        uint16 version = (uint16(uint8(reportData[0])) << 8) | uint16(uint8(reportData[1]));
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (version != 3) revert UnsupportedReportVersion(version);
        // forge-lint: disable-next-line(calls-loop)
        r = abi.decode(verifier.verify(payload, parameterPayload), (ReportV3));
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (r.feedId != expectedFeed) revert WrongFeed(expectedFeed, r.feedId);
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (r.price <= 0) revert InvalidPrice(r.price);
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (r.expiresAt < block.timestamp) revert ReportExpired(r.expiresAt);
    }

    /// @notice Decodes only the feed id of a payload (no verification), to route a report to its
    ///         asset before verifying it.
    function feedOf(bytes calldata payload) internal pure returns (bytes32 feedId) {
        (, bytes memory reportData) = abi.decode(payload, (bytes32[3], bytes));
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (reportData.length < 32) revert UnsupportedReportVersion(0);
        assembly {
            feedId := mload(add(reportData, 32))
        }
    }
}
