// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPriceResolver} from "../interfaces/IPriceResolver.sol";
import {IVerifierProxy, ReportV3} from "../interfaces/IVerifierProxy.sol";

/// @title DataStreamsResolver
/// @notice Boundary prices from Chainlink Data Streams v3 reports verified onchain (ADR-002 §2).
///         The canonical report for boundary T is the one whose window contains T:
///         validFromTimestamp <= T <= observationsTimestamp. Chainlink documents report windows
///         as contiguous with no gaps and no overlap, so exactly one report qualifies and the
///         submitter has nothing to choose
///         (https://docs.chain.link/data-streams/how-report-timestamps-work).
/// @dev Defense in depth against an overlap anomaly: the first valid proposal starts a
///      finalization window that is never restarted; during it a different containing report
///      replaces the current one only if keccak256(verified report) is lower (deterministic and
///      not grindable: the hash covers DON-signed report data, not signatures or calldata).
///      No proposal by T + grace => UNRESOLVABLE (and later submissions are rejected, so the
///      status can never flip). No push-feed sanity bound (ADR-002 §5).
contract DataStreamsResolver is IPriceResolver, Ownable2Step, ReentrancyGuard {
    struct Proposal {
        int192 price;
        uint64 firstProposedAt;
        uint32 observationsTimestamp;
        bytes32 reportHash;
    }

    /// @notice Chainlink VerifierProxy.
    IVerifierProxy public immutable verifier;
    /// @notice Seconds from the first proposal until the price is FINAL.
    uint64 public immutable finalizationWindow;
    /// @notice Seconds after T without any proposal before the boundary is UNRESOLVABLE.
    uint64 public immutable grace;

    mapping(bytes32 assetId => bytes32 feedId) public feedIdOf;
    mapping(bytes32 assetId => mapping(uint64 timestamp => Proposal)) private _proposals;

    event AssetConfigured(bytes32 indexed assetId, bytes32 feedId);
    event ReportProposed(
        bytes32 indexed assetId,
        uint64 indexed timestamp,
        int192 price,
        uint32 validFromTimestamp,
        uint32 observationsTimestamp,
        bytes32 reportHash,
        bool replaced
    );

    error AssetAlreadyConfigured(bytes32 assetId);
    error UnknownAsset(bytes32 assetId);
    error InvalidConfig();
    error UnsupportedReportVersion(uint16 version);
    error WrongFeed(bytes32 expected, bytes32 actual);
    error BoundaryNotInReportWindow(uint64 timestamp, uint32 validFrom, uint32 observations);
    error InvalidPrice(int192 price);
    error SubmissionWindowClosed(uint64 timestamp);

    constructor(address owner_, IVerifierProxy verifier_, uint64 finalizationWindow_, uint64 grace_)
        Ownable(owner_)
    {
        if (
            address(verifier_) == address(0) || finalizationWindow_ == 0
                || grace_ <= finalizationWindow_
        ) {
            revert InvalidConfig();
        }
        verifier = verifier_;
        finalizationWindow = finalizationWindow_;
        grace = grace_;
    }

    /// @notice Maps an asset to its Data Streams feed ID. One-time.
    function configureAsset(bytes32 assetId, bytes32 feedId) external onlyOwner {
        if (feedIdOf[assetId] != bytes32(0)) revert AssetAlreadyConfigured(assetId);
        if (feedId == bytes32(0)) revert InvalidConfig();
        feedIdOf[assetId] = feedId;
        emit AssetConfigured(assetId, feedId);
    }

    /// @inheritdoc IPriceResolver
    function supportsAsset(bytes32 assetId) external view returns (bool) {
        return feedIdOf[assetId] != bytes32(0);
    }

    /// @inheritdoc IPriceResolver
    /// @dev `data` is the full report payload from Data Streams (header + signed report).
    ///      No-op once FINAL.
    // slither-disable-next-line reentrancy-no-eth
    function submit(bytes32 assetId, uint64 timestamp, bytes calldata data) external nonReentrant {
        bytes32 feedId = _feedId(assetId);
        Proposal storage p = _proposals[assetId][timestamp];
        bool exists = p.firstProposedAt != 0;
        if (exists && block.timestamp >= uint256(p.firstProposedAt) + finalizationWindow) return;
        if (!exists && block.timestamp > uint256(timestamp) + grace) {
            revert SubmissionWindowClosed(timestamp);
        }

        (, bytes memory reportData) = abi.decode(data, (bytes32[3], bytes));
        if (reportData.length < 2) revert UnsupportedReportVersion(0);
        uint16 version = (uint16(uint8(reportData[0])) << 8) | uint16(uint8(reportData[1]));
        if (version != 3) revert UnsupportedReportVersion(version);

        // Trusted call: the immutable Chainlink VerifierProxy; submit is also nonReentrant.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        bytes memory verified = verifier.verify(data, bytes(""));
        ReportV3 memory r = abi.decode(verified, (ReportV3));
        if (r.feedId != feedId) revert WrongFeed(feedId, r.feedId);
        if (r.validFromTimestamp > timestamp || r.observationsTimestamp < timestamp) {
            revert BoundaryNotInReportWindow(
                timestamp, r.validFromTimestamp, r.observationsTimestamp
            );
        }
        if (r.price <= 0) revert InvalidPrice(r.price);

        bytes32 h = keccak256(verified);
        // Events below follow only the trusted, immutable verifier call.
        // forge-lint: disable-start(reentrancy-events)
        if (!exists) {
            // uint64 timestamps overflow in year 2^64 s; safe.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint64 nowTs = uint64(block.timestamp);
            _proposals[assetId][timestamp] = Proposal(r.price, nowTs, r.observationsTimestamp, h);
            emit ReportProposed(
                assetId, timestamp, r.price, r.validFromTimestamp, r.observationsTimestamp, h, false
            );
        } else if (h < p.reportHash) {
            p.price = r.price;
            p.observationsTimestamp = r.observationsTimestamp;
            p.reportHash = h;
            emit ReportProposed(
                assetId, timestamp, r.price, r.validFromTimestamp, r.observationsTimestamp, h, true
            );
        }
        // forge-lint: disable-end(reentrancy-events)
    }

    /// @inheritdoc IPriceResolver
    function priceAt(bytes32 assetId, uint64 timestamp)
        external
        view
        returns (Status status, int256 price)
    {
        _feedId(assetId);
        Proposal memory p = _proposals[assetId][timestamp];
        if (p.firstProposedAt != 0) {
            if (block.timestamp >= uint256(p.firstProposedAt) + finalizationWindow) {
                return (Status.FINAL, p.price);
            }
            return (Status.PENDING, 0);
        }
        if (block.timestamp > uint256(timestamp) + grace) return (Status.UNRESOLVABLE, 0);
        return (Status.PENDING, 0);
    }

    /// @notice The current proposal for a boundary (zeroed if none).
    function proposal(bytes32 assetId, uint64 timestamp) external view returns (Proposal memory) {
        return _proposals[assetId][timestamp];
    }

    function _feedId(bytes32 assetId) private view returns (bytes32 feedId) {
        feedId = feedIdOf[assetId];
        if (feedId == bytes32(0)) revert UnknownAsset(assetId);
    }
}
