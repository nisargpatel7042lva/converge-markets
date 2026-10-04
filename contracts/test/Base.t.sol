// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../src/MarketFactory.sol";
import {Market} from "../src/Market.sol";
import {OutcomeToken} from "../src/OutcomeToken.sol";
import {IPriceResolver} from "../src/interfaces/IPriceResolver.sol";
import {ReportV3} from "../src/interfaces/IVerifierProxy.sol";
import {ChainlinkRoundResolver} from "../src/resolvers/ChainlinkRoundResolver.sol";
import {DataStreamsResolver} from "../src/resolvers/DataStreamsResolver.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockStreamsVerifierProxy} from "./mocks/MockStreamsVerifierProxy.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice Shared fixtures: USDC-like collateral, factory, both resolvers, one asset each.
abstract contract Base is Test {
    bytes32 internal constant BTC = keccak256("BTC/USD");
    bytes32 internal constant ETH = keccak256("ETH/USD");
    /// @dev v3 feed ids start with 0x0003 (schema version prefix).
    bytes32 internal constant ETH_FEED =
        0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782;
    uint64 internal constant MAX_DELAY = 120;
    uint64 internal constant LIVENESS = 1 days;
    uint64 internal constant WINDOW = 2 minutes;
    uint64 internal constant GRACE = 30 minutes;
    uint64 internal constant M15 = 15 minutes;
    uint64 internal constant H1 = 1 hours;
    /// @dev 2026-10-01 14:15:00 UTC
    uint64 internal constant T0 = 1_790_864_100;

    address internal admin = makeAddr("admin");
    address internal creator = makeAddr("creator");
    address internal guardian = makeAddr("guardian");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    uint256 internal signerKey = 0xA11CE;
    address internal signer;

    MockERC20 internal usdc;
    MarketFactory internal factory;
    MockAggregator internal feed;
    ChainlinkRoundResolver internal roundResolver;
    MockStreamsVerifierProxy internal verifierProxy;
    DataStreamsResolver internal streamsResolver;

    function setUp() public virtual {
        vm.warp(T0 - 1 hours);
        signer = vm.addr(signerKey);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        factory = new MarketFactory(IERC20(address(usdc)), admin);
        feed = new MockAggregator(8);
        roundResolver = new ChainlinkRoundResolver(admin, LIVENESS);
        verifierProxy = new MockStreamsVerifierProxy(signer);
        streamsResolver = new DataStreamsResolver(admin, verifierProxy, WINDOW, GRACE);

        vm.startPrank(admin);
        roundResolver.configureAsset(BTC, feed, uint32(MAX_DELAY));
        streamsResolver.configureAsset(ETH, ETH_FEED);
        factory.grantRole(factory.CREATOR_ROLE(), creator);
        factory.grantRole(factory.GUARDIAN_ROLE(), guardian);
        factory.setAsset(BTC, roundResolver, "BTC", true);
        factory.setAsset(ETH, streamsResolver, "ETH", true);
        vm.stopPrank();
        // A round before T0 so first-round proofs have a same-phase predecessor.
        feed.setRound(1, 1, 60_000e8, T0 - 30 minutes);
    }

    // ------------------------------------------------------------------ helpers

    function _create(bytes32 assetId, uint64 duration, uint64 start) internal returns (Market m) {
        vm.prank(creator);
        m = Market(factory.createMarket(assetId, duration, start));
    }

    function _split(Market m, address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(m), amount);
        m.split(amount);
        vm.stopPrank();
    }

    /// @dev Adds a round at `updatedAt` and returns its encoded proof.
    function _round(uint64 aggRound, int256 answer, uint256 updatedAt)
        internal
        returns (bytes memory)
    {
        return abi.encode(feed.setRound(1, aggRound, answer, updatedAt));
    }

    function _report(bytes32 feedId, uint32 validFrom, uint32 obs, int192 price)
        internal
        view
        returns (bytes memory payload)
    {
        return _reportWithBid(feedId, validFrom, obs, price, price);
    }

    /// @dev `bid` lets tests produce different report bytes for the same window/price.
    function _reportWithBid(bytes32 feedId, uint32 validFrom, uint32 obs, int192 price, int192 bid)
        internal
        view
        returns (bytes memory payload)
    {
        bytes memory reportData = abi.encode(
            ReportV3({
                feedId: feedId,
                validFromTimestamp: validFrom,
                observationsTimestamp: obs,
                nativeFee: 0,
                linkFee: 0,
                expiresAt: obs + 1 days,
                price: price,
                bid: bid,
                ask: price
            })
        );
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(keccak256(reportData));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        bytes32[3] memory ctx;
        payload = abi.encode(ctx, reportData, abi.encodePacked(r, s, v));
    }

    function _status(IPriceResolver res, bytes32 a, uint64 t)
        internal
        view
        returns (IPriceResolver.Status s)
    {
        (s,) = res.priceAt(a, t);
    }
}
