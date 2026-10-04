// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "../Base.t.sol";
import {Market} from "../../src/Market.sol";

contract MarketFuzzTest is Base {
    Market internal m;

    function setUp() public override {
        super.setUp();
        m = _create(BTC, M15, T0);
    }

    /// split then merge returns exactly what was put in, for any amount and actor.
    function testFuzz_splitMergeConserves(address actor, uint256 amount, uint256 mergeAmt) public {
        vm.assume(actor != address(0) && actor != address(m) && actor.code.length == 0);
        amount = bound(amount, 1, type(uint128).max);
        mergeAmt = bound(mergeAmt, 1, amount);
        usdc.mint(actor, amount);
        vm.startPrank(actor);
        usdc.approve(address(m), amount);
        m.split(amount);
        m.merge(mergeAmt);
        assertEq(usdc.balanceOf(actor), mergeAmt);
        if (amount > mergeAmt) m.merge(amount - mergeAmt);
        vm.stopPrank();
        assertEq(usdc.balanceOf(actor), amount);
        assertEq(usdc.balanceOf(address(m)), 0);
    }

    function testFuzz_splitThenFullMerge(address actor, uint256 amount) public {
        vm.assume(actor != address(0) && actor != address(m) && actor.code.length == 0);
        amount = bound(amount, 1, type(uint128).max);
        usdc.mint(actor, amount);
        vm.startPrank(actor);
        usdc.approve(address(m), amount);
        m.split(amount);
        m.merge(amount);
        vm.stopPrank();
        assertEq(usdc.balanceOf(actor), amount);
        assertEq(usdc.balanceOf(address(m)), 0);
        assertEq(m.up().totalSupply(), 0);
        assertEq(m.down().totalSupply(), 0);
    }

    /// Whatever the outcome, a holder of both sides redeems exactly their stake (fee 0).
    function testFuzz_pairAlwaysWorthOne(uint256 amount, int256 endPx, bool invalid) public {
        amount = bound(amount, 1, type(uint128).max);
        _split(m, alice, amount);
        if (invalid) {
            vm.warp(T0 + LIVENESS + 1);
            m.invalidate();
        } else {
            endPx = bound(endPx, 1, 1e30);
            vm.warp(T0 + 10);
            m.open(_round(2, 100e8, T0 + 1));
            vm.warp(T0 + M15 + 10);
            m.resolve(_round(3, endPx, T0 + M15 + 1));
        }
        vm.prank(alice);
        m.redeem();
        assertEq(usdc.balanceOf(alice), amount);
    }
}
