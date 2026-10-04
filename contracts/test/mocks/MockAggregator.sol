// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";

/// @notice Chainlink proxy mock with an explicit round history. Round ids follow the proxy
///         encoding (phaseId << 64) | aggregatorRoundId. Missing rounds revert like Chainlink
///         ("No data present"). Tests and testnet only.
contract MockAggregator is IAggregatorV3 {
    struct Round {
        int256 answer;
        uint256 updatedAt;
    }

    uint8 public immutable override decimals;
    mapping(uint80 => Round) public rounds;
    uint80 public latestId;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function description() external pure returns (string memory) {
        return "MOCK / USD";
    }

    function id(uint16 phase, uint64 aggRound) public pure returns (uint80) {
        return (uint80(phase) << 64) | aggRound;
    }

    /// @notice Writes a round and makes it the latest.
    function setRound(uint16 phase, uint64 aggRound, int256 answer, uint256 updatedAt)
        external
        returns (uint80 roundId)
    {
        roundId = id(phase, aggRound);
        rounds[roundId] = Round(answer, updatedAt);
        latestId = roundId;
    }

    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        Round memory r = rounds[roundId];
        require(r.updatedAt != 0, "No data present");
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = rounds[latestId];
        return (latestId, r.answer, r.updatedAt, r.updatedAt, latestId);
    }
}

/// @notice Returns zeroed data instead of reverting for unknown rounds.
contract ZeroingAggregator is IAggregatorV3 {
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external pure returns (string memory) {
        return "ZERO";
    }

    function getRoundData(uint80) external pure returns (uint80, int256, uint256, uint256, uint80) {
        return (0, 0, 0, 0, 0);
    }

    function latestRoundData() external pure returns (uint80, int256, uint256, uint256, uint80) {
        return (0, 0, 0, 0, 0);
    }
}
