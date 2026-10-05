// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultBase} from "../VaultBase.t.sol";
import {ConvergeVault} from "../../src/vault/ConvergeVault.sol";
import {QuoteMath} from "../../src/vault/QuoteMath.sol";
import {Market} from "../../src/Market.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Property tests for the economics the threat model relies on: keeper actions are
///         value-neutral, the mark band covers every volatility the keeper could have chosen, a
///         round trip never profits, and claims never exceed what an epoch settled.
contract VaultFuzzTest is VaultBase {
    Market internal m;

    function setUp() public override {
        super.setUp();
        _fund(alice, 1000 * U);
        // an hour round (15:00 to 16:00) so epoch ends (every 15 min) fall inside it
        m = _openEth(T0 + 2700, H1, 3000e18);
        vm.warp(T0 + 2700 + 200);
    }

    function _donateUp(uint256 amount) internal {
        _split(m, bob, amount);
        IERC20 up = IERC20(address(m.up()));
        vm.prank(bob);
        up.transfer(address(vault), amount);
    }

    function _hardValue() internal view returns (uint256 h) {
        uint256 bal = usdc.balanceOf(address(vault));
        h = bal - vault.pendingDeposits() - vault.claimableAssets();
        for (uint256 i = 0; i < vault.marketCount(); i++) {
            Market k = Market(vault.marketAt(i));
            uint256 u = IERC20(address(k.up())).balanceOf(address(vault));
            uint256 d = IERC20(address(k.down())).balanceOf(address(vault));
            h += u < d ? u : d;
        }
    }

    /// @dev Split and merge only convert between collateral and complete pairs: the hard value and
    ///      both NAVs stay exactly where they were.
    function testFuzz_splitAndMergeAreValueNeutral(uint256 splitAmt, uint256 mergeAmt) public {
        splitAmt = bound(splitAmt, 1, 300 * U);
        vault.checkpoint(_noReports());
        uint256 lo0 = vault.quoteNavLower();
        uint256 hi0 = vault.lastNavUpper();
        uint256 h0 = _hardValue();
        vm.prank(vKeeper);
        vault.splitForInventory(m, splitAmt);
        assertEq(_hardValue(), h0);
        vault.checkpoint(_noReports());
        assertEq(vault.quoteNavLower(), lo0);
        assertEq(vault.lastNavUpper(), hi0);
        mergeAmt = bound(mergeAmt, 1, splitAmt);
        vm.prank(vKeeper);
        vault.mergeInventory(m, mergeAmt);
        assertEq(_hardValue(), h0);
        vault.checkpoint(_noReports());
        assertEq(vault.quoteNavLower(), lo0);
    }

    /// @dev The keeper's volatility can change quotes, never the hard value; its effect on the NAV
    ///      is limited to the (tiny) gap between the mark at its sigma and the owner-band corners.
    function testFuzz_sigmaCannotMoveHardValueOrNavBeyondTheBand(
        uint256 sigma,
        int256 offsetBps,
        uint256 donate
    ) public {
        sigma = bound(sigma, 0.3e18, 2e18);
        donate = bound(donate, 1 * U, 80 * U);
        offsetBps = bound(offsetBps, -50, 50);
        _setSigma(0.6e18);
        vm.prank(vKeeper);
        vault.splitForInventory(m, 100 * U);
        _donateUp(donate);
        int192 px = int192(int256(3000e18) * (10_000 + offsetBps) / 10_000);
        vault.checkpoint(_markNow(px));
        uint256 loA = vault.quoteNavLower();
        uint256 hiA = vault.lastNavUpper();
        uint256 h0 = _hardValue();

        vm.warp(block.timestamp + 31);
        vm.prank(vKeeper);
        // within the 20% step limit of 0.6
        vault.setSigma(ETH, bound(sigma, 0.48e18, 0.72e18));
        assertEq(_hardValue(), h0);
        vault.checkpoint(_markNow(px));
        // the shift moves only the excess (donate UP tokens): at most donate x 1 on either side,
        // and for any sigma the lower NAV stays <= upper NAV
        assertLe(vault.quoteNavLower(), vault.lastNavUpper());
        uint256 maxShift = donate; // each excess token is worth between 0 and 1
        assertLe(_diff(vault.quoteNavLower(), loA), maxShift);
        assertLe(_diff(vault.lastNavUpper(), hiA), maxShift);
        // tighter: with the sigma corners in the band the difference is a small fraction of the excess
        assertLe(_diff(vault.quoteNavLower(), loA), donate / 50 + 1);
    }

    function _diff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    /// @dev For ANY sigma the keeper could have chosen inside the owner band, the true fair value
    ///      lies inside the band the vault uses for marks (min/max over {sigma, sigmaMin,
    ///      sigmaMax}, widened by markBand). Mark error from sigma is therefore covered.
    function testFuzz_markBandCoversEverySigmaInTheBand(
        uint256 keeperSigma,
        uint256 otherSigma,
        int256 offsetBps,
        uint256 tau
    ) public view {
        keeperSigma = bound(keeperSigma, 0.3e18, 2e18);
        otherSigma = bound(otherSigma, 0.3e18, 2e18);
        offsetBps = bound(offsetBps, -300, 300); // |S/K - 1| up to 3%
        tau = bound(tau, 30, 900);
        uint256 spot = uint256(int256(3000e18) * (10_000 + offsetBps) / 10_000);
        uint256 pk = QuoteMath.normCdf(QuoteMath.d2(spot, 3000e18, keeperSigma, tau));
        uint256 p0 = QuoteMath.normCdf(QuoteMath.d2(spot, 3000e18, 0.3e18, tau));
        uint256 p1 = QuoteMath.normCdf(QuoteMath.d2(spot, 3000e18, 2e18, tau));
        uint256 truth = QuoteMath.normCdf(QuoteMath.d2(spot, 3000e18, otherSigma, tau));
        uint256 lo = _min3(pk, p0, p1);
        uint256 hi = _max3(pk, p0, p1);
        uint256 band = vault.markBand();
        lo = lo > band ? lo - band : 0;
        hi = hi + band > 1e18 ? 1e18 : hi + band;
        assertGe(truth, lo, "true value below the band");
        assertLe(truth, hi, "true value above the band");
    }

    function _min3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        return a < b ? (a < c ? a : c) : (b < c ? b : c);
    }

    function _max3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        return a > b ? (a > c ? a : c) : (b > c ? b : c);
    }

    /// @dev A depositor who leaves at the next epoch never gets more than they put in, whatever the
    ///      exposure and whatever the mark: deposits mint at the upper NAV, redemptions pay the lower.
    function testFuzz_roundTripCannotProfit(uint256 deposit, uint256 donate, int256 offsetBps)
        public
    {
        deposit = bound(deposit, 10 * U, 900 * U);
        donate = bound(donate, 0, 90 * U);
        offsetBps = bound(offsetBps, -100, 100);
        _setSigma(0.6e18);
        vm.prank(vKeeper);
        vault.splitForInventory(m, 100 * U);
        if (donate != 0) {
            _donateUp(donate);
        }
        int192 px = int192(int256(3000e18) * (10_000 + offsetBps) / 10_000);

        // enter
        uint256 e = _requestDeposit(carol(), deposit);
        _toEpochEnd(e); // T0 + 900: the round has just ended, excess is awaiting resolution
        // keep the round open instead: use an epoch end that falls inside a longer round
        vault.settleEpoch(e, _markIfNeeded(px));
        vm.prank(carol());
        vault.claimDeposit(e, carol());
        uint256 shares = vault.balanceOf(carol());

        // leave in the next epoch, at the same marks
        vm.prank(carol());
        uint256 e2 = vault.requestRedeem(shares);
        _toEpochEnd(e2);
        vault.settleEpoch(e2, _markIfNeeded(px));
        vm.prank(carol());
        vault.claimRedeem(e2, carol());
        assertLe(usdc.balanceOf(carol()), deposit);
    }

    function carol() internal returns (address) {
        return makeAddr("carolFuzz");
    }

    function _markIfNeeded(int192 px) internal view returns (bytes[] memory) {
        return vault.marksNeeded().length == 0 ? _noReports() : _markNow(px);
    }

    /// @dev Several LPs in one epoch: the sum of what they claim never exceeds what the epoch settled.
    function testFuzz_claimsNeverExceedSettlement(uint256 a, uint256 b, uint256 c, uint256 pct)
        public
    {
        a = bound(a, 10 * U, 300 * U);
        b = bound(b, 10 * U, 300 * U);
        c = bound(c, 10 * U, 300 * U);
        pct = bound(pct, 1, 100);
        address[3] memory who = [makeAddr("u1"), makeAddr("u2"), makeAddr("u3")];
        uint256[3] memory amt = [a, b, c];
        uint256 e;
        for (uint256 i = 0; i < 3; i++) {
            e = _requestDeposit(who[i], amt[i]);
        }
        _toEpochEnd(e);
        vault.settleEpoch(e, _noReports());
        uint256 minted;
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(who[i]);
            vault.claimDeposit(e, who[i]);
            minted += vault.balanceOf(who[i]);
        }
        (,,,, uint128 mintedTotal,,) = vault.epochs(e);
        assertLe(minted, mintedTotal);
        // now all three redeem a fraction, with part of the vault locked in pairs (partial fill)
        vm.prank(vKeeper);
        vault.splitForInventory(m, 250 * U);
        uint256 e2;
        for (uint256 i = 0; i < 3; i++) {
            uint256 sh = vault.balanceOf(who[i]) * pct / 100;
            if (sh == 0) continue;
            vm.prank(who[i]);
            e2 = vault.requestRedeem(sh);
        }
        _toEpochEnd(e2);
        vault.settleEpoch(e2, _noReports());
        (,,,,,, uint128 paid) = vault.epochs(e2);
        uint256 paidOut;
        for (uint256 i = 0; i < 3; i++) {
            if (vault.redeemRequest(e2, who[i]) == 0) continue;
            vm.prank(who[i]);
            vault.claimRedeem(e2, who[i]);
            paidOut += usdc.balanceOf(who[i]);
        }
        assertLe(paidOut, paid);
        assertLe(vault.claimableAssets(), usdc.balanceOf(address(vault)));
    }

    /// @dev A deposit followed by the same price (no NAV change) mints and redeems within rounding.
    function testFuzz_flatNavRoundTripLosesOnlyRounding(uint256 deposit) public {
        deposit = bound(deposit, 10 * U, 1_000_000 * U);
        vm.prank(vOwner);
        vault.setTvlCap(type(uint128).max);
        address u = makeAddr("flat");
        uint256 e = _requestDeposit(u, deposit);
        _toEpochEnd(e);
        vault.settleEpoch(e, _noReports());
        vm.prank(u);
        vault.claimDeposit(e, u);
        uint256 sh = vault.balanceOf(u);
        vm.prank(u);
        uint256 e2 = vault.requestRedeem(sh);
        _toEpochEnd(e2);
        vault.settleEpoch(e2, _noReports());
        vm.prank(u);
        vault.claimRedeem(e2, u);
        uint256 got = usdc.balanceOf(u);
        assertLe(got, deposit);
        assertGe(got + 2, deposit); // at most a couple of units of rounding, in the vault's favour
    }
}
