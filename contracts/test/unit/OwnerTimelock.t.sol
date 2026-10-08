// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultBase} from "../VaultBase.t.sol";
import {ConvergeVault} from "../../src/vault/ConvergeVault.sol";
import {OwnerTimelock} from "../../src/governance/OwnerTimelock.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice F9-01: the owner of the vault is a timelock driven by the Safe. These tests run the
///         deployment sequence (boot delay 0, handover batch, production delay) and then check
///         what the delay buys: owner actions are public for the delay, the Safe alone is not the
///         owner, and stopping stays instant.
contract OwnerTimelockTest is VaultBase {
    OwnerTimelock internal tl;
    address internal safe = makeAddr("safe");
    uint256 internal constant TL_DELAY = 1 days;
    bytes32 internal constant SALT = keccak256("test");

    function setUp() public override {
        super.setUp();
        address[] memory who = new address[](1);
        who[0] = safe;
        tl = new OwnerTimelock(0, who, who);
        // the deployer (vOwner here) proposes the timelock as owner, as scripts/mainnet does
        vm.prank(vOwner);
        vault.transferOwnership(address(tl));
    }

    function _handover() internal {
        address[] memory t = new address[](2);
        uint256[] memory v = new uint256[](2);
        bytes[] memory d = new bytes[](2);
        t[0] = address(vault);
        d[0] = abi.encodeCall(Ownable2Step.acceptOwnership, ());
        t[1] = address(tl);
        d[1] = abi.encodeCall(TimelockController.updateDelay, (TL_DELAY));
        vm.startPrank(safe);
        tl.scheduleBatch(t, v, d, bytes32(0), SALT, 0);
        tl.executeBatch(t, v, d, bytes32(0), SALT);
        vm.stopPrank();
    }

    function _schedule(bytes memory data, bytes32 salt) internal {
        vm.prank(safe);
        tl.schedule(address(vault), 0, data, bytes32(0), salt, TL_DELAY);
    }

    function test_roles_safeOnly_noAdminExceptTheTimelockItself() public view {
        assertTrue(tl.hasRole(tl.PROPOSER_ROLE(), safe));
        assertTrue(tl.hasRole(tl.EXECUTOR_ROLE(), safe));
        assertTrue(tl.hasRole(tl.CANCELLER_ROLE(), safe));
        assertTrue(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), address(tl)));
        assertFalse(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), safe));
        assertFalse(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), address(this)));
        assertEq(tl.getMinDelay(), 0);
    }

    function test_handover_makesTheTimelockTheOwnerAndRaisesTheDelay() public {
        assertEq(vault.owner(), vOwner); // not yet: pending
        _handover();
        assertEq(vault.owner(), address(tl));
        assertEq(tl.getMinDelay(), TL_DELAY);
    }

    function test_afterTheHandover_theSafeAloneCannotDoOwnerThings() public {
        _handover();
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        vault.setTvlCap(1);
        vm.prank(vOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, vOwner));
        vault.setTvlCap(1);
    }

    function test_anOwnerAction_waitsTheFullDelay_thenRuns() public {
        _handover();
        bytes memory data = abi.encodeCall(ConvergeVault.setTvlCap, (777 * U));
        _schedule(data, SALT);
        bytes32 id = tl.hashOperation(address(vault), 0, data, bytes32(0), SALT);
        assertTrue(tl.isOperationPending(id));

        vm.prank(safe);
        vm.expectRevert(); // not ready
        tl.execute(address(vault), 0, data, bytes32(0), SALT);
        vm.warp(vm.getBlockTimestamp() + TL_DELAY - 1);
        vm.prank(safe);
        vm.expectRevert(); // one second short
        tl.execute(address(vault), 0, data, bytes32(0), SALT);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(safe);
        tl.execute(address(vault), 0, data, bytes32(0), SALT);
        assertEq(vault.tvlCap(), 777 * U);
        assertTrue(tl.isOperationDone(id));
    }

    function test_scheduling_isRestrictedToTheSafe_andAShorterDelayIsRefused() public {
        _handover();
        bytes memory data = abi.encodeCall(ConvergeVault.setTvlCap, (1));
        vm.prank(alice);
        vm.expectRevert();
        tl.schedule(address(vault), 0, data, bytes32(0), SALT, TL_DELAY);
        vm.prank(safe);
        vm.expectRevert(); // below the minimum delay
        tl.schedule(address(vault), 0, data, bytes32(0), SALT, TL_DELAY - 1);
        // nobody can change the delay except through the timelock itself
        vm.prank(safe);
        vm.expectRevert();
        tl.updateDelay(0);
    }

    function test_theSafeCanCancel_aPendingOperation() public {
        _handover();
        bytes memory data = abi.encodeCall(ConvergeVault.setTvlCap, (1));
        _schedule(data, SALT);
        bytes32 id = tl.hashOperation(address(vault), 0, data, bytes32(0), SALT);
        vm.prank(safe);
        tl.cancel(id);
        assertFalse(tl.isOperation(id));
        vm.warp(vm.getBlockTimestamp() + TL_DELAY);
        vm.prank(safe);
        vm.expectRevert();
        tl.execute(address(vault), 0, data, bytes32(0), SALT);
    }

    function test_stoppingStaysInstant_guardianPausesWithoutTheTimelock() public {
        _handover();
        vm.prank(vGuardian);
        vault.pauseQuoting();
        assertTrue(vault.quotingPaused());
        // resuming is an owner action: it takes the delay
        bytes memory data = abi.encodeCall(ConvergeVault.resumeQuoting, ());
        vm.prank(vGuardian);
        vm.expectRevert();
        vault.resumeQuoting();
        _schedule(data, SALT);
        vm.warp(vm.getBlockTimestamp() + TL_DELAY);
        vm.prank(safe);
        tl.execute(address(vault), 0, data, bytes32(0), SALT);
        assertFalse(vault.quotingPaused());
    }

    function test_keeperRotation_isPublicForTheDelay() public {
        _handover();
        address newKeeper = makeAddr("newKeeper");
        bytes memory data = abi.encodeCall(ConvergeVault.setKeeper, (newKeeper));
        _schedule(data, SALT);
        assertEq(vault.keeper(), vKeeper); // nothing changed yet: the operation is only announced
        vm.warp(vm.getBlockTimestamp() + TL_DELAY);
        vm.prank(safe);
        tl.execute(address(vault), 0, data, bytes32(0), SALT);
        assertEq(vault.keeper(), newKeeper);
        assertTrue(vault.keeperHalt());
    }
}
