// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultBase} from "../VaultBase.t.sol";
import {ConvergeVault} from "../../src/vault/ConvergeVault.sol";
import {QuoteMath} from "../../src/vault/QuoteMath.sol";
import {Market} from "../../src/Market.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice LP-side behaviour of ConvergeVault: requests, epochs, two-sided pricing, claims,
///         fees, caps, roles and every revert path of those functions.
contract VaultFlowsTest is VaultBase {
    function _burnVaultAssets() internal {
        uint256 bal = usdc.balanceOf(address(vault));
        vm.prank(address(vault));
        usdc.transfer(address(0xB0B), bal);
    }

    // ------------------------------------------------------------------ constructor / views

    function test_constructor_state() public view {
        assertEq(address(vault.asset()), address(usdc));
        assertEq(address(vault.factory()), address(factory));
        assertEq(address(vault.streams()), address(streamsResolver));
        assertEq(address(vault.verifier()), address(verifierProxy));
        assertEq(vault.epochLength(), EPOCH);
        assertEq(vault.genesis() % EPOCH, 0);
        assertEq(vault.owner(), vOwner);
        assertEq(vault.guardian(), vGuardian);
        assertEq(vault.keeper(), vKeeper);
        assertEq(vault.treasury(), vTreasury);
        assertEq(vault.decimals(), 6);
        assertEq(vault.unitScale(), 1e12);
        assertEq(vault.performanceFeeBps(), 1000);
        assertEq(vault.pricePerShareLower(), 1e18);
        assertEq(vault.quoteParams().levels, 2);
    }

    function test_constructor_revertsOnBadConfig() public {
        QuoteMath.Params memory p = _launchParams();
        IERC20 a = IERC20(address(usdc));
        vm.expectRevert(ConvergeVault.ZeroAddress.selector);
        new ConvergeVault(
            a, factory, streamsResolver, vOwner, address(0), vKeeper, vTreasury, EPOCH, 10 * U, 1, p
        );
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        new ConvergeVault(
            a, factory, streamsResolver, vOwner, vGuardian, vKeeper, vTreasury, 59, 10 * U, 1, p
        );
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        new ConvergeVault(
            a, factory, streamsResolver, vOwner, vGuardian, vKeeper, vTreasury, EPOCH, 1000, 1, p
        );
        // collateral different from the factory's
        MockOther o = new MockOther();
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        new ConvergeVault(
            IERC20(address(o)),
            factory,
            streamsResolver,
            vOwner,
            vGuardian,
            vKeeper,
            vTreasury,
            EPOCH,
            10 * U,
            1,
            p
        );
        p.perMarketMaxFraction = 0.06e18; // above the hard limit
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        new ConvergeVault(
            a, factory, streamsResolver, vOwner, vGuardian, vKeeper, vTreasury, EPOCH, 10 * U, 1, p
        );
    }

    function test_epochMath() public view {
        uint256 g = vault.genesis();
        assertEq(vault.currentEpoch(), 0);
        assertEq(vault.epochOf(g + EPOCH), 1);
        assertEq(vault.epochEnd(0), g + EPOCH);
    }

    // ------------------------------------------------------------------ deposits

    function test_firstDeposit_mintsOneToOneMinusDeadShares() public {
        uint256 e = _requestDeposit(alice, 100 * U);
        assertEq(e, 0);
        assertEq(usdc.balanceOf(address(vault)), 100 * U);
        assertEq(vault.pendingDeposits(), 100 * U);
        assertEq(vault.depositRequest(0, alice), 100 * U);
        _toEpochEnd(0);
        vault.settleEpoch(0, _noReports());
        assertEq(vault.totalSupply(), 100 * U);
        assertEq(vault.balanceOf(address(0xdEaD)), 1000);
        assertEq(vault.pendingDeposits(), 0);
        assertEq(vault.quoteNavLower(), 100 * U);
        assertEq(vault.lastNavUpper(), 100 * U);
        vm.prank(alice);
        vault.claimDeposit(0, alice);
        assertEq(vault.balanceOf(alice), 100 * U - 1000);
        assertEq(vault.balanceOf(address(vault)), 0);
    }

    function test_secondDeposit_samePriceAtFlatNav() public {
        _fund(alice, 100 * U);
        uint256 e = _requestDeposit(bob, 50 * U);
        _toEpochEnd(e);
        vault.settleEpoch(e, _noReports());
        vm.prank(bob);
        vault.claimDeposit(e, bob);
        assertEq(vault.balanceOf(bob), 50 * U);
        assertEq(vault.totalSupply(), 150 * U);
    }

    function test_deposit_batchSharesProRata() public {
        _fund(alice, 100 * U);
        uint256 e = _requestDeposit(bob, 30 * U);
        _requestDeposit(treasury, 10 * U);
        _toEpochEnd(e);
        vault.settleEpoch(e, _noReports());
        vm.prank(bob);
        vault.claimDeposit(e, bob);
        vm.prank(treasury);
        vault.claimDeposit(e, treasury);
        assertEq(vault.balanceOf(bob), 30 * U);
        assertEq(vault.balanceOf(treasury), 10 * U);
    }

    function test_requestDeposit_revertsBelowMinimum() public {
        usdc.mint(alice, 100 * U);
        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.BelowMinimum.selector, 9 * U, 10 * U));
        vault.requestDeposit(9 * U);
        vm.stopPrank();
    }

    function test_requestDeposit_enforcesTvlCapIncludingPending() public {
        vm.prank(vOwner);
        vault.setTvlCap(100 * U);
        _requestDeposit(alice, 60 * U);
        usdc.mint(bob, 50 * U);
        vm.startPrank(bob);
        usdc.approve(address(vault), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.TvlCapExceeded.selector, 50 * U, 40 * U)
        );
        vault.requestDeposit(50 * U);
        vault.requestDeposit(40 * U); // exactly the room
        vm.stopPrank();
        // after settlement the cap counts the settled upper NAV
        _toEpochEnd(0);
        vault.settleEpoch(0, _noReports());
        usdc.mint(bob, 1 * U);
        vm.startPrank(bob);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.TvlCapExceeded.selector, 10 * U, 0));
        vault.requestDeposit(10 * U);
        vm.stopPrank();
        vm.prank(vOwner);
        vault.setTvlCap(200 * U);
        vm.prank(bob);
        vault.requestDeposit(10 * U);
    }

    function test_requestDeposit_rejectsFeeOnTransferAsset() public {
        // A vault over a fee-on-transfer collateral cannot be built through the factory check,
        // so emulate: make the token charge a fee via a hook-less mock after deployment.
        FotUsdc f = new FotUsdc();
        MarketFactory f2 = new MarketFactory(IERC20(address(f)), admin);
        ConvergeVault v2 = new ConvergeVault(
            IERC20(address(f)),
            f2,
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
        f.mint(alice, 100 * U);
        vm.startPrank(alice);
        f.approve(address(v2), type(uint256).max);
        vm.expectRevert(ConvergeVault.FeeOnTransferNotSupported.selector);
        v2.requestDeposit(50 * U);
        vm.stopPrank();
    }

    function test_requestDeposit_revertsWithoutAllowance() public {
        usdc.mint(alice, 20 * U);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(vault), 0, 20 * U
            )
        );
        vault.requestDeposit(20 * U);
    }

    // ------------------------------------------------------------------ settlement guards

    function test_settle_revertsBeforeEpochEnds() public {
        _requestDeposit(alice, 20 * U);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.EpochNotEnded.selector, 0));
        vault.settleEpoch(0, _noReports());
        vm.warp(vault.epochEnd(0) - 1);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.EpochNotEnded.selector, 0));
        vault.settleEpoch(0, _noReports());
    }

    function test_settle_revertsTwiceAndWhenEmpty() public {
        _requestDeposit(alice, 20 * U);
        _toEpochEnd(0);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.EpochNotEnded.selector, 5));
        vault.settleEpoch(5, _noReports());
        vm.warp(vault.epochEnd(5));
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.NothingToSettle.selector, 5));
        vault.settleEpoch(5, _noReports());
        vault.settleEpoch(0, _noReports());
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.AlreadySettled.selector, 0));
        vault.settleEpoch(0, _noReports());
    }

    function test_settle_eachEpochHasItsOwnDisjointWindow() public {
        uint256 e0 = _requestDeposit(alice, 20 * U);
        vm.warp(vault.epochEnd(0));
        uint256 e1 = _requestDeposit(bob, 20 * U);
        assertEq(e1, e0 + 1);
        vm.warp(vault.epochEnd(1));
        vault.settleEpoch(1, _noReports()); // epoch 1 settles in its window and is the first deposit
        vault.settleEpoch(0, _noReports()); // epoch 0's window is long gone: it expires instead
        vm.prank(alice);
        vault.claimDeposit(0, alice);
        vm.prank(bob);
        vault.claimDeposit(1, bob);
        assertEq(usdc.balanceOf(alice), 20 * U); // refunded
        assertEq(vault.balanceOf(bob), 20 * U - 1000); // shares
    }

    // ------------------------------------------------------------------ claims

    function test_claimDeposit_reverts() public {
        _requestDeposit(alice, 20 * U);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.NotSettled.selector, 0));
        vault.claimDeposit(0, alice);
        _toEpochEnd(0);
        vault.settleEpoch(0, _noReports());
        vm.prank(alice);
        vm.expectRevert(ConvergeVault.ZeroAddress.selector);
        vault.claimDeposit(0, address(0));
        vm.prank(bob);
        vm.expectRevert(ConvergeVault.NothingToClaim.selector);
        vault.claimDeposit(0, bob);
        vm.prank(alice);
        vault.claimDeposit(0, alice);
        vm.prank(alice);
        vm.expectRevert(ConvergeVault.NothingToClaim.selector);
        vault.claimDeposit(0, alice); // no double claim
    }

    function test_claimDeposit_toOtherReceiver() public {
        _fund(alice, 20 * U);
        assertEq(vault.balanceOf(alice), 20 * U - 1000);
        uint256 e = _requestDeposit(bob, 10 * U);
        _toEpochEnd(e);
        vault.settleEpoch(e, _noReports());
        vm.prank(bob);
        vault.claimDeposit(e, carol());
        assertEq(vault.balanceOf(carol()), 10 * U);
    }

    function carol() internal returns (address) {
        return makeAddr("carol");
    }

    // ------------------------------------------------------------------ redemptions

    function test_redeem_fullAtFlatNav() public {
        _fund(alice, 100 * U);
        _fund(bob, 100 * U);
        uint256 shares = vault.balanceOf(alice);
        vm.startPrank(alice);
        uint256 e = vault.requestRedeem(shares);
        vm.stopPrank();
        assertEq(vault.balanceOf(alice), 0);
        assertEq(vault.balanceOf(address(vault)), shares);
        _toEpochEnd(e);
        vault.settleEpoch(e, _noReports());
        // lower NAV 200e6 over supply 200e6: one asset unit per share
        assertEq(vault.claimableAssets(), shares);
        vm.prank(alice);
        vault.claimRedeem(e, alice);
        assertEq(usdc.balanceOf(alice), shares);
        assertEq(vault.claimableAssets(), 0);
        assertEq(vault.totalSupply(), 200 * U - shares);
        assertEq(vault.quoteNavLower(), 200 * U - shares);
    }

    function test_redeem_revertsZeroAndWithoutShares() public {
        vm.expectRevert(ConvergeVault.ZeroAmount.selector);
        vault.requestRedeem(0);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 0, 5)
        );
        vault.requestRedeem(5);
    }

    function test_claimRedeem_reverts() public {
        _fund(alice, 100 * U);
        vm.prank(alice);
        uint256 e = vault.requestRedeem(10 * U);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.NotSettled.selector, e));
        vault.claimRedeem(e, alice);
        _toEpochEnd(e);
        vault.settleEpoch(e, _noReports());
        vm.prank(alice);
        vm.expectRevert(ConvergeVault.ZeroAddress.selector);
        vault.claimRedeem(e, address(0));
        vm.prank(bob);
        vm.expectRevert(ConvergeVault.NothingToClaim.selector);
        vault.claimRedeem(e, bob);
    }

    function test_redeem_partialFillRequeuesRemainder() public {
        _fund(alice, 100 * U);
        // park 30 USDC in pairs (30% pair cap), leaving 70 liquid
        Market m = _openEth(T0, M15, 3000e18);
        vm.warp(T0 + 100);
        _setSigma(0.6e18);
        vm.prank(vKeeper);
        vault.splitForInventory(m, 30 * U);
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 e = vault.requestRedeem(shares);
        _toEpochEnd(e);
        // pairs are worth exactly 1: no marks are needed
        vault.settleEpoch(e, _noReports());
        (,,, uint128 sharesMinted, uint128 filled, uint128 paid) = _epoch(e);
        assertEq(sharesMinted, 0);
        assertEq(paid, 70 * U); // all the free liquidity
        assertLt(filled, shares);
        assertEq(usdc.balanceOf(address(vault)), 70 * U); // the 70 is reserved for the claim; 30 sits in pairs
        vm.prank(alice);
        vault.claimRedeem(e, alice);
        assertEq(usdc.balanceOf(alice), 70 * U);
        // remainder was queued again in the current epoch
        uint256 cur = vault.currentEpoch();
        assertGt(vault.redeemRequest(cur, alice), 0);
        assertEq(vault.redeemRequest(cur, alice), shares - filled);
        // keeper merges, the next epoch pays the rest
        vm.prank(vKeeper);
        vault.mergeInventory(m, 30 * U);
        _toEpochEnd(cur);
        vault.settleEpoch(cur, _noReports());
        vm.prank(alice);
        vault.claimRedeem(cur, alice);
        // all but the dead shares' value and rounding dust
        assertApproxEqAbs(usdc.balanceOf(alice), 100 * U, 1100);
    }

    function _epoch(uint256 id)
        internal
        view
        returns (uint128 d, uint128 r, bool st, uint128 minted, uint128 filled, uint128 paid)
    {
        (d, r, st,, minted, filled, paid) = vault.epochs(id);
    }

    function test_redeem_neverBlockedByPauseOrBreaker() public {
        _fund(alice, 100 * U);
        vm.prank(vGuardian);
        vault.pauseQuoting();
        vm.prank(alice);
        uint256 e = vault.requestRedeem(50 * U);
        _toEpochEnd(e);
        vault.settleEpoch(e, _noReports());
        vm.prank(alice);
        vault.claimRedeem(e, alice);
        assertEq(usdc.balanceOf(alice), 50 * U);
    }

    // ------------------------------------------------------------------ rejected deposits

    function test_deposit_refundedWhenNavIsWiped() public {
        _fund(alice, 100 * U);
        _burnVaultAssets(); // total loss: NAV 0 with shares outstanding
        uint256 e = _requestDeposit(bob, 40 * U);
        _toEpochEnd(e);
        vault.settleEpoch(e, _noReports());
        (,,, uint128 minted,,) = _epoch(e);
        assertEq(minted, 0);
        assertEq(vault.claimableAssets(), 40 * U);
        vm.prank(bob);
        vault.claimDeposit(e, bob);
        assertEq(usdc.balanceOf(bob), 40 * U);
        assertEq(vault.claimableAssets(), 0);
        assertEq(vault.balanceOf(bob), 0);
    }

    // ------------------------------------------------------------------ performance fee

    function test_fee_chargedOnGainsAboveHighWaterMark() public {
        _fund(alice, 100 * U);
        usdc.mint(address(vault), 10 * U); // +10% gain on 100
        uint256 e = _requestDeposit(bob, 10 * U);
        _toEpochEnd(e);
        vault.settleEpoch(e, _noReports());
        // fee = 10% of 10 = 1 USDC; shares = 1e6 * 100e6 / (110e6 - 1e6)
        uint256 feeShares = vault.balanceOf(vTreasury);
        assertEq(feeShares, 917_431);
        uint256 supplyAfterFee = 100 * U + feeShares;
        assertEq(vault.hwmPps(), uint256(110 * U) * 1e18 / supplyAfterFee);
        // treasury's shares are worth ~1 USDC at the lower NAV
        assertApproxEqAbs(feeShares * 110 * U / supplyAfterFee, 1 * U, 2);
        // the depositor entered at the post-fee price: 10e6 * supplyAfterFee / 110e6
        vm.prank(bob);
        vault.claimDeposit(e, bob);
        assertEq(vault.balanceOf(bob), uint256(10 * U) * supplyAfterFee / (110 * U));
    }

    function test_fee_noneBelowHighWaterMarkAndZeroWhenDisabled() public {
        _fund(alice, 100 * U);
        usdc.mint(address(vault), 10 * U);
        uint256 e = _requestDeposit(bob, 10 * U);
        _toEpochEnd(e);
        vault.settleEpoch(e, _noReports());
        uint256 fee1 = vault.balanceOf(vTreasury);
        // lose some value: pps falls below the mark; no new fee when it recovers partially
        vm.prank(address(vault));
        usdc.transfer(address(0xB0B), 5 * U);
        uint256 e2 = _requestDeposit(bob, 10 * U);
        _toEpochEnd(e2);
        vault.settleEpoch(e2, _noReports());
        assertEq(vault.balanceOf(vTreasury), fee1);
        // disable the fee: a gain above the mark is not charged
        vm.prank(vOwner);
        vault.setPerformanceFee(0);
        usdc.mint(address(vault), 50 * U);
        uint256 e3 = _requestDeposit(bob, 10 * U);
        _toEpochEnd(e3);
        vault.settleEpoch(e3, _noReports());
        assertEq(vault.balanceOf(vTreasury), fee1);
        assertGt(vault.hwmPps(), 1e18);
    }

    function test_fee_capEnforced() public {
        vm.startPrank(vOwner);
        vault.setPerformanceFee(2000);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.FeeTooHigh.selector, 2001));
        vault.setPerformanceFee(2001);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        vault.setPerformanceFee(0);
    }

    // ------------------------------------------------------------------ inflation defense

    function test_donationBeforeSecondDepositDoesNotZeroShares() public {
        _fund(alice, 10 * U); // the smallest first deposit
        usdc.mint(address(vault), 1_000_000 * U); // donation to inflate the share price
        uint256 e = _requestDeposit(bob, 10 * U);
        _toEpochEnd(e);
        vault.settleEpoch(e, _noReports());
        vm.prank(bob);
        vault.claimDeposit(e, bob);
        // bob still gets a nonzero share count, priced at the upper NAV (floor): the attacker spent
        // 1,000,000 USDC to cost bob at most one share unit of rounding.
        uint256 bobShares = vault.balanceOf(bob);
        assertGt(bobShares, 0);
        assertEq(bobShares, uint256(10 * U) * (vault.totalSupply() - bobShares) / (1_000_010 * U));
    }

    // ------------------------------------------------------------------ settlement fed by marks

    function test_settle_revertsOnUnknownDuplicateOrNonCanonicalReport() public {
        _fund(alice, 100 * U);
        Market m = _openEth(T0, M15, 3000e18);
        vm.warp(T0 + 100);
        _setSigma(0.6e18);
        vm.prank(vKeeper);
        vault.splitForInventory(m, 20 * U);
        uint256 e = _requestDeposit(bob, 20 * U);
        _toEpochEnd(e);
        uint64 t = uint64(block.timestamp);
        bytes32 other = 0x0003aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;
        bytes[] memory rs = new bytes[](1);
        rs[0] = _report(other, uint32(t - 1), uint32(t), 1e18);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.UnknownReportFeed.selector, other));
        vault.settleEpoch(e, rs);
        // a report from before the epoch end does not contain it
        rs[0] = _rep(uint32(t - 11), 3000e18);
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.ReportNotCanonical.selector, t, t - 12, t - 11)
        );
        vault.settleEpoch(e, rs);
        // nor does one from after it
        rs[0] = _repWindow(t + 1, t + 2, 3000e18, t + 1 days);
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.ReportNotCanonical.selector, t, t + 1, t + 2)
        );
        vault.settleEpoch(e, rs);
        rs = new bytes[](2);
        rs[0] = _rep(uint32(t), 3000e18);
        rs[1] = _rep(uint32(t), 3000e18);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.DuplicateReport.selector, ETH));
        vault.settleEpoch(e, rs);
    }

    // ------------------------------------------------------------------ settlement window

    function test_settle_expiresAfterTheWindow_refundsAndRequeues() public {
        _fund(alice, 100 * U);
        uint256 aliceShares = vault.balanceOf(alice);
        uint256 e = _requestDeposit(bob, 40 * U);
        vm.prank(alice);
        vault.requestRedeem(aliceShares / 2);
        _toEpochEnd(e);
        vm.warp(block.timestamp + vault.settleWindow() + 1);
        vm.expectEmit(address(vault));
        emit ConvergeVault.EpochExpired(e, 40 * U, aliceShares / 2);
        vault.settleEpoch(e, _noReports());
        // nothing was priced: deposits are refundable, redemption requests queued again
        assertEq(vault.pendingDeposits(), 0);
        assertEq(vault.claimableAssets(), 40 * U);
        vm.prank(bob);
        vault.claimDeposit(e, bob);
        assertEq(usdc.balanceOf(bob), 40 * U);
        vm.prank(alice);
        vault.claimRedeem(e, alice);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(vault.redeemRequest(vault.currentEpoch(), alice), aliceShares / 2);
        assertEq(vault.claimableAssets(), 0);
        assertEq(vault.totalSupply(), 100 * U); // no mint, no burn, no new NAV
    }

    function test_settle_lastSecondOfTheWindowStillSettles() public {
        uint256 e = _requestDeposit(alice, 40 * U);
        _toEpochEnd(e);
        vm.warp(block.timestamp + vault.settleWindow());
        vault.settleEpoch(e, _noReports());
        vm.prank(alice);
        vault.claimDeposit(e, alice);
        assertEq(vault.balanceOf(alice), 40 * U - 1000);
    }

    /// @dev The price is the one AT the epoch end: settling later inside the window (a round can
    ///      not end inside it) gives the same shares however the price moved in between.
    function test_settle_laterInTheWindowGivesTheSameShares() public {
        _fund(alice, 1000 * U);
        // an hour round starting 15:00; excess exposure is built before the 15:30 epoch end
        Market h = _openEth(T0 + 2700, H1, 3000e18);
        vm.warp(T0 + 2700 + 300);
        _setSigma(0.6e18);
        vm.prank(vKeeper);
        vault.splitForInventory(h, 100 * U);
        _split(h, bob, 50 * U);
        IERC20 up = IERC20(address(h.up()));
        vm.prank(bob);
        up.transfer(address(vault), 50 * U); // 50 UP above the pairs
        uint256 e = _requestDeposit(carol(), 100 * U);
        uint256 end = vault.epochEnd(e);
        vm.warp(end);
        uint256 snap = vm.snapshotState();

        // settle at once with the canonical mark at the epoch end
        vault.settleEpoch(e, _markAt(end, 3000e18));
        uint256 sharesNow = _mintedFor(e);

        // the same epoch 9 minutes later (the price has moved a lot meanwhile): identical
        vm.revertToState(snap);
        vm.warp(end + 9 * 60);
        vault.settleEpoch(e, _markAt(end, 3000e18));
        assertEq(_mintedFor(e), sharesNow);
        assertGt(sharesNow, 0);
    }

    function test_settleWindow_mustBeShorterThanARound_andEpochsOnTheRoundGrid() public {
        vm.startPrank(vOwner);
        vault.setRiskConfig(10, 0.05e18, 899, 500, 0.3e18, 0.5e18);
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setRiskConfig(10, 0.05e18, 900, 500, 0.3e18, 0.5e18);
        vm.stopPrank();
        QuoteMath.Params memory p = _launchParams();
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        new ConvergeVault(
            IERC20(address(usdc)),
            factory,
            streamsResolver,
            vOwner,
            vGuardian,
            vKeeper,
            vTreasury,
            1000,
            10 * U,
            1,
            p
        );
    }

    function _mintedFor(uint256 e) internal view returns (uint256 m) {
        (,,,, m,,) = vault.epochs(e);
    }

    function _resolveAt(Market mk, uint64 endTs, int192 px) internal {
        vm.warp(endTs + 1);
        streamsResolver.submit(
            ETH, endTs, _report(ETH_FEED, uint32(endTs - 1), uint32(endTs + 1), px)
        );
        vm.warp(endTs + WINDOW + 1);
        mk.resolve("");
    }

    function test_settle_endedButUnresolvedRoundBlocksUntilResolved() public {
        _fund(alice, 1000 * U);
        Market m = _openEth(T0, M15, 3000e18);
        vm.warp(T0 + 200);
        _setSigma(0.6e18);
        vm.prank(vKeeper);
        vault.splitForInventory(m, 100 * U);
        _split(m, bob, 20 * U);
        IERC20 up = IERC20(address(m.up()));
        vm.prank(bob);
        up.transfer(address(vault), 20 * U); // excess exposure in a round ending at T0 + 900
        uint256 e = _requestDeposit(carol(), 50 * U);
        vm.warp(vault.epochEnd(e)); // the epoch ends exactly when the round does
        (bytes32[] memory feeds, address[] memory pending) = vault.settlementPlan(e);
        assertEq(feeds.length, 0); // ended by then: no mark, an outcome instead
        assertEq(pending.length, 1);
        assertEq(pending[0], address(m));
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.MarketNotResolved.selector, address(m))
        );
        vault.settleEpoch(e, _noReports());
        // anyone resolves, then the settlement goes through at the exact outcome value
        _resolveAt(m, T0 + 900, 3100e18);
        vault.settleEpoch(e, _noReports());
        (, pending) = vault.settlementPlan(e);
        assertEq(pending.length, 0);
    }
}

contract MockOther {
    function decimals() external pure returns (uint8) {
        return 6;
    }
}

/// @dev 6-dp token that burns 1% of every transfer.
contract FotUsdc {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[t] += a - a / 100;
        return true;
    }

    function transfer(address t, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[t] += a;
        return true;
    }
}
