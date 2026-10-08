// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title FeeSink
/// @notice The fee recipient of ONE partner market (an EIP-1167 clone made by the PartnerRegistry).
///         `Market.claimFees` is permissionless and pays whatever `feeRecipient()` returns; giving
///         every market its own sink means a fee claimed by anyone is still this market's fee, so
///         the registry can attribute it to the right partner (Phase 8 review, finding H2 round 2).
/// @dev Holds only that market's redeem fees. Only the registry can move them out, and it moves
///      them straight into its own books. The implementation locks itself.
contract FeeSink {
    using SafeERC20 for IERC20;

    address public registry;
    IERC20 public collateral;

    error AlreadyInitialized();
    error OnlyRegistry();
    error ZeroAddress();

    /// @dev Locks the implementation.
    constructor() {
        registry = address(0xdead);
    }

    function initialize(address registry_, IERC20 collateral_) external {
        if (registry != address(0)) revert AlreadyInitialized();
        if (registry_ == address(0) || address(collateral_) == address(0)) revert ZeroAddress();
        registry = registry_;
        collateral = collateral_;
    }

    /// @notice Sends everything this sink holds to the registry. Registry only.
    /// @return amount The collateral moved.
    function pull() external returns (uint256 amount) {
        if (msg.sender != registry) revert OnlyRegistry();
        amount = collateral.balanceOf(address(this));
        if (amount != 0) collateral.safeTransfer(msg.sender, amount);
    }
}
