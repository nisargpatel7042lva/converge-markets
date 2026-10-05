// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultBase} from "../VaultBase.t.sol";
import {ConvergeVault} from "../../src/vault/ConvergeVault.sol";
import {QuoteMath} from "../../src/vault/QuoteMath.sol";
import {Market} from "../../src/Market.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Keeper powers and their bounds, the inventory registry, NAV valuation, the breaker,
///         roles and admin configuration.
contract VaultInventoryTest is VaultBase {
    Market internal m;

    function setUp() public override {
        super.setUp();
        _fund(alice, 1000 * U); // epoch 0 settles at T0 - 45 min
        m = _openEth(T0, M15, 3000e18);
        vm.warp(T0 + 300);
    }

    function _resolveEth(Market mk, uint64 end, int192 px) internal {
        vm.warp(end + 1);
        streamsResolver.submit(ETH, end, _report(ETH_FEED, uint32(end - 1), uint32(end + 1), px));
        vm.warp(end + WINDOW + 1);
        mk.resolve("");
    }

    function _donate(Market mk, bool up, uint256 amount) internal {
        _split(mk, bob, amount);
        IERC20 t = up ? IERC20(address(mk.up())) : IERC20(address(mk.down()));
        vm.prank(bob);
        t.transfer(address(vault), amount);
    }

    // ------------------------------------------------------------------ setSigma

    function test_setSigma_firstValueAndEvent() public {
        vm.expectEmit(address(vault));
        emit ConvergeVault.SigmaSet(ETH, 0.6e18);
        _setSigma(0.6e18);
        (,, uint128 sigma, uint64 at,,) = vault.assetCfg(ETH);
        assertEq(sigma, 0.6e18);
        assertEq(at, block.timestamp);
    }

    function test_setSigma_revertsForNonKeeperAndUnknownAsset() public {
        vm.prank(alice);
        vm.expectRevert(ConvergeVault.OnlyKeeper.selector);
        vault.setSigma(ETH, 0.6e18);
        vm.prank(vOwner);
        vm.expectRevert(ConvergeVault.OnlyKeeper.selector);
        vault.setSigma(ETH, 0.6e18);
        vm.prank(vKeeper);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.AssetNotEnabled.selector, BTC));
        vault.setSigma(BTC, 0.6e18);
    }

    function test_setSigma_bandStepAndRate() public {
        _setSigma(0.6e18);
        vm.startPrank(vKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.SigmaOutOfBand.selector, 0.29e18, 0.3e18, 2e18)
        );
        vault.setSigma(ETH, 0.29e18);
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.SigmaOutOfBand.selector, 2.01e18, 0.3e18, 2e18)
        );
        vault.setSigma(ETH, 2.01e18);
        // inside the band but too soon
        vm.expectRevert(
            abi.encodeWithSelector(
                // forge-lint: disable-next-line(environment-read-across-mutation)
                ConvergeVault.SigmaTooSoon.selector,
                // forge-lint: disable-next-line(environment-read-across-mutation)
                uint64(block.timestamp + 30)
            )
        );
        vault.setSigma(ETH, 0.61e18);
        // forge-lint: disable-next-line(environment-read-across-mutation)
        vm.warp(block.timestamp + 30);
        // 20% step limit: 0.6 -> 0.73 is +21.7%
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.SigmaStepTooLarge.selector, 0.73e18, 0.6e18)
        );
        vault.setSigma(ETH, 0.73e18);
        vault.setSigma(ETH, 0.72e18); // exactly +20%
        // a stale sigma may be reset anywhere inside the band
        vm.warp(block.timestamp + 16 minutes);
        vault.setSigma(ETH, 1.9e18);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ splitForInventory

    function test_split_registersAndMovesCollateral() public {
        vm.expectEmit(address(vault));
        emit ConvergeVault.MarketRegistered(address(m), ETH);
        vm.prank(vKeeper);
        vault.splitForInventory(m, 100 * U);
        assertEq(vault.marketCount(), 1);
        assertEq(vault.marketAt(0), address(m));
        assertTrue(vault.isRegistered(address(m)));
        (int256 basis, int256 cash) = vault.positionOf(address(m));
        assertEq(basis, int256(100 * U));
        assertEq(cash, 0);
        assertEq(IERC20(address(m.up())).balanceOf(address(vault)), 100 * U);
        assertEq(IERC20(address(m.down())).balanceOf(address(vault)), 100 * U);
        assertEq(usdc.allowance(address(vault), address(m)), 0); // no standing approval
        // splitting pairs does not change the NAV
        vault.checkpoint(_noReports());
        assertEq(vault.quoteNavLower(), 1000 * U);
        assertEq(vault.lastNavUpper(), 1000 * U);
    }

    function test_split_revertsForNonKeeper() public {
        vm.prank(alice);
        vm.expectRevert(ConvergeVault.OnlyKeeper.selector);
        vault.splitForInventory(m, 1);
    }

    function test_split_revertsZeroAndPaused() public {
        vm.startPrank(vKeeper);
        vm.expectRevert(ConvergeVault.ZeroAmount.selector);
        vault.splitForInventory(m, 0);
        vm.stopPrank();
        vm.prank(vGuardian);
        vault.pauseQuoting();
        vm.prank(vKeeper);
        vm.expectRevert(ConvergeVault.QuotingIsPaused.selector);
        vault.splitForInventory(m, 1 * U);
    }

    function test_split_rejectsForeignAndUnsupportedMarkets() public {
        FakeMarket fake = new FakeMarket(ETH, T0, T0 + 900);
        Market btcM = _create(BTC, M15, T0 + 1800);
        vm.startPrank(vKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.NotFactoryMarket.selector, address(fake))
        );
        vault.splitForInventory(Market(address(fake)), 1 * U);
        // a real factory market of an asset the vault has not enabled
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.AssetNotEnabled.selector, BTC));
        vault.splitForInventory(btcM, 1 * U);
        // same factory key but a different address (impostor claiming real parameters)
        FakeMarket fake2 = new FakeMarket(ETH, T0 + 900, T0 + 1800);
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.NotFactoryMarket.selector, address(fake2))
        );
        vault.splitForInventory(Market(address(fake2)), 1 * U);
        vm.stopPrank();
    }

    function test_split_rejectsResolvedAndNoQuoteWindow() public {
        vm.startPrank(vKeeper);
        vm.warp(T0 + 900 - 30); // the no-quote window starts 30 s before the end
        vm.expectRevert(ConvergeVault.InNoQuoteWindow.selector);
        vault.splitForInventory(m, 1 * U);
        vm.stopPrank();
        _resolveEth(m, T0 + 900, 3100e18);
        vm.prank(vKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConvergeVault.WrongMarketState.selector, uint8(Market.State.RESOLVED_UP)
            )
        );
        vault.splitForInventory(m, 1 * U);
    }

    function test_split_pairAndInventoryCaps() public {
        Market m2 = _create(ETH, M15, T0 + 900);
        vm.startPrank(vKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.PairCapExceeded.selector, 301 * U, 300 * U)
        );
        vault.splitForInventory(m, 301 * U);
        vault.splitForInventory(m, 300 * U);
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.InventoryCapExceeded.selector, 600 * U, 500 * U)
        );
        vault.splitForInventory(m2, 300 * U);
        vault.splitForInventory(m2, 200 * U); // 500 in total is allowed
        vm.stopPrank();
    }

    function test_split_registryIsBounded() public {
        Market[] memory ms = new Market[](17);
        for (uint256 i = 1; i < 17; i++) {
            ms[i] = _create(ETH, M15, T0 + uint64(900 * i));
        }
        vm.startPrank(vKeeper);
        vault.splitForInventory(m, 10 * U);
        for (uint256 i = 1; i < 16; i++) {
            vault.splitForInventory(ms[i], 10 * U);
        }
        assertEq(vault.marketCount(), 16);
        Market extra = ms[16];
        vm.expectRevert(ConvergeVault.TooManyMarkets.selector);
        vault.splitForInventory(extra, 10 * U);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ mergeInventory

    function test_merge_returnsCollateralAndPrunesEmptyMarket() public {
        vm.startPrank(vKeeper);
        vault.splitForInventory(m, 100 * U);
        vault.mergeInventory(m, 40 * U);
        (int256 basis,) = vault.positionOf(address(m));
        assertEq(basis, int256(60 * U));
        assertEq(vault.marketCount(), 1);
        vault.mergeInventory(m, 60 * U);
        assertEq(vault.marketCount(), 0);
        assertFalse(vault.isRegistered(address(m)));
        vm.stopPrank();
    }

    function test_merge_reverts() public {
        vm.prank(alice);
        vm.expectRevert(ConvergeVault.OnlyKeeper.selector);
        vault.mergeInventory(m, 1);
        vm.startPrank(vKeeper);
        vm.expectRevert(ConvergeVault.ZeroAmount.selector);
        vault.mergeInventory(m, 0);
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.MarketNotRegistered.selector, address(m))
        );
        vault.mergeInventory(m, 1);
        vault.splitForInventory(m, 10 * U);
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.NotEnoughPairs.selector, 10 * U, 11 * U)
        );
        vault.mergeInventory(m, 11 * U);
        vm.stopPrank();
    }

    function test_merge_worksWhilePaused() public {
        vm.prank(vKeeper);
        vault.splitForInventory(m, 10 * U);
        vm.prank(vGuardian);
        vault.pauseQuoting();
        vm.prank(vKeeper);
        vault.mergeInventory(m, 10 * U);
        assertEq(vault.marketCount(), 0);
    }

    // ------------------------------------------------------------------ redeemResolved

    function test_redeemResolved_pairsAndWinningExcess() public {
        vm.prank(vKeeper);
        vault.splitForInventory(m, 100 * U);
        _donate(m, true, 10 * U);
        _resolveEth(m, T0 + 900, 3100e18); // UP wins
        uint256 before = usdc.balanceOf(address(vault));
        vault.redeemResolved(m); // anyone
        assertEq(usdc.balanceOf(address(vault)) - before, 110 * U);
        assertEq(vault.marketCount(), 0);
        assertEq(IERC20(address(m.up())).balanceOf(address(vault)), 0);
    }

    function test_redeemResolved_losingExcessPaysNothingAndInvalidPaysHalf() public {
        vm.prank(vKeeper);
        vault.splitForInventory(m, 100 * U);
        _donate(m, true, 10 * U);
        _resolveEth(m, T0 + 900, 2900e18); // DOWN wins: the donated UP is worth 0
        uint256 before = usdc.balanceOf(address(vault));
        vault.redeemResolved(m);
        assertEq(usdc.balanceOf(address(vault)) - before, 100 * U);

        // an INVALID market pays half per leftover token
        Market m2 = _create(ETH, M15, T0 + 1800);
        vm.warp(T0 + 1800 - 100);
        vm.prank(vKeeper);
        vault.splitForInventory(m2, 20 * U);
        _donate(m2, true, 10 * U);
        vm.warp(T0 + 1800 + GRACE + 1); // no strike report ever arrives: the boundary is UNRESOLVABLE
        m2.invalidate();
        before = usdc.balanceOf(address(vault));
        vault.redeemResolved(m2);
        assertEq(usdc.balanceOf(address(vault)) - before, 20 * U + 5 * U);
    }

    function test_redeemResolved_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.MarketNotRegistered.selector, address(m))
        );
        vault.redeemResolved(m);
        vm.prank(vKeeper);
        vault.splitForInventory(m, 10 * U);
        vm.expectRevert(ConvergeVault.MarketUnresolved.selector);
        vault.redeemResolved(m);
        _resolveEth(m, T0 + 900, 3100e18);
        // nothing left to redeem
        vm.startPrank(address(vault));
        IERC20(address(m.up())).transfer(address(0xB0B), 10 * U);
        IERC20(address(m.down())).transfer(address(0xB0B), 10 * U);
        vm.stopPrank();
        vm.expectRevert(ConvergeVault.NothingToRedeem.selector);
        vault.redeemResolved(m);
    }

    // ------------------------------------------------------------------ NAV valuation

    function _band(uint256 spot, uint256 tau) internal view returns (uint256 pLo, uint256 pHi) {
        uint256[3] memory sg = [uint256(0.6e18), 0.3e18, 2e18];
        pLo = 1e18;
        for (uint256 k = 0; k < 3; k++) {
            uint256 p = QuoteMath.normCdf(QuoteMath.d2(spot, 3000e18, sg[k], tau));
            if (p < pLo) pLo = p;
            if (p > pHi) pHi = p;
        }
        uint256 band = vault.markBand();
        pLo = pLo > band ? pLo - band : 0;
        pHi = pHi + band > 1e18 ? 1e18 : pHi + band;
    }

    function test_nav_excessPricedFromReportWithBand() public {
        _setSigma(0.6e18);
        vm.prank(vKeeper);
        vault.splitForInventory(m, 100 * U);
        _donate(m, true, 10 * U); // 10 USDC of UP above the pairs
        uint256 obs = block.timestamp;
        vault.checkpoint(_markNow(3000e18));
        (uint256 pLo, uint256 pHi) = _band(3000e18, T0 + 900 - obs);
        uint256 expLo = 1000 * U + (10 * U * pLo) / 1e18; // the excess; pairs are worth 1 each
        uint256 expHi = 1000 * U + (10 * U * pHi + 1e18 - 1) / 1e18;
        assertEq(vault.quoteNavLower(), expLo);
        assertEq(vault.lastNavUpper(), expHi);
        assertLt(vault.quoteNavLower(), vault.lastNavUpper());
        // a DOWN excess uses the complement
        _donate(m, false, 30 * U); // net DOWN excess is now 20
        vault.checkpoint(_markNow(3000e18));
        uint256 downLo = (20 * U * (1e18 - pHi)) / 1e18;
        assertEq(vault.quoteNavLower(), 1000 * U + 10 * U + downLo); // 110 pairs now
    }

    /// @dev An hour market that is mid-round at every epoch end of the next half hour.
    function _hourMarketWithExcess() internal returns (Market h) {
        h = _create(ETH, H1, T0 + 2700);
        vm.warp(T0 + 2700 + 1);
        streamsResolver.submit(
            ETH, T0 + 2700, _report(ETH_FEED, uint32(T0 + 2699), uint32(T0 + 2701), 3000e18)
        );
        vm.warp(T0 + 2700 + WINDOW + 1);
        h.open("");
        _setSigma(0.6e18);
        vm.prank(vKeeper);
        vault.splitForInventory(h, 100 * U);
        _donate(h, true, 10 * U);
    }

    function test_nav_strictSettlementNeedsTheCanonicalMark() public {
        _hourMarketWithExcess();
        uint256 e = _requestDeposit(carolAddr(), 20 * U);
        (bytes32[] memory needed, address[] memory pending) = vault.settlementPlan(e);
        assertEq(needed.length, 1);
        assertEq(needed[0], ETH_FEED);
        assertEq(pending.length, 0);
        _toEpochEnd(e); // 15:30, the hour market runs to 16:00
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.MarkMissing.selector, ETH));
        vault.settleEpoch(e, _noReports());
        vault.settleEpoch(e, _markAt(block.timestamp, 3000e18)); // with the report at T it settles
        assertGt(vault.lastNavUpper(), vault.quoteNavLower());
    }

    function test_nav_marksNeededEmptyWhenNoExcess() public {
        vm.prank(vKeeper);
        vault.splitForInventory(m, 50 * U);
        (bytes32[] memory feeds, address[] memory pending) = vault.settlementPlan(5);
        assertEq(feeds.length, 0);
        assertEq(pending.length, 0);
    }

    function test_nav_resolvedMarketsAreExactNetOfFee() public {
        // a market created with a 1% redeem fee
        vm.prank(admin);
        factory.setRedeemFee(100);
        vm.prank(admin);
        factory.setFeeRecipient(treasury);
        Market mf = _create(ETH, M15, T0 + 1800);
        vm.warp(T0 + 1800 - 100);
        vm.prank(vKeeper);
        vault.splitForInventory(mf, 100 * U);
        _donate(mf, true, 100 * U);
        _resolveEth(m, T0 + 900, 3100e18); // unrelated market; time passes
        vm.warp(T0 + 1800 + 1);
        streamsResolver.submit(
            ETH, T0 + 1800, _report(ETH_FEED, uint32(T0 + 1800 - 1), uint32(T0 + 1800 + 1), 3000e18)
        );
        vm.warp(T0 + 1800 + WINDOW + 1);
        mf.open("");
        _resolveEth(mf, T0 + 2700, 3100e18);
        vault.checkpoint(_noReports());
        // pairs 100 at 1.0; winning excess 100 at 0.99 (lower, rounded down) and 1.0 (upper)
        assertEq(vault.quoteNavLower(), 1000 * U + 99 * U);
        assertEq(vault.lastNavUpper(), 1000 * U + 100 * U);
    }

    function test_nav_unopenedMarketIsHalfWithBand() public {
        Market future = _create(ETH, M15, T0 + 3600);
        vm.prank(vKeeper);
        vault.splitForInventory(future, 100 * U);
        _donate(future, true, 10 * U);
        vault.checkpoint(_noReports());
        uint256 band = vault.markBand();
        assertEq(vault.quoteNavLower(), 1000 * U + 10 * U * (0.5e18 - band) / 1e18);
        assertEq(vault.lastNavUpper(), 1000 * U + 10 * U * (0.5e18 + band) / 1e18);
    }

    // ------------------------------------------------------------------ breaker

    function test_breaker_tripsOnDrawdownAndNeverBlocksExits() public {
        vault.checkpoint(_noReports()); // snapshot the day's start
        // lose 6% of the assets (limit 5%)
        vm.prank(address(vault));
        usdc.transfer(address(0xB0B), 60 * U);
        assertFalse(vault.quotingPaused());
        vm.expectEmit(address(vault));
        emit ConvergeVault.QuotingPaused(address(vault));
        vault.checkpoint(_noReports());
        assertTrue(vault.quotingPaused());
        // requests and claims keep working
        vm.prank(alice);
        uint256 e = vault.requestRedeem(100 * U);
        _toEpochEnd(e);
        vault.settleEpoch(e, _noReports());
        vm.prank(alice);
        vault.claimRedeem(e, alice);
        assertGt(usdc.balanceOf(alice), 0);
        // the owner resumes; the breaker restarts from the current price, so it does not re-trip
        vm.prank(vOwner);
        vault.resumeQuoting();
        vault.checkpoint(_noReports());
        assertFalse(vault.quotingPaused());
    }

    function test_breaker_withinLimitAndNewDayResets() public {
        vault.checkpoint(_noReports());
        vm.prank(address(vault));
        usdc.transfer(address(0xB0B), 40 * U); // 4%: inside the limit
        vault.checkpoint(_noReports());
        assertFalse(vault.quotingPaused());
        // next UTC day: the reference price resets, so another 4% is allowed
        vm.warp(block.timestamp + 1 days);
        vault.checkpoint(_noReports());
        vm.prank(address(vault));
        usdc.transfer(address(0xB0B), 38 * U);
        vault.checkpoint(_noReports());
        assertFalse(vault.quotingPaused());
    }

    function test_breaker_omittedReportCannotTripIt() public {
        _setSigma(0.6e18);
        vm.prank(vKeeper);
        vault.splitForInventory(m, 100 * U);
        _donate(m, true, 100 * U); // a large excess, priced from a report
        vault.checkpoint(_markNow(3000e18));
        uint256 lower = vault.quoteNavLower();
        vm.warp(block.timestamp + 60);
        // a griefer calls checkpoint without any report: the last verified mark is reused
        vault.checkpoint(_noReports());
        assertFalse(vault.quotingPaused());
        assertApproxEqRel(vault.quoteNavLower(), lower, 0.01e18);
    }

    function test_breaker_roundEndedButUnresolvedDoesNotTripIt() public {
        _setSigma(0.6e18);
        vm.prank(vKeeper);
        vault.splitForInventory(m, 100 * U);
        _donate(m, true, 100 * U); // 100 spare UP: a large exposure to the round's outcome
        vault.checkpoint(_markNow(3010e18)); // spot above strike: UP is likely to win
        vm.warp(T0 + 900 + 5); // the round has ended; the resolution report is not final yet
        vault.checkpoint(_noReports()); // anyone, with no report
        assertFalse(vault.quotingPaused());
        // valued from the last verified mark (less the sigma corners and the band), not at zero:
        // the lower NAV keeps a good part of the 100 USDC of spare UP
        assertGt(vault.quoteNavLower(), 1000 * U + 50 * U);
    }

    function test_checkpoint_onEmptyVaultIsNoop() public {
        ConvergeVault v2 = new ConvergeVault(
            IERC20(address(usdc)),
            factory,
            streamsResolver,
            vOwner,
            vGuardian,
            vKeeper,
            vTreasury,
            EPOCH,
            10 * U,
            1e12,
            _launchParams()
        );
        v2.checkpoint(_noReports());
        assertEq(v2.navUpdatedAt(), 0);
    }

    // ------------------------------------------------------------------ guardian and owner

    function test_pause_guardianAndOwnerOnly() public {
        vm.prank(alice);
        vm.expectRevert(ConvergeVault.OnlyGuardianOrOwner.selector);
        vault.pauseQuoting();
        vm.prank(vKeeper);
        vm.expectRevert(ConvergeVault.OnlyGuardianOrOwner.selector);
        vault.pauseQuoting();
        vm.prank(vGuardian);
        vault.pauseQuoting();
        assertTrue(vault.quotingPaused());
        // the guardian cannot resume
        vm.prank(vGuardian);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, vGuardian)
        );
        vault.resumeQuoting();
        vm.prank(vOwner);
        vault.resumeQuoting();
        assertFalse(vault.quotingPaused());
        vm.prank(vOwner);
        vault.pauseQuoting();
        assertTrue(vault.quotingPaused());
    }

    function test_ownership_isTwoStep() public {
        vm.prank(vOwner);
        vault.transferOwnership(alice);
        assertEq(vault.owner(), vOwner);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        vault.acceptOwnership();
        vm.prank(alice);
        vault.acceptOwnership();
        assertEq(vault.owner(), alice);
    }

    function test_ownerSetters_authAndZeroChecks() public {
        vm.startPrank(vKeeper);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, vKeeper)
        );
        vault.setKeeper(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, vKeeper)
        );
        vault.setTvlCap(1);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, vKeeper)
        );
        vault.setQuoteParams(_launchParams());
        vm.stopPrank();
        vm.startPrank(vOwner);
        vm.expectRevert(ConvergeVault.ZeroAddress.selector);
        vault.setKeeper(address(0));
        vm.expectRevert(ConvergeVault.ZeroAddress.selector);
        vault.setGuardian(address(0));
        vm.expectRevert(ConvergeVault.ZeroAddress.selector);
        vault.setTreasury(address(0));
        vault.setKeeper(alice);
        vault.setGuardian(bob);
        vault.setTreasury(alice);
        vault.setTvlCap(7);
        vm.stopPrank();
        assertEq(vault.keeper(), alice);
        assertEq(vault.guardian(), bob);
        assertEq(vault.treasury(), alice);
        assertEq(vault.tvlCap(), 7);
        // the old keeper lost its powers
        vm.prank(vKeeper);
        vm.expectRevert(ConvergeVault.OnlyKeeper.selector);
        vault.setSigma(ETH, 0.6e18);
    }

    function test_enableAsset_rules() public {
        vm.startPrank(vOwner);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.AssetAlreadyEnabled.selector, ETH));
        vault.enableAsset(ETH, 0.3e18, 2e18);
        // BTC is resolved by the round-proof resolver: not a Data Streams asset
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.UnsupportedAsset.selector, BTC));
        vault.enableAsset(BTC, 0.3e18, 2e18);
        vm.stopPrank();
    }

    function test_enableAsset_bandValidationAndSetBand() public {
        vm.startPrank(vOwner);
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setSigmaBand(ETH, 0.005e18, 2e18);
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setSigmaBand(ETH, 0.5e18, 0.4e18);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.AssetNotEnabled.selector, BTC));
        vault.setSigmaBand(BTC, 0.3e18, 2e18);
        vm.stopPrank();
        _setSigma(0.6e18);
        vm.prank(vOwner);
        vault.setSigmaBand(ETH, 0.7e18, 2e18); // the current sigma falls out of the band
        (,, uint128 sigma,,,) = vault.assetCfg(ETH);
        assertEq(sigma, 0);
        _setSigma(0.8e18);
    }

    function test_enableAsset_limitsAssetCount() public {
        // the registry holds at most MAX_ASSETS enabled assets
        for (uint256 i = 0; i < 7; i++) {
            bytes32 id = keccak256(abi.encode("A", i));
            vm.startPrank(admin);
            streamsResolver.configureAsset(id, bytes32(uint256(0x0003 << 240) | (i + 1)));
            factory.setAsset(id, streamsResolver, "X", true);
            vm.stopPrank();
            vm.prank(vOwner);
            vault.enableAsset(id, 0.3e18, 2e18);
        }
        bytes32 id8 = keccak256("A8");
        vm.startPrank(admin);
        streamsResolver.configureAsset(id8, bytes32(uint256(0x0003 << 240) | 99));
        factory.setAsset(id8, streamsResolver, "X", true);
        vm.stopPrank();
        vm.prank(vOwner);
        vm.expectRevert(ConvergeVault.TooManyAssets.selector);
        vault.enableAsset(id8, 0.3e18, 2e18);
    }

    function test_riskAndSigmaConfig_validation() public {
        vm.startPrank(vOwner);
        vault.setRiskConfig(20, 0.1e18, 300, 300, 0.2e18, 0.4e18);
        assertEq(vault.maxMarkAge(), 20);
        assertEq(vault.settleWindow(), 300);
        assertEq(vault.breakerBps(), 300);
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setRiskConfig(0, 0.1e18, 300, 300, 0.2e18, 0.4e18);
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setRiskConfig(61, 0.1e18, 300, 300, 0.2e18, 0.4e18);
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setRiskConfig(20, 0.31e18, 300, 300, 0.2e18, 0.4e18);
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setRiskConfig(20, 0.1e18, 59, 300, 0.2e18, 0.4e18);
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setRiskConfig(20, 0.1e18, 300, 2501, 0.2e18, 0.4e18);
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setRiskConfig(20, 0.1e18, 300, 0, 0.2e18, 0.4e18);
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setRiskConfig(20, 0.1e18, 300, 300, 1.1e18, 0.4e18);
        vault.setSigmaConfig(1000, 10, 600, 900);
        assertEq(vault.sigmaMinInterval(), 10);
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setSigmaConfig(0, 10, 600, 900);
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setSigmaConfig(1000, 0, 600, 900);
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setSigmaConfig(1000, 100, 50, 900);
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setSigmaConfig(1000, 10, 600, 59);
        vm.stopPrank();
    }

    function test_quoteParams_hardLimits() public {
        QuoteMath.Params memory p = _launchParams();
        vm.startPrank(vOwner);
        vault.setQuoteParams(p);
        p.totalAtRiskMaxFraction = 0.41e18;
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setQuoteParams(p);
        p = _launchParams();
        p.perMarketMaxFraction = 0.051e18;
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setQuoteParams(p);
        p = _launchParams();
        p.priceMax = 0.995e18;
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setQuoteParams(p);
        p = _launchParams();
        p.noQuoteWindowSec = 5;
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setQuoteParams(p);
        p = _launchParams();
        p.levels = 5;
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setQuoteParams(p);
        p = _launchParams();
        p.liquidityNavFraction = 0.51e18;
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setQuoteParams(p);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ venue timelock

    function test_venue_initialOnceThenTimelocked() public {
        vm.startPrank(vOwner);
        vm.expectRevert(ConvergeVault.VenueAlreadySet.selector);
        vault.setInitialVenue(alice);
        vm.expectRevert(ConvergeVault.VenueNotProposed.selector);
        vault.acceptVenue();
        vm.expectRevert(ConvergeVault.ZeroAddress.selector);
        vault.proposeVenue(address(0));
        vault.proposeVenue(alice);
        uint64 eta = vault.pendingVenueEta();
        assertEq(eta, block.timestamp + 2 days);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.VenueTimelock.selector, eta));
        vault.acceptVenue();
        vm.warp(eta);
        vault.acceptVenue();
        vm.stopPrank();
        assertEq(vault.venue(), alice);
        assertEq(vault.pendingVenue(), address(0));
        // cancel path
        vm.startPrank(vOwner);
        vault.proposeVenue(bob);
        vault.cancelVenue();
        vm.expectRevert(ConvergeVault.VenueNotProposed.selector);
        vault.acceptVenue();
        vm.stopPrank();
    }

    function test_setInitialVenue_zeroAndFirstUse() public {
        ConvergeVault v2 = new ConvergeVault(
            IERC20(address(usdc)),
            factory,
            streamsResolver,
            vOwner,
            vGuardian,
            vKeeper,
            vTreasury,
            EPOCH,
            10 * U,
            1e12,
            _launchParams()
        );
        vm.startPrank(vOwner);
        vm.expectRevert(ConvergeVault.ZeroAddress.selector);
        v2.setInitialVenue(address(0));
        v2.setInitialVenue(address(venue));
        vm.stopPrank();
        assertEq(v2.venue(), address(venue));
    }

    function test_venueFill_onlyVenue() public {
        ConvergeVault.FillParams memory f;
        f.market = m;
        f.units = 1;
        f.premium = 1;
        f.taker = alice;
        vm.prank(vKeeper);
        vm.expectRevert(ConvergeVault.OnlyVenue.selector);
        vault.venueFill(f);
        vm.prank(vOwner);
        vm.expectRevert(ConvergeVault.OnlyVenue.selector);
        vault.venueFill(f);
    }

    function carolAddr() internal returns (address) {
        return makeAddr("carol");
    }
}

/// @dev Looks like a Market to the vault but was not created by the factory.
contract FakeMarket {
    bytes32 public assetId;
    uint64 public startTime;
    uint64 public endTime;

    constructor(bytes32 a, uint64 s, uint64 e) {
        assetId = a;
        startTime = s;
        endTime = e;
    }
}
