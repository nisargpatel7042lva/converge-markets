// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultBase} from "../VaultBase.t.sol";
import {ConvergeVault} from "../../src/vault/ConvergeVault.sol";
import {ForwardVenue} from "../../src/vault/ForwardVenue.sol";
import {QuoteMath} from "../../src/vault/QuoteMath.sol";
import {Market} from "../../src/Market.sol";
import {DataStreamsResolver} from "../../src/resolvers/DataStreamsResolver.sol";
import {ChainlinkRoundResolver} from "../../src/resolvers/ChainlinkRoundResolver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {FeeMockERC20} from "../mocks/FeeMockERC20.sol";

/// @notice Regression tests for the Phase 9 manual-review findings that changed contract code
///         (docs/security/internal-audit.md, findings F9-03 to F9-15).
contract ReviewFixesTest is VaultBase {
    Market internal m;

    function setUp() public override {
        super.setUp();
        _fund(alice, 1000 * U);
        m = _openEth(T0, M15, 3000e18);
        vm.warp(T0 + 300);
    }

    function _donate(Market mk, bool up, uint256 amount) internal {
        _split(mk, bob, amount);
        IERC20 t = up ? IERC20(address(mk.up())) : IERC20(address(mk.down()));
        vm.prank(bob);
        t.transfer(address(vault), amount);
    }

    // ------------------------------------------------------------------ F9-04 keeper rotation

    function test_setKeeper_discardsOldSigmaAndHaltsUntilTheNewKeyActs() public {
        _setSigma(1.5e18); // a hostile (in-band) value
        address newKeeper = makeAddr("newKeeper");
        vm.prank(vOwner);
        vault.setKeeper(newKeeper);

        (,, uint128 sigma,,,) = vault.assetCfg(ETH);
        assertEq(sigma, 0, "the old key's sigma is gone");
        assertTrue(vault.keeperHalt(), "quoting is halted until the new key unhalts");

        // the new key is not tied to the old value: any in-band first value is accepted
        vm.prank(newKeeper);
        vault.setSigma(ETH, 0.5e18);
        (,, sigma,,,) = vault.assetCfg(ETH);
        assertEq(sigma, 0.5e18);
        assertTrue(vault.keeperHalt(), "setting sigma does not resume quoting");
        vm.prank(newKeeper);
        vault.unhaltQuoting();
        assertFalse(vault.keeperHalt());
        // the old key can do nothing any more
        vm.prank(vKeeper);
        vm.expectRevert(ConvergeVault.OnlyKeeper.selector);
        vault.haltQuoting("X");
    }

    // ------------------------------------------------------------------ F9-09 / F9-10 config bounds

    function test_setQuoteParams_requiresSymmetricPriceBounds() public {
        QuoteMath.Params memory p = _launchParams();
        p.priceMin = 0.01e18; // 0.01 + 0.98 != 1
        vm.prank(vOwner);
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setQuoteParams(p);
        p.priceMax = 0.99e18; // symmetric again
        vm.prank(vOwner);
        vault.setQuoteParams(p);
    }

    function test_setSigmaConfig_isBoundedAndCannotTruncate() public {
        vm.startPrank(vOwner);
        // 2^32 + 1 would be cast to 1 and silently disable quoting
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setSigmaConfig(2000, 30, 900, uint256(type(uint32).max) + 2);
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setSigmaConfig(2000, 30, 2 hours, 1800); // sigma may not live longer than an hour
        vm.expectRevert(ConvergeVault.InvalidConfig.selector);
        vault.setSigmaConfig(2000, 30, 900, 3 hours); // nor may the NAV
        vault.setSigmaConfig(2000, 30, 900, 1800);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ F9-11 one feed, one asset

    function test_enableAsset_rejectsASecondAssetOnTheSameFeed() public {
        bytes32 dup = keccak256("DUP");
        vm.startPrank(admin);
        streamsResolver.configureAsset(dup, ETH_FEED);
        factory.setAsset(dup, streamsResolver, "DUP", true);
        vm.stopPrank();
        assertEq(vault.assetOfFeed(ETH_FEED), ETH);
        vm.prank(vOwner);
        vm.expectRevert(abi.encodeWithSelector(ConvergeVault.FeedAlreadyUsed.selector, ETH_FEED));
        vault.enableAsset(dup, 0.3e18, 2e18);
    }

    // ------------------------------------------------------------------ F9-06 dust needs no mark

    function test_dustExcessNeedsNoMarkToSettle() public {
        // an hour-long round, so the epoch ends while it is still running
        Market h = _openEth(T0 + 2700, H1, 3000e18);
        vm.prank(vKeeper);
        vault.splitForInventory(h, 100 * U); // pairs only: no mark needed
        uint256 e = vault.currentEpoch();
        _toEpochEnd(e);
        assertGt(h.endTime(), vault.epochEnd(e));
        _donate(h, true, 1); // one raw unit of UP: a dust "excess"
        (bytes32[] memory feeds,) = vault.settlementPlan(e);
        assertEq(feeds.length, 0, "a donation of one unit does not make a settlement need a report");

        // and a real excess (above the dust threshold) still does
        _donate(h, true, vault.DUST_TOKENS() + 1);
        (feeds,) = vault.settlementPlan(e);
        assertEq(feeds.length, 1);
    }

    // ------------------------------------------------------------------ F9-03 no choice between mark and outcome

    function test_redeemResolved_isDeferredWhileAnEpochSettlementIsPending() public {
        vm.prank(vKeeper);
        vault.splitForInventory(m, 100 * U);
        _donate(m, true, 10 * U);
        // the round ends and resolves (UP wins)
        vm.warp(T0 + 900 + 1);
        streamsResolver.submit(
            ETH, T0 + 900, _report(ETH_FEED, uint32(T0 + 899), uint32(T0 + 901), 3100e18)
        );
        vm.warp(T0 + 900 + WINDOW + 1);
        m.resolve("");

        // an LP asks to leave; the epoch ends and its settlement is pending
        uint256 e = vault.currentEpoch();
        vm.prank(alice);
        vault.requestRedeem(100 * U);
        _toEpochEnd(e);
        vm.expectRevert(ConvergeVault.SettlementPending.selector);
        vault.redeemResolved(m);

        // once settled, anyone can realise it
        vault.settleEpoch(e, _planMarks(e, 3100e18));
        vault.redeemResolved(m);
        assertEq(vault.marketCount(), 0);
    }

    // ------------------------------------------------------------------ F9-12 resolver ownership

    function test_renounceOwnershipIsDisabledOnTheResolvers() public {
        vm.prank(admin);
        vm.expectRevert(DataStreamsResolver.InvalidConfig.selector);
        streamsResolver.renounceOwnership();
        vm.prank(admin);
        vm.expectRevert(ChainlinkRoundResolver.InvalidConfig.selector);
        roundResolver.renounceOwnership();
        assertEq(streamsResolver.owner(), admin);
    }
}

/// @notice F9-15: the venue's escrow must arrive in full, like every other contract's deposits.
contract VenueFeeOnTransferTest is VaultBase {
    FeeMockERC20 internal fee;

    function _newCollateral() internal override returns (MockERC20) {
        fee = new FeeMockERC20();
        return fee;
    }

    function test_placeOrder_rejectsACollateralThatTakesAFee() public {
        _fund(alice, 1000 * U);
        Market m = _openEth(T0, M15, 3000e18);
        vm.warp(T0 + 300);
        _enableTrading(m, 100 * U);
        fee.setFeeBps(100); // the issuer turns on a 1 % transfer fee
        vm.deal(taker, 1 ether);
        usdc.mint(taker, 100 * U);
        vm.startPrank(taker);
        usdc.approve(address(venue), type(uint256).max);
        vm.expectRevert(ForwardVenue.FeeOnTransfer.selector);
        venue.placeOrder{value: 0.001 ether}(m, ForwardVenue.Kind.BUY_UP, 10 * U, 0.6e18);
        vm.stopPrank();
    }
}
