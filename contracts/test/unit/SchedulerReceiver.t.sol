// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Base} from "../Base.t.sol";
import {Market} from "../../src/Market.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {SchedulerReceiver as S, IReceiver} from "../../src/scheduler/SchedulerReceiver.sol";

contract SchedulerReceiverTest is Base {
    S internal rx;
    address internal fwd = makeAddr("forwarder");
    address internal wfOwner = makeAddr("workflowOwner");
    bytes32 internal wfId = keccak256("converge-scheduler");
    bytes10 internal wfName = bytes10("scheduler");

    function setUp() public override {
        super.setUp();
        rx = new S(fwd, factory, admin);
        vm.startPrank(admin);
        factory.grantRole(factory.CREATOR_ROLE(), address(rx));
        rx.setWorkflow(wfOwner, wfId);
        vm.stopPrank();
    }

    function _meta(bytes32 id, address owner) internal view returns (bytes memory) {
        return abi.encodePacked(id, wfName, owner, bytes2(0x0001)); // production: 64 bytes
    }

    function _report(uint64 scheduled, S.Action[] memory actions)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(block.chainid, scheduled, actions);
    }

    function _one(S.Kind kind, bytes32 asset, uint64 dur, uint64 start, bytes memory ev)
        internal
        pure
        returns (S.Action[] memory a)
    {
        a = new S.Action[](1);
        a[0] = S.Action(kind, asset, dur, start, ev);
    }

    function _deliver(S.Action[] memory a) internal {
        vm.prank(fwd);
        rx.onReport(_meta(wfId, wfOwner), _report(uint64(vm.getBlockTimestamp()), a));
    }

    // ------------------------------------------------------------------ construction / admin

    function test_constructor_rejectsZero() public {
        vm.expectRevert(S.ZeroAddress.selector);
        new S(address(0), factory, admin);
        vm.expectRevert(S.ZeroAddress.selector);
        new S(fwd, MarketFactory(address(0)), admin);
        vm.expectRevert(S.ZeroAddress.selector);
        new S(fwd, factory, address(0));
    }

    function test_supportsInterface() public view {
        assertTrue(rx.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(rx.supportsInterface(type(IERC165).interfaceId));
        assertFalse(rx.supportsInterface(0xdeadbeef));
    }

    function test_admin_roles() public {
        bytes32 a = rx.DEFAULT_ADMIN_ROLE();
        bytes32 o = rx.OPERATOR_ROLE();
        vm.startPrank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, a
            )
        );
        rx.setWorkflow(alice, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, a
            )
        );
        rx.setMaxReportAge(1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, o
            )
        );
        rx.setLeader(S.Leader.FALLBACK);
        vm.stopPrank();
        vm.startPrank(admin);
        vm.expectRevert(S.ZeroAddress.selector);
        rx.setWorkflow(address(0), 0);
        vm.expectEmit(address(rx));
        emit S.MaxReportAgeSet(60);
        rx.setMaxReportAge(60);
        vm.expectEmit(address(rx));
        emit S.LeaderSet(S.Leader.FALLBACK);
        rx.setLeader(S.Leader.FALLBACK);
        vm.stopPrank();
        assertEq(uint8(rx.leader()), uint8(S.Leader.FALLBACK));
        assertEq(rx.maxReportAge(), 60);
    }

    // ------------------------------------------------------------------ authentication

    function test_onReport_onlyForwarder() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(S.InvalidSender.selector, alice));
        rx.onReport(_meta(wfId, wfOwner), "");
    }

    function test_onReport_requiresConfiguredWorkflow() public {
        S fresh = new S(fwd, factory, admin);
        vm.prank(fwd);
        vm.expectRevert(S.WorkflowNotConfigured.selector);
        fresh.onReport(_meta(wfId, wfOwner), "");
    }

    function test_onReport_checksMetadata() public {
        vm.startPrank(fwd);
        vm.expectRevert(S.BadMetadata.selector);
        rx.onReport(hex"0011", "");
        vm.expectRevert(abi.encodeWithSelector(S.InvalidWorkflowOwner.selector, alice));
        rx.onReport(_meta(wfId, alice), "");
        vm.expectRevert(abi.encodeWithSelector(S.InvalidWorkflowId.selector, bytes32("x")));
        rx.onReport(_meta(bytes32("x"), wfOwner), "");
        vm.stopPrank();
    }

    function test_onReport_anyWorkflowIdWhenUnset_and62ByteMetadata() public {
        vm.prank(admin);
        rx.setWorkflow(wfOwner, bytes32(0));
        vm.prank(fwd);
        rx.onReport(
            abi.encodePacked(bytes32("any"), wfName, wfOwner),
            _report(uint64(block.timestamp), new S.Action[](0))
        );
    }

    function test_onReport_rejectsWrongChainAndStale() public {
        S.Action[] memory none = new S.Action[](0);
        vm.startPrank(fwd);
        vm.expectRevert(abi.encodeWithSelector(S.WrongChain.selector, uint256(1)));
        rx.onReport(_meta(wfId, wfOwner), abi.encode(uint256(1), uint64(block.timestamp), none));
        uint64 old = uint64(block.timestamp - 5 minutes - 1);
        vm.expectRevert(abi.encodeWithSelector(S.StaleReport.selector, old));
        rx.onReport(_meta(wfId, wfOwner), _report(old, none));
        rx.onReport(_meta(wfId, wfOwner), _report(uint64(block.timestamp - 5 minutes), none));
        vm.stopPrank();
    }

    function test_onReport_ignoredWhenFallbackLeads() public {
        vm.prank(admin);
        rx.setLeader(S.Leader.FALLBACK);
        vm.expectEmit(address(rx));
        emit S.ReportIgnored(uint64(block.timestamp), S.Leader.FALLBACK);
        _deliver(_one(S.Kind.CREATE, BTC, M15, T0, ""));
        assertEq(factory.getMarket(BTC, M15, T0), address(0));
    }

    // ------------------------------------------------------------------ actions

    function test_fullLifecycleThroughReports() public {
        _deliver(_one(S.Kind.CREATE, BTC, M15, T0, ""));
        Market m = Market(factory.getMarket(BTC, M15, T0));
        assertTrue(address(m) != address(0));
        vm.warp(T0 + 10);
        _deliver(_one(S.Kind.OPEN, BTC, M15, T0, _round(2, 100e8, T0 + 1)));
        assertEq(uint8(m.state()), uint8(Market.State.OPEN));
        vm.warp(T0 + M15 + 10);
        _deliver(_one(S.Kind.RESOLVE, BTC, M15, T0, _round(3, 99e8, T0 + M15 + 1)));
        assertEq(uint8(m.state()), uint8(Market.State.RESOLVED_DOWN));
    }

    function test_invalidateAction() public {
        _deliver(_one(S.Kind.CREATE, ETH, M15, T0, ""));
        vm.warp(T0 + GRACE + 1);
        _deliver(_one(S.Kind.INVALIDATE, ETH, M15, T0, ""));
        assertEq(
            uint8(Market(factory.getMarket(ETH, M15, T0)).state()), uint8(Market.State.INVALID)
        );
    }

    function test_failuresAreIsolatedAndReported() public {
        S.Action[] memory a = new S.Action[](4);
        a[0] = S.Action(S.Kind.CREATE, BTC, M15, T0, "");
        a[1] = S.Action(S.Kind.CREATE, BTC, M15, T0, ""); // duplicate -> MarketExists
        a[2] = S.Action(S.Kind.OPEN, BTC, M15, T0 + M15, ""); // no such market
        a[3] = S.Action(S.Kind.CREATE, BTC, H1, T0 + 45 minutes, "");
        vm.expectEmit(address(rx));
        emit S.ActionExecuted(S.Kind.CREATE, BTC, M15, T0, true, bytes4(0));
        vm.expectEmit(address(rx));
        emit S.ActionExecuted(
            S.Kind.CREATE, BTC, M15, T0, false, MarketFactory.MarketExists.selector
        );
        vm.expectEmit(address(rx));
        emit S.ActionExecuted(S.Kind.OPEN, BTC, M15, T0 + M15, false, S.MarketNotFound.selector);
        vm.expectEmit(address(rx));
        emit S.ActionExecuted(S.Kind.CREATE, BTC, H1, T0 + 45 minutes, true, bytes4(0));
        vm.expectEmit(address(rx));
        emit S.ReportProcessed(uint64(block.timestamp), 4, 2);
        _deliver(a);
        assertTrue(factory.getMarket(BTC, H1, T0 + 45 minutes) != address(0));
    }

    function test_openTooEarlyAndResolveFailuresReportSelector() public {
        _deliver(_one(S.Kind.CREATE, BTC, M15, T0, ""));
        vm.expectEmit(address(rx));
        emit S.ActionExecuted(S.Kind.OPEN, BTC, M15, T0, false, Market.TooEarly.selector);
        _deliver(_one(S.Kind.OPEN, BTC, M15, T0, ""));
        vm.expectEmit(address(rx));
        emit S.ActionExecuted(S.Kind.RESOLVE, BTC, M15, T0, false, Market.WrongState.selector);
        _deliver(_one(S.Kind.RESOLVE, BTC, M15, T0, ""));
        vm.expectEmit(address(rx));
        emit S.ActionExecuted(
            S.Kind.INVALIDATE, BTC, M15, T0, false, Market.NotUnresolvable.selector
        );
        _deliver(_one(S.Kind.INVALIDATE, BTC, M15, T0, ""));
    }

    function test_createWithoutRoleFailsGracefully() public {
        bytes32 creatorRole = factory.CREATOR_ROLE();
        vm.prank(admin);
        factory.revokeRole(creatorRole, address(rx));
        _deliver(_one(S.Kind.CREATE, BTC, M15, T0, ""));
        assertEq(factory.getMarket(BTC, M15, T0), address(0));
    }

    function test_createWhilePausedFailsGracefully() public {
        vm.prank(guardian);
        factory.pause();
        _deliver(_one(S.Kind.CREATE, BTC, M15, T0, ""));
        assertEq(factory.getMarket(BTC, M15, T0), address(0));
    }
}
