// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultBase} from "../VaultBase.t.sol";
import {ConvergeVault} from "../../src/vault/ConvergeVault.sol";
import {ForwardVenue} from "../../src/vault/ForwardVenue.sol";
import {Market} from "../../src/Market.sol";
import {PartnerRegistry} from "../../src/partners/PartnerRegistry.sol";
import {IPartnerRegistry} from "../../src/partners/IPartnerRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice The vault side of liquidity-as-a-service (ADR-008): which markets it accepts, the
///         per-partner and global caps (a partner can never pull more than its cap), the slot
///         limit, the status gate, and a full partner market lifecycle with a real fill.
contract VaultPartnersTest is VaultBase {
    address internal pOwner = makeAddr("pOwner");
    address internal pGuardian = makeAddr("pGuardian");
    address internal pTreasury = makeAddr("pTreasury");
    address internal pSlash = makeAddr("pSlash");
    address internal partnerA = makeAddr("partnerA");
    address internal partnerB = makeAddr("partnerB");
    address internal partnerC = makeAddr("partnerC");

    PartnerRegistry internal reg;

    function setUp() public override {
        super.setUp();
        reg = new PartnerRegistry(factory, pOwner, pGuardian, pTreasury);
        vm.startPrank(pOwner);
        reg.setConfig(100 * U, 500 * U, 50, pTreasury, pSlash);
        reg.setVault(address(vault));
        reg.setFeed(ETH, true);
        bytes32[] memory feeds = new bytes32[](1);
        feeds[0] = ETH;
        reg.approvePartner(partnerA, 40 * U, 3000, feeds);
        reg.approvePartner(partnerB, 40 * U, 3000, feeds);
        reg.approvePartner(partnerC, 40 * U, 3000, feeds);
        vm.stopPrank();
        _bond(partnerA);
        _bond(partnerB);
        _bond(partnerC);
        vm.prank(vOwner);
        vault.setPartnerRegistry(IPartnerRegistry(address(reg)));
        _fund(alice, 1000 * U); // epoch 0 settles; NAV 1000 U, partner fraction 10 % = 100 U
        _setSigma(0.6e18);
    }

    function _bond(address who) internal {
        usdc.mint(who, 100 * U);
        vm.startPrank(who);
        usdc.approve(address(reg), 100 * U);
        reg.postBond(100 * U);
        vm.stopPrank();
    }

    function _mk(address who, int256 strike, uint64 duration) internal returns (Market m) {
        vm.prank(who);
        m = Market(reg.createThresholdMarket(ETH, strike, uint64(block.timestamp) + duration));
    }

    function _alloc(Market m, uint256 amount) internal {
        vm.prank(vKeeper);
        vault.splitForInventory(m, amount);
    }

    function _basis(Market m) internal view returns (int256 b) {
        (b,) = vault.positionOf(address(m));
    }

    // ------------------------------------------------------------------ which markets are accepted

    function test_unknownMarketIsRejected() public {
        // a market from neither factory
        PartnerRegistry other = new PartnerRegistry(factory, pOwner, pGuardian, pTreasury);
        vm.startPrank(pOwner);
        other.setConfig(0, 500 * U, 0, pTreasury, pSlash);
        other.setFeed(ETH, true);
        bytes32[] memory feeds = new bytes32[](1);
        feeds[0] = ETH;
        other.approvePartner(partnerA, 40 * U, 0, feeds);
        vm.stopPrank();
        vm.prank(partnerA);
        Market foreign =
            Market(other.createThresholdMarket(ETH, 3000e18, uint64(block.timestamp) + 1 hours));
        vm.prank(vKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.NotFactoryMarket.selector, address(foreign))
        );
        vault.splitForInventory(foreign, 1 * U);
    }

    function test_partnerMarketNeedsTheRegistryToBeSet() public {
        // a vault where the owner never connected a registry
        ConvergeVault bare = new ConvergeVault(
            IERC20(address(usdc)),
            factory,
            streamsResolver,
            vOwner,
            vGuardian,
            vKeeper,
            vTreasury,
            EPOCH,
            10 * U,
            1_000_000 * U,
            _launchParams()
        );
        vm.prank(vOwner);
        bare.enableAsset(ETH, 0.3e18, 2e18);
        Market m = _mk(partnerA, 3000e18, 1 hours);
        vm.prank(vKeeper);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.NotFactoryMarket.selector, address(m)));
        bare.splitForInventory(m, 1);
    }

    function test_registryIsSetOnceAndByTheOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.setPartnerRegistry(IPartnerRegistry(address(reg)));
        vm.prank(vOwner);
        vm.expectRevert(ConvergeVault.PartnerRegistryAlreadySet.selector);
        vault.setPartnerRegistry(IPartnerRegistry(address(1)));
        ConvergeVault bare = new ConvergeVault(
            IERC20(address(usdc)),
            factory,
            streamsResolver,
            vOwner,
            vGuardian,
            vKeeper,
            vTreasury,
            EPOCH,
            10 * U,
            1_000_000 * U,
            _launchParams()
        );
        vm.prank(vOwner);
        vm.expectRevert(ConvergeVault.ZeroAddress.selector);
        bare.setPartnerRegistry(IPartnerRegistry(address(0)));
    }

    function test_coreMarketsStillWork() public {
        Market core = _create(ETH, M15, T0);
        vm.warp(T0 - 20 * 60);
        _alloc(core, 10 * U);
        assertEq(vault.partnerOf(address(core)), address(0));
        assertEq(vault.partnerMarketCount(), 0);
        assertEq(vault.marketCount(), 1);
    }

    function test_aFeedTheVaultHasNotEnabledCannotBeOnboarded() public {
        // BTC exists in the core factory but not in the vault: no depth, so no partner template
        vm.prank(pOwner);
        vm.expectRevert(abi.encodeWithSelector(PartnerRegistry.FeedHasNoDepth.selector, BTC));
        reg.setFeed(BTC, true);
    }

    // ------------------------------------------------------------------ the caps

    function test_perPartnerCap_singleMarket() public {
        Market m = _mk(partnerA, 3000e18, 1 hours);
        _alloc(m, 40 * U); // exactly the cap
        assertEq(_basis(m), int256(40 * U));
        vm.prank(vKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConvergeVault.PartnerCapExceeded.selector, partnerA, 40 * U + 1, 40 * U
            )
        );
        vault.splitForInventory(m, 1);
    }

    function test_perPartnerCap_isTheSumOverAllItsMarkets() public {
        Market m1 = _mk(partnerA, 3000e18, 1 hours);
        Market m2 = _mk(partnerA, 3100e18, 2 hours);
        Market m3 = _mk(partnerA, 2900e18, 3 hours);
        _alloc(m1, 15 * U);
        _alloc(m2, 15 * U);
        vm.prank(vKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConvergeVault.PartnerCapExceeded.selector, partnerA, 40 * U + 1, 40 * U
            )
        );
        vault.splitForInventory(m3, 10 * U + 1);
        _alloc(m3, 10 * U); // exactly the cap in total
        assertEq(_basis(m1) + _basis(m2) + _basis(m3), int256(40 * U));
    }

    function test_perPartnerCap_cannotBeBypassedByManySmallSplits() public {
        Market m = _mk(partnerA, 3000e18, 1 hours);
        for (uint256 i = 0; i < 40; i++) {
            _alloc(m, 1 * U);
        }
        vm.prank(vKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConvergeVault.PartnerCapExceeded.selector, partnerA, 40 * U + 1, 40 * U
            )
        );
        vault.splitForInventory(m, 1);
    }

    function test_perPartnerCap_isPerPartner() public {
        Market a = _mk(partnerA, 3000e18, 1 hours);
        Market b = _mk(partnerB, 3000e18, 1 hours);
        _alloc(a, 40 * U);
        _alloc(b, 40 * U); // B's own cap is untouched by A's use
        assertEq(_basis(a), int256(40 * U));
        assertEq(_basis(b), int256(40 * U));
    }

    function test_perPartnerCap_roomReturnsAfterMerging() public {
        Market m = _mk(partnerA, 3000e18, 1 hours);
        _alloc(m, 40 * U);
        vm.prank(vKeeper);
        vault.mergeInventory(m, 25 * U);
        assertEq(_basis(m), int256(15 * U));
        _alloc(m, 25 * U); // back to the cap, not beyond
        vm.prank(vKeeper);
        vm.expectRevert();
        vault.splitForInventory(m, 1);
    }

    function test_perPartnerCap_followsTheOwnersLoweredCap() public {
        Market m = _mk(partnerA, 3000e18, 1 hours);
        _alloc(m, 30 * U);
        vm.prank(pOwner);
        reg.setPartnerTerms(partnerA, 20 * U, 3000);
        // existing inventory stays (merge is the keeper's job) but nothing more is allocated
        vm.prank(vKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConvergeVault.PartnerCapExceeded.selector, partnerA, 30 * U + 1, 20 * U
            )
        );
        vault.splitForInventory(m, 1);
        assertEq(_basis(m), int256(30 * U));
    }

    function test_globalCap_acrossPartners() public {
        vm.prank(pOwner);
        reg.setConfig(100 * U, 50 * U, 50, pTreasury, pSlash); // all partners together: 50 U
        Market a = _mk(partnerA, 3000e18, 1 hours);
        Market b = _mk(partnerB, 3000e18, 1 hours);
        _alloc(a, 30 * U);
        vm.prank(vKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConvergeVault.PartnerGlobalCapExceeded.selector, 50 * U + 1, 50 * U
            )
        );
        vault.splitForInventory(b, 20 * U + 1);
        _alloc(b, 20 * U);
    }

    function test_globalCap_vaultFractionAppliesEvenIfTheRegistryIsGenerous() public {
        // registry says 500 U in total and 400 U for the partner; the vault's own 10 % of NAV is 100 U
        vm.startPrank(pOwner);
        reg.setPartnerTerms(partnerA, 400 * U, 3000);
        reg.setPartnerTerms(partnerB, 400 * U, 3000);
        vm.stopPrank();
        Market a = _mk(partnerA, 3000e18, 1 hours);
        Market b = _mk(partnerB, 3000e18, 1 hours);
        _alloc(a, 60 * U);
        vm.prank(vKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConvergeVault.PartnerGlobalCapExceeded.selector, 100 * U + 1, 100 * U
            )
        );
        vault.splitForInventory(b, 40 * U + 1);
        _alloc(b, 40 * U);
        assertEq(vault.maxPartnerFraction(), 0.1e18);
    }

    function test_partnerFraction_ownerBoundedAndZeroStopsAllocation() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.setPartnerFraction(0.2e18);
        vm.startPrank(vOwner);
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setPartnerFraction(0.3e18 + 1);
        vault.setPartnerFraction(0);
        vm.stopPrank();
        Market m = _mk(partnerA, 3000e18, 1 hours);
        vm.prank(vKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.PartnerGlobalCapExceeded.selector, 1, 0)
        );
        vault.splitForInventory(m, 1);
    }

    function test_partnerSlots_areBoundedAndFreedOnUnregister() public {
        // 7 partner markets from three partners (3 each at most can be registered)
        Market[] memory ms = new Market[](7);
        for (uint256 i = 0; i < 7; i++) {
            ms[i] =
                _mk(i < 3 ? partnerA : (i < 6 ? partnerB : partnerC), int256(3000e18 + i), 1 hours);
        }
        for (uint256 i = 0; i < 6; i++) {
            _alloc(ms[i], 1 * U);
        }
        assertEq(vault.partnerMarketCount(), 6);
        vm.prank(vKeeper);
        vm.expectRevert(ConvergeVault.TooManyPartnerMarkets.selector);
        vault.splitForInventory(ms[6], 1 * U);
        // merging a market to empty frees its slot
        vm.prank(vKeeper);
        vault.mergeInventory(ms[0], 1 * U);
        assertEq(vault.partnerMarketCount(), 5);
        assertEq(vault.partnerOf(address(ms[0])), address(0));
        _alloc(ms[6], 1 * U);
        assertEq(vault.partnerMarketCount(), 6);
    }

    function test_onePartnerCannotTakeAllThePartnerSlots() public {
        Market[] memory ms = new Market[](4);
        for (uint256 i = 0; i < 4; i++) {
            ms[i] = _mk(partnerA, int256(3000e18 + i), 1 hours);
        }
        for (uint256 i = 0; i < 3; i++) {
            _alloc(ms[i], 1 * U);
        }
        vm.prank(vKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.TooManyMarketsForPartner.selector, partnerA)
        );
        vault.splitForInventory(ms[3], 1 * U);
        // the other partners still have room
        _alloc(_mk(partnerB, 3100e18, 1 hours), 1 * U);
        // freeing one of A's slots lets its fourth market in
        vm.prank(vKeeper);
        vault.mergeInventory(ms[0], 1 * U);
        _alloc(ms[3], 1 * U);
    }

    function test_partnerMarketsCannotCrowdOutTheCoreRounds() public {
        for (uint256 i = 0; i < 6; i++) {
            _alloc(_mk(i < 3 ? partnerA : partnerB, int256(3000e18 + i), 1 hours), 1 * U);
        }
        // the 16 slot registry still has room for 10 core rounds
        assertEq(vault.marketCount(), 6);
        uint256 t = block.timestamp;
        for (uint256 i = 0; i < 4; i++) {
            Market core = _create(ETH, M15, uint64(((t / 900) + 2 + i) * 900));
            _alloc(core, 1 * U);
        }
        assertEq(vault.marketCount(), 10);
    }

    // ------------------------------------------------------------------ status gate

    function test_suspendedPartner_noNewAllocationAndNoQuoting() public {
        Market m = _mk(partnerA, 3000e18, 1 hours);
        _alloc(m, 10 * U);
        vm.warp(block.timestamp + 1);
        assertTrue(vault.venueView(m).tradable);
        vm.prank(pGuardian);
        reg.suspendPartner(partnerA);
        assertFalse(vault.venueView(m).tradable);
        vm.prank(vKeeper);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.PartnerInactive.selector, address(m)));
        vault.splitForInventory(m, 1);
        // merging is never blocked
        vm.prank(vKeeper);
        vault.mergeInventory(m, 10 * U);
        assertEq(_basis(m), 0);
        vm.prank(pOwner);
        reg.unsuspendPartner(partnerA);
        _alloc(m, 1 * U);
    }

    function test_voidedMarket_stopsQuotingAndAllocation() public {
        Market m = _mk(partnerA, 3000e18, 1 hours);
        Market healthy = _mk(partnerA, 3100e18, 1 hours);
        _alloc(m, 10 * U);
        _alloc(healthy, 10 * U);
        vm.prank(pOwner);
        reg.voidMarket(address(m), keccak256("misdescribed"));
        assertFalse(vault.venueView(m).tradable);
        assertTrue(vault.venueView(healthy).tradable);
        vm.prank(vKeeper);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.PartnerInactive.selector, address(m)));
        vault.splitForInventory(m, 1);
    }

    function test_bondBelowMinimumDeactivates() public {
        Market m = _mk(partnerA, 3000e18, 1 hours);
        _alloc(m, 5 * U);
        vm.prank(pOwner);
        reg.slash(partnerA, 1, keccak256("dust"));
        assertFalse(vault.venueView(m).tradable);
        vm.prank(vKeeper);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.PartnerInactive.selector, address(m)));
        vault.splitForInventory(m, 1);
    }

    function test_slashedBondGoesToTheVaultAsADonationToLps() public {
        vm.prank(pOwner);
        reg.setConfig(100 * U, 500 * U, 50, pTreasury, address(vault));
        uint256 before = usdc.balanceOf(address(vault));
        vm.prank(pOwner);
        reg.slash(partnerA, 100 * U, keccak256("invalid market"));
        assertEq(usdc.balanceOf(address(vault)) - before, 100 * U);
        // visible at the next checkpoint
        vault.checkpoint(_noReports());
        assertEq(vault.quoteNavLower(), 1100 * U);
    }

    function test_fillsOnASuspendedPartnerMarketRevert() public {
        Market m = _mk(partnerA, 3000e18, 1 hours);
        _alloc(m, 20 * U);
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 5 * U, 0.7e18);
        vm.prank(pGuardian);
        reg.suspendPartner(partnerA);
        (,,, uint64 at,,,,,) = venue.orders(id);
        vm.warp(at);
        vm.prank(executor);
        // the order is refunded rather than filled: nothing trades once the partner is suspended
        (uint256 filled,) = venue.executeOrder(id, _repWindow(at - 1, at + 1, 3000e18, at + 1 days));
        assertEq(filled, 0);
    }

    // ------------------------------------------------------------------ lifecycle

    function _exec(uint256 id, int192 px) internal returns (uint256 filled, uint256 premium) {
        (,,, uint64 at,,,,,) = venue.orders(id);
        vm.warp(at);
        vm.prank(executor);
        return venue.executeOrder(id, _repWindow(at - 1, at + 1, px, at + 1 days));
    }

    function _resolve(Market m, int192 px) internal {
        uint64 end = m.endTime();
        vm.warp(end + 1);
        streamsResolver.submit(ETH, end, _report(ETH_FEED, uint32(end - 1), uint32(end + 1), px));
        vm.warp(end + WINDOW + 1);
        m.resolve("");
    }

    function test_lifecycle_createQuoteTradeResolveRedeem_upWins() public {
        Market m = _mk(partnerA, 3000e18, 1 hours);
        _alloc(m, 30 * U);
        assertEq(vault.partnerOf(address(m)), partnerA);
        vm.warp(block.timestamp + 1);
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 10 * U, 0.7e18);
        (uint256 filled, uint256 premium) = _exec(id, 3000e18);
        assertEq(filled, 10 * U);
        assertGt(premium, 0);
        assertLt(premium, 7 * U);
        assertEq(m.up().balanceOf(taker), 10 * U);

        _resolve(m, 3100e18);
        assertEq(uint8(m.state()), uint8(Market.State.RESOLVED_UP));
        vm.prank(taker);
        m.redeem();
        // 10 UP pay 10 minus the 50 bps redeem fee, plus the escrow refund
        assertGe(usdc.balanceOf(taker), 10 * U - 50_000);

        // the vault pulls its value back: 30 - 10 = 20 pairs merge, 10 DOWN lose
        uint256 before = usdc.balanceOf(address(vault));
        vault.redeemResolved(m);
        assertEq(usdc.balanceOf(address(vault)) - before, 20 * U);
        assertEq(vault.marketCount(), 0);
        assertEq(vault.partnerMarketCount(), 0);
        // the partner's fee share is collectable
        reg.collectFees(m);
        assertGt(reg.feesOwed(partnerA), 0);
    }

    function test_lifecycle_downWins_andTheVaultKeepsThePremium() public {
        Market m = _mk(partnerA, 3000e18, 1 hours);
        _alloc(m, 30 * U);
        vm.warp(block.timestamp + 1);
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 10 * U, 0.7e18);
        (, uint256 premium) = _exec(id, 3000e18);
        _resolve(m, 2900e18);
        assertEq(uint8(m.state()), uint8(Market.State.RESOLVED_DOWN));
        uint256 before = usdc.balanceOf(address(vault));
        vault.redeemResolved(m);
        // merge 20 pairs, redeem 10 winning DOWN (minus the redeem fee)
        uint256 payout = usdc.balanceOf(address(vault)) - before;
        assertEq(payout, 30 * U - (10 * U * 50) / 10_000);
        assertGt(premium, 0);
    }

    function test_lifecycle_navUsesThePinnedStrike() public {
        // two markets, same asset and end; only the strike differs. With spot 3000 the market
        // struck at 2980 is likelier UP than the one struck at 3020, so the vault prices UP higher
        // in the first: the price comes from each market's own strike.
        Market lo = _mk(partnerA, 2980e18, 1 hours);
        Market hi = _mk(partnerB, 3020e18, 1 hours);
        _alloc(lo, 10 * U);
        _alloc(hi, 10 * U);
        // a taker buys UP in both at the oracle price 3000: the vault sells UP and keeps DOWN
        vm.warp(block.timestamp + 1);
        uint256 id1 = _placeAs(taker, lo, ForwardVenue.Kind.BUY_UP, 2 * U, 0.99e18);
        uint256 id2 = _placeAs(bob, hi, ForwardVenue.Kind.BUY_UP, 2 * U, 0.99e18);
        (, uint256 premiumLo) = _exec(id1, 3000e18);
        (, uint256 premiumHi) = _exec(id2, 3000e18);
        // UP is a little likelier than not at strike 2980 and a little less likely at 3020
        assertGt(premiumLo, premiumHi);
    }

    function test_lifecycle_invalidPartnerMarketPaysHalf() public {
        Market m = _mk(partnerA, 3000e18, 1 hours);
        _alloc(m, 10 * U);
        vm.warp(m.endTime() + GRACE + 1);
        m.resolve(""); // no report ever arrived: INVALID
        assertEq(uint8(m.state()), uint8(Market.State.INVALID));
        uint256 before = usdc.balanceOf(address(vault));
        vault.redeemResolved(m); // all 10 are complete pairs: merged at par, no fee
        assertEq(usdc.balanceOf(address(vault)) - before, 10 * U);
    }

    // ------------------------------------------------------------------ settlement with a partner market

    function test_epochSettlementValuesAPartnerMarketAtItsStrike() public {
        Market m = _mk(partnerA, 3000e18, 3 hours);
        _alloc(m, 30 * U);
        vm.warp(block.timestamp + 1);
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 10 * U, 0.7e18);
        _exec(id, 3000e18);
        // a deposit request starts the next settlement; the vault holds excess DOWN of a running
        // partner market, so the plan asks for one report (the market is the same asset as core)
        uint256 e = _requestDeposit(bob, 20 * U);
        _toEpochEnd(e);
        (bytes32[] memory feeds,) = vault.settlementPlan(e);
        assertEq(feeds.length, 1);
        vault.settleEpoch(e, _planMarks(e, 3000e18));
        assertTrue(vault.quoteNavLower() > 0);
    }

    // ------------------------------------------------------------------ review findings

    /// @dev H1: a strike far above the spot used to make lnWad(0) revert inside the NAV valuation,
    ///      and one donated token was enough to freeze the checkpoint, the epoch settlement and
    ///      every fill for the life of the market.
    function test_absurdStrikeCannotFreezeTheVault() public {
        Market bad = _mk(partnerA, 1e40, 7 days); // 1e22 times the ETH spot
        _alloc(bad, 1 * U);
        Market healthy = _mk(partnerB, 3000e18, 1 hours);
        _alloc(healthy, 20 * U);
        // anyone gives the vault one token of the absurd market: it now holds an unmatched excess
        _split(bad, bob, 1);
        IERC20 badUp = IERC20(address(bad.up()));
        vm.prank(bob);
        badUp.transfer(address(vault), 1);

        vault.checkpoint(_markNow(3000e18)); // used to revert with LnWadUndefined
        assertGt(vault.quoteNavLower(), 0);

        // an epoch with a deposit still settles
        uint256 e = _requestDeposit(carol(), 20 * U);
        _toEpochEnd(e);
        vault.settleEpoch(e, _planMarks(e, 3000e18));

        // and a trade in a healthy market still fills (the auto-checkpoint inside the fill runs)
        vm.warp(block.timestamp + 61);
        _setSigma(0.6e18); // the keeper refreshes sigma (it goes stale after 15 minutes)
        vault.checkpoint(_markNow(3000e18));
        uint256 id = _placeAs(taker, healthy, ForwardVenue.Kind.BUY_UP, 2 * U, 0.7e18);
        (uint256 filled,) = _exec(id, 3000e18);
        assertGt(filled, 0);
    }

    function carol() internal pure returns (address) {
        return address(0xCA201);
    }

    /// @dev M1: the cap bounds the collateral the vault SPLITS into a partner's markets. What
    ///      the vault can additionally lose on a partner market by trading is bounded by the
    ///      per-market loss ceiling (1 % of NAV), whatever the cap. This test drives sells into the
    ///      vault and checks both bounds.
    function test_tradingCannotPushLossPastTheCeilingAndSplitsStayUnderTheCap() public {
        Market m = _mk(partnerA, 3000e18, 1 hours);
        _alloc(m, 40 * U); // the whole cap
        vm.warp(block.timestamp + 1);
        // a taker splits its own collateral (not the vault's) and sells 300 UP into the vault
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.SELL_UP, 300 * U, 0.01e18);
        _exec(id, 3000e18);
        (int256 basis, int256 cash) = vault.positionOf(address(m));
        assertLe(basis, int256(40 * U)); // split collateral never above the cap
        uint256 up = IERC20(address(m.up())).balanceOf(address(vault));
        uint256 down = IERC20(address(m.down())).balanceOf(address(vault));
        int256 lossU = basis - cash - int256(up < down ? up : down);
        // 1 % of the 1000 U NAV (tolerance of the rounding of the room computation)
        assertLe(lossU, int256(10 * U) + int256(U / 100));
        assertGt(cash, -int256(10 * U) - int256(U / 100));
    }

    function test_directionalLossOnAPartnerMarketIsBoundedWhateverTheCap() public {
        // a partner with a tiny cap still cannot drive loss past the same ceiling
        vm.prank(pOwner);
        reg.setPartnerTerms(partnerA, 1 * U, 3000);
        Market m = _mk(partnerA, 3000e18, 1 hours);
        _alloc(m, 1 * U);
        vm.warp(block.timestamp + 1);
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.SELL_UP, 300 * U, 0.01e18);
        _exec(id, 3000e18);
        (int256 basis, int256 cash) = vault.positionOf(address(m));
        assertLe(basis, int256(1 * U));
        uint256 up = IERC20(address(m.up())).balanceOf(address(vault));
        uint256 down = IERC20(address(m.down())).balanceOf(address(vault));
        int256 lossU = basis - cash - int256(up < down ? up : down);
        assertLe(lossU, int256(10 * U) + int256(U / 100));
    }
}
