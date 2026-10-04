// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title OutcomeToken
/// @notice ERC-20 for one side (UP or DOWN) of one market round. Deployed as an EIP-1167 clone.
///         Only its Market can mint and burn. Decimals equal the collateral's decimals, so one
///         token unit is always backed by one collateral unit (as a complete UP+DOWN pair).
contract OutcomeToken is ERC20 {
    /// @notice The Market allowed to mint and burn. Zero until initialized.
    address public market;

    string private _tokenName;
    string private _tokenSymbol;
    uint8 private _tokenDecimals;

    error AlreadyInitialized();
    error OnlyMarket();
    error ZeroAddress();

    /// @dev The implementation is locked: it can never be initialized or used directly.
    constructor() ERC20("", "") {
        market = address(0xdead);
    }

    /// @notice One-time setup, called by the factory in the same transaction as the clone.
    function initialize(
        address market_,
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_
    ) external {
        if (market != address(0)) revert AlreadyInitialized();
        if (market_ == address(0)) revert ZeroAddress();
        market = market_;
        _tokenName = name_;
        _tokenSymbol = symbol_;
        _tokenDecimals = decimals_;
    }

    /// @notice Mints `amount` to `to`. Market only.
    function mint(address to, uint256 amount) external {
        if (msg.sender != market) revert OnlyMarket();
        _mint(to, amount);
    }

    /// @notice Burns `amount` from `from`. Market only (no allowance needed: the Market burns
    ///         only on the holder's own merge/redeem call).
    function burn(address from, uint256 amount) external {
        if (msg.sender != market) revert OnlyMarket();
        _burn(from, amount);
    }

    function name() public view override returns (string memory) {
        return _tokenName;
    }

    function symbol() public view override returns (string memory) {
        return _tokenSymbol;
    }

    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }
}
