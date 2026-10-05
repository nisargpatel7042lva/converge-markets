// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {Market} from "../src/Market.sol";
import {ConvergeVault} from "../src/vault/ConvergeVault.sol";
import {ForwardVenue} from "../src/vault/ForwardVenue.sol";
import {QuoteMath} from "../src/vault/QuoteMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReportV3} from "../src/interfaces/IVerifierProxy.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice Shared fixtures for the vault, venue and malicious-keeper tests: a vault over the Base
///         factory (ETH is the Data Streams asset), launch parameters from config/strategy.default.json.
abstract contract VaultBase is Base {
    uint256 internal constant U = 1e6; // one USDC
    uint64 internal constant EPOCH = 900;
    uint32 internal constant DELAY = 2;
    uint32 internal constant LATE = 30;
    uint256 internal constant SPOT = 3000e18;

    address internal vOwner = makeAddr("vOwner");
    address internal vGuardian = makeAddr("vGuardian");
    address internal vKeeper = makeAddr("vKeeper");
    address internal vTreasury = makeAddr("vTreasury");
    address internal executor = makeAddr("executor");
    address internal taker = makeAddr("taker");

    ConvergeVault internal vault;
    ForwardVenue internal venue;

    function _launchParams() internal pure returns (QuoteMath.Params memory p) {
        p = QuoteMath.Params({
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

    function setUp() public virtual override {
        super.setUp();
        vault = new ConvergeVault(
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
        venue = new ForwardVenue(vault, DELAY, LATE, 0.001 ether);
        vm.startPrank(vOwner);
        vault.enableAsset(ETH, 0.3e18, 2e18);
        vault.setInitialVenue(address(venue));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ LP flows

    function _requestDeposit(address who, uint256 amount) internal returns (uint256 epochId) {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(vault), amount);
        epochId = vault.requestDeposit(amount);
        vm.stopPrank();
    }

    function _toEpochEnd(uint256 epochId) internal {
        vm.warp(vault.epochEnd(epochId));
    }

    function _noReports() internal pure returns (bytes[] memory r) {
        r = new bytes[](0);
    }

    /// @dev Deposit, wait for the epoch to end, settle, claim.
    function _fund(address who, uint256 amount) internal {
        uint256 e = _requestDeposit(who, amount);
        _toEpochEnd(e);
        vault.settleEpoch(e, _noReports());
        vm.prank(who);
        vault.claimDeposit(e, who);
    }

    // ------------------------------------------------------------------ markets and marks

    /// @dev Creates an ETH market for [start, start + duration), advances to start + finalization
    ///      window and opens it at strike `px`.
    function _openEth(uint64 start, uint64 duration, int192 px) internal returns (Market m) {
        m = _create(ETH, duration, start);
        vm.warp(start + 1);
        streamsResolver.submit(
            ETH, start, _report(ETH_FEED, uint32(start - 1), uint32(start + 1), px)
        );
        vm.warp(start + WINDOW + 1);
        m.open("");
    }

    /// @dev A report whose window contains `obs` (validFrom = obs - 1).
    function _rep(uint32 obs, int192 px) internal view returns (bytes memory) {
        return _report(ETH_FEED, obs - 1, obs, px);
    }

    /// @dev A report with a custom window and expiry.
    function _repWindow(uint64 validFrom, uint64 obs, int192 px, uint64 expiresAt)
        internal
        view
        returns (bytes memory payload)
    {
        bytes memory reportData = abi.encode(
            ReportV3({
                feedId: ETH_FEED,
                validFromTimestamp: uint32(validFrom),
                observationsTimestamp: uint32(obs),
                nativeFee: 0,
                linkFee: 0,
                expiresAt: uint32(expiresAt),
                price: px,
                bid: px,
                ask: px
            })
        );
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(keccak256(reportData));
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(signerKey, digest);
        bytes32[3] memory ctx;
        payload = abi.encode(ctx, reportData, abi.encodePacked(r, sg, v));
    }

    /// @dev The canonical report for time `at` (its window contains `at`), as a one-element array.
    function _markAt(uint256 at, int192 px) internal view returns (bytes[] memory r) {
        r = new bytes[](1);
        r[0] = _rep(uint32(at), px);
    }

    /// @dev What settling epoch `epochId` needs: the canonical mark if any asset needs one.
    function _planMarks(uint256 epochId, int192 px) internal view returns (bytes[] memory) {
        (bytes32[] memory feeds,) = vault.settlementPlan(epochId);
        return feeds.length == 0 ? _noReports() : _markAt(vault.epochEnd(epochId), px);
    }

    function _markNow(int192 px) internal view returns (bytes[] memory r) {
        r = new bytes[](1);
        r[0] = _rep(uint32(block.timestamp), px);
    }

    function _setSigma(uint256 s) internal {
        vm.prank(vKeeper);
        vault.setSigma(ETH, s);
    }

    function _enableTrading(Market m, uint256 splitAmount) internal {
        _setSigma(0.6e18);
        vm.prank(vKeeper);
        vault.splitForInventory(m, splitAmount);
    }

    function _placeAs(address who, Market m, ForwardVenue.Kind k, uint256 shares, uint256 limit)
        internal
        returns (uint256 id)
    {
        vm.deal(who, 1 ether);
        if (k == ForwardVenue.Kind.BUY_UP || k == ForwardVenue.Kind.BUY_DOWN) {
            usdc.mint(who, (shares * limit + 1e18 - 1) / 1e18 + 4); // exactly the escrow
            vm.prank(who);
            usdc.approve(address(venue), type(uint256).max);
        } else {
            _split(m, who, shares);
            IERC20 t = (k == ForwardVenue.Kind.SELL_UP)
                ? IERC20(address(m.up()))
                : IERC20(address(m.down()));
            vm.prank(who);
            t.approve(address(venue), type(uint256).max);
        }
        vm.prank(who);
        id = venue.placeOrder{value: 0.001 ether}(m, k, shares, limit);
    }
}
