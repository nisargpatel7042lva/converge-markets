// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Base} from "../Base.t.sol";
import {Market} from "../../src/Market.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OutcomeToken} from "../../src/OutcomeToken.sol";
import {IPriceResolver} from "../../src/interfaces/IPriceResolver.sol";
import {MockERC20, MockFeeOnTransferERC20} from "../mocks/MockERC20.sol";

contract MarketTest is Base {
    Market internal m; // BTC 15m via ChainlinkRoundResolver
    OutcomeToken internal upT;
    OutcomeToken internal downT;

    function setUp() public override {
        super.setUp();
        m = _create(BTC, M15, T0);
        upT = m.up();
        downT = m.down();
    }

    // ------------------------------------------------------------------ init

    function test_initialize_setsParams() public view {
        assertEq(m.factory(), address(factory));
        assertEq(m.assetId(), BTC);
        assertEq(address(m.resolver()), address(roundResolver));
        assertEq(address(m.collateral()), address(usdc));
        assertEq(m.startTime(), T0);
        assertEq(m.endTime(), T0 + M15);
        assertEq(m.redeemFeeBps(), 0);
        assertEq(uint8(m.state()), uint8(Market.State.CREATED));
        assertEq(upT.market(), address(m));
        assertEq(downT.decimals(), 6);
    }

    function test_initialize_revertsTwice() public {
        Market.Params memory p;
        p.factory = address(factory);
        vm.prank(address(factory));
        vm.expectRevert(Market.AlreadyInitialized.selector);
        m.initialize(p);
    }

    function test_initialize_implementationLocked() public {
        Market impl = Market(factory.marketImplementation());
        Market.Params memory p;
        p.factory = address(this);
        vm.expectRevert(Market.AlreadyInitialized.selector);
        impl.initialize(p);
    }

    function test_initialize_onlyFactoryParam() public {
        // A fresh, uninitialized market (not via factory) rejects a caller that isn't p.factory.
        Market fresh = Market(_cloneOf(factory.marketImplementation()));
        Market.Params memory p;
        p.factory = address(0xBEEF);
        vm.expectRevert(Market.OnlyFactory.selector);
        fresh.initialize(p);
    }

    function _cloneOf(address impl) internal returns (address c) {
        bytes memory code = abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", impl, hex"5af43d82803e903d91602b57fd5bf3"
        );
        assembly {
            c := create(0, add(code, 0x20), mload(code))
        }
    }

    // ------------------------------------------------------------------ split / merge

    function test_split_mintsBothSides() public {
        usdc.mint(alice, 100e6);
        vm.startPrank(alice);
        usdc.approve(address(m), 100e6);
        vm.expectEmit(address(m));
        emit Market.Split(alice, 100e6);
        m.split(100e6);
        vm.stopPrank();
        assertEq(upT.balanceOf(alice), 100e6);
        assertEq(downT.balanceOf(alice), 100e6);
        assertEq(usdc.balanceOf(address(m)), 100e6);
    }

    function test_split_revertsZero() public {
        vm.expectRevert(Market.ZeroAmount.selector);
        m.split(0);
    }

    function test_split_revertsWhenPaused() public {
        vm.prank(guardian);
        factory.pause();
        usdc.mint(alice, 1e6);
        vm.startPrank(alice);
        usdc.approve(address(m), 1e6);
        vm.expectRevert(Market.SplitPaused.selector);
        m.split(1e6);
        vm.stopPrank();
    }

    function test_split_revertsAfterResolution() public {
        _resolveUp();
        usdc.mint(alice, 1e6);
        vm.startPrank(alice);
        usdc.approve(address(m), 1e6);
        vm.expectRevert(
            abi.encodeWithSelector(Market.WrongState.selector, Market.State.RESOLVED_UP)
        );
        m.split(1e6);
        vm.stopPrank();
    }

    function test_split_allowedWhenOpen() public {
        _open(60_000e8);
        _split(m, alice, 5e6);
        assertEq(upT.totalSupply(), 5e6);
    }

    function test_split_revertsWithoutApproval() public {
        usdc.mint(alice, 1e6);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(m), 0, 1e6
            )
        );
        m.split(1e6);
    }

    function test_split_rejectsFeeOnTransferCollateral() public {
        MockFeeOnTransferERC20 fot = new MockFeeOnTransferERC20();
        MarketFactory f2 = new MarketFactory(IERC20(address(fot)), admin);
        vm.startPrank(admin);
        f2.grantRole(f2.CREATOR_ROLE(), creator);
        f2.setAsset(BTC, roundResolver, "BTC", true);
        vm.stopPrank();
        vm.prank(creator);
        Market fm = Market(f2.createMarket(BTC, M15, T0));
        fot.mint(alice, 100e6);
        vm.startPrank(alice);
        fot.approve(address(fm), 100e6);
        vm.expectRevert(
            abi.encodeWithSelector(Market.FeeOnTransferNotSupported.selector, 100e6, 99e6)
        );
        fm.split(100e6);
        vm.stopPrank();
    }

    function test_merge_returnsCollateral() public {
        _split(m, alice, 100e6);
        vm.expectEmit(address(m));
        emit Market.Merged(alice, 40e6);
        vm.prank(alice);
        m.merge(40e6);
        assertEq(usdc.balanceOf(alice), 40e6);
        assertEq(upT.balanceOf(alice), 60e6);
        assertEq(downT.balanceOf(alice), 60e6);
    }

    function test_merge_revertsZero() public {
        vm.expectRevert(Market.ZeroAmount.selector);
        m.merge(0);
    }

    function test_merge_revertsWithoutBothSides() public {
        _split(m, alice, 10e6);
        vm.prank(alice);
        downT.transfer(bob, 10e6);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 0, 10e6)
        );
        m.merge(10e6);
    }

    function test_merge_worksWhilePaused() public {
        _split(m, alice, 10e6);
        vm.prank(guardian);
        factory.pause();
        vm.prank(alice);
        m.merge(10e6);
        assertEq(usdc.balanceOf(alice), 10e6);
    }

    function test_merge_worksAfterResolution() public {
        _split(m, alice, 10e6);
        _resolveDown();
        vm.prank(alice);
        m.merge(10e6);
        assertEq(usdc.balanceOf(alice), 10e6);
    }

    function test_merge_worksWhenInvalid() public {
        _split(m, alice, 10e6);
        vm.warp(T0 + LIVENESS + 1);
        m.invalidate();
        vm.prank(alice);
        m.merge(10e6);
        assertEq(usdc.balanceOf(alice), 10e6);
    }

    // ------------------------------------------------------------------ open

    function test_open_revertsBeforeStart() public {
        vm.expectRevert(abi.encodeWithSelector(Market.TooEarly.selector, T0));
        m.open("");
    }

    function test_open_revertsWhilePending() public {
        vm.warp(T0 + 10);
        vm.expectRevert(Market.PriceNotFinal.selector);
        m.open("");
    }

    function test_open_keepsSubmissionWhilePending() public {
        Market em = _create(ETH, M15, T0);
        vm.warp(T0 + 3);
        em.open(_report(ETH_FEED, uint32(T0), uint32(T0), 3000e18)); // no revert
        assertEq(uint8(em.state()), uint8(Market.State.CREATED));
        assertEq(streamsResolver.proposal(ETH, T0).price, 3000e18);
        vm.expectRevert(Market.PriceNotFinal.selector);
        em.open("");
    }

    function test_open_setsStrike() public {
        vm.warp(T0 + 10);
        bytes memory proof = _round(2, 61_000e8, T0 + 5);
        vm.expectEmit(address(m));
        emit Market.Opened(61_000e8);
        m.open(proof);
        assertEq(m.strike(), 61_000e8);
        assertEq(uint8(m.state()), uint8(Market.State.OPEN));
    }

    function test_open_afterSomeoneElseProved() public {
        vm.warp(T0 + 10);
        bytes memory proof = _round(2, 61_000e8, T0 + 5);
        roundResolver.submit(BTC, T0, proof);
        m.open(proof); // submit is a no-op once decided
        assertEq(m.strike(), 61_000e8);
    }

    function test_open_revertsTwice() public {
        _open(60_000e8);
        vm.expectRevert(abi.encodeWithSelector(Market.WrongState.selector, Market.State.OPEN));
        m.open("");
    }

    function test_open_unresolvableInvalidates() public {
        vm.warp(T0 + MAX_DELAY + 1); // no feed round since T0
        vm.expectEmit(address(m));
        emit Market.Invalidated(T0);
        m.open("");
        assertEq(uint8(m.state()), uint8(Market.State.INVALID));
    }

    // ------------------------------------------------------------------ resolve

    function test_resolve_revertsIfNotOpen() public {
        vm.warp(T0 + M15 + 10);
        vm.expectRevert(abi.encodeWithSelector(Market.WrongState.selector, Market.State.CREATED));
        m.resolve("");
    }

    function test_resolve_revertsBeforeEnd() public {
        _open(60_000e8);
        vm.expectRevert(abi.encodeWithSelector(Market.TooEarly.selector, T0 + M15));
        m.resolve("");
    }

    function test_resolve_revertsWhilePending() public {
        _open(60_000e8);
        vm.warp(T0 + M15 + 5);
        vm.expectRevert(Market.PriceNotFinal.selector);
        m.resolve("");
    }

    function test_resolve_up() public {
        _open(60_000e8);
        vm.warp(T0 + M15 + 30);
        bytes memory proof = _round(3, 60_001e8, T0 + M15 + 20);
        vm.expectEmit(address(m));
        emit Market.Resolved(Market.State.RESOLVED_UP, 60_000e8, 60_001e8);
        m.resolve(proof);
        assertEq(uint8(m.state()), uint8(Market.State.RESOLVED_UP));
        assertEq(m.endPrice(), 60_001e8);
    }

    function test_resolve_tieGoesUp() public {
        _open(60_000e8);
        vm.warp(T0 + M15 + 30);
        m.resolve(_round(3, 60_000e8, T0 + M15 + 1));
        assertEq(uint8(m.state()), uint8(Market.State.RESOLVED_UP));
    }

    function test_resolve_down() public {
        _resolveDown();
        assertEq(uint8(m.state()), uint8(Market.State.RESOLVED_DOWN));
    }

    function test_resolve_revertsTwice() public {
        _resolveUp();
        vm.expectRevert(
            abi.encodeWithSelector(Market.WrongState.selector, Market.State.RESOLVED_UP)
        );
        m.resolve("");
    }

    function test_resolve_unresolvableInvalidates() public {
        _open(60_000e8);
        // First round after end is too late (> MAX_DELAY).
        vm.warp(T0 + M15 + 1000);
        bytes memory proof = _round(3, 59_000e8, T0 + M15 + MAX_DELAY + 1);
        vm.expectEmit(address(m));
        emit Market.Invalidated(T0 + M15);
        m.resolve(proof);
        assertEq(uint8(m.state()), uint8(Market.State.INVALID));
    }

    // ------------------------------------------------------------------ invalidate

    function test_invalidate_revertsWhilePending() public {
        vm.warp(T0 + 10);
        vm.expectRevert(Market.NotUnresolvable.selector);
        m.invalidate();
    }

    function test_invalidate_createdAfterLiveness() public {
        vm.warp(T0 + LIVENESS + 1);
        m.invalidate();
        assertEq(uint8(m.state()), uint8(Market.State.INVALID));
    }

    function test_invalidate_openWhenEndUnresolvable() public {
        _open(60_000e8);
        vm.warp(T0 + M15 + MAX_DELAY + 1);
        // latest round (opened round at T0+5) < endTime and delay passed
        m.invalidate();
        assertEq(uint8(m.state()), uint8(Market.State.INVALID));
    }

    function test_invalidate_revertsWhenResolved() public {
        _resolveUp();
        vm.expectRevert(
            abi.encodeWithSelector(Market.WrongState.selector, Market.State.RESOLVED_UP)
        );
        m.invalidate();
    }

    function test_invalidate_revertsIfFinal() public {
        vm.warp(T0 + 10);
        roundResolver.submit(BTC, T0, _round(2, 1e8, T0 + 1));
        vm.expectRevert(Market.NotUnresolvable.selector);
        m.invalidate();
    }

    // ------------------------------------------------------------------ redeem

    function test_redeem_revertsBeforeResolution() public {
        _split(m, alice, 10e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Market.WrongState.selector, Market.State.CREATED));
        m.redeem();
        _open(60_000e8);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Market.WrongState.selector, Market.State.OPEN));
        m.redeem();
    }

    function test_redeem_winnerUp() public {
        _split(m, alice, 10e6);
        vm.prank(alice);
        downT.transfer(bob, 10e6);
        _resolveUp();
        assertEq(m.claimable(alice), 10e6);
        assertEq(m.claimable(bob), 0);
        vm.expectEmit(address(m));
        emit Market.Redeemed(alice, 10e6, 0, 10e6, 0);
        vm.prank(alice);
        m.redeem();
        assertEq(usdc.balanceOf(alice), 10e6);
        assertEq(upT.balanceOf(alice), 0);
        // loser can redeem to clean up, gets 0
        vm.prank(bob);
        m.redeem();
        assertEq(usdc.balanceOf(bob), 0);
        assertEq(downT.balanceOf(bob), 0);
        assertEq(usdc.balanceOf(address(m)), 0);
    }

    function test_redeem_winnerDown() public {
        _split(m, alice, 7e6);
        _resolveDown();
        assertEq(m.claimable(alice), 7e6);
        vm.prank(alice);
        m.redeem(); // holds both sides: gets 7 (DOWN wins), UP burned
        assertEq(usdc.balanceOf(alice), 7e6);
        assertEq(upT.totalSupply(), 0);
    }

    function test_redeem_invalidPaysHalf() public {
        _split(m, alice, 11); // odd base units
        vm.prank(alice);
        downT.transfer(bob, 11);
        vm.warp(T0 + LIVENESS + 1);
        m.invalidate();
        assertEq(m.claimable(alice), 5);
        vm.prank(alice);
        m.redeem();
        vm.prank(bob);
        m.redeem();
        assertEq(usdc.balanceOf(alice), 5); // floor(11/2)
        assertEq(usdc.balanceOf(bob), 5);
        assertEq(usdc.balanceOf(address(m)), 1); // dust stays, never over-paid
    }

    function test_redeem_invalidBothSidesFull() public {
        _split(m, alice, 10e6);
        vm.warp(T0 + LIVENESS + 1);
        m.invalidate();
        vm.prank(alice);
        m.redeem();
        assertEq(usdc.balanceOf(alice), 10e6);
    }

    function test_redeem_revertsWithNothing() public {
        _resolveUp();
        vm.prank(alice);
        vm.expectRevert(Market.NothingToRedeem.selector);
        m.redeem();
    }

    function test_redeem_worksWhilePaused() public {
        _split(m, alice, 10e6);
        _resolveUp();
        vm.prank(guardian);
        factory.pause();
        vm.prank(alice);
        m.redeem();
        assertEq(usdc.balanceOf(alice), 10e6);
    }

    function test_redeem_withFee() public {
        vm.startPrank(admin);
        factory.setRedeemFee(100); // 1%
        factory.setFeeRecipient(treasury);
        vm.stopPrank();
        Market fm = _create(BTC, M15, T0 + M15);
        _split(fm, alice, 1000e6);
        // open at T0+15m, resolve at T0+30m
        vm.warp(T0 + M15 + 10);
        fm.open(_round(2, 100e8, T0 + M15 + 1));
        vm.warp(T0 + 2 * M15 + 10);
        fm.resolve(_round(3, 101e8, T0 + 2 * M15 + 1));
        vm.prank(alice);
        fm.redeem();
        assertEq(usdc.balanceOf(alice), 990e6);
        assertEq(fm.feesAccrued(), 10e6);
        assertEq(usdc.balanceOf(treasury), 0); // pull, not push
        vm.expectEmit(address(fm));
        emit Market.FeesClaimed(treasury, 10e6);
        fm.claimFees();
        assertEq(usdc.balanceOf(treasury), 10e6);
        assertEq(fm.feesAccrued(), 0);
        vm.expectRevert(Market.NothingToClaim.selector);
        fm.claimFees();
    }

    function test_claimFees_revertsWithoutRecipient_redeemNeverBlocked() public {
        vm.startPrank(admin);
        factory.setRedeemFee(100);
        factory.setFeeRecipient(treasury);
        vm.stopPrank();
        Market fm = _create(BTC, M15, T0 + M15);
        _split(fm, alice, 1000e6);
        _split(fm, bob, 1000e6);
        vm.warp(T0 + M15 + 10);
        fm.open(_round(2, 100e8, T0 + M15 + 1));
        vm.warp(T0 + 2 * M15 + 10);
        fm.resolve(_round(3, 101e8, T0 + 2 * M15 + 1));
        vm.prank(alice);
        fm.redeem();
        vm.prank(admin);
        factory.setFeeRecipient(address(0)); // recipient removed: redeem still works, no fee
        vm.prank(bob);
        fm.redeem();
        assertEq(usdc.balanceOf(bob), 1000e6);
        vm.expectRevert(Market.NoFeeRecipient.selector);
        fm.claimFees();
        assertEq(fm.feesAccrued(), 10e6);
    }

    function test_open_rejectsValueWithoutSubmission() public {
        vm.warp(T0 + 10);
        bytes memory proof = _round(2, 1e8, T0 + 1);
        roundResolver.submit(BTC, T0, proof);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(Market.UnexpectedValue.selector);
        m.open{value: 1}("");
    }

    function test_open_afterGraceWithEvidence_invalidatesInsteadOfReverting() public {
        Market em = _create(ETH, M15, T0);
        bytes memory rep = _report(ETH_FEED, uint32(T0), uint32(T0), 1e18);
        vm.warp(T0 + GRACE + 1);
        em.open(rep); // checkpoint says UNRESOLVABLE first; late evidence is not submitted
        assertEq(uint8(em.state()), uint8(Market.State.INVALID));
    }

    function test_streamsMarket_feeModeForwardsValue() public {
        bytes memory param = abi.encode(address(0x1234));
        verifierProxy.setFeeMode(1 gwei, param);
        vm.prank(admin);
        streamsResolver.setParameterPayload(param);
        Market em = _create(ETH, M15, T0);
        vm.warp(T0 + 3);
        bytes memory rep = _report(ETH_FEED, uint32(T0), uint32(T0), 3000e18);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("FeeRequired(uint256,uint256)", 1 gwei, 0));
        em.open(rep);
        vm.prank(alice);
        em.open{value: 3 gwei}(rep); // 2 gwei change refunded to the resolver
        assertEq(address(streamsResolver).balance, 2 gwei);
        vm.prank(admin);
        streamsResolver.withdrawNative(payable(treasury), 2 gwei);
        assertEq(treasury.balance, 2 gwei);
        vm.warp(T0 + 3 + WINDOW);
        em.open("");
        assertEq(em.strike(), 3000e18);
    }

    function test_redeem_feeSkippedWithoutRecipient() public {
        vm.prank(admin);
        factory.setRedeemFee(100);
        Market fm = _create(BTC, M15, T0 + M15);
        _split(fm, alice, 1000e6);
        vm.warp(T0 + M15 + 10);
        fm.open(_round(2, 100e8, T0 + M15 + 1));
        vm.warp(T0 + 2 * M15 + 10);
        fm.resolve(_round(3, 99e8, T0 + 2 * M15 + 1));
        vm.prank(alice);
        fm.redeem();
        assertEq(usdc.balanceOf(alice), 1000e6);
    }

    function test_redeem_feeSnapshotAtCreation() public {
        // m was created with fee 0; raising the fee later does not affect it.
        vm.startPrank(admin);
        factory.setRedeemFee(100);
        factory.setFeeRecipient(treasury);
        vm.stopPrank();
        _split(m, alice, 10e6);
        _resolveUp();
        vm.prank(alice);
        m.redeem();
        assertEq(usdc.balanceOf(alice), 10e6);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function test_claimable_zeroBeforeOutcome() public {
        _split(m, alice, 10e6);
        assertEq(m.claimable(alice), 0);
    }

    // ------------------------------------------------------------------ 18-decimal collateral

    function test_18DecimalCollateral_fullLifecycle() public {
        MockERC20 dai = new MockERC20("Dai", "DAI", 18);
        MarketFactory f18 = new MarketFactory(IERC20(address(dai)), admin);
        vm.startPrank(admin);
        f18.grantRole(f18.CREATOR_ROLE(), creator);
        f18.setAsset(BTC, roundResolver, "BTC", true);
        vm.stopPrank();
        vm.prank(creator);
        Market dm = Market(f18.createMarket(BTC, M15, T0));
        assertEq(dm.up().decimals(), 18);
        dai.mint(alice, 3e18 + 1);
        vm.startPrank(alice);
        dai.approve(address(dm), 3e18 + 1);
        dm.split(3e18 + 1);
        dm.merge(1e18);
        vm.stopPrank();
        vm.warp(T0 + 10);
        dm.open(_round(2, 100e8, T0 + 1));
        vm.warp(T0 + M15 + 10);
        dm.resolve(_round(3, 99e8, T0 + M15 + 1));
        vm.prank(alice);
        dm.redeem();
        assertEq(dai.balanceOf(alice), 3e18 + 1);
        assertEq(dai.balanceOf(address(dm)), 0);
    }

    // ------------------------------------------------------------------ Data Streams market

    function test_streamsMarket_lifecycle() public {
        Market em = _create(ETH, M15, T0);
        _split(em, alice, 50e6);
        vm.warp(T0 + 3);
        // report window [T0-1, T0+1] contains T0
        em.open(_report(ETH_FEED, uint32(T0 - 1), uint32(T0 + 1), 3000e18));
        assertEq(uint8(em.state()), uint8(Market.State.CREATED)); // still PENDING (window)
        vm.warp(T0 + 3 + WINDOW);
        em.open("");
        assertEq(em.strike(), 3000e18);
        vm.warp(T0 + M15 + 2);
        em.resolve(_report(ETH_FEED, uint32(T0 + M15), uint32(T0 + M15), 2999e18));
        vm.warp(T0 + M15 + 2 + WINDOW);
        em.resolve("");
        assertEq(uint8(em.state()), uint8(Market.State.RESOLVED_DOWN));
        vm.prank(alice);
        em.redeem();
        assertEq(usdc.balanceOf(alice), 50e6);
    }

    function test_streamsMarket_noReportInvalidates() public {
        Market em = _create(ETH, M15, T0);
        vm.warp(T0 + GRACE + 1);
        em.invalidate();
        assertEq(uint8(em.state()), uint8(Market.State.INVALID));
    }

    /// Regression (Phase 1 review M1): during an aggregator migration a boundary must never be
    /// both voided (for the round ending there) and priced (for the round starting there).
    function test_adjacentRoundsAgreeAcrossPhaseMigration() public {
        Market next = _create(BTC, M15, T0 + M15);
        _open(100e8);
        uint64 t1 = T0 + M15;
        vm.warp(t1 + 5);
        uint80 oldPhase = feed.setRound(1, 3, 120e8, t1 + 5); // old phase still transmitting
        feed.setRound(2, 1, 90e8, t1 - 10); // proxy switched; its latest is before t1
        vm.warp(t1 + MAX_DELAY + 1);
        m.resolve(""); // stale current phase -> UNRESOLVABLE, checkpointed
        assertEq(uint8(m.state()), uint8(Market.State.INVALID));
        next.open(abi.encode(oldPhase)); // old-phase proof is ignored: boundary already decided
        assertEq(uint8(next.state()), uint8(Market.State.INVALID));
    }

    // ------------------------------------------------------------------ helpers

    function _open(int256 strike) internal {
        vm.warp(T0 + 10);
        m.open(_round(2, strike, T0 + 5));
    }

    function _resolveUp() internal {
        _open(60_000e8);
        vm.warp(T0 + M15 + 30);
        m.resolve(_round(3, 61_000e8, T0 + M15 + 1));
    }

    function _resolveDown() internal {
        _open(60_000e8);
        vm.warp(T0 + M15 + 30);
        m.resolve(_round(3, 59_000e8, T0 + M15 + 1));
    }
}
