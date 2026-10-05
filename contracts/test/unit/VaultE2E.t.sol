// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultBase} from "../VaultBase.t.sol";
import {ConvergeVault} from "../../src/vault/ConvergeVault.sol";
import {ForwardVenue} from "../../src/vault/ForwardVenue.sol";
import {Market} from "../../src/Market.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice The whole life of the vault in one test, with every number derived by hand:
///         deposit -> keeper prepares inventory -> a taker fills -> the round resolves ->
///         redeemResolved -> settleEpoch -> withdraw.
///
/// Setup: Alice deposits 1,000 USDC (first deposit: 1 share per unit, 1,000 shares locked as dead
/// shares, so Alice holds 1,000,000,000 - 1,000 raw shares of a 1,000,000,000 supply).
/// The keeper sets sigma = 60% and splits 100 USDC into 100 UP + 100 DOWN of the 14:15 round
/// (strike 3,000). A taker buys 10 UP with a limit of 0.60. At the pricing time spot = strike with
/// 698 s left, so fair = Phi(-0.5 * 0.6 * sqrt(698 / 31,557,600)) = 0.49945, the half spread is
/// the 0.05 floor, and the ask is ceil_0.01(0.54945) = 0.55: the taker pays 10 x 0.55 = 5.50 USDC.
contract VaultE2ETest is VaultBase {
    Market internal m;
    uint256 internal aliceShares;

    function _runToTrade() internal returns (uint256 id) {
        _fund(alice, 1000 * U);
        aliceShares = vault.balanceOf(alice);
        assertEq(aliceShares, 1000 * U - 1000);
        m = _openEth(T0, M15, 3000e18);
        vm.warp(T0 + 200);
        _setSigma(0.6e18);
        vm.prank(vKeeper);
        vault.splitForInventory(m, 100 * U);
        vault.checkpoint(_noReports());
        assertEq(usdc.balanceOf(address(vault)), 900 * U); // free collateral
        id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 10 * U, 0.6e18);
    }

    function _fillAndResolve(int192 endPx) internal {
        uint256 id = _runToTrade();
        (uint256 filled, uint256 premium) = _execFill(id);
        assertEq(filled, 10 * U);
        assertEq(premium, 5_500_000); // 10 x 0.55
        // vault position: 90 UP + 100 DOWN, cash +5.50, basis 100 -> worst case loss
        // = basis - cash - min(up, down) = 100 - 5.5 - 90 = 4.5 = 10 x (1 - 0.55)
        (int256 basis, int256 cash) = vault.positionOf(address(m));
        assertEq(basis, int256(100 * U));
        assertEq(cash, 5_500_000);
        assertEq(IERC20(address(m.up())).balanceOf(address(vault)), 90 * U);
        assertEq(IERC20(address(m.down())).balanceOf(address(vault)), 100 * U);
        assertEq(usdc.balanceOf(address(vault)), 905_500_000); // 900 + 5.50
        assertEq(IERC20(address(m.up())).balanceOf(taker), 10 * U);

        // the round ends; the end report decides it
        vm.warp(T0 + 900 + 1);
        streamsResolver.submit(
            ETH, T0 + 900, _report(ETH_FEED, uint32(T0 + 899), uint32(T0 + 901), endPx)
        );
        vm.warp(T0 + 900 + WINDOW + 1);
        m.resolve("");
    }

    function _execFill(uint256 id) internal returns (uint256 filled, uint256 premium) {
        (,,, uint64 at,,,,,) = venue.orders(id);
        vm.warp(at);
        vm.prank(executor);
        return venue.executeOrder(id, _repWindow(at - 1, at + 1, 3000e18, at + 1 days));
    }

    /// @dev UP wins: the vault's 10 missing UP cost it 10 - 5.50 = 4.50 USDC.
    function test_e2e_upWins_lpLosesFourFifty() public {
        _fillAndResolve(3100e18);
        assertEq(uint8(m.state()), uint8(Market.State.RESOLVED_UP));

        // taker redeems 10 UP -> 10 USDC (profit 10 - 5.5 = 4.5)
        vm.prank(taker);
        m.redeem();
        // 10 USDC payout + 0.50 unspent limit escrow (0.60 limit vs 0.55 fill, on 10 shares) + 4 slack units
        assertEq(usdc.balanceOf(taker), 10 * U + 500_000 + 4);

        // anyone pulls the vault's winnings: merge 90 pairs (+90), redeem 10 DOWN (losers: +0)
        uint256 before = usdc.balanceOf(address(vault));
        vault.redeemResolved(m);
        assertEq(usdc.balanceOf(address(vault)) - before, 90 * U);
        assertEq(usdc.balanceOf(address(vault)), 995_500_000); // 905.50 + 90
        assertEq(vault.marketCount(), 0);

        // Alice requests a full redemption in the next epoch; no marks are needed (no inventory).
        vm.prank(alice);
        uint256 e = vault.requestRedeem(aliceShares);
        _toEpochEnd(e);
        vault.settleEpoch(e, _noReports());
        // lower NAV 995,500,000 over supply 1,000,000,000:
        // payout = floor(aliceShares * 995,500,000 / 1,000,000,000) = 995,499,004 (rounded down)
        uint256 expected = (aliceShares * 995_500_000) / 1_000_000_000;
        assertEq(expected, 995_499_004);
        vm.prank(alice);
        vault.claimRedeem(e, alice);
        assertEq(usdc.balanceOf(alice), 995_499_004);
        // LP return: -0.4501% (the 4.50 loss plus the dead shares' 0.000996 USDC share of NAV)
        assertEq(usdc.balanceOf(address(vault)), 995_500_000 - 995_499_004); // 996 units left: dead shares
        assertEq(vault.totalSupply(), 1000); // only the dead shares remain
        assertEq(vault.claimableAssets(), 0);
        // no fee was charged on a loss
        assertEq(vault.balanceOf(vTreasury), 0);
    }

    /// @dev DOWN wins: the vault keeps its 5.50 premium and its 10 spare DOWN pay out.
    function test_e2e_downWins_lpGainsFiveFifty_feeOnTheGain() public {
        _fillAndResolve(2900e18);
        assertEq(uint8(m.state()), uint8(Market.State.RESOLVED_DOWN));
        uint256 before = usdc.balanceOf(address(vault));
        vault.redeemResolved(m);
        // merge 90 pairs = 90, redeem the remaining 10 DOWN (winners) = 10
        assertEq(usdc.balanceOf(address(vault)) - before, 100 * U);
        assertEq(usdc.balanceOf(address(vault)), 1_005_500_000);

        // A new deposit request starts the settlement that charges the performance fee.
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 e = vault.requestRedeem(shares);
        _toEpochEnd(e);
        vault.settleEpoch(e, _noReports());
        // pps_lower = 1,005,500,000 / 1,000,000,000 = 1.0055; gain over the 1.0 mark = 0.0055
        // fee assets = 0.0055 x 1,000,000,000 x 10% = 550,000 USDC units (0.55 USDC)
        // fee shares = 550,000 x 1,000,000,000 / (1,005,500,000 - 550,000) = 547,290.4 -> 547,290
        uint256 feeAssets = 550_000;
        uint256 feeShares = feeAssets * 1_000_000_000 / (1_005_500_000 - feeAssets);
        assertEq(vault.balanceOf(vTreasury), feeShares);
        assertEq(feeShares, 547_290);
        // Alice is paid at pps = 1,005,500,000 / (1,000,000,000 + 547,285)
        uint256 supply0 = 1_000_000_000 + feeShares;
        uint256 expected = shares * 1_005_500_000 / supply0;
        vm.prank(alice);
        vault.claimRedeem(e, alice);
        assertEq(usdc.balanceOf(alice), expected);
        // she keeps 99.9% of the 5.50 gain after the fee and the dead shares: > her 1,000 USDC
        assertGt(expected, 1000 * U);
        // the treasury's shares are worth about the 0.55 USDC fee
        assertApproxEqAbs(
            feeShares * (1_005_500_000 - expected) / (feeShares + 1000), 550_000, 1000
        );
    }
}
