// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAggregatorV3
/// @notice Subset of Chainlink's AggregatorV3Interface used by ChainlinkRoundResolver.
/// @dev Signatures match the Chainlink proxy contracts read onchain on Monad (docs/EXTERNAL.md):
///      decimals(), description(), latestRoundData(), getRoundData(uint80).
///      Proxy round ids encode (phaseId << 64) | aggregatorRoundId.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function description() external view returns (string memory);

    function getRoundData(uint80 roundId)
        external
        view
        returns (
            uint80 roundId_,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}
