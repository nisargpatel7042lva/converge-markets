// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "../Base.t.sol";
import {Market} from "../../src/Market.sol";
import {IPriceResolver} from "../../src/interfaces/IPriceResolver.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {SchedulerLens as L} from "../../src/scheduler/SchedulerLens.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";

contract SchedulerLensTest is Base {
    L internal lens = new L();

    function _query(uint64 now_, uint64 lookback, uint64 epoch)
        internal
        view
        returns (L.Query memory q)
    {
        uint64[] memory d15 = new uint64[](1);
        d15[0] = M15;
        q.factory = factory;
        q.assets = new L.AssetQuery[](2);
        q.assets[0] = L.AssetQuery(BTC, L.ResolverKind.ROUND, d15);
        q.assets[1] = L.AssetQuery(ETH, L.ResolverKind.STREAMS, d15);
        q.now_ = now_;
        q.lookahead = 3;
        q.lookback = lookback;
        q.epoch = epoch;
    }

    function test_snapshot_missingUpcomingAndDueBoundaries() public {
        // now = T0 - 10 min: upcoming starts T0, T0+15m, T0+30m are all missing
        L.Slot[] memory s0 = lens.snapshot(_query(uint64(vm.getBlockTimestamp()), 2 hours, 0));
        assertEq(s0.length, 2 * (3 + 8)); // 3 upcoming + 8 recent (all missing) per asset
        Market m = _create(BTC, M15, T0);
        _create(ETH, M15, T0);
        vm.warp(T0 + 10);
        // BTC round proof available: first round at/after T0
        feed.setRound(1, 2, 61_000e8, T0 + 3);
        L.Slot[] memory s = lens.snapshot(_query(uint64(vm.getBlockTimestamp()), 30 minutes, T0));
        // epoch=T0 filters recent; T0 slots now due (boundary = start)
        bool sawBtc;
        bool sawEth;
        uint80 btcProof;
        for (uint256 i; i < s.length; ++i) {
            if (s[i].startTime != T0) continue;
            if (s[i].assetId == BTC) {
                sawBtc = true;
                assertEq(s[i].market, address(m));
                assertEq(s[i].boundary, T0);
                assertEq(s[i].boundaryStatus, uint8(IPriceResolver.Status.PENDING));
                assertEq(uint8(s[i].finding), uint8(L.Finding.FOUND));
                assertEq(s[i].roundId, feed.id(1, 2));
                btcProof = s[i].roundId;
            } else {
                sawEth = true;
                assertFalse(s[i].proposalPending);
                assertEq(uint8(s[i].finding), uint8(L.Finding.NONE));
            }
        }
        assertTrue(sawBtc && sawEth);
        // the lens proof is accepted by the resolver -> open, after which the slot disappears
        m.open(abi.encode(btcProof));
        L.Slot[] memory after_ =
            lens.snapshot(_query(uint64(vm.getBlockTimestamp()), 30 minutes, T0));
        for (uint256 i; i < after_.length; ++i) {
            assertFalse(after_[i].market == address(m), "settled/not-due slots are omitted");
        }
    }

    function test_snapshot_streamsProposalPending() public {
        Market em = _create(ETH, M15, T0);
        vm.warp(T0 + 3);
        em.open(_report(ETH_FEED, uint32(T0), uint32(T0), 3000e18));
        L.Slot[] memory s = lens.snapshot(_query(uint64(vm.getBlockTimestamp()), 30 minutes, T0));
        bool found;
        for (uint256 i; i < s.length; ++i) {
            if (s[i].market == address(em)) {
                found = true;
                assertTrue(s[i].proposalPending);
            }
        }
        assertTrue(found);
    }

    function test_snapshot_respectsEpochAndLookback() public {
        vm.warp(T0 + 5 hours + 60); // not on a boundary (a round starting exactly now would be "missed")
        uint64 nowTs = uint64(block.timestamp);
        L.Slot[] memory a = lens.snapshot(_query(nowTs, 1 hours, 0));
        L.Slot[] memory b = lens.snapshot(_query(nowTs, 4 hours, 0));
        L.Slot[] memory c = lens.snapshot(_query(nowTs, 4 hours, nowTs));
        assertEq(a.length, 2 * (3 + 4));
        assertEq(b.length, 2 * (3 + 16));
        assertEq(c.length, 2 * 3); // only upcoming survive the epoch
    }

    function test_findings() public {
        MockAggregator f = new MockAggregator(8);
        assertEq(_finding(f, 100), uint8(L.Finding.NOT_YET)); // empty feed
        f.setRound(1, 1, 1, 50);
        assertEq(_finding(f, 100), uint8(L.Finding.NOT_YET));
        f.setRound(1, 2, 1, 150);
        assertEq(_finding(f, 100), uint8(L.Finding.FOUND));
        f.setRound(2, 1, 1, 200); // new phase, round 1 is first at/after 180
        assertEq(_finding(f, 180), uint8(L.Finding.FIRST_OF_PHASE));
        // missing round inside the phase
        MockAggregator g = new MockAggregator(8);
        for (uint64 i = 1; i <= 8; ++i) {
            g.setRound(1, i, 1, i * 100);
        }
        vm.mockCallRevert(address(g), abi.encodeCall(IAggregatorV3.getRoundData, (g.id(1, 4))), "");
        assertEq(_finding(g, 350), uint8(L.Finding.MISSING_ROUND));
    }

    function _finding(MockAggregator f, uint64 t) internal view returns (uint8) {
        (L.Finding k,) = lens.firstRoundAtOrAfter(IAggregatorV3(address(f)), t);
        return uint8(k);
    }

    /// The lens's onchain search always returns the unique proof ChainlinkRoundResolver accepts.
    function testFuzz_lensProofIsAcceptedByResolver(uint64 n, uint64 seed, uint64 tOffset) public {
        n = uint64(bound(n, 2, 300));
        MockAggregator f = new MockAggregator(8);
        uint256 ts = 1_000_000;
        for (uint64 i = 1; i <= n; ++i) {
            ts += 1 + (uint256(keccak256(abi.encode(seed, i))) % 900); // gaps 1..900 s
            f.setRound(1, i, int256(uint256(i)), ts);
        }
        uint64 t = uint64(1_000_001 + bound(tOffset, 0, ts - 1_000_001));
        (L.Finding k, uint80 id) = lens.firstRoundAtOrAfter(IAggregatorV3(address(f)), t);
        (,,, uint256 lastUpdated,) = f.latestRoundData();
        if (k == L.Finding.FOUND) {
            (,,, uint256 u,) = f.getRoundData(id);
            (,,, uint256 prev,) = f.getRoundData(id - 1);
            assertGe(u, t);
            assertLt(prev, t);
        } else if (k == L.Finding.FIRST_OF_PHASE) {
            (,,, uint256 u1,) = f.getRoundData(f.id(1, 1));
            assertGe(u1, t);
        } else {
            assertEq(uint8(k), uint8(L.Finding.NOT_YET));
            assertLt(lastUpdated, t);
        }
    }
}
