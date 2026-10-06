// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {Market} from "../../src/Market.sol";
import {ConvergeVault} from "../../src/vault/ConvergeVault.sol";
import {ForwardVenue} from "../../src/vault/ForwardVenue.sol";
import {QuoteMath} from "../../src/vault/QuoteMath.sol";
import {DataStreamsResolver} from "../../src/resolvers/DataStreamsResolver.sol";
import {IVerifierProxy, ReportV3} from "../../src/interfaces/IVerifierProxy.sol";
import {MockStreamsVerifierProxy} from "../mocks/MockStreamsVerifierProxy.sol";

/// @notice Fork tests on a Monad MAINNET fork (docs/phases/PHASE-4-plan.md deviation 1: the
///         ADR-004 venue replaces the Kuru adapter, so the external systems the vault touches are
///         the real USDC token and the real Data Streams VerifierProxy).
///         1. The whole vault lifecycle runs against the real USDC contract (6 dp, Circle's
///            FiatToken: balances, approvals, blacklist checks), with a signed-report stand-in
///            verifier (a live subscription is not available to this project).
///         2. The real VerifierProxy is reached through our code path and rejects forged reports.
///         Skipped unless run with `--rpc-url` pointing at Monad mainnet (chain 143): `make check-4` does.
contract VaultForkTest is Test {
    address internal constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address internal constant REAL_VERIFIER = 0xEd813D895457907399E41D36Ec0bE103E32148c8;
    bytes32 internal constant ETH = keccak256("ETH/USD");
    bytes32 internal constant FEED =
        0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782;
    uint256 internal constant U = 1e6;
    uint256 internal signerKey = 0xA11CE;

    MarketFactory internal factory;
    DataStreamsResolver internal resolver;
    ConvergeVault internal vault;
    ForwardVenue internal venue;
    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    address internal lp = makeAddr("lp");
    address internal taker = makeAddr("taker");
    address internal executor = makeAddr("executor");

    function setUp() public {
        // Run with `--rpc-url <Monad mainnet>`; on the default local chain the suite is skipped.
        if (block.chainid != 143) vm.skip(true);
    }

    function _params() internal pure returns (QuoteMath.Params memory) {
        return QuoteMath.Params({
            minHalfSpread: 0.05e18,
            maxHalfSpread: 0.2e18,
            volSpreadK: 1e18,
            stalenessSec: 4e18,
            inventorySkewMax: 0.1e18,
            inventorySkewK: 2e18,
            noQuoteWindowSec: 30,
            priceMin: 0.02e18,
            priceMax: 0.98e18,
            tick: 0.01e18,
            levels: 2,
            baseRangeTicks: 8e18,
            minRangeTicks: 2e18,
            liquidityNavFraction: 0.12e18,
            minLevelSize: 1,
            perMarketMaxFraction: 0.01e18,
            totalAtRiskMaxFraction: 0.08e18
        });
    }

    function _deploy(IVerifierProxy verifier) internal {
        factory = new MarketFactory(IERC20(USDC), admin);
        resolver = new DataStreamsResolver(admin, verifier, 120, 30 minutes);
        vm.startPrank(admin);
        resolver.configureAsset(ETH, FEED);
        factory.grantRole(factory.CREATOR_ROLE(), admin);
        factory.setAsset(ETH, resolver, "ETH", true);
        vm.stopPrank();
        vault = new ConvergeVault(
            IERC20(USDC),
            factory,
            resolver,
            admin,
            admin,
            keeper,
            admin,
            900,
            10 * U,
            1_000_000 * U,
            _params()
        );
        venue = new ForwardVenue(vault, 2, 4, 0.001 ether);
        vm.startPrank(admin);
        vault.enableAsset(ETH, 0.3e18, 2e18);
        vault.setInitialVenue(address(venue));
        vm.stopPrank();
    }

    function _report(uint64 validFrom, uint64 obs, int192 px) internal view returns (bytes memory) {
        bytes memory data = abi.encode(
            ReportV3(FEED, uint32(validFrom), uint32(obs), 0, 0, uint32(obs + 1 days), px, px, px)
        );
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(keccak256(data));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        bytes32[3] memory ctx;
        return abi.encode(ctx, data, abi.encodePacked(r, s, v));
    }

    /// @dev The real proxy's error for a payload whose config digest it does not know.
    function _verifierNotFound() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(bytes4(keccak256("VerifierNotFound(bytes32)")), bytes32(0));
    }

    function test_fork_realUsdcFacts() public view {
        assertEq(IERC20Metadata(USDC).decimals(), 6);
        assertEq(IERC20Metadata(USDC).symbol(), "USDC");
        assertGt(USDC.code.length, 0);
        assertGt(REAL_VERIFIER.code.length, 0, "no VerifierProxy at the documented address");
    }

    /// @dev deposit -> inventory -> forward-priced fill -> resolve -> redeemResolved -> settle ->
    ///      withdraw, all with the real USDC contract. Same hand numbers as VaultE2E (premium 5.50,
    ///      UP wins, LP ends with 995.499004 USDC).
    function test_fork_lifecycleWithRealUsdc() public {
        _deploy(new MockStreamsVerifierProxy(vm.addr(signerKey)));

        // LP deposits 1,000 real USDC
        deal(USDC, lp, 1000 * U);
        vm.startPrank(lp);
        IERC20(USDC).approve(address(vault), type(uint256).max);
        uint256 e0 = vault.requestDeposit(1000 * U);
        vm.stopPrank();
        vm.warp(vault.epochEnd(e0));
        vault.settleEpoch(e0, new bytes[](0));
        vm.prank(lp);
        vault.claimDeposit(e0, lp);
        uint256 shares = vault.balanceOf(lp);
        assertEq(shares, 1000 * U - 1000);

        // a 15-minute round starting at the next boundary at least 5 minutes away
        // forge-lint: disable-next-line(environment-read-across-mutation)
        uint64 start = uint64((block.timestamp / 900 + 2) * 900);
        vm.prank(admin);
        Market m = Market(factory.createMarket(ETH, 900, start));
        vm.warp(start + 1);
        resolver.submit(ETH, start, _report(start - 1, start + 1, 3000e18));
        vm.warp(start + 121);
        m.open("");

        vm.warp(start + 200);
        vm.startPrank(keeper);
        vault.setSigma(ETH, 0.6e18);
        vault.splitForInventory(m, 100 * U);
        vm.stopPrank();
        vault.checkpoint(new bytes[](0));

        // taker buys 10 UP, limit 0.60 (hand-checked ask 0.55)
        deal(USDC, taker, 7 * U);
        vm.deal(taker, 1 ether);
        vm.startPrank(taker);
        IERC20(USDC).approve(address(venue), type(uint256).max);
        uint256 id =
            venue.placeOrder{value: 0.001 ether}(m, ForwardVenue.Kind.BUY_UP, 10 * U, 0.6e18);
        vm.stopPrank();
        uint64 at = uint64(block.timestamp + 2);
        vm.warp(at);
        vm.prank(executor);
        (uint256 filled, uint256 premium) = venue.executeOrder(id, _report(at - 1, at + 1, 3000e18));
        assertEq(filled, 10 * U);
        assertEq(premium, 5_500_000);
        assertEq(IERC20(USDC).balanceOf(address(vault)), 905_500_000);

        // resolve UP
        vm.warp(start + 900 + 1);
        resolver.submit(ETH, start + 900, _report(start + 899, start + 901, 3100e18));
        vm.warp(start + 900 + 121);
        m.resolve("");
        vault.redeemResolved(m);
        assertEq(IERC20(USDC).balanceOf(address(vault)), 995_500_000);

        vm.prank(lp);
        uint256 e1 = vault.requestRedeem(shares);
        vm.warp(vault.epochEnd(e1));
        vault.settleEpoch(e1, new bytes[](0));
        vm.prank(lp);
        vault.claimRedeem(e1, lp);
        assertEq(IERC20(USDC).balanceOf(lp), 995_499_004);
    }

    /// @dev The real VerifierProxy sits behind our code path: a forged report must be rejected by
    ///      it (not accepted, and not silently ignored).
    function test_fork_realVerifierRejectsForgedReports() public {
        _deploy(IVerifierProxy(REAL_VERIFIER));
        bytes memory forged = _report(1, 2, 3000e18);
        // direct: the real proxy refuses a payload that was not signed by the DON
        vm.expectRevert(_verifierNotFound());
        IVerifierProxy(REAL_VERIFIER).verify(forged, "");
        // through the resolver the market lifecycle depends on
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(_verifierNotFound());
        resolver.submit(ETH, uint64(block.timestamp - 10), forged);
        // through the vault's mark path
        deal(USDC, lp, 100 * U);
        vm.startPrank(lp);
        IERC20(USDC).approve(address(vault), type(uint256).max);
        uint256 e = vault.requestDeposit(100 * U);
        vm.stopPrank();
        vm.warp(vault.epochEnd(e));
        vault.settleEpoch(e, new bytes[](0)); // shares exist now, so checkpoint verifies reports
        bytes[] memory rs = new bytes[](1);
        rs[0] = forged;
        vm.expectRevert(_verifierNotFound());
        vault.checkpoint(rs);
    }
}
