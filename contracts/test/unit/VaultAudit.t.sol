// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultBase} from "../VaultBase.t.sol";
import {ConvergeVault} from "../../src/vault/ConvergeVault.sol";
import {ForwardVenue} from "../../src/vault/ForwardVenue.sol";
import {QuoteMath} from "../../src/vault/QuoteMath.sol";
import {Market} from "../../src/Market.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Tests added after the independent audit (docs/evidence/phase-4/hostile-review.md): one
///         or more per finding, named after it.
contract VaultAuditTest is VaultBase {
    Market internal h; // an hour round, 15:00 to 16:00

    function setUp() public override {
        super.setUp();
        _fund(alice, 1000 * U);
        h = _openEth(T0 + 2700, H1, 3000e18);
        vm.warp(T0 + 2700 + 200);
        _setSigma(0.6e18);
        vm.prank(vKeeper);
        vault.splitForInventory(h, 100 * U);
        vault.checkpoint(_noReports());
    }

    function _exec(uint256 id, int192 px) internal returns (uint256 filled) {
        (,,, uint64 at,,,,,) = venue.orders(id);
        if (block.timestamp < at) vm.warp(at);
        vm.prank(executor);
        (filled,) = venue.executeOrder(id, _repWindow(at - 1, at, px, at + 1 days));
    }

    function _donateUp(Market mk, uint256 amount) internal {
        _split(mk, bob, amount);
        IERC20 up = IERC20(address(mk.up()));
        vm.prank(bob);
        up.transfer(address(vault), amount);
    }

    // ------------------------------------------------------------------ F-01

    /// @dev The epoch is priced at the marks of its end time, so the inventory must not change
    ///      between the end and the settlement: fills are frozen while an ended epoch with
    ///      requests can still be settled (audit F-01: a trade after the end was valued at the
    ///      earlier price and moved the NAV by about 1.3%).
    function test_audit_F01_fillsAreFrozenWhileAnEndedEpochAwaitsSettlement() public {
        uint256 e = vault.currentEpoch();
        vm.prank(alice);
        vault.requestRedeem(100 * U);
        uint256 end = vault.epochEnd(e);
        vm.warp(end - 1);
        uint256 id = _placeAs(taker, h, ForwardVenue.Kind.BUY_UP, 2 * U, 0.9e18); // priced at end + 1
        // the venue sees the market as untradable, the order comes back unfilled
        vm.warp(end + 1);
        assertFalse(vault.venueView(h).tradable);
        assertEq(_exec(id, 3000e18), 0);
        // and the vault itself refuses a fill
        ConvergeVault.FillParams memory f =
            ConvergeVault.FillParams(h, true, true, 1 * U, 550_000, taker, 3000e18, uint64(end));
        vm.prank(address(venue));
        vm.expectRevert(ConvergeVault.SettlementPending.selector);
        vault.venueFill(f);
        // once the epoch is settled trading resumes
        vault.settleEpoch(e, _markAt(end, 3000e18));
        vm.warp(block.timestamp + 31);
        _setSigma(0.62e18);
        assertTrue(vault.venueView(h).tradable);
        uint256 id2 = _placeAs(taker, h, ForwardVenue.Kind.BUY_UP, 2 * U, 0.9e18);
        assertEq(_exec(id2, 3000e18), 2 * U);
    }

    function test_audit_F01_noFreezeWithoutRequests_orAfterTheWindow() public {
        uint256 e = vault.currentEpoch();
        uint256 end = vault.epochEnd(e);
        vm.warp(end + 1);
        assertTrue(vault.venueView(h).tradable); // nothing to settle: nothing to protect
        // with a request that nobody settles, trading resumes once the window is over
        vm.warp(end - 5);
        vm.prank(alice);
        vault.requestRedeem(10 * U);
        vm.warp(end + 1);
        assertFalse(vault.venueView(h).tradable);
        vm.warp(end + vault.settleWindow() + 1);
        _setSigma(0.62e18); // the earlier sigma has gone stale by now
        assertTrue(vault.venueView(h).tradable);
    }

    // ------------------------------------------------------------------ F-04, F-06

    function test_audit_F04_mergeCanNeverBeKeptHostage() public {
        vm.prank(alice);
        vm.expectRevert(ConvergeVault.OnlyKeeper.selector);
        vault.mergeInventory(h, 1 * U);
        vm.prank(vOwner);
        vault.mergeInventory(h, 10 * U);
        vm.prank(vGuardian);
        vault.mergeInventory(h, 10 * U);
        vm.prank(vGuardian);
        vault.pauseQuoting();
        vm.prank(alice); // anyone, while quoting is paused
        vault.mergeInventory(h, 10 * U);
        (int256 basis,) = vault.positionOf(address(h));
        assertEq(basis, int256(70 * U));
    }

    function test_audit_F06_pruneEmptyFreesTheSlot() public {
        vm.expectRevert(
            abi.encodeWithSelector(ConvergeVault.MarketNotRegistered.selector, address(0xBAD))
        );
        vault.pruneEmpty(Market(address(0xBAD)));
        vm.expectRevert(ConvergeVault.NotEmpty.selector);
        vault.pruneEmpty(h);
        // a taker bought both sides: the vault holds no tokens but is still registered
        IERC20 up = IERC20(address(h.up()));
        IERC20 down = IERC20(address(h.down()));
        vm.startPrank(address(vault));
        up.transfer(address(0xB0B), 100 * U);
        down.transfer(address(0xB0B), 100 * U);
        vm.stopPrank();
        assertTrue(vault.isRegistered(address(h)));
        vault.pruneEmpty(h); // anyone
        assertFalse(vault.isRegistered(address(h)));
        assertEq(vault.marketCount(), 0);
    }

    // ------------------------------------------------------------------ F-07 (mutation survivors)

    function test_audit_F07_losingExcessIsWorthNothingOnceResolved() public {
        Market r = _openEth(T0 + 5400, M15, 3000e18);
        vm.warp(T0 + 5400 + 130);
        vm.prank(vKeeper);
        vault.splitForInventory(r, 50 * U);
        _donateUp(r, 10 * U);
        // DOWN wins: the spare UP pays nothing
        vm.warp(T0 + 5400 + 900 + 1);
        streamsResolver.submit(
            ETH,
            T0 + 5400 + 900,
            _report(ETH_FEED, uint32(T0 + 5400 + 899), uint32(T0 + 5400 + 901), 2900e18)
        );
        vm.warp(T0 + 5400 + 900 + WINDOW + 1);
        r.resolve("");
        vault.checkpoint(_noReports());
        assertEq(vault.quoteNavLower(), 1000 * U);
        assertEq(vault.lastNavUpper(), 1000 * U);
    }

    function test_audit_F07_invalidRoundPaysHalfOnTheExcess() public {
        Market r = _create(ETH, M15, T0 + 5400);
        vm.warp(T0 + 5400 - 100);
        vm.prank(vKeeper);
        vault.splitForInventory(r, 20 * U);
        _donateUp(r, 10 * U);
        vm.warp(T0 + 5400 + GRACE + 1); // no strike report ever arrives
        r.invalidate();
        vault.checkpoint(_noReports());
        // 100 pairs in h + 20 in r are worth 1 each; the spare 10 UP of the invalid round pay 0.5
        assertEq(vault.quoteNavLower(), 1000 * U + 5 * U);
        assertEq(vault.lastNavUpper(), 1000 * U + 5 * U);
    }

    // ------------------------------------------------------------------ F-12, F-15 and limits

    function test_audit_F12_ownershipCanNotBeRenounced() public {
        vm.prank(vOwner);
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.renounceOwnership();
    }

    function test_audit_F15_cancelVenueEmits() public {
        vm.startPrank(vOwner);
        vault.proposeVenue(alice);
        vm.expectEmit(address(vault));
        emit ConvergeVault.VenueCancelled(alice);
        vault.cancelVenue();
        vm.stopPrank();
    }

    function test_audit_spreadFloorAndLatenessCap() public {
        QuoteMath.Params memory p = _launchParams();
        p.minHalfSpread = 0.01e18; // a near-zero spread would give quotes away
        vm.prank(vOwner);
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setQuoteParams(p);
        vm.expectRevert(ForwardVenue.InvalidConfig.selector);
        new ForwardVenue(vault, 2, 11, 0); // the execute-or-skip option is kept to seconds
        new ForwardVenue(vault, 2, 10, 0);
    }

    // ------------------------------------------------------------------ F-14 (measured worst cases)

    /// @dev Sixteen registered markets, every one holding excess: the cost of a fill and of a
    ///      settlement that needs a mark.
    function test_audit_F14_worstCaseGas() public {
        Market[] memory more = new Market[](15);
        for (uint256 i = 0; i < 15; i++) {
            more[i] = _create(ETH, H1, T0 + 2700 + uint64(3600 * (i + 1)));
        }
        vm.startPrank(vKeeper);
        for (uint256 i = 0; i < 15; i++) {
            vault.splitForInventory(more[i], 5 * U);
        }
        vm.stopPrank();
        for (uint256 i = 0; i < 15; i++) {
            _donateUp(more[i], 1 * U);
        }
        _donateUp(h, 5 * U);
        assertEq(vault.marketCount(), 16);
        // a settlement that needs the canonical mark
        uint256 e = vault.currentEpoch();
        _requestDeposit(carolAddr(), 20 * U);
        uint256 end = vault.epochEnd(e);
        vm.warp(end);
        bytes[] memory marks = _markAt(end, 3000e18);
        uint256 g = gasleft();
        vault.settleEpoch(e, marks);
        emit log_named_uint(
            "gas: settleEpoch, 16 registered markets all holding excess", g - gasleft()
        );

        // a fill that also triggers the automatic re-valuation (stored NAV older than a minute)
        vm.warp(block.timestamp + 61);
        _setSigma(0.62e18);
        uint256 id = _placeAs(taker, h, ForwardVenue.Kind.BUY_UP, 2 * U, 0.9e18);
        (,,, uint64 at,,,,,) = venue.orders(id);
        vm.warp(at);
        bytes memory rep = _repWindow(at - 1, at, 3000e18, at + 1 days);
        g = gasleft();
        vm.prank(executor);
        venue.executeOrder(id, rep);
        emit log_named_uint(
            "gas: executeOrder, 16 markets with excess, auto-checkpoint included", g - gasleft()
        );
    }

    function carolAddr() internal returns (address) {
        return makeAddr("carolAudit");
    }
}
