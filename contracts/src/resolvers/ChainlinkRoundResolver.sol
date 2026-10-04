// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IPriceResolver} from "../interfaces/IPriceResolver.sol";
import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";

/// @title ChainlinkRoundResolver
/// @notice Boundary prices from Chainlink push feeds via a round proof (ADR-002, round-proof mode).
///         P(T) is the answer of the FIRST feed round with updatedAt >= T. Anyone proves it by
///         supplying that roundId; the contract checks that the previous round in the same phase
///         has updatedAt < T, so there is exactly one valid proof per boundary.
/// @dev Status rules (all permanent once reached):
///      - FINAL: a valid first-round proof with updatedAt - T <= maxOracleDelay.
///      - UNRESOLVABLE if any of:
///        (a) the proven first round has updatedAt - T > maxOracleDelay;
///        (b) block.timestamp > T + maxOracleDelay and the feed's latest round is still before T
///            (any later round would be updated after T + maxOracleDelay, i.e. case (a));
///        (c) block.timestamp > T + livenessGrace with no proof (proofs are rejected after this,
///            so the status can never flip back). Covers a first round that opens a new
///            aggregator phase, which has no same-phase predecessor and cannot be proven.
///      Phases: only rounds of the proxy's CURRENT phase are accepted. During an aggregator
///      migration the old phase can keep transmitting, which would otherwise allow two different
///      "first rounds" for the same boundary (one per phase).
///      Permanence: (b) and (c) are derived from time and feed state; `checkpoint` stores them so
///      a boundary seen as UNRESOLVABLE by any market can never later become FINAL.
///      Asset configuration is set once and can never change, so markets that snapshot this
///      resolver keep a fixed oracle.
// `submit` is payable only to match IPriceResolver; it rejects any value, so no ETH can be locked.
// forge-lint: disable-start(locked-ether)
// slither-disable-next-line locked-ether
contract ChainlinkRoundResolver is IPriceResolver, Ownable2Step {
    /// @notice Per-asset feed configuration (immutable once set).
    struct AssetConfig {
        IAggregatorV3 feed;
        uint32 maxOracleDelay;
    }

    struct Boundary {
        Status status;
        int256 price;
        uint80 roundId;
    }

    /// @notice After T + livenessGrace, unproven boundaries are UNRESOLVABLE and proofs are rejected.
    uint64 public immutable livenessGrace;

    mapping(bytes32 assetId => AssetConfig) public assetConfig;
    mapping(bytes32 assetId => mapping(uint64 timestamp => Boundary)) private _boundaries;

    event AssetConfigured(bytes32 indexed assetId, address feed, uint32 maxOracleDelay);
    /// @notice A boundary became UNRESOLVABLE without a proof (stale feed or liveness timeout).
    event BoundaryUnresolvable(bytes32 indexed assetId, uint64 indexed timestamp);
    event BoundaryProven(
        bytes32 indexed assetId,
        uint64 indexed timestamp,
        Status status,
        int256 price,
        uint80 roundId,
        uint256 updatedAt
    );

    error AssetAlreadyConfigured(bytes32 assetId);
    error UnknownAsset(bytes32 assetId);
    error InvalidConfig();
    error BadProofLength();
    error RoundNotFound(uint80 roundId);
    error RoundBeforeBoundary(uint80 roundId, uint256 updatedAt);
    error NotFirstRound(uint80 roundId);
    error FirstRoundOfPhase(uint80 roundId);
    error InvalidAnswer(int256 answer);
    error ProofWindowClosed(uint64 timestamp);
    error NotCurrentPhase(uint80 roundId, uint80 latestRoundId);
    error NoValueAccepted();

    /// @param owner_ Admin that configures assets (Safe multisig on mainnet).
    /// @param livenessGrace_ Seconds after T before an unproven boundary becomes UNRESOLVABLE.
    constructor(address owner_, uint64 livenessGrace_) Ownable(owner_) {
        if (livenessGrace_ == 0) revert InvalidConfig();
        livenessGrace = livenessGrace_;
    }

    /// @notice Sets the feed for an asset. One-time; reverts if already configured.
    function configureAsset(bytes32 assetId, IAggregatorV3 feed, uint32 maxOracleDelay)
        external
        onlyOwner
    {
        if (address(assetConfig[assetId].feed) != address(0)) {
            revert AssetAlreadyConfigured(assetId);
        }
        if (address(feed) == address(0) || maxOracleDelay == 0 || maxOracleDelay >= livenessGrace) {
            revert InvalidConfig();
        }
        assetConfig[assetId] = AssetConfig(feed, maxOracleDelay);
        emit AssetConfigured(assetId, address(feed), maxOracleDelay);
    }

    /// @inheritdoc IPriceResolver
    function supportsAsset(bytes32 assetId) external view returns (bool) {
        return address(assetConfig[assetId].feed) != address(0);
    }

    /// @inheritdoc IPriceResolver
    /// @dev `data` = abi.encode(uint80 roundId) of the first round with updatedAt >= timestamp.
    ///      No-op if the boundary is already decided, so a market's open/resolve never fails
    ///      because someone else proved the boundary first.
    // slither-disable-next-line unused-return
    function submit(bytes32 assetId, uint64 timestamp, bytes calldata data) external payable {
        if (msg.value != 0) revert NoValueAccepted();
        AssetConfig memory cfg = _config(assetId);
        Boundary storage b = _boundaries[assetId][timestamp];
        if (b.status != Status.PENDING) return;
        if (block.timestamp > uint256(timestamp) + livenessGrace) {
            revert ProofWindowClosed(timestamp);
        }
        if (data.length != 32) revert BadProofLength();
        uint80 roundId = abi.decode(data, (uint80));

        // forge-lint: disable-next-line(unused-return)
        (uint80 latestId,,,,) = cfg.feed.latestRoundData();
        if (roundId >> 64 != latestId >> 64) revert NotCurrentPhase(roundId, latestId);
        (int256 answer, uint256 updatedAt) = _round(cfg.feed, roundId);
        if (updatedAt < timestamp) revert RoundBeforeBoundary(roundId, updatedAt);
        // Intentional truncation: the low 64 bits of a proxy roundId are the aggregator round id.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (uint64(roundId) <= 1) revert FirstRoundOfPhase(roundId);
        (, uint256 prevUpdatedAt) = _round(cfg.feed, roundId - 1);
        if (prevUpdatedAt >= timestamp) revert NotFirstRound(roundId);
        if (answer <= 0) revert InvalidAnswer(answer);

        if (updatedAt - timestamp > cfg.maxOracleDelay) {
            b.status = Status.UNRESOLVABLE;
        } else {
            b.status = Status.FINAL;
            b.price = answer;
        }
        b.roundId = roundId;
        emit BoundaryProven(assetId, timestamp, b.status, b.price, roundId, updatedAt);
    }

    /// @inheritdoc IPriceResolver
    function checkpoint(bytes32 assetId, uint64 timestamp)
        external
        returns (Status status, int256 price)
    {
        (status, price) = priceAt(assetId, timestamp);
        Boundary storage b = _boundaries[assetId][timestamp];
        if (status == Status.UNRESOLVABLE && b.status == Status.PENDING) {
            b.status = Status.UNRESOLVABLE;
            emit BoundaryUnresolvable(assetId, timestamp);
        }
    }

    /// @inheritdoc IPriceResolver
    // slither-disable-next-line unused-return
    function priceAt(bytes32 assetId, uint64 timestamp)
        public
        view
        returns (Status status, int256 price)
    {
        AssetConfig memory cfg = _config(assetId);
        Boundary memory b = _boundaries[assetId][timestamp];
        if (b.status != Status.PENDING) return (b.status, b.price);
        if (block.timestamp > uint256(timestamp) + livenessGrace) {
            return (Status.UNRESOLVABLE, 0);
        }
        if (block.timestamp > uint256(timestamp) + cfg.maxOracleDelay) {
            // Only updatedAt matters for the "no round since T" check.
            // forge-lint: disable-next-line(unused-return)
            (,,, uint256 latestUpdatedAt,) = cfg.feed.latestRoundData();
            if (latestUpdatedAt < timestamp) return (Status.UNRESOLVABLE, 0);
        }
        return (Status.PENDING, 0);
    }

    /// @notice The stored proof for a boundary (roundId is 0 while pending).
    function boundary(bytes32 assetId, uint64 timestamp) external view returns (Boundary memory) {
        return _boundaries[assetId][timestamp];
    }

    function _config(bytes32 assetId) private view returns (AssetConfig memory cfg) {
        cfg = assetConfig[assetId];
        if (address(cfg.feed) == address(0)) revert UnknownAsset(assetId);
    }

    /// @dev Reads a round; reverts RoundNotFound if the proxy reverts or the round is empty.
    // slither-disable-next-line unused-return
    function _round(IAggregatorV3 feed, uint80 roundId)
        private
        view
        returns (int256 answer, uint256 updatedAt)
    {
        try feed.getRoundData(roundId) returns (uint80, int256 a, uint256, uint256 u, uint80) {
            if (u == 0) revert RoundNotFound(roundId);
            return (a, u);
        } catch {
            revert RoundNotFound(roundId);
        }
    }
}
// forge-lint: disable-end(locked-ether)
