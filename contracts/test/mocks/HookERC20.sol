// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockERC20} from "./MockERC20.sol";

interface ITransferHook {
    function onTransferHook() external;
}

/// @notice An ERC-777 style collateral for the reentrancy tests: before a transfer leaves a hooked
///         account and after one arrives at it, the account's `onTransferHook` runs. A hostile
///         depositor, receiver or executor is exactly such a contract. Tests only.
contract HookERC20 is MockERC20 {
    mapping(address => bool) public hooked;

    constructor() MockERC20("Hook USD", "hUSD", 6) {}

    function setHooked(address account, bool on) external {
        hooked[account] = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && hooked[from]) ITransferHook(from).onTransferHook();
        super._update(from, to, value);
        if (to != address(0) && hooked[to]) ITransferHook(to).onTransferHook();
    }
}
