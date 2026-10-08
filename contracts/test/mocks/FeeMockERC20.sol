// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockERC20} from "./MockERC20.sol";

/// @notice A collateral that can start taking a fee on transfers after the system is set up
///         (e.g. an issuer turning one on later). Fee is zero until `setFeeBps` is called.
contract FeeMockERC20 is MockERC20 {
    uint256 public feeBps;

    constructor() MockERC20("Fee USD", "FUSD", 6) {}

    function setFeeBps(uint256 bps) external {
        feeBps = bps;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (feeBps != 0 && from != address(0) && to != address(0)) {
            uint256 fee = value * feeBps / 10_000;
            super._update(from, address(0), fee); // burned
            value -= fee;
        }
        super._update(from, to, value);
    }
}
