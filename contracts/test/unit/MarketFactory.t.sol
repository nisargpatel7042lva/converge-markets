// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Base} from "../Base.t.sol";
import {MarketFactory as F} from "../../src/MarketFactory.sol";
import {Market} from "../../src/Market.sol";
import {OutcomeToken} from "../../src/OutcomeToken.sol";
import {IPriceResolver} from "../../src/interfaces/IPriceResolver.sol";
import {ChainlinkRoundResolver} from "../../src/resolvers/ChainlinkRoundResolver.sol";

contract MarketFactoryTest is Base {
    function test_constructor_rejectsZero() public {
        vm.expectRevert(F.ZeroAddress.selector);
        new F(IERC20(address(0)), admin);
        vm.expectRevert(F.ZeroAddress.selector);
        new F(IERC20(address(usdc)), address(0));
    }

    function test_constructor_state() public view {
        assertEq(address(factory.collateral()), address(usdc));
        assertEq(factory.collateralDecimals(), 6);
        assertTrue(factory.hasRole(factory.DEFAULT_ADMIN_ROLE(), admin));
        assertEq(factory.redeemFeeBps(), 0);
        assertEq(factory.feeRecipient(), address(0));
    }

    function test_createMarket_registersAndNames() public {
        address predicted = factory.predictMarket(BTC, M15, T0);
        vm.expectEmit(true, true, true, false, address(factory));
        Market.Params memory p;
        emit F.MarketCreated(predicted, BTC, T0, M15, p);
        Market m = _create(BTC, M15, T0);
        assertEq(address(m), predicted);
        assertEq(factory.getMarket(BTC, M15, T0), address(m));
        assertEq(factory.marketByKey(factory.marketKey(BTC, M15, T0)), address(m));
        assertEq(factory.marketCount(), 1);
        OutcomeToken up = m.up();
        OutcomeToken down = m.down();
        assertEq(up.name(), "BTC UP 2026-10-01 14:15 UTC");
        assertEq(up.symbol(), "cBTC-UP-2610011415");
        assertEq(down.name(), "BTC DOWN 2026-10-01 14:15 UTC");
        assertEq(down.symbol(), "cBTC-DOWN-2610011415");
    }

    function test_createMarket_oneHour() public {
        Market m = _create(BTC, H1, T0 + 45 minutes);
        assertEq(m.endTime(), T0 + 45 minutes + H1);
        assertEq(m.up().name(), "BTC UP 2026-10-01 15:00 UTC");
    }

    function test_createMarket_sameStartDifferentDurations() public {
        address a = address(_create(BTC, M15, T0 + 45 minutes));
        address b = address(_create(BTC, H1, T0 + 45 minutes));
        assertTrue(a != b);
    }

    function test_createMarket_onlyCreator() public {
        bytes32 role = factory.CREATOR_ROLE();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role
            )
        );
        factory.createMarket(BTC, M15, T0);
    }

    function test_createMarket_revertsDuplicate() public {
        Market m = _create(BTC, M15, T0);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(F.MarketExists.selector, address(m)));
        factory.createMarket(BTC, M15, T0);
    }

    function test_createMarket_revertsUnknownOrDisabledAsset() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(F.AssetNotEnabled.selector, bytes32("X")));
        factory.createMarket(bytes32("X"), M15, T0);
        vm.prank(admin);
        factory.setAsset(BTC, roundResolver, "BTC", false);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(F.AssetNotEnabled.selector, BTC));
        factory.createMarket(BTC, M15, T0);
    }

    function test_createMarket_revertsBadDuration() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(F.UnsupportedDuration.selector, uint64(5 minutes)));
        factory.createMarket(BTC, 5 minutes, T0);
    }

    function test_createMarket_revertsNotAligned() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(F.NotAligned.selector, T0 + 1, M15));
        factory.createMarket(BTC, M15, T0 + 1);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(F.NotAligned.selector, T0, H1));
        factory.createMarket(BTC, H1, T0); // 14:15 is not an hour boundary
    }

    function test_createMarket_revertsInPast() public {
        vm.warp(T0 + 1);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(F.StartInPast.selector, T0));
        factory.createMarket(BTC, M15, T0);
    }

    function test_createMarket_atCurrentBoundary() public {
        vm.warp(T0);
        _create(BTC, M15, T0);
    }

    function test_pause_blocksCreation_onlyGuardian_unpauseOnlyAdmin() public {
        bytes32 g = factory.GUARDIAN_ROLE();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, g
            )
        );
        factory.pause();
        vm.prank(guardian);
        factory.pause();
        assertTrue(factory.paused());
        vm.prank(creator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.createMarket(BTC, M15, T0);
        bytes32 a = factory.DEFAULT_ADMIN_ROLE();
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, a
            )
        );
        factory.unpause();
        vm.prank(admin);
        factory.unpause();
        _create(BTC, M15, T0);
    }

    function test_setAsset_validations() public {
        vm.startPrank(admin);
        vm.expectRevert(F.ZeroAddress.selector);
        factory.setAsset(BTC, IPriceResolver(address(0)), "BTC", true);
        vm.expectRevert(F.EmptyLabel.selector);
        factory.setAsset(BTC, roundResolver, "", true);
        vm.expectRevert(
            abi.encodeWithSelector(F.ResolverDoesNotSupportAsset.selector, bytes32("Z"))
        );
        factory.setAsset(bytes32("Z"), roundResolver, "Z", true);
        vm.expectRevert(abi.encodeWithSelector(F.AssetResolverFixed.selector, BTC));
        factory.setAsset(BTC, streamsResolver, "BTC", true);
        // label/enabled updates on the same resolver are fine
        factory.setAsset(BTC, roundResolver, "XBT", true);
        vm.stopPrank();
        assertEq(factory.asset(BTC).label, "XBT");
    }

    function test_setAsset_onlyAdmin() public {
        bytes32 a = factory.DEFAULT_ADMIN_ROLE();
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, creator, a
            )
        );
        factory.setAsset(BTC, roundResolver, "BTC", true);
    }

    function test_redeemFee_capAndEvents() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(F.FeeTooHigh.selector, uint16(101)));
        factory.setRedeemFee(101);
        vm.expectEmit(address(factory));
        emit F.RedeemFeeSet(100);
        factory.setRedeemFee(100);
        vm.expectEmit(address(factory));
        emit F.FeeRecipientSet(treasury);
        factory.setFeeRecipient(treasury);
        vm.stopPrank();
        assertEq(factory.redeemFeeBps(), 100);
        assertEq(_create(BTC, M15, T0).redeemFeeBps(), 100);
    }

    function test_redeemFee_onlyAdmin() public {
        bytes32 a = factory.DEFAULT_ADMIN_ROLE();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, a
            )
        );
        factory.setRedeemFee(1);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, a
            )
        );
        factory.setFeeRecipient(alice);
    }
}

contract OutcomeTokenTest is Base {
    function test_implementationLocked() public {
        OutcomeToken impl = OutcomeToken(factory.tokenImplementation());
        vm.expectRevert(OutcomeToken.AlreadyInitialized.selector);
        impl.initialize(address(this), "a", "b", 6);
    }

    function test_onlyMarketMintBurn_andReinitBlocked() public {
        Market m = _create(BTC, M15, T0);
        OutcomeToken up = m.up();
        vm.expectRevert(OutcomeToken.OnlyMarket.selector);
        up.mint(alice, 1);
        vm.expectRevert(OutcomeToken.OnlyMarket.selector);
        up.burn(alice, 1);
        vm.expectRevert(OutcomeToken.AlreadyInitialized.selector);
        up.initialize(alice, "x", "y", 18);
    }

    function test_initialize_rejectsZeroMarket() public {
        OutcomeToken t = OutcomeToken(_clone(factory.tokenImplementation()));
        vm.expectRevert(OutcomeToken.ZeroAddress.selector);
        t.initialize(address(0), "a", "b", 6);
        t.initialize(alice, "a", "b", 6);
        assertEq(t.market(), alice);
        assertEq(t.decimals(), 6);
    }

    function _clone(address impl) internal returns (address c) {
        bytes memory code = abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", impl, hex"5af43d82803e903d91602b57fd5bf3"
        );
        assembly {
            c := create(0, add(code, 0x20), mload(code))
        }
    }
}
