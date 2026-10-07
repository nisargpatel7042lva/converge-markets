// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "../Base.t.sol";
import {Market} from "../../src/Market.sol";
import {OutcomeToken} from "../../src/OutcomeToken.sol";
import {IPriceResolver} from "../../src/interfaces/IPriceResolver.sol";
import {PartnerRegistry} from "../../src/partners/PartnerRegistry.sol";
import {IPartnerRegistry} from "../../src/partners/IPartnerRegistry.sol";
import {ThresholdResolver} from "../../src/resolvers/ThresholdResolver.sol";
import {Vm} from "forge-std/Vm.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice The registry on its own (no vault): partners, bonds, templates, creation, fees, slashing.
contract PartnerRegistryTest is Base {
    uint256 internal constant U = 1e6;

    address internal pOwner = makeAddr("pOwner");
    address internal pGuardian = makeAddr("pGuardian");
    address internal pTreasury = makeAddr("pTreasury");
    address internal pSlash = makeAddr("pSlash");
    address internal partner = makeAddr("partner");
    address internal other = makeAddr("other");

    PartnerRegistry internal reg;

    function setUp() public override {
        super.setUp();
        reg = new PartnerRegistry(factory, pOwner, pGuardian, pTreasury);
        vm.startPrank(pOwner);
        reg.setConfig(100 * U, 500 * U, 50, pTreasury, pSlash);
        reg.setFeed(ETH, true);
        bytes32[] memory feeds = new bytes32[](1);
        feeds[0] = ETH;
        reg.approvePartner(partner, 200 * U, 3000, feeds);
        vm.stopPrank();
        _bond(partner, 100 * U);
    }

    function _bond(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(reg), amount);
        reg.postBond(amount);
        vm.stopPrank();
    }

    function _create(address who, int256 strike, uint64 endTime) internal returns (Market m) {
        vm.prank(who);
        m = Market(reg.createThresholdMarket(ETH, strike, endTime));
    }

    function _end(uint64 d) internal view returns (uint64) {
        // forge-lint: disable-next-line(environment-read-across-mutation)
        return uint64(block.timestamp) + d;
    }

    // ------------------------------------------------------------------ creation

    function test_create_opensAtOnceWithThePinnedStrike() public {
        uint64 end = _end(1 hours);
        Market m = _create(partner, 3000e18, end);
        assertEq(uint8(m.state()), uint8(Market.State.OPEN));
        assertEq(m.strike(), 3000e18);
        assertEq(m.startTime(), block.timestamp);
        assertEq(m.endTime(), end);
        assertEq(m.assetId(), ETH);
        assertEq(m.factory(), address(reg));
        assertEq(m.redeemFeeBps(), 50);
        assertEq(address(m.collateral()), address(usdc));
        assertEq(reg.marketCount(), 1);
        assertEq(reg.markets(0), address(m));
        assertEq(reg.infoOf(address(m)).partner, partner);
        assertEq(reg.liveMarketsOf(partner).length, 1);
    }

    function test_create_emitsFactoryShapedEventAndPartnerEvent() public {
        uint64 end = _end(1 hours);
        vm.recordLogs();
        Market m = _create(partner, 3000.5e18, end);
        bytes32 created = keccak256(
            "MarketCreated(address,bytes32,uint64,uint64,(address,bytes32,address,address,address,address,uint64,uint64,uint16))"
        );
        bytes32 partnerEv = keccak256(
            "PartnerMarketCreated(address,address,bytes32,int256,uint64,uint64,address,uint16)"
        );
        uint256 seen;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(reg)) continue;
            if (logs[i].topics[0] == created) {
                seen += 1;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), address(m));
                assertEq(logs[i].topics[2], ETH);
            } else if (logs[i].topics[0] == partnerEv) {
                seen += 10;
                assertEq(address(uint160(uint256(logs[i].topics[2]))), partner);
            }
        }
        assertEq(seen, 11);
    }

    function test_create_tokenNamesCarryTheStrikeAndEnd() public {
        // 2026-10-01 14:15:00 UTC + 1h = 15:15
        vm.warp(T0);
        Market m = _create(partner, 3000.5e18, uint64(T0) + 1 hours);
        assertEq(m.up().name(), "ETH >=3000.5 UP 2026-10-01 15:15 UTC");
        assertEq(m.down().name(), "ETH >=3000.5 DOWN 2026-10-01 15:15 UTC");
        Market m2 = _create(partner, 0.031542e18, uint64(T0) + 1 hours);
        assertEq(m2.up().name(), "ETH >=0.031542 UP 2026-10-01 15:15 UTC");
        Market m3 = _create(partner, 0.000001e18, uint64(T0) + 1 hours);
        assertEq(m3.up().name(), "ETH >=0.000001 UP 2026-10-01 15:15 UTC");
        Market m4 = _create(partner, 5e18, uint64(T0) + 1 hours);
        assertEq(m4.up().name(), "ETH >=5 UP 2026-10-01 15:15 UTC");
    }

    function test_create_durationBounds() public {
        _create(partner, 3000e18, _end(15 minutes));
        _create(partner, 3000e18, _end(7 days));
        vm.startPrank(partner);
        vm.expectRevert(
            abi.encodeWithSelector(PartnerRegistry.InvalidDuration.selector, 15 minutes - 1)
        );
        reg.createThresholdMarket(ETH, 3000e18, _end(15 minutes - 1));
        vm.expectRevert(
            abi.encodeWithSelector(PartnerRegistry.InvalidDuration.selector, 7 days + 1)
        );
        reg.createThresholdMarket(ETH, 3000e18, _end(7 days + 1));
        vm.expectRevert(abi.encodeWithSelector(PartnerRegistry.InvalidDuration.selector, 0));
        reg.createThresholdMarket(ETH, 3000e18, uint64(block.timestamp));
        vm.expectRevert(abi.encodeWithSelector(PartnerRegistry.InvalidDuration.selector, 0));
        reg.createThresholdMarket(ETH, 3000e18, uint64(block.timestamp) - 1);
        vm.stopPrank();
    }

    function test_create_rejectsBadStrike() public {
        vm.startPrank(partner);
        vm.expectRevert(abi.encodeWithSelector(PartnerRegistry.InvalidStrike.selector, int256(0)));
        reg.createThresholdMarket(ETH, 0, _end(1 hours));
        vm.expectRevert(abi.encodeWithSelector(PartnerRegistry.InvalidStrike.selector, int256(-1)));
        reg.createThresholdMarket(ETH, -1, _end(1 hours));
        vm.stopPrank();
    }

    function test_create_requiresApprovalFeedBondAndNotSuspended() public {
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(PartnerRegistry.NotApproved.selector, other));
        reg.createThresholdMarket(ETH, 3000e18, _end(1 hours));

        // a feed the partner is not allowed to use
        vm.prank(partner);
        vm.expectRevert(
            abi.encodeWithSelector(PartnerRegistry.FeedNotAllowed.selector, partner, BTC)
        );
        reg.createThresholdMarket(BTC, 3000e18, _end(1 hours));

        // allowed for the partner but not onboarded
        vm.prank(pOwner);
        reg.setPartnerFeed(partner, BTC, true);
        vm.prank(partner);
        vm.expectRevert(abi.encodeWithSelector(PartnerRegistry.FeedNotEnabled.selector, BTC));
        reg.createThresholdMarket(BTC, 3000e18, _end(1 hours));

        // suspended
        vm.prank(pGuardian);
        reg.suspendPartner(partner);
        vm.prank(partner);
        vm.expectRevert(
            abi.encodeWithSelector(PartnerRegistry.PartnerIsSuspended.selector, partner)
        );
        reg.createThresholdMarket(ETH, 3000e18, _end(1 hours));
        vm.prank(pOwner);
        reg.unsuspendPartner(partner);

        // bond below the minimum after the owner raises it
        vm.prank(pOwner);
        reg.setConfig(101 * U, 500 * U, 50, pTreasury, pSlash);
        vm.prank(partner);
        vm.expectRevert(
            abi.encodeWithSelector(PartnerRegistry.BondTooLow.selector, 100 * U, 101 * U)
        );
        reg.createThresholdMarket(ETH, 3000e18, _end(1 hours));
    }

    function test_create_pauseBlocksCreationAndSplitButNotMergeOrRedeem() public {
        Market m = _create(partner, 3000e18, _end(1 hours));
        _split(m, alice, 10 * U);
        vm.prank(pGuardian);
        reg.pause();
        vm.prank(partner);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        reg.createThresholdMarket(ETH, 3000e18, _end(1 hours));
        usdc.mint(alice, 1);
        vm.startPrank(alice);
        usdc.approve(address(m), 1);
        vm.expectRevert(Market.SplitPaused.selector);
        m.split(1);
        m.merge(10 * U); // exits are never paused
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), 10 * U + 1);
    }

    function test_create_liveSlotsAreBoundedAndEndedMarketsFreeThem() public {
        for (uint256 i = 0; i < reg.MAX_LIVE_PER_PARTNER(); i++) {
            _create(partner, int256(3000e18 + i), _end(1 hours));
        }
        vm.prank(partner);
        vm.expectRevert(
            abi.encodeWithSelector(PartnerRegistry.TooManyLiveMarkets.selector, partner)
        );
        reg.createThresholdMarket(ETH, 3000e18, _end(1 hours));
        // forge-lint: disable-next-line(environment-read-across-mutation)
        vm.warp(block.timestamp + 1 hours);
        _create(partner, 3000e18, _end(1 hours)); // all eight ended: pruned, one slot used
        assertEq(reg.liveMarketsOf(partner).length, 1);
        assertEq(reg.marketCount(), 9);
    }

    function test_liveMarkets_listsEveryRunningMarketAcrossPartners() public {
        address second = makeAddr("second");
        bytes32[] memory feeds = new bytes32[](1);
        feeds[0] = ETH;
        vm.prank(pOwner);
        reg.approvePartner(second, 50 * U, 0, feeds);
        _bond(second, 100 * U);
        Market a = _create(partner, 3000e18, _end(1 hours));
        Market b = _create(second, 3100e18, _end(2 hours));
        Market c = _create(partner, 3200e18, _end(30 minutes));
        address[] memory live = reg.liveMarkets();
        assertEq(live.length, 3);
        assertEq(live[0], address(a));
        assertEq(live[1], address(c));
        assertEq(live[2], address(b));
        // an ended market drops out of the list without anyone pruning
        // forge-lint: disable-next-line(environment-read-across-mutation)
        vm.warp(block.timestamp + 45 minutes);
        live = reg.liveMarkets();
        assertEq(live.length, 2);
        vm.warp(block.timestamp + 3 hours);
        assertEq(reg.liveMarkets().length, 0);
    }

    function test_create_marketCreatedIsEmittedBeforeOpened() public {
        vm.recordLogs();
        Market m = _create(partner, 3000e18, _end(1 hours));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 created = keccak256(
            "MarketCreated(address,bytes32,uint64,uint64,(address,bytes32,address,address,address,address,uint64,uint64,uint16))"
        );
        bytes32 opened = keccak256("Opened(int256)");
        int256 createdAt = -1;
        int256 openedAt = -1;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(reg) && logs[i].topics[0] == created) {
                createdAt = int256(i);
            }
            if (logs[i].emitter == address(m) && logs[i].topics[0] == opened) openedAt = int256(i);
        }
        assertGe(createdAt, 0);
        assertGt(openedAt, createdAt); // an indexer registers the clone from MarketCreated first
    }

    // ------------------------------------------------------------------ resolution through the pin

    function test_resolve_usesTheRealOracleForTheEndPrice_upOnTie() public {
        // forge-lint: disable-next-line(environment-read-across-mutation)
        uint64 start = uint64(block.timestamp);
        uint64 end = start + 1 hours;
        Market m = _create(partner, 3000e18, end);
        vm.warp(end + 1);
        streamsResolver.submit(
            ETH, end, _report(ETH_FEED, uint32(end - 1), uint32(end + 1), 3000e18)
        );
        vm.warp(end + WINDOW + 1);
        m.resolve("");
        assertEq(uint8(m.state()), uint8(Market.State.RESOLVED_UP)); // a tie goes UP
        assertEq(m.endPrice(), 3000e18);
    }

    function test_resolve_belowStrikeIsDown() public {
        uint64 end = _end(1 hours);
        Market m = _create(partner, 3000e18, end);
        vm.warp(end + 1);
        streamsResolver.submit(
            ETH, end, _report(ETH_FEED, uint32(end - 1), uint32(end + 1), 3000e18 - 1)
        );
        vm.warp(end + WINDOW + 1);
        m.resolve("");
        assertEq(uint8(m.state()), uint8(Market.State.RESOLVED_DOWN));
    }

    function test_resolve_submitThroughTheMarketWithEvidence() public {
        uint64 end = _end(1 hours);
        Market m = _create(partner, 3000e18, end);
        vm.warp(end + 1);
        bytes memory rep = _report(ETH_FEED, uint32(end - 1), uint32(end + 1), 3100e18);
        m.resolve(rep); // PENDING + evidence: forwarded to the real resolver through the pin
        vm.warp(end + WINDOW + 1);
        m.resolve("");
        assertEq(uint8(m.state()), uint8(Market.State.RESOLVED_UP));
    }

    function test_resolve_noReportIsInvalidAfterGrace() public {
        uint64 end = _end(1 hours);
        Market m = _create(partner, 3000e18, end);
        _split(m, alice, 10 * U);
        vm.warp(end + GRACE + 1);
        m.resolve("");
        assertEq(uint8(m.state()), uint8(Market.State.INVALID));
        vm.prank(alice);
        m.redeem();
        assertEq(usdc.balanceOf(alice), 10 * U - _fee(10 * U));
    }

    function _fee(uint256 payout) internal pure returns (uint256) {
        // INVALID pays (up + down) / 2 = 10 U; the fee is 50 bps of the payout
        return (payout * 50) / 10_000;
    }

    // ------------------------------------------------------------------ the pin

    function test_pin_startIsFixedEndForwards() public {
        uint64 end = _end(1 hours);
        Market m = _create(partner, 3000e18, end);
        ThresholdResolver pin = ThresholdResolver(address(m.resolver()));
        assertEq(pin.strike(), 3000e18);
        assertEq(pin.startTime(), m.startTime());
        assertEq(address(pin.base()), address(streamsResolver));
        (IPriceResolver.Status s, int256 p) = pin.priceAt(ETH, m.startTime());
        assertEq(uint8(s), uint8(IPriceResolver.Status.FINAL));
        assertEq(p, 3000e18);
        (s,) = pin.priceAt(ETH, end);
        assertEq(uint8(s), uint8(IPriceResolver.Status.PENDING));
        assertTrue(pin.supportsAsset(ETH));
        assertFalse(pin.supportsAsset(keccak256("NOPE")));
        uint64 st = m.startTime();
        vm.expectRevert(ThresholdResolver.StartBoundaryIsFixed.selector);
        pin.submit(ETH, st, "");
    }

    function test_pin_cannotBeReinitialisedAndImplementationIsLocked() public {
        Market m = _create(partner, 3000e18, _end(1 hours));
        ThresholdResolver pin = ThresholdResolver(address(m.resolver()));
        vm.expectRevert(ThresholdResolver.AlreadyInitialized.selector);
        pin.initialize(streamsResolver, 1, 1);
        ThresholdResolver impl = ThresholdResolver(reg.thresholdImplementation());
        vm.expectRevert(ThresholdResolver.AlreadyInitialized.selector);
        impl.initialize(streamsResolver, 1, 1);
    }

    function test_pin_initializeValidatesInputs() public {
        ThresholdResolver fresh = new ThresholdResolver();
        // a directly deployed instance is locked like the implementation
        vm.expectRevert(ThresholdResolver.AlreadyInitialized.selector);
        fresh.initialize(streamsResolver, 1, 1);
        ThresholdResolver c = ThresholdResolver(Clones.clone(reg.thresholdImplementation()));
        vm.expectRevert(ThresholdResolver.ZeroAddress.selector);
        c.initialize(IPriceResolver(address(0)), 1, 1);
        vm.expectRevert(abi.encodeWithSelector(ThresholdResolver.InvalidStrike.selector, int256(0)));
        c.initialize(streamsResolver, 0, 1);
        vm.expectRevert(ThresholdResolver.InvalidStart.selector);
        c.initialize(streamsResolver, 1, 0);
        c.initialize(streamsResolver, 5, 7);
        assertEq(c.strike(), 5);
        assertEq(c.startTime(), 7);
    }

    // ------------------------------------------------------------------ governance

    function test_approve_onlyOwnerAndValidates() public {
        bytes32[] memory feeds = new bytes32[](0);
        vm.prank(partner);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, partner)
        );
        reg.approvePartner(other, 1, 0, feeds);
        vm.startPrank(pOwner);
        vm.expectRevert(PartnerRegistry.ZeroAddress.selector);
        reg.approvePartner(address(0), 1, 0, feeds);
        vm.expectRevert(PartnerRegistry.InvalidTerms.selector);
        reg.approvePartner(other, 1, 10_001, feeds);
        vm.expectRevert(PartnerRegistry.InvalidTerms.selector);
        reg.approvePartner(other, uint256(type(uint128).max) + 1, 0, feeds);
        reg.approvePartner(other, 7 * U, 1000, feeds);
        vm.stopPrank();
        assertEq(reg.partnerOf(other).exposureCap, 7 * U);
        assertEq(reg.partnerCount(), 2);
        // approving again updates terms and does not duplicate the partner list
        vm.prank(pOwner);
        reg.approvePartner(other, 9 * U, 500, feeds);
        assertEq(reg.partnerCount(), 2);
        assertEq(reg.partnerOf(other).feeShareBps, 500);
    }

    function test_setPartnerTerms_andFeeds() public {
        vm.startPrank(pOwner);
        reg.setPartnerTerms(partner, 50 * U, 100);
        assertEq(reg.partnerOf(partner).exposureCap, 50 * U);
        assertEq(reg.partnerOf(partner).feeShareBps, 100);
        vm.expectRevert(abi.encodeWithSelector(PartnerRegistry.NotApproved.selector, other));
        reg.setPartnerTerms(other, 1, 1);
        vm.expectRevert(PartnerRegistry.InvalidTerms.selector);
        reg.setPartnerTerms(partner, 1, 10_001);
        vm.expectRevert(abi.encodeWithSelector(PartnerRegistry.NotApproved.selector, other));
        reg.setPartnerFeed(other, ETH, true);
        reg.setPartnerFeed(partner, ETH, false);
        vm.stopPrank();
        vm.prank(partner);
        vm.expectRevert(
            abi.encodeWithSelector(PartnerRegistry.FeedNotAllowed.selector, partner, ETH)
        );
        reg.createThresholdMarket(ETH, 3000e18, _end(1 hours));
    }

    function test_setFeed_needsACoreAssetAndAVaultAsset() public {
        bytes32 unknown = keccak256("DOGE/USD");
        vm.startPrank(pOwner);
        vm.expectRevert(abi.encodeWithSelector(PartnerRegistry.FeedNotEnabled.selector, unknown));
        reg.setFeed(unknown, true);
        // an asset the core factory has but the vault has not enabled: no depth, refused
        reg.setVault(address(new FakeVault(false)));
        vm.expectRevert(abi.encodeWithSelector(PartnerRegistry.FeedHasNoDepth.selector, BTC));
        reg.setFeed(BTC, true);
        reg.setFeed(ETH, false);
        assertFalse(reg.feedEnabled(ETH));
        vm.stopPrank();
    }

    function test_setVault_onceAndValidated() public {
        vm.startPrank(pOwner);
        vm.expectRevert(PartnerRegistry.ZeroAddress.selector);
        reg.setVault(address(0));
        reg.setVault(address(1));
        vm.expectRevert(PartnerRegistry.VaultAlreadySet.selector);
        reg.setVault(address(2));
        vm.stopPrank();
    }

    function test_setConfig_validatesAndGuardianRoles() public {
        vm.startPrank(pOwner);
        vm.expectRevert(abi.encodeWithSelector(PartnerRegistry.FeeTooHigh.selector, 101));
        reg.setConfig(0, 0, 101, pTreasury, pSlash);
        vm.expectRevert(PartnerRegistry.ZeroAddress.selector);
        reg.setConfig(0, 0, 0, address(0), pSlash);
        vm.expectRevert(PartnerRegistry.ZeroAddress.selector);
        reg.setConfig(0, 0, 0, pTreasury, address(0));
        vm.expectRevert(PartnerRegistry.ZeroAddress.selector);
        reg.setGuardian(address(0));
        reg.setGuardian(other);
        vm.stopPrank();
        assertEq(reg.guardian(), other);
        // only guardian/owner pause and suspend; only the owner unpauses and unsuspends
        vm.prank(partner);
        vm.expectRevert(PartnerRegistry.OnlyGuardianOrOwner.selector);
        reg.pause();
        vm.prank(partner);
        vm.expectRevert(PartnerRegistry.OnlyGuardianOrOwner.selector);
        reg.suspendPartner(partner);
        vm.prank(other);
        reg.pause();
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, other));
        reg.unpause();
        vm.prank(pOwner);
        reg.unpause();
        vm.prank(pOwner);
        vm.expectRevert(PartnerRegistry.InvalidTerms.selector);
        reg.renounceOwnership();
    }

    function test_limits_reflectsStatus() public {
        Market m = _create(partner, 3000e18, _end(1 hours));
        IPartnerRegistry.Limits memory l = reg.limits(address(m));
        assertTrue(l.exists);
        assertTrue(l.active);
        assertEq(l.partner, partner);
        assertEq(l.partnerCap, 200 * U);
        assertEq(l.globalCap, 500 * U);

        vm.prank(pOwner);
        reg.voidMarket(address(m), keccak256("misdescribed"));
        l = reg.limits(address(m));
        assertTrue(l.exists);
        assertFalse(l.active);
        assertEq(l.partnerCap, 0);

        l = reg.limits(address(0xBEEF));
        assertFalse(l.exists);
        assertFalse(l.active);
        assertEq(l.partner, address(0));
    }

    function test_voidMarket_unknownReverts() public {
        vm.prank(pOwner);
        vm.expectRevert(abi.encodeWithSelector(PartnerRegistry.UnknownMarket.selector, address(1)));
        reg.voidMarket(address(1), 0);
    }

    // ------------------------------------------------------------------ bond

    function test_bond_postRequiresApprovalAndAmount() public {
        usdc.mint(other, 5);
        vm.startPrank(other);
        usdc.approve(address(reg), 5);
        vm.expectRevert(abi.encodeWithSelector(PartnerRegistry.NotApproved.selector, other));
        reg.postBond(5);
        vm.stopPrank();
        vm.prank(partner);
        vm.expectRevert(PartnerRegistry.ZeroAmount.selector);
        reg.postBond(0);
    }

    function test_bond_withdrawalWaitsForTheDelayAndTheChallengePeriod() public {
        // a market that ends in 7 days pushes the challenge period past the 7 day delay
        Market m = _create(partner, 3000e18, _end(7 days));
        uint64 end = m.endTime();
        vm.prank(partner);
        reg.requestBondWithdrawal(40 * U);
        assertEq(reg.partnerOf(partner).bond, 60 * U);
        assertEq(reg.partnerOf(partner).pendingWithdrawal, 40 * U);
        uint64 ready = end + reg.CHALLENGE_PERIOD();
        assertEq(reg.partnerOf(partner).withdrawableAt, ready);

        vm.prank(partner);
        vm.expectRevert(abi.encodeWithSelector(PartnerRegistry.WithdrawalNotReady.selector, ready));
        reg.executeBondWithdrawal(partner);
        vm.warp(ready);
        vm.prank(partner);
        reg.executeBondWithdrawal(partner);
        assertEq(usdc.balanceOf(partner), 40 * U);
        assertEq(reg.partnerOf(partner).pendingWithdrawal, 0);
    }

    function test_bond_withdrawalWithNoMarketsWaitsTheDelay() public {
        vm.prank(partner);
        reg.requestBondWithdrawal(100 * U);
        // forge-lint: disable-next-line(environment-read-across-mutation)
        uint64 ready = uint64(block.timestamp) + reg.WITHDRAW_DELAY();
        vm.warp(ready - 1);
        vm.prank(partner);
        vm.expectRevert(abi.encodeWithSelector(PartnerRegistry.WithdrawalNotReady.selector, ready));
        reg.executeBondWithdrawal(partner);
        vm.warp(ready);
        vm.prank(partner);
        reg.executeBondWithdrawal(address(0xCAFE));
        assertEq(usdc.balanceOf(address(0xCAFE)), 100 * U);
        // with the bond gone the partner cannot create
        vm.prank(partner);
        vm.expectRevert(abi.encodeWithSelector(PartnerRegistry.BondTooLow.selector, 0, 100 * U));
        reg.createThresholdMarket(ETH, 3000e18, _end(1 hours));
    }

    function test_bond_withdrawalGuards() public {
        vm.startPrank(partner);
        vm.expectRevert(
            abi.encodeWithSelector(PartnerRegistry.InsufficientBond.selector, 100 * U, 0)
        );
        reg.requestBondWithdrawal(0);
        vm.expectRevert(
            abi.encodeWithSelector(PartnerRegistry.InsufficientBond.selector, 100 * U, 101 * U)
        );
        reg.requestBondWithdrawal(101 * U);
        reg.requestBondWithdrawal(10 * U);
        vm.expectRevert(PartnerRegistry.WithdrawalPending.selector);
        reg.requestBondWithdrawal(10 * U);
        vm.warp(block.timestamp + 8 days);
        vm.expectRevert(PartnerRegistry.ZeroAddress.selector);
        reg.executeBondWithdrawal(address(0));
        vm.stopPrank();
        // a suspended partner cannot withdraw
        vm.prank(pGuardian);
        reg.suspendPartner(partner);
        vm.prank(partner);
        vm.expectRevert(
            abi.encodeWithSelector(PartnerRegistry.PartnerIsSuspended.selector, partner)
        );
        reg.executeBondWithdrawal(partner);
        // nothing to withdraw / cancel
        vm.prank(other);
        vm.expectRevert(PartnerRegistry.NothingToWithdraw.selector);
        reg.executeBondWithdrawal(other);
        vm.prank(other);
        vm.expectRevert(PartnerRegistry.NothingToWithdraw.selector);
        reg.cancelBondWithdrawal();
    }

    function test_bond_cancelRestoresTheActiveBond() public {
        vm.startPrank(partner);
        reg.requestBondWithdrawal(30 * U);
        assertEq(reg.partnerOf(partner).bond, 70 * U);
        reg.cancelBondWithdrawal();
        vm.stopPrank();
        assertEq(reg.partnerOf(partner).bond, 100 * U);
        assertEq(reg.partnerOf(partner).pendingWithdrawal, 0);
        assertEq(reg.partnerOf(partner).withdrawableAt, 0);
    }

    function test_slash_takesTheBondFirstThenThePendingWithdrawal() public {
        vm.prank(partner);
        reg.requestBondWithdrawal(40 * U); // bond 60, pending 40
        vm.prank(pOwner);
        reg.slash(partner, 70 * U, keccak256("invalid markets"));
        assertEq(reg.partnerOf(partner).bond, 0);
        assertEq(reg.partnerOf(partner).pendingWithdrawal, 30 * U);
        assertEq(usdc.balanceOf(pSlash), 70 * U);
        // the rest of the pending withdrawal is still slashable
        vm.prank(pOwner);
        reg.slash(partner, 30 * U, 0);
        assertEq(usdc.balanceOf(pSlash), 100 * U);
        assertEq(usdc.balanceOf(address(reg)), 0);
    }

    function test_slash_guards() public {
        vm.prank(partner);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, partner)
        );
        reg.slash(partner, 1, 0);
        vm.startPrank(pOwner);
        vm.expectRevert(PartnerRegistry.ZeroAmount.selector);
        reg.slash(partner, 0, 0);
        vm.expectRevert(
            abi.encodeWithSelector(PartnerRegistry.InsufficientBond.selector, 100 * U, 100 * U + 1)
        );
        reg.slash(partner, 100 * U + 1, 0);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ fees

    function _winAndRedeem(Market m, uint256 amount) internal {
        _split(m, alice, amount);
        uint64 end = m.endTime();
        vm.warp(end + 1);
        streamsResolver.submit(
            ETH, end, _report(ETH_FEED, uint32(end - 1), uint32(end + 1), 3100e18)
        );
        vm.warp(end + WINDOW + 1);
        m.resolve("");
        vm.prank(alice);
        m.redeem();
    }

    function test_fees_splitBetweenPartnerAndTreasury() public {
        Market m = _create(partner, 3000e18, _end(1 hours));
        _winAndRedeem(m, 1000 * U);
        // 50 bps of a 1000 U payout = 5 U accrued to the registry's market fee
        assertEq(m.feesAccrued(), 5 * U);
        assertEq(usdc.balanceOf(alice), 995 * U);
        reg.collectFees(m);
        // 30 % to the partner, 70 % to the treasury
        assertEq(reg.feesOwed(partner), 1_500_000);
        assertEq(usdc.balanceOf(pTreasury), 3_500_000);
        assertEq(usdc.balanceOf(address(reg)), 100 * U + 1_500_000); // bond + the partner's fees
        address to = makeAddr("feeTo");
        vm.prank(partner);
        reg.withdrawFees(to);
        assertEq(usdc.balanceOf(to), 1_500_000);
        vm.prank(partner);
        vm.expectRevert(PartnerRegistry.NothingToWithdraw.selector);
        reg.withdrawFees(to);
        vm.prank(partner);
        vm.expectRevert(PartnerRegistry.NothingToWithdraw.selector);
        reg.withdrawFees(address(0));
    }

    function test_fees_shareIsSnapshottedAtCreation() public {
        Market m = _create(partner, 3000e18, _end(1 hours));
        vm.prank(pOwner);
        reg.setPartnerTerms(partner, 200 * U, 10_000);
        _winAndRedeem(m, 1000 * U);
        reg.collectFees(m);
        assertEq(reg.feesOwed(partner), 1_500_000); // still 30 %
    }

    function test_fees_unknownMarketAndEmptyFeesRevert() public {
        vm.expectRevert(
            abi.encodeWithSelector(PartnerRegistry.UnknownMarket.selector, address(factory))
        );
        reg.collectFees(Market(address(factory)));
        Market m = _create(partner, 3000e18, _end(1 hours));
        vm.expectRevert(Market.NothingToClaim.selector);
        reg.collectFees(m);
    }

    function test_fees_zeroFeeMarketsAccrueNothing() public {
        vm.prank(pOwner);
        reg.setConfig(100 * U, 500 * U, 0, pTreasury, pSlash);
        Market m = _create(partner, 3000e18, _end(1 hours));
        _winAndRedeem(m, 100 * U);
        assertEq(m.feesAccrued(), 0);
        assertEq(usdc.balanceOf(alice), 100 * U);
    }
}

/// @dev Stands in for a vault that has not enabled the asset.
contract FakeVault {
    bool internal immutable ENABLED;

    constructor(bool enabled) {
        ENABLED = enabled;
    }

    function assetCfg(bytes32)
        external
        view
        returns (bool, bytes32, uint128, uint64, uint128, uint128)
    {
        return (ENABLED, bytes32(0), 0, 0, 0, 0);
    }
}
