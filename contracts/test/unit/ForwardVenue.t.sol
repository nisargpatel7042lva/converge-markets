// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultBase} from "../VaultBase.t.sol";
import {ConvergeVault} from "../../src/vault/ConvergeVault.sol";
import {ForwardVenue} from "../../src/vault/ForwardVenue.sol";
import {QuoteMath} from "../../src/vault/QuoteMath.sol";
import {ReportLib} from "../../src/vault/ReportLib.sol";
import {MockStreamsVerifierProxy} from "../mocks/MockStreamsVerifierProxy.sol";
import {Market} from "../../src/Market.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice The forward-priced venue: placing, executing (including the ADR-004 stop-ship tests
///         that an executor cannot choose the report or the price), expiry, refunds and the
///         vault's own bounds on every fill.
contract ForwardVenueTest is VaultBase {
    using QuoteMath for QuoteMath.Quote;

    Market internal m;
    uint256 internal constant REWARD = 0.001 ether;

    function setUp() public override {
        super.setUp();
        _fund(alice, 1000 * U);
        m = _openEth(T0, M15, 3000e18);
        vm.warp(T0 + 300);
        _enableTrading(m, 100 * U);
        vault.checkpoint(_noReports());
        vm.deal(executor, 0);
    }

    // ------------------------------------------------------------------ helpers

    function _exec(uint256 id, int192 px) internal returns (uint256 filled, uint256 premium) {
        (,,, uint64 execAt,,,,,) = venue.orders(id);
        if (block.timestamp < execAt) vm.warp(execAt);
        bytes memory rep = _repWindow(execAt - 1, execAt, px, execAt + 1 days);
        vm.prank(executor);
        return venue.executeOrder(id, rep);
    }

    function _execAt(uint256 id) internal view returns (uint64 at) {
        (,,, at,,,,,) = venue.orders(id);
    }

    function _ladder(uint64 at, uint256 spot) internal view returns (QuoteMath.Quote memory) {
        return venue.quoteAt(m, spot, at);
    }

    // ------------------------------------------------------------------ the quote the vault posts

    function test_quote_atTheMoney_handChecked() public view {
        // S = K, 598 s left, sigma 0.6 -> d2 = -0.5*0.6*sqrt(598/31557600) = -0.001306, fair 0.49948.
        // Half spread: floor 0.05 beats k*phi*sqrt(4/598) = 0.0326. No skew (no excess).
        // Ask = ceil(0.49948 + 0.05) to the 0.01 tick = 0.55; bid = floor(0.49948 - 0.05) = 0.44.
        QuoteMath.Quote memory q = venue.quoteAt(m, SPOT, uint64(block.timestamp + DELAY));
        assertTrue(q.quoting);
        assertEq(q.asks[0].price, 0.55e18);
        assertEq(q.bids[0].price, 0.44e18);
        assertEq(q.halfSpread, 0.05e18);
        assertApproxEqAbs(q.fair, 0.49948e18, 0.0001e18);
    }

    function test_quote_notAvailableOutsideOpenWindowOrWhenPaused() public {
        assertTrue(venue.quoteAt(m, SPOT, uint64(T0 + 302)).quoting);
        assertFalse(venue.quoteAt(m, SPOT, uint64(T0 + 900)).quoting); // at or after the end
        assertFalse(venue.quoteAt(m, SPOT, uint64(T0 + 900 - 20)).quoting); // no-quote window
        vm.prank(vGuardian);
        vault.pauseQuoting();
        assertFalse(venue.quoteAt(m, SPOT, uint64(T0 + 302)).quoting);
    }

    // ------------------------------------------------------------------ placing

    function test_place_buyEscrowsCollateralAndSellEscrowsTokens() public {
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 5 * U, 0.6e18);
        (
            address t,
            ForwardVenue.Kind k,
            ForwardVenue.Status st,
            uint64 at,,
            uint128 shares,
            uint128 limit,
            uint128 escrow,
            uint128 reward
        ) = venue.orders(id);
        assertEq(t, taker);
        assertEq(uint8(k), uint8(ForwardVenue.Kind.BUY_UP));
        assertEq(uint8(st), uint8(ForwardVenue.Status.OPEN));
        assertEq(at, block.timestamp + DELAY);
        assertEq(shares, 5 * U);
        assertEq(limit, 0.6e18);
        assertEq(escrow, 3 * U + 4); // 5 * 0.6 + rounding slack
        assertEq(reward, REWARD);
        assertEq(usdc.balanceOf(address(venue)), 3 * U + 4);
        uint256 id2 = _placeAs(bob, m, ForwardVenue.Kind.SELL_UP, 5 * U, 0.4e18);
        (,,,,,,, uint128 esc2,) = venue.orders(id2);
        assertEq(esc2, 5 * U);
        assertEq(IERC20(address(m.up())).balanceOf(address(venue)), 5 * U);
        assertEq(address(venue).balance, 2 * REWARD);
    }

    function test_place_reverts() public {
        usdc.mint(taker, 100 * U);
        vm.deal(taker, 3 ether);
        vm.startPrank(taker);
        usdc.approve(address(venue), type(uint256).max);
        vm.expectRevert(ForwardVenue.ZeroAmount.selector);
        venue.placeOrder{value: REWARD}(m, ForwardVenue.Kind.BUY_UP, 0, 0.5e18);
        vm.expectRevert(abi.encodeWithSelector(ForwardVenue.LimitOutOfRange.selector, 0));
        venue.placeOrder{value: REWARD}(m, ForwardVenue.Kind.BUY_UP, 1 * U, 0);
        vm.expectRevert(abi.encodeWithSelector(ForwardVenue.LimitOutOfRange.selector, 1e18));
        venue.placeOrder{value: REWARD}(m, ForwardVenue.Kind.BUY_UP, 1 * U, 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(ForwardVenue.RewardTooLow.selector, REWARD - 1, REWARD)
        );
        venue.placeOrder{value: REWARD - 1}(m, ForwardVenue.Kind.BUY_UP, 1 * U, 0.5e18);
        vm.expectRevert(abi.encodeWithSelector(ForwardVenue.RewardTooHigh.selector, 1 ether + 1));
        venue.placeOrder{value: 1 ether + 1}(m, ForwardVenue.Kind.BUY_UP, 1 * U, 0.5e18);
        vm.stopPrank();
        // unregistered market
        Market other = _create(ETH, M15, T0 + 900);
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(ForwardVenue.MarketNotTradable.selector, address(other))
        );
        venue.placeOrder{value: REWARD}(other, ForwardVenue.Kind.BUY_UP, 1 * U, 0.5e18);
        // paused vault
        vm.prank(vGuardian);
        vault.pauseQuoting();
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(ForwardVenue.MarketNotTradable.selector, address(m)));
        venue.placeOrder{value: REWARD}(m, ForwardVenue.Kind.BUY_UP, 1 * U, 0.5e18);
    }

    function test_place_withoutApprovalReverts() public {
        vm.deal(taker, 1 ether);
        usdc.mint(taker, 10 * U);
        vm.prank(taker);
        vm.expectRevert();
        venue.placeOrder{value: REWARD}(m, ForwardVenue.Kind.BUY_UP, 1 * U, 0.5e18);
        vm.prank(taker);
        vm.expectRevert();
        venue.placeOrder{value: REWARD}(m, ForwardVenue.Kind.SELL_DOWN, 1 * U, 0.5e18);
    }

    // ------------------------------------------------------------------ executing: the four kinds

    function test_exec_buyUp_fillsAtAskWithPriceImprovementAndRefund() public {
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.6e18);
        QuoteMath.Quote memory q = _ladder(_execAt(id), SPOT);
        uint256 size0 = q.asks[0].size / 1e12;
        assertGt(size0, 2 * U); // the first level alone covers the order
        (uint256 filled, uint256 premium) = _exec(id, 3000e18);
        assertEq(filled, 2 * U);
        assertEq(premium, 2 * U * 55 / 100); // 1.10 USDC at 0.55
        assertEq(IERC20(address(m.up())).balanceOf(taker), 2 * U);
        // collateral escrow 2*0.6 + 4 = 1.200004; premium 1.1 refunded the rest
        assertEq(usdc.balanceOf(taker), 1_200_004 - 1_100_000);
        assertEq(usdc.balanceOf(address(venue)), 0);
        assertEq(executor.balance, REWARD);
        (int256 basis, int256 cash) = vault.positionOf(address(m));
        assertEq(basis, int256(100 * U));
        assertEq(cash, int256(premium));
        assertEq(IERC20(address(m.up())).balanceOf(address(vault)), 98 * U);
        (,, ForwardVenue.Status st,,,,,,) = venue.orders(id);
        assertEq(uint8(st), uint8(ForwardVenue.Status.DONE));
    }

    function test_exec_sellUp_fillsAtBid() public {
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.SELL_UP, 2 * U, 0.4e18);
        (uint256 filled, uint256 premium) = _exec(id, 3000e18);
        assertEq(filled, 2 * U);
        assertEq(premium, 2 * U * 44 / 100); // bid 0.44
        assertEq(usdc.balanceOf(taker), premium);
        assertEq(IERC20(address(m.up())).balanceOf(taker), 0);
        assertEq(IERC20(address(m.up())).balanceOf(address(vault)), 102 * U);
        (, int256 cash) = vault.positionOf(address(m));
        assertEq(cash, -int256(premium));
    }

    function test_exec_buyDown_usesComplementOfBid() public {
        // DOWN ask = 1 - UP bid = 0.56
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_DOWN, 2 * U, 0.6e18);
        (uint256 filled, uint256 premium) = _exec(id, 3000e18);
        assertEq(filled, 2 * U);
        assertEq(premium, 2 * U * 56 / 100);
        assertEq(IERC20(address(m.down())).balanceOf(taker), 2 * U);
    }

    function test_exec_sellDown_usesComplementOfAsk() public {
        // DOWN bid = 1 - UP ask = 0.45
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.SELL_DOWN, 2 * U, 0.4e18);
        (uint256 filled, uint256 premium) = _exec(id, 3000e18);
        assertEq(filled, 2 * U);
        assertEq(premium, 2 * U * 45 / 100);
        assertEq(usdc.balanceOf(taker), premium);
    }

    function test_exec_walksSecondLevelWhenLimitAllows() public {
        QuoteMath.Params memory pp = _launchParams();
        pp.perMarketMaxFraction = 0.05e18; // room for both levels
        vm.prank(vOwner);
        vault.setQuoteParams(pp);
        QuoteMath.Quote memory q = _ladder(uint64(block.timestamp + DELAY), SPOT);
        assertEq(q.asks.length, 2);
        uint256 total = (q.asks[0].size + q.asks[1].size) / 1e12;
        uint256 want = total + 5 * U;
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, want, 0.99e18);
        (uint256 filled,) = _exec(id, 3000e18);
        assertApproxEqAbs(filled, total, 1); // both levels and no more
        assertLt(filled, want);
        // unfilled escrow came back
        assertGt(usdc.balanceOf(taker), 0);
    }

    function test_exec_limitBelowAskLeavesOrderUnfilledAndRefunds() public {
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.5e18);
        (uint256 filled, uint256 premium) = _exec(id, 3000e18);
        assertEq(filled, 0);
        assertEq(premium, 0);
        assertEq(usdc.balanceOf(taker), 2 * U / 2 + 4); // full escrow back
        assertEq(executor.balance, REWARD); // the executor is still paid
        // a sell order with a limit above the bid is refunded in kind
        uint256 id2 = _placeAs(bob, m, ForwardVenue.Kind.SELL_UP, 2 * U, 0.6e18);
        _exec(id2, 3000e18);
        assertEq(IERC20(address(m.up())).balanceOf(bob), 2 * U);
    }

    function test_exec_priceFollowsTheReport() public {
        // the same order against a higher spot costs more: nothing but the report moves the price
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.99e18);
        uint256 snap = vm.snapshotState();
        (, uint256 p1) = _exec(id, 3000e18);
        vm.revertToState(snap);
        (, uint256 p2) = _exec(id, 3010e18);
        assertGt(p2, p1);
    }

    function test_exec_riskCeilingBindsTheFill() public {
        QuoteMath.Params memory p = _launchParams();
        p.perMarketMaxFraction = 0.001e18; // loss ceiling: 1 USDC
        vm.prank(vOwner);
        vault.setQuoteParams(p);
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 100 * U, 0.99e18);
        (uint256 filled,) = _exec(id, 3000e18);
        // selling x UP at 0.55 from a flat pair book loses 0.45x: x <= 1/0.45 = 2.2222 shares
        assertEq(filled, 2_222_222);
        (int256 basis, int256 cash) = vault.positionOf(address(m));
        uint256 up = IERC20(address(m.up())).balanceOf(address(vault));
        uint256 down = IERC20(address(m.down())).balanceOf(address(vault));
        int256 loss = basis - cash - int256(up < down ? up : down);
        assertLe(loss, int256(1 * U));
        assertGt(loss, int256(1 * U) - 10); // and it used (almost) all of the room
    }

    function test_exec_vaultPausedAfterPlacementRefunds() public {
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.6e18);
        vm.prank(vGuardian);
        vault.pauseQuoting();
        (uint256 filled,) = _exec(id, 3000e18);
        assertEq(filled, 0);
        assertEq(usdc.balanceOf(taker), 2 * U * 6 / 10 + 4);
    }

    function test_exec_noFillInNoQuoteWindowOrAfterEnd() public {
        vm.warp(T0 + 900 - 31);
        vault.checkpoint(_noReports());
        _setSigmaFresh();
        // pricing time T0+900-29 is inside the 30 s no-quote window
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.99e18);
        (uint256 filled,) = _exec(id, 3000e18);
        assertEq(filled, 0);
    }

    function _setSigmaFresh() internal {
        // forge-lint: disable-next-line(environment-read-across-mutation)
        vm.warp(block.timestamp + 31);
        _setSigma(0.62e18);
        // forge-lint: disable-next-line(environment-read-across-mutation)
        vm.warp(block.timestamp - 31);
    }

    function test_exec_staleSigmaMeansNoQuote() public {
        vm.prank(vOwner);
        vault.setSigmaConfig(2000, 30, 60, 1800); // sigma older than 60 s is stale
        // forge-lint: disable-next-line(environment-read-across-mutation)
        // forge-lint: disable-next-line(environment-read-across-mutation)
        vm.warp(block.timestamp + 61);
        vault.checkpoint(_noReports());
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.6e18);
        (uint256 filled,) = _exec(id, 3000e18);
        assertEq(filled, 0); // no quote on a stale sigma: refunded
        _setSigma(0.62e18);
        uint256 id2 = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.6e18);
        (filled,) = _exec(id2, 3000e18);
        assertEq(filled, 2 * U);
    }

    // ------------------------------------------------------------------ the executor cannot choose (ADR-004 stop-ship)

    function test_exec_wrongWindowReportsRevert() public {
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.6e18);
        uint64 at = _execAt(id);
        vm.warp(at);
        vm.startPrank(executor);
        // window ends before the pricing time
        vm.expectRevert(
            abi.encodeWithSelector(ForwardVenue.ReportNotCanonical.selector, at, at - 5, at - 1)
        );
        venue.executeOrder(id, _repWindow(at - 5, at - 1, 3000e18, at + 1 days));
        // window starts after the pricing time (the next report in a contiguous series)
        vm.expectRevert(
            abi.encodeWithSelector(ForwardVenue.ReportNotCanonical.selector, at, at + 1, at + 6)
        );
        venue.executeOrder(id, _repWindow(at + 1, at + 6, 3000e18, at + 1 days));
        vm.stopPrank();
    }

    function test_exec_laterCallSamePriceSameFill() public {
        // Calling at T or at T + 20 s changes nothing: the price is the canonical report's.
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.99e18);
        uint64 at = _execAt(id);
        uint256 snap = vm.snapshotState();
        vm.warp(at);
        vm.prank(executor);
        (uint256 f1, uint256 p1) =
            venue.executeOrder(id, _repWindow(at - 1, at + 1, 3000e18, at + 1 days));
        vm.revertToState(snap);
        vm.warp(at + 20);
        vm.prank(executor);
        (uint256 f2, uint256 p2) =
            venue.executeOrder(id, _repWindow(at - 1, at + 1, 3000e18, at + 1 days));
        assertEq(f1, f2);
        assertEq(p1, p2);
    }

    function test_exec_timingRules() public {
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.6e18);
        uint64 at = _execAt(id);
        bytes memory rep = _repWindow(at - 1, at + 1, 3000e18, at + 1 days);
        vm.startPrank(executor);
        vm.expectRevert(abi.encodeWithSelector(ForwardVenue.TooEarly.selector, at));
        venue.executeOrder(id, rep);
        vm.warp(at + LATE);
        venue.executeOrder(id, rep); // the last valid second
        vm.expectRevert(abi.encodeWithSelector(ForwardVenue.NotOpen.selector, id)); // once only
        venue.executeOrder(id, rep);
        vm.stopPrank();
    }

    function test_exec_cannotReplayOrExpireAfterwards() public {
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.6e18);
        _exec(id, 3000e18);
        vm.warp(block.timestamp + 1000);
        vm.expectRevert(abi.encodeWithSelector(ForwardVenue.NotOpen.selector, id));
        venue.expireOrder(id);
        vm.expectRevert(abi.encodeWithSelector(ForwardVenue.NotOpen.selector, 12345));
        venue.executeOrder(12345, "");
    }

    function test_exec_overlappingReports_isTheDocumentedTrustAssumption() public {
        // Chainlink guarantees contiguous, non-overlapping windows (ADR-002). If two valid reports
        // both contained T the executor could pick; the venue cannot detect it. This test pins the
        // behaviour so the assumption is explicit, not silent.
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.99e18);
        uint64 at = _execAt(id);
        vm.warp(at);
        uint256 snap = vm.snapshotState();
        vm.prank(executor);
        (, uint256 low) = venue.executeOrder(id, _repWindow(at - 2, at + 2, 3000e18, at + 1 days));
        vm.revertToState(snap);
        vm.prank(executor);
        (, uint256 high) = venue.executeOrder(id, _repWindow(at - 1, at + 3, 3002e18, at + 1 days));
        assertGt(high, low);
    }

    function test_exec_badReportsRevert() public {
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.6e18);
        uint64 at = _execAt(id);
        vm.warp(at);
        vm.startPrank(executor);
        // wrong feed
        bytes32 other = 0x0003aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;
        vm.expectRevert(abi.encodeWithSelector(ReportLib.WrongFeed.selector, ETH_FEED, other));
        venue.executeOrder(id, _report(other, uint32(at - 1), uint32(at + 1), 3000e18));
        // forged signature
        bytes memory good = _repWindow(at - 1, at + 1, 3000e18, at + 1 days);
        (bytes32[3] memory ctx, bytes memory data,) = abi.decode(good, (bytes32[3], bytes, bytes));
        vm.expectRevert();
        venue.executeOrder(id, abi.encode(ctx, data, new bytes(65)));
        // expired report
        vm.expectRevert(abi.encodeWithSelector(ReportLib.ReportExpired.selector, at - 1));
        venue.executeOrder(id, _repWindow(at - 1, at + 1, 3000e18, at - 1));
        // non-positive price
        vm.expectRevert(abi.encodeWithSelector(ReportLib.InvalidPrice.selector, int192(0)));
        venue.executeOrder(id, _repWindow(at - 1, at + 1, 0, at + 1 days));
        // wrong schema version (v8 feed id prefix)
        bytes32 v8 = 0x0008aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;
        vm.expectRevert(
            abi.encodeWithSelector(ReportLib.UnsupportedReportVersion.selector, uint16(8))
        );
        venue.executeOrder(id, _report(v8, uint32(at - 1), uint32(at + 1), 3000e18));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ expiry, rewards

    function test_expire_refundsAndPaysCaller() public {
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.6e18);
        uint64 at = _execAt(id);
        vm.warp(at + LATE);
        vm.expectRevert(abi.encodeWithSelector(ForwardVenue.NotExpired.selector, at + LATE));
        venue.expireOrder(id);
        vm.warp(at + LATE + 1);
        vm.prank(executor);
        venue.expireOrder(id);
        assertEq(usdc.balanceOf(taker), 2 * U * 6 / 10 + 4);
        assertEq(executor.balance, REWARD);
        vm.expectRevert(abi.encodeWithSelector(ForwardVenue.NotOpen.selector, id));
        venue.executeOrder(id, "");
    }

    function test_expire_worksEvenWhenVaultIsPausedAndTokenOrderRefundsTokens() public {
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.SELL_DOWN, 3 * U, 0.4e18);
        vm.prank(vGuardian);
        vault.pauseQuoting();
        vm.warp(_execAt(id) + LATE + 1);
        vm.prank(executor);
        venue.expireOrder(id);
        assertEq(IERC20(address(m.down())).balanceOf(taker), 3 * U);
    }

    function test_reward_rejectingExecutorReverts() public {
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.6e18);
        uint64 at = _execAt(id);
        vm.warp(at);
        NoReceive nr = new NoReceive();
        bytes memory rep = _repWindow(at - 1, at + 1, 3000e18, at + 1 days);
        vm.expectRevert(ForwardVenue.NativeTransferFailed.selector);
        nr.exec(venue, id, rep);
    }

    function test_setMinReward_vaultOwnerOnly() public {
        vm.expectRevert(ForwardVenue.NotVaultOwner.selector);
        venue.setMinReward(1);
        vm.startPrank(vOwner);
        venue.setMinReward(5 gwei);
        assertEq(venue.minReward(), 5 gwei);
        vm.expectRevert(ForwardVenue.InvalidConfig.selector);
        venue.setMinReward(1 ether + 1);
        vm.stopPrank();
    }

    function test_constructor_validation() public {
        vm.expectRevert(ForwardVenue.InvalidConfig.selector);
        new ForwardVenue(ConvergeVault(address(0)), 2, 30, 0);
        vm.expectRevert(ForwardVenue.InvalidConfig.selector);
        new ForwardVenue(vault, 0, 30, 0);
        vm.expectRevert(ForwardVenue.InvalidConfig.selector);
        new ForwardVenue(vault, 2, 0, 0);
        vm.expectRevert(ForwardVenue.InvalidConfig.selector);
        new ForwardVenue(vault, 2, 30, 2 ether);
    }

    // ------------------------------------------------------------------ vault-side bounds (a faulty venue)

    function _asVenueFill(ConvergeVault.FillParams memory f) internal {
        usdc.mint(address(venue), 1000 * U);
        vm.startPrank(address(venue));
        usdc.approve(address(vault), type(uint256).max);
        IERC20(address(m.up())).approve(address(vault), type(uint256).max);
        vault.venueFill(f);
        vm.stopPrank();
    }

    function _fp(uint256 units, uint256 premium)
        internal
        view
        returns (ConvergeVault.FillParams memory f)
    {
        f = ConvergeVault.FillParams(
            m, true, true, units, premium, taker, 3000e18, uint64(block.timestamp)
        );
    }

    function test_vaultBounds_rejectBadFills() public {
        ConvergeVault.FillParams memory f = _fp(0, 1);
        usdc.mint(address(venue), 1000 * U);
        vm.startPrank(address(venue));
        usdc.approve(address(vault), type(uint256).max);
        vm.expectRevert(ConvergeVault.ZeroAmount.selector);
        vault.venueFill(f);
        f = _fp(1 * U, 1 * U / 2);
        f.taker = address(0);
        vm.expectRevert(ConvergeVault.ZeroAddress.selector);
        vault.venueFill(f);
        f.taker = address(vault);
        vm.expectRevert(ConvergeVault.ZeroAddress.selector);
        vault.venueFill(f);
        f = _fp(1 * U, 1 * U / 2);
        f.market = Market(address(0xBAD));
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.MarketNotRegistered.selector, address(0xBAD))
        );
        vault.venueFill(f);
        // price below / above the bounds (0.02 .. 0.98)
        f = _fp(1 * U, 0.01e6);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.PriceOutOfBounds.selector, 0.01e18));
        vault.venueFill(f);
        f = _fp(1 * U, 0.99e6);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.PriceOutOfBounds.selector, 0.99e18));
        vault.venueFill(f);
        // beyond the loss ceiling (10 USDC): selling 30 UP at 0.5 loses 15
        f = _fp(30 * U, 15 * U);
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.RiskLimitExceeded.selector, 30 * U, 20 * U)
        );
        vault.venueFill(f);
        vm.stopPrank();
    }

    function test_vaultBounds_pausedAndStaleNav() public {
        ConvergeVault.FillParams memory f = _fp(1 * U, 1 * U / 2);
        usdc.mint(address(venue), 10 * U);
        vm.startPrank(address(venue));
        usdc.approve(address(vault), type(uint256).max);
        vm.stopPrank();
        vm.warp(block.timestamp + 31 minutes);
        vm.prank(address(venue));
        vm.expectRevert(ConvergeVault.NotTradable.selector);
        vault.venueFill(f);
        vault.checkpoint(_noReports());
        vm.prank(vGuardian);
        vault.pauseQuoting();
        vm.prank(address(venue));
        vm.expectRevert(ConvergeVault.QuotingIsPaused.selector);
        vault.venueFill(f);
    }

    function test_vaultBounds_buyNeedsFreeLiquidityAndAccountsCash() public {
        // the vault buys UP at 0.5 for 1 USDC premium; goes through when inside limits
        ConvergeVault.FillParams memory f = _fp(2 * U, 1 * U);
        f.vaultSells = false;
        IERC20 up = IERC20(address(m.up()));
        _split(m, address(venue), 2 * U);
        _asVenueFill(f);
        (, int256 cash) = vault.positionOf(address(m));
        assertEq(cash, -int256(1 * U));
        assertEq(up.balanceOf(address(vault)), 102 * U);
        assertEq(usdc.balanceOf(taker), 1 * U);

        // reserved assets are never spendable: leave 0.4 USDC free and a 2-UP buy is out of room
        uint256 bal = usdc.balanceOf(address(vault));
        vm.prank(address(vault));
        usdc.transfer(address(0xB0B), bal - 400_000);
        assertEq(vault.fillRoom(m, true, false, 0.5e18), 800_000); // 0.4 USDC / 0.5
        _split(m, address(venue), 2 * U);
        vm.prank(address(venue));
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.RiskLimitExceeded.selector, 2 * U, 800_000)
        );
        vault.venueFill(f);
    }

    function test_vaultBounds_pullFailuresRevert() public {
        // the venue never approved the vault: the pull fails and the fill is not recorded
        vm.prank(address(venue));
        vm.expectRevert();
        vault.venueFill(_fp(1 * U, 1 * U / 2));
    }

    // ------------------------------------------------------------------ the breaker needs nobody

    function test_autoCheckpoint_tripsTheBreakerFromFills() public {
        // 6% of the collateral disappears (a loss the vault has not noticed yet)
        vm.prank(address(vault));
        usdc.transfer(address(0xB0B), 56 * U); // 1000 NAV with 100 in pairs: 6% of the 944 free + pairs
        assertFalse(vault.quotingPaused());
        // forge-lint: disable-next-line(environment-read-across-mutation)
        vm.warp(block.timestamp + 61); // the stored NAV is more than a minute old
        _setSigma(0.62e18); // keep sigma fresh
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.6e18);
        uint256 before = vault.quoteNavLower();
        _exec(id, 3000e18); // the fill itself is fine; it re-values the vault afterwards
        assertTrue(vault.quotingPaused());
        assertLt(vault.quoteNavLower(), before);
        // no new trading, but exits are untouched
        vm.deal(taker, 1 ether);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(ForwardVenue.MarketNotTradable.selector, address(m)));
        venue.placeOrder{value: REWARD}(m, ForwardVenue.Kind.BUY_UP, 1 * U, 0.6e18);
    }

    function test_autoCheckpoint_neverRaisesTheNav() public {
        usdc.mint(address(vault), 50 * U); // the vault is worth more than its stored NAV
        uint256 before = vault.quoteNavLower();
        // forge-lint: disable-next-line(environment-read-across-mutation)
        vm.warp(block.timestamp + 61);
        _setSigma(0.62e18);
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.6e18);
        _exec(id, 3000e18);
        assertEq(vault.quoteNavLower(), before); // only a checkpoint or a settlement can raise it
        assertEq(vault.navUpdatedAt(), block.timestamp);
        assertFalse(vault.quotingPaused());
    }

    function test_autoCheckpoint_ignoresAVenueMarkOlderThanAMinute() public {
        // a hostile venue passing an old report cannot move the NAV or trip the breaker with it
        // forge-lint: disable-next-line(environment-read-across-mutation)
        vm.warp(block.timestamp + 61);
        _setSigma(0.62e18);
        uint64 stamp = vault.navUpdatedAt();
        ConvergeVault.FillParams memory f = _fp(1 * U, 550_000);
        f.refObs = uint64(block.timestamp - 100);
        _asVenueFill(f);
        assertEq(vault.navUpdatedAt(), stamp);
        // a fresh one does re-value
        f.refObs = uint64(block.timestamp);
        _asVenueFill(f);
        assertEq(vault.navUpdatedAt(), block.timestamp);
    }

    /// @dev The vault walks its registry (at most 16 markets) on every fill: measure the worst case.
    function test_gas_executeOrderWithSixteenRegisteredMarkets() public {
        Market[] memory more = new Market[](15);
        for (uint256 i = 0; i < 15; i++) {
            more[i] = _create(ETH, M15, T0 + uint64(900 * (i + 1)));
        }
        vm.startPrank(vKeeper);
        for (uint256 i = 0; i < 15; i++) {
            vault.splitForInventory(more[i], 5 * U);
        }
        vm.stopPrank();
        assertEq(vault.marketCount(), 16);
        vault.checkpoint(_noReports());
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.6e18);
        (,,, uint64 at,,,,,) = venue.orders(id);
        vm.warp(at);
        bytes memory rep = _repWindow(at - 1, at, 3000e18, at + 1 days);
        uint256 g = gasleft();
        vm.prank(executor);
        venue.executeOrder(id, rep);
        uint256 used = g - gasleft();
        emit log_named_uint("gas: executeOrder with 16 registered markets (one level)", used);
        assertLt(used, 2_000_000);
    }

    function test_gas_executeOrderIsMeasured() public {
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.6e18);
        (,,, uint64 at,,,,,) = venue.orders(id);
        vm.warp(at);
        bytes memory rep = _repWindow(at - 1, at + 1, 3000e18, at + 1 days);
        uint256 g = gasleft();
        vm.prank(executor);
        venue.executeOrder(id, rep);
        uint256 used = g - gasleft();
        emit log_named_uint("gas: executeOrder (2 USDC buy, one ladder level, cold)", used);
        assertLt(used, 700_000); // ADR-004 assumed 400k; the measured figure is recorded in the report
    }
}

contract NoReceive {
    function exec(ForwardVenue v, uint256 id, bytes memory rep) external {
        v.executeOrder(id, rep);
    }
}
