// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Base} from "../Base.t.sol";
import {IPriceResolver} from "../../src/interfaces/IPriceResolver.sol";
import {IVerifierProxy, ReportV3} from "../../src/interfaces/IVerifierProxy.sol";
import {DataStreamsResolver as D} from "../../src/resolvers/DataStreamsResolver.sol";
import {MockStreamsVerifierProxy} from "../mocks/MockStreamsVerifierProxy.sol";

contract DataStreamsResolverTest is Base {
    function test_constructor_rejectsBadConfig() public {
        vm.expectRevert(D.InvalidConfig.selector);
        new D(admin, IVerifierProxy(address(0)), WINDOW, GRACE);
        vm.expectRevert(D.InvalidConfig.selector);
        new D(admin, verifierProxy, 0, GRACE);
        vm.expectRevert(D.InvalidConfig.selector);
        new D(admin, verifierProxy, WINDOW, WINDOW);
    }

    function test_configure_onlyOwner_setOnce_nonZero() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        streamsResolver.configureAsset(BTC, ETH_FEED);
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(D.AssetAlreadyConfigured.selector, ETH));
        streamsResolver.configureAsset(ETH, ETH_FEED);
        vm.expectRevert(D.InvalidConfig.selector);
        streamsResolver.configureAsset(BTC, bytes32(0));
        vm.stopPrank();
        assertTrue(streamsResolver.supportsAsset(ETH));
        assertFalse(streamsResolver.supportsAsset(BTC));
    }

    function test_unknownAsset_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(D.UnknownAsset.selector, BTC));
        streamsResolver.priceAt(BTC, T0);
        vm.expectRevert(abi.encodeWithSelector(D.UnknownAsset.selector, BTC));
        streamsResolver.submit(BTC, T0, "");
    }

    function test_proposal_thenFinalAfterWindow() public {
        vm.warp(T0 + 2);
        bytes memory rep = _report(ETH_FEED, uint32(T0 - 2), uint32(T0 + 1), 3000e18);
        streamsResolver.submit(ETH, T0, rep);
        assertEq(uint8(_status(streamsResolver, ETH, T0)), uint8(IPriceResolver.Status.PENDING));
        vm.warp(T0 + 2 + WINDOW - 1);
        assertEq(uint8(_status(streamsResolver, ETH, T0)), uint8(IPriceResolver.Status.PENDING));
        vm.warp(T0 + 2 + WINDOW);
        (IPriceResolver.Status s, int256 p) = streamsResolver.priceAt(ETH, T0);
        assertEq(uint8(s), uint8(IPriceResolver.Status.FINAL));
        assertEq(p, 3000e18);
    }

    function test_windowBoundsInclusive() public {
        vm.warp(T0 + 2);
        streamsResolver.submit(ETH, T0, _report(ETH_FEED, uint32(T0), uint32(T0), 1e18));
        streamsResolver.submit(ETH, T0 + 60, _report(ETH_FEED, uint32(T0), uint32(T0 + 60), 1e18));
    }

    function test_reportNotContainingBoundary_reverts() public {
        vm.warp(T0 + 5);
        vm.expectRevert(
            abi.encodeWithSelector(
                D.BoundaryNotInReportWindow.selector, T0, uint32(T0 + 1), uint32(T0 + 2)
            )
        );
        streamsResolver.submit(ETH, T0, _report(ETH_FEED, uint32(T0 + 1), uint32(T0 + 2), 1e18));
        vm.expectRevert(
            abi.encodeWithSelector(
                D.BoundaryNotInReportWindow.selector, T0, uint32(T0 - 3), uint32(T0 - 1)
            )
        );
        streamsResolver.submit(ETH, T0, _report(ETH_FEED, uint32(T0 - 3), uint32(T0 - 1), 1e18));
    }

    function test_wrongFeed_reverts() public {
        bytes32 other = 0x0003aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;
        vm.warp(T0 + 5);
        vm.expectRevert(abi.encodeWithSelector(D.WrongFeed.selector, ETH_FEED, other));
        streamsResolver.submit(ETH, T0, _report(other, uint32(T0), uint32(T0), 1e18));
    }

    function test_wrongVersion_reverts() public {
        bytes32 v8 = 0x0008aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;
        vm.warp(T0 + 5);
        vm.expectRevert(abi.encodeWithSelector(D.UnsupportedReportVersion.selector, uint16(8)));
        streamsResolver.submit(ETH, T0, _report(v8, uint32(T0), uint32(T0), 1e18));
    }

    function test_shortReport_reverts() public {
        bytes32[3] memory ctx;
        vm.expectRevert(abi.encodeWithSelector(D.UnsupportedReportVersion.selector, uint16(0)));
        streamsResolver.submit(ETH, T0, abi.encode(ctx, hex"00", hex""));
    }

    function test_nonPositivePrice_reverts() public {
        vm.warp(T0 + 5);
        vm.expectRevert(abi.encodeWithSelector(D.InvalidPrice.selector, int192(0)));
        streamsResolver.submit(ETH, T0, _report(ETH_FEED, uint32(T0), uint32(T0), 0));
    }

    function test_badSignature_reverts() public {
        bytes memory rep = _report(ETH_FEED, uint32(T0), uint32(T0), 1e18);
        (bytes32[3] memory ctx, bytes memory data,) = abi.decode(rep, (bytes32[3], bytes, bytes));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, keccak256("x"));
        vm.warp(T0 + 5);
        vm.expectRevert(MockStreamsVerifierProxy.BadSignature.selector);
        streamsResolver.submit(ETH, T0, abi.encode(ctx, data, abi.encodePacked(r, s, v)));
    }

    function test_replacement_onlyByLowerHash() public {
        vm.warp(T0 + 2);
        bytes memory a = _reportWithBid(ETH_FEED, uint32(T0), uint32(T0), 100e18, 1);
        bytes memory b = _reportWithBid(ETH_FEED, uint32(T0), uint32(T0), 200e18, 2);
        bytes32 ha = keccak256(_data(a));
        bytes32 hb = keccak256(_data(b));
        (bytes memory hi, bytes memory lo, int192 loPrice) =
            ha < hb ? (b, a, int192(100e18)) : (a, b, int192(200e18));
        streamsResolver.submit(ETH, T0, hi);
        uint64 first = streamsResolver.proposal(ETH, T0).firstProposedAt;
        vm.warp(T0 + 30);
        streamsResolver.submit(ETH, T0, lo); // replaces
        assertEq(streamsResolver.proposal(ETH, T0).price, loPrice);
        assertEq(streamsResolver.proposal(ETH, T0).firstProposedAt, first); // window never restarts
        streamsResolver.submit(ETH, T0, hi); // higher hash: ignored
        assertEq(streamsResolver.proposal(ETH, T0).price, loPrice);
        vm.warp(first + WINDOW);
        (, int256 p) = streamsResolver.priceAt(ETH, T0);
        assertEq(p, loPrice);
    }

    function test_submitNoopAfterFinal() public {
        vm.warp(T0 + 2);
        streamsResolver.submit(ETH, T0, _report(ETH_FEED, uint32(T0), uint32(T0), 1e18));
        vm.warp(T0 + 2 + WINDOW);
        streamsResolver.submit(ETH, T0, hex"00"); // would revert if processed
        (, int256 p) = streamsResolver.priceAt(ETH, T0);
        assertEq(p, 1e18);
    }

    function test_noProposal_unresolvableAfterGrace_andRejectsLate() public {
        vm.warp(T0 + GRACE);
        assertEq(uint8(_status(streamsResolver, ETH, T0)), uint8(IPriceResolver.Status.PENDING));
        vm.warp(T0 + GRACE + 1);
        assertEq(
            uint8(_status(streamsResolver, ETH, T0)), uint8(IPriceResolver.Status.UNRESOLVABLE)
        );
        bytes memory rep = _report(ETH_FEED, uint32(T0), uint32(T0), 1e18);
        vm.expectRevert(abi.encodeWithSelector(D.SubmissionWindowClosed.selector, T0));
        streamsResolver.submit(ETH, T0, rep);
    }

    function test_proposalBeforeGraceStillFinalizesAfterGrace() public {
        vm.warp(T0 + GRACE - 1);
        streamsResolver.submit(ETH, T0, _report(ETH_FEED, uint32(T0), uint32(T0), 1e18));
        vm.warp(T0 + GRACE + WINDOW);
        assertEq(uint8(_status(streamsResolver, ETH, T0)), uint8(IPriceResolver.Status.FINAL));
    }

    function test_checkpoint_emitsSettledOnce() public {
        vm.warp(T0 + 2);
        streamsResolver.submit(ETH, T0, _report(ETH_FEED, uint32(T0), uint32(T0), 5e18));
        (IPriceResolver.Status s,) = streamsResolver.checkpoint(ETH, T0);
        assertEq(uint8(s), uint8(IPriceResolver.Status.PENDING));
        vm.warp(T0 + 2 + WINDOW);
        vm.expectEmit(address(streamsResolver));
        emit D.BoundarySettled(ETH, T0, IPriceResolver.Status.FINAL, 5e18);
        streamsResolver.checkpoint(ETH, T0);
        vm.recordLogs();
        streamsResolver.checkpoint(ETH, T0);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_checkpoint_unresolvable() public {
        vm.warp(T0 + GRACE + 1);
        vm.expectEmit(address(streamsResolver));
        emit D.BoundarySettled(ETH, T0, IPriceResolver.Status.UNRESOLVABLE, 0);
        streamsResolver.checkpoint(ETH, T0);
    }

    function test_valueRejectedWhenFinal() public {
        vm.warp(T0 + 2);
        bytes memory rep = _report(ETH_FEED, uint32(T0), uint32(T0), 5e18);
        streamsResolver.submit(ETH, T0, rep);
        vm.warp(T0 + 2 + WINDOW);
        vm.deal(alice, 1);
        vm.prank(alice);
        vm.expectRevert(D.ValueNotUsed.selector);
        streamsResolver.submit{value: 1}(ETH, T0, rep);
    }

    function test_adminFunctions() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        streamsResolver.setParameterPayload(hex"01");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        streamsResolver.withdrawNative(payable(alice), 0);
        vm.startPrank(admin);
        vm.expectEmit(address(streamsResolver));
        emit D.ParameterPayloadSet(hex"01");
        streamsResolver.setParameterPayload(hex"01");
        assertEq(streamsResolver.parameterPayload(), hex"01");
        vm.expectRevert(D.ZeroAddress.selector);
        streamsResolver.withdrawNative(payable(address(0)), 0);
        vm.deal(address(streamsResolver), 5);
        streamsResolver.withdrawNative(payable(treasury), 5);
        assertEq(treasury.balance, 5);
        // a recipient that rejects native transfers
        vm.deal(address(streamsResolver), 1);
        vm.expectRevert(D.NativeTransferFailed.selector);
        streamsResolver.withdrawNative(payable(address(usdc)), 1);
        vm.stopPrank();
    }

    function _data(bytes memory payload) internal pure returns (bytes memory d) {
        (, d,) = abi.decode(payload, (bytes32[3], bytes, bytes));
    }
}
