// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Base} from "../Base.t.sol";
import {IPriceResolver} from "../../src/interfaces/IPriceResolver.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {ChainlinkRoundResolver as R} from "../../src/resolvers/ChainlinkRoundResolver.sol";
import {MockAggregator, ZeroingAggregator} from "../mocks/MockAggregator.sol";

contract ChainlinkRoundResolverTest is Base {
    // feed history from Base.setUp: phase 1 round 1 @ T0-30m

    function test_constructor_rejectsZeroGrace() public {
        vm.expectRevert(R.InvalidConfig.selector);
        new R(admin, 0);
    }

    function test_configure_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        roundResolver.configureAsset(ETH, feed, 60);
    }

    function test_configure_setOnce() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(R.AssetAlreadyConfigured.selector, BTC));
        roundResolver.configureAsset(BTC, feed, 60);
    }

    function test_configure_rejectsBadParams() public {
        vm.startPrank(admin);
        vm.expectRevert(R.InvalidConfig.selector);
        roundResolver.configureAsset(ETH, IAggregatorV3(address(0)), 60);
        vm.expectRevert(R.InvalidConfig.selector);
        roundResolver.configureAsset(ETH, feed, 0);
        vm.expectRevert(R.InvalidConfig.selector);
        roundResolver.configureAsset(ETH, feed, uint32(LIVENESS));
        vm.stopPrank();
    }

    function test_supportsAsset() public view {
        assertTrue(roundResolver.supportsAsset(BTC));
        assertFalse(roundResolver.supportsAsset(ETH));
    }

    function test_unknownAsset_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(R.UnknownAsset.selector, ETH));
        roundResolver.priceAt(ETH, T0);
        vm.expectRevert(abi.encodeWithSelector(R.UnknownAsset.selector, ETH));
        roundResolver.submit(ETH, T0, abi.encode(uint80(1)));
    }

    function test_validProof_final() public {
        vm.warp(T0 + 10);
        uint80 id = feed.setRound(1, 2, 61_000e8, T0 + 7);
        vm.expectEmit(address(roundResolver));
        emit R.BoundaryProven(BTC, T0, IPriceResolver.Status.FINAL, 61_000e8, id, T0 + 7);
        roundResolver.submit(BTC, T0, abi.encode(id));
        (IPriceResolver.Status s, int256 p) = roundResolver.priceAt(BTC, T0);
        assertEq(uint8(s), uint8(IPriceResolver.Status.FINAL));
        assertEq(p, 61_000e8);
        assertEq(roundResolver.boundary(BTC, T0).roundId, id);
    }

    function test_proofExactlyAtBoundary() public {
        vm.warp(T0 + 10);
        uint80 id = feed.setRound(1, 2, 1e8, T0);
        roundResolver.submit(BTC, T0, abi.encode(id));
        assertEq(uint8(_status(roundResolver, BTC, T0)), uint8(IPriceResolver.Status.FINAL));
    }

    function test_proofAtMaxDelayIsFinal() public {
        vm.warp(T0 + 500);
        uint80 id = feed.setRound(1, 2, 1e8, T0 + MAX_DELAY);
        roundResolver.submit(BTC, T0, abi.encode(id));
        assertEq(uint8(_status(roundResolver, BTC, T0)), uint8(IPriceResolver.Status.FINAL));
    }

    function test_proofBeyondMaxDelayIsUnresolvable() public {
        vm.warp(T0 + 500);
        uint80 id = feed.setRound(1, 2, 1e8, T0 + MAX_DELAY + 1);
        roundResolver.submit(BTC, T0, abi.encode(id));
        assertEq(uint8(_status(roundResolver, BTC, T0)), uint8(IPriceResolver.Status.UNRESOLVABLE));
    }

    function test_wrongRound_notFirst() public {
        vm.warp(T0 + 100);
        feed.setRound(1, 2, 1e8, T0 + 5);
        uint80 id3 = feed.setRound(1, 3, 2e8, T0 + 50);
        vm.expectRevert(abi.encodeWithSelector(R.NotFirstRound.selector, id3));
        roundResolver.submit(BTC, T0, abi.encode(id3));
    }

    function test_wrongRound_beforeBoundary() public {
        vm.warp(T0 + 100);
        uint80 id1 = feed.id(1, 1);
        vm.expectRevert(
            abi.encodeWithSelector(R.RoundBeforeBoundary.selector, id1, T0 - 30 minutes)
        );
        roundResolver.submit(BTC, T0, abi.encode(id1));
    }

    function test_roundFromAnotherPhase_firstOfPhaseRejected() public {
        vm.warp(T0 + 100);
        uint80 id = feed.setRound(2, 1, 1e8, T0 + 5); // phase 2 round 1
        vm.expectRevert(abi.encodeWithSelector(R.FirstRoundOfPhase.selector, id));
        roundResolver.submit(BTC, T0, abi.encode(id));
    }

    function test_roundFromAnotherPhase_noPredecessorInPhase() public {
        // phase 2, round 2 exists but phase-2 round 1 does not: predecessor lookup fails.
        vm.warp(T0 + 100);
        uint80 id = feed.setRound(2, 2, 1e8, T0 + 5);
        vm.expectRevert(abi.encodeWithSelector(R.RoundNotFound.selector, id - 1));
        roundResolver.submit(BTC, T0, abi.encode(id));
    }

    function test_roundFromAnotherPhase_validWithinPhase() public {
        vm.warp(T0 + 100);
        feed.setRound(2, 1, 1e8, T0 - 10);
        uint80 id = feed.setRound(2, 2, 2e8, T0 + 5);
        roundResolver.submit(BTC, T0, abi.encode(id));
        (, int256 p) = roundResolver.priceAt(BTC, T0);
        assertEq(p, 2e8);
    }

    function test_missingRound_reverts() public {
        vm.warp(T0 + 100);
        uint80 id = feed.id(1, 9);
        vm.expectRevert(abi.encodeWithSelector(R.RoundNotFound.selector, id));
        roundResolver.submit(BTC, T0, abi.encode(id));
    }

    function test_zeroedRound_reverts() public {
        ZeroingAggregator z = new ZeroingAggregator();
        vm.prank(admin);
        roundResolver.configureAsset(ETH, z, 60);
        vm.warp(T0 + 100);
        vm.expectRevert(abi.encodeWithSelector(R.RoundNotFound.selector, uint80(5)));
        roundResolver.submit(ETH, T0, abi.encode(uint80(5)));
    }

    function test_nonPositiveAnswer_reverts() public {
        vm.warp(T0 + 100);
        uint80 id = feed.setRound(1, 2, 0, T0 + 5);
        vm.expectRevert(abi.encodeWithSelector(R.InvalidAnswer.selector, int256(0)));
        roundResolver.submit(BTC, T0, abi.encode(id));
    }

    function test_badProofLength_reverts() public {
        vm.expectRevert(R.BadProofLength.selector);
        roundResolver.submit(BTC, T0, hex"01");
    }

    function test_submitIsNoopOnceDecided() public {
        vm.warp(T0 + 10);
        uint80 id = feed.setRound(1, 2, 5e8, T0 + 1);
        roundResolver.submit(BTC, T0, abi.encode(id));
        roundResolver.submit(BTC, T0, hex"01"); // would revert if processed
        (, int256 p) = roundResolver.priceAt(BTC, T0);
        assertEq(p, 5e8);
    }

    function test_pendingBeforeDelay() public {
        vm.warp(T0 + MAX_DELAY);
        assertEq(uint8(_status(roundResolver, BTC, T0)), uint8(IPriceResolver.Status.PENDING));
    }

    function test_staleFeed_unresolvableAfterDelay() public {
        vm.warp(T0 + MAX_DELAY + 1); // latest round is T0-30m
        assertEq(uint8(_status(roundResolver, BTC, T0)), uint8(IPriceResolver.Status.UNRESOLVABLE));
    }

    function test_roundExistsButUnproven_pendingUntilLiveness() public {
        feed.setRound(1, 2, 1e8, T0 + 5);
        vm.warp(T0 + 1 hours);
        assertEq(uint8(_status(roundResolver, BTC, T0)), uint8(IPriceResolver.Status.PENDING));
        vm.warp(T0 + LIVENESS + 1);
        assertEq(uint8(_status(roundResolver, BTC, T0)), uint8(IPriceResolver.Status.UNRESOLVABLE));
    }

    function test_proofRejectedAfterLiveness() public {
        uint80 id = feed.setRound(1, 2, 1e8, T0 + 5);
        vm.warp(T0 + LIVENESS + 1);
        vm.expectRevert(abi.encodeWithSelector(R.ProofWindowClosed.selector, T0));
        roundResolver.submit(BTC, T0, abi.encode(id));
    }

    function test_rejectsValue() public {
        vm.warp(T0 + 10);
        uint80 id = feed.setRound(1, 2, 1e8, T0 + 1);
        vm.deal(alice, 1);
        vm.prank(alice);
        vm.expectRevert(R.NoValueAccepted.selector);
        roundResolver.submit{value: 1}(BTC, T0, abi.encode(id));
    }

    /// Aggregator migration: the old phase keeps transmitting while the proxy points at the new
    /// phase. Only current-phase proofs are accepted, so a submitter cannot pick between phases.
    function test_crossPhase_onlyCurrentPhaseAccepted() public {
        vm.warp(T0 + 10);
        uint80 oldId = feed.setRound(1, 2, 100e8, T0 + 2); // old phase, valid shape
        feed.setRound(2, 1, 150e8, T0 - 60);
        uint80 newId = feed.setRound(2, 2, 200e8, T0 + 3); // proxy now on phase 2
        vm.expectRevert(abi.encodeWithSelector(R.NotCurrentPhase.selector, oldId, newId));
        roundResolver.submit(BTC, T0, abi.encode(oldId));
        roundResolver.submit(BTC, T0, abi.encode(newId));
        (, int256 p) = roundResolver.priceAt(BTC, T0);
        assertEq(p, 200e8);
    }

    /// Once UNRESOLVABLE is checkpointed it can never become FINAL (adjacent rounds agree).
    function test_checkpoint_makesUnresolvablePermanent() public {
        vm.warp(T0 + MAX_DELAY + 1); // stale: no round since T0
        vm.expectEmit(address(roundResolver));
        emit R.BoundaryUnresolvable(BTC, T0);
        (IPriceResolver.Status s,) = roundResolver.checkpoint(BTC, T0);
        assertEq(uint8(s), uint8(IPriceResolver.Status.UNRESOLVABLE));
        // a late round arrives: without the checkpoint the view would fall back to PENDING
        uint80 id = feed.setRound(1, 2, 1e8, block.timestamp);
        roundResolver.submit(BTC, T0, abi.encode(id)); // no-op: already decided
        assertEq(uint8(_status(roundResolver, BTC, T0)), uint8(IPriceResolver.Status.UNRESOLVABLE));
        roundResolver.checkpoint(BTC, T0); // idempotent, no second event
    }

    function test_checkpoint_pendingAndFinalPassThrough() public {
        vm.warp(T0 + 10);
        (IPriceResolver.Status s,) = roundResolver.checkpoint(BTC, T0);
        assertEq(uint8(s), uint8(IPriceResolver.Status.PENDING));
        roundResolver.submit(BTC, T0, _round(2, 9e8, T0 + 1));
        int256 p;
        (s, p) = roundResolver.checkpoint(BTC, T0);
        assertEq(uint8(s), uint8(IPriceResolver.Status.FINAL));
        assertEq(p, 9e8);
    }

    function test_adjacentRoundsShareBoundary() public {
        vm.warp(T0 + M15 + 10);
        uint80 id = feed.setRound(1, 2, 7e8, T0 + M15 + 2);
        roundResolver.submit(BTC, T0 + M15, abi.encode(id));
        // settlement of [T0, T0+15m) and strike of [T0+15m, T0+30m) read the same record
        (, int256 p) = roundResolver.priceAt(BTC, T0 + M15);
        assertEq(p, 7e8);
    }
}
