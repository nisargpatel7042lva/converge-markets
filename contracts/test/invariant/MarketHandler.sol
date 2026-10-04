// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Market} from "../../src/Market.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OutcomeToken} from "../../src/OutcomeToken.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";

/// @notice Drives random sequences of user + oracle + admin actions against several markets.
///         Ghost variables track every collateral unit that enters or leaves each market.
contract MarketHandler is Test {
    MarketFactory public factory;
    MockERC20 public usdc;
    MockAggregator public feed;
    address public guardian;
    address public admin;

    Market[] public markets;
    address[] public actors;

    mapping(address market => uint256) public ghostIn;
    mapping(address market => uint256) public ghostOut;
    mapping(address actor => uint256) public deposited;
    mapping(address actor => uint256) public withdrawn;
    /// @dev Outcome tokens received from other actors (each worth at most 1 collateral unit).
    mapping(address actor => uint256) public tokensReceived;
    uint256 public totalDeposited;
    uint256 public totalWithdrawn;
    /// @dev Coverage counters: prove the run reached every lifecycle path.
    uint256 public opened;
    uint256 public resolved;
    uint256 public invalidated;
    uint256 public redeems;

    uint16 internal phase = 1;
    uint64 internal aggRound = 1;

    constructor(
        MarketFactory f,
        MockERC20 u,
        MockAggregator fd,
        Market[] memory ms,
        address guardian_,
        address admin_
    ) {
        factory = f;
        usdc = u;
        feed = fd;
        guardian = guardian_;
        admin = admin_;
        for (uint256 i; i < ms.length; ++i) {
            markets.push(ms[i]);
        }
        actors.push(makeAddr("actor0"));
        actors.push(makeAddr("actor1"));
        actors.push(makeAddr("actor2"));
    }

    function marketsLength() external view returns (uint256) {
        return markets.length;
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function _m(uint256 i) internal view returns (Market) {
        return markets[i % markets.length];
    }

    function _a(uint256 i) internal view returns (address) {
        return actors[i % actors.length];
    }

    // ------------------------------------------------------------------ user actions

    function split(uint256 ai, uint256 mi, uint256 amount) external {
        Market m = _m(mi);
        address a = _a(ai);
        amount = bound(amount, 1, 1_000_000e6);
        Market.State s = m.state();
        if (factory.paused() || (s != Market.State.CREATED && s != Market.State.OPEN)) return;
        usdc.mint(a, amount);
        vm.startPrank(a);
        usdc.approve(address(m), amount);
        m.split(amount);
        vm.stopPrank();
        ghostIn[address(m)] += amount;
        deposited[a] += amount;
        totalDeposited += amount;
    }

    function merge(uint256 ai, uint256 mi, uint256 amount) external {
        Market m = _m(mi);
        address a = _a(ai);
        uint256 maxAmt = _min(m.up().balanceOf(a), m.down().balanceOf(a));
        if (maxAmt == 0) return;
        amount = bound(amount, 1, maxAmt);
        vm.prank(a);
        m.merge(amount);
        ghostOut[address(m)] += amount;
        withdrawn[a] += amount;
        totalWithdrawn += amount;
    }

    function transferToken(uint256 fromI, uint256 toI, uint256 mi, bool upSide, uint256 amount)
        external
    {
        Market m = _m(mi);
        address from = _a(fromI);
        address to = _a(toI);
        if (from == to) return;
        OutcomeToken t = upSide ? m.up() : m.down();
        uint256 bal = t.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(from);
        t.transfer(to, amount);
        tokensReceived[to] += amount;
    }

    function redeem(uint256 ai, uint256 mi) external {
        Market m = _m(mi);
        address a = _a(ai);
        Market.State s = m.state();
        if (s == Market.State.CREATED || s == Market.State.OPEN) return;
        if (m.up().balanceOf(a) == 0 && m.down().balanceOf(a) == 0) return;
        uint256 before = usdc.balanceOf(a);
        vm.prank(a);
        m.redeem();
        redeems += 1;
        uint256 got = usdc.balanceOf(a) - before;
        ghostOut[address(m)] += got;
        withdrawn[a] += got;
        totalWithdrawn += got;
    }

    // ------------------------------------------------------------------ oracle + time

    /// @dev Advances time up to 10 minutes. For every 15-minute boundary crossed, a healthy feed
    ///      publishes a round 0-59 s after it; about 1 in 7 boundaries is skipped (stale feed),
    ///      which drives the INVALID paths.
    function warp(uint256 secs) external {
        secs = bound(secs, 1, 10 minutes);
        uint256 from = vm.getBlockTimestamp();
        uint256 to = from + secs;
        uint256 b = from - (from % 15 minutes) + 15 minutes;
        for (; b <= to; b += 15 minutes) {
            if (uint256(keccak256(abi.encode(b, secs))) % 7 == 0) continue;
            uint256 at = b + (secs % 60);
            if (at > to) at = to;
            vm.warp(at);
            aggRound += 1;
            int256 px = int256(99e8 + (uint256(keccak256(abi.encode(b))) % 3) * 1e8);
            feed.setRound(phase, aggRound, px, at);
        }
        vm.warp(to);
    }

    /// @dev Publishes a feed round now with a random price (sometimes equal to the last one).
    function pushRound(uint256 price) external {
        aggRound += 1;
        feed.setRound(phase, aggRound, int256(bound(price, 99e8, 101e8)), block.timestamp);
    }

    /// @dev Proves the boundary the market waits on (if a first round exists) and opens/resolves.
    function advance(uint256 mi) external {
        Market m = _m(mi);
        Market.State s = m.state();
        if (s == Market.State.CREATED) {
            if (block.timestamp < m.startTime()) return;
            _drive(m, m.startTime(), true);
        } else if (s == Market.State.OPEN) {
            if (block.timestamp < m.endTime()) return;
            _drive(m, m.endTime(), false);
        }
        _count(s, m.state());
    }

    function invalidate(uint256 mi) external {
        Market m = _m(mi);
        Market.State s = m.state();
        if (s != Market.State.CREATED && s != Market.State.OPEN) return;
        try m.invalidate() {} catch {}
        _count(s, m.state());
    }

    function _count(Market.State before, Market.State afterS) internal {
        if (before == afterS) return;
        if (afterS == Market.State.OPEN) opened += 1;
        else if (afterS == Market.State.INVALID) invalidated += 1;
        else resolved += 1;
    }

    // ------------------------------------------------------------------ admin

    function togglePause(bool p) external {
        if (p && !factory.paused()) {
            vm.prank(guardian);
            factory.pause();
        } else if (!p && factory.paused()) {
            vm.prank(admin);
            factory.unpause();
        }
    }

    // ------------------------------------------------------------------ internals

    function _drive(Market m, uint64 boundary, bool opening) internal {
        bytes memory proof = _firstRoundProof(boundary);
        // Model a live feed: if nothing was published since the boundary and we are still
        // within the oracle delay, publish a round now (sometimes at the same price -> ties).
        if (proof.length == 0 && block.timestamp <= uint256(boundary) + 120) {
            aggRound += 1;
            int256 px = int256(
                99e8 + (uint256(keccak256(abi.encode(block.timestamp, boundary))) % 3) * 1e8
            );
            feed.setRound(phase, aggRound, px, block.timestamp);
            proof = _firstRoundProof(boundary);
        }
        if (opening) {
            try m.open(proof) {} catch {}
        } else {
            try m.resolve(proof) {} catch {}
        }
    }

    /// @dev Finds the first round (current phase) with updatedAt >= boundary, if any.
    function _firstRoundProof(uint64 boundary) internal view returns (bytes memory) {
        uint64 first;
        for (uint64 r = aggRound; r >= 2; --r) {
            (,,, uint256 u,) = feed.getRoundData(feed.id(phase, r));
            if (u >= boundary) first = r;
            else break;
        }
        if (first == 0) return "";
        return abi.encode(feed.id(phase, first));
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
