// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {Market} from "../../src/Market.sol";
import {ConvergeVault} from "../../src/vault/ConvergeVault.sol";
import {ForwardVenue} from "../../src/vault/ForwardVenue.sol";
import {QuoteMath} from "../../src/vault/QuoteMath.sol";
import {DataStreamsResolver} from "../../src/resolvers/DataStreamsResolver.sol";
import {ChainlinkRoundResolver} from "../../src/resolvers/ChainlinkRoundResolver.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {ReportV3} from "../../src/interfaces/IVerifierProxy.sol";
import {PartnerRegistry} from "../../src/partners/PartnerRegistry.sol";
import {IPartnerRegistry} from "../../src/partners/IPartnerRegistry.sol";
import {FeeSink} from "../../src/partners/FeeSink.sol";
import {MockStreamsVerifierProxy} from "../mocks/MockStreamsVerifierProxy.sol";

interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;

    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool success);

    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function VERSION() external view returns (string memory);
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface IFiatToken {
    function blacklister() external view returns (address);
    function blacklist(address account) external;
    function isBlacklisted(address account) external view returns (bool);
}

/// @notice The whole system on a Monad MAINNET fork, against the real external contracts of
///         docs/EXTERNAL.md: the real USDC (Circle's FiatToken, with its blacklist), the real
///         Chainlink BTC, ETH and MON push feeds, the real Safe v1.4.1 singleton and proxy factory,
///         and the real Data Streams VerifierProxy. There is no Kuru adapter in this repository
///         (ADR-004/005), so there are no Kuru addresses to test against.
///         The Data Streams reports are the one thing a fork cannot provide: signing needs the DON,
///         and the project has no Chainlink account yet, so a signing stand-in is used for them
///         (the real proxy is exercised for rejection in VaultFork.t.sol).
///         Skipped unless run with `--rpc-url` pointing at Monad mainnet (chain 143): `make check-9` does.
contract MainnetSystemForkTest is Test {
    address internal constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address internal constant BTC_USD = 0xc1d4C3331635184fA4C3c22fb92211B2Ac9E0546;
    address internal constant ETH_USD = 0x1B1414782B859871781bA3E4B0979b9ca57A0A04;
    address internal constant MON_USD = 0xBcD78f76005B7515837af6b50c7C52BCf73822fb;
    address internal constant SAFE_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant SAFE_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    bytes32 internal constant ETH = keccak256("ETH/USD");
    bytes32 internal constant ETH_FEED =
        0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782;
    uint256 internal constant U = 1e6;
    uint256 internal signerKey = 0xA11CE;

    address internal deployer = makeAddr("deployer");
    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");
    address internal treasury = makeAddr("treasury");
    address internal lp = makeAddr("lp");
    address internal taker = makeAddr("taker");
    address internal partner = makeAddr("partner");
    address internal signer1 = makeAddr("safeSigner1");

    MarketFactory internal factory;
    DataStreamsResolver internal streams;
    ConvergeVault internal vault;
    ForwardVenue internal venue;
    PartnerRegistry internal registry;

    function setUp() public {
        if (block.chainid != 143) vm.skip(true);
    }

    // ------------------------------------------------------------------ the real feeds

    function _checkFeed(address proxy, string memory description, uint256 maxAge) internal view {
        IAggregatorV3 f = IAggregatorV3(proxy);
        assertGt(proxy.code.length, 0, "no code at the documented feed address");
        assertEq(f.decimals(), 8, "decimals");
        (uint80 id, int256 answer,, uint256 updatedAt,) = f.latestRoundData();
        assertGt(answer, 0, "answer");
        assertLe(block.timestamp - updatedAt, maxAge, "the feed is stale on the fork");
        assertGt(uint64(id), 1, "no previous round in the phase");
        assertEq(
            keccak256(bytes(_description(proxy))), keccak256(bytes(description)), "description"
        );
    }

    function _description(address proxy) internal view returns (string memory) {
        (bool ok, bytes memory ret) = proxy.staticcall(abi.encodeWithSignature("description()"));
        require(ok, "description()");
        return abi.decode(ret, (string));
    }

    /// @dev The addresses in docs/EXTERNAL.md are what they claim to be, right now.
    function test_fork_realChainlinkFeedsAreWhatTheDocsSay() public view {
        _checkFeed(BTC_USD, "BTC / USD", 2 hours);
        _checkFeed(ETH_USD, "ETH / USD", 2 hours);
        _checkFeed(MON_USD, "MON / USD", 2 hours);
    }

    /// @dev Round proofs against the REAL feeds: pick a boundary a little in the past, find the
    ///      first round at or after it by walking back from the latest round, prove it, and read
    ///      the price. Covers the feed ABI, the phase check, and the decimals.
    function test_fork_roundProofsOnRealFeeds() public {
        address[3] memory feeds = [BTC_USD, ETH_USD, MON_USD];
        bytes32[3] memory ids = [keccak256("BTC/USD"), keccak256("ETH/USD"), keccak256("MON/USD")];
        ChainlinkRoundResolver r = new ChainlinkRoundResolver(address(this), 1 days);
        for (uint256 i = 0; i < 3; i++) {
            r.configureAsset(ids[i], IAggregatorV3(feeds[i]), 2 hours);
            (uint80 latest,,, uint256 latestAt,) = IAggregatorV3(feeds[i]).latestRoundData();
            // a boundary 20 minutes before the latest update, so the round after it exists
            // forge-lint: disable-next-line(unsafe-typecast)
            uint64 t = uint64(latestAt - 20 minutes);
            uint80 first = latest;
            for (uint256 k = 0; k < 400; k++) {
                if (uint64(first) <= 2) break;
                (,,, uint256 prevAt,) = IAggregatorV3(feeds[i]).getRoundData(first - 1);
                if (prevAt < t) break;
                first -= 1;
            }
            (,,, uint256 firstAt,) = IAggregatorV3(feeds[i]).getRoundData(first);
            if (firstAt < t) continue; // the feed was silent for a long time around t
            r.submit(ids[i], t, abi.encode(first));
            (IChainlinkStatus s, int256 price) = _status(r, ids[i], t);
            assertTrue(s == IChainlinkStatus.FINAL || s == IChainlinkStatus.UNRESOLVABLE);
            if (s == IChainlinkStatus.FINAL) assertGt(price, 0);
            // a second proof for the same boundary is a no-op, never a different price
            r.submit(ids[i], t, abi.encode(first));
        }
    }

    // typed access to the resolver's status enum without importing the interface twice
    enum IChainlinkStatus {
        PENDING,
        FINAL,
        UNRESOLVABLE
    }

    function _status(ChainlinkRoundResolver r, bytes32 id, uint64 t)
        internal
        view
        returns (IChainlinkStatus, int256)
    {
        (ChainlinkRoundResolver.Status s, int256 p) = _price(r, id, t);
        return (IChainlinkStatus(uint8(s)), p);
    }

    function _price(ChainlinkRoundResolver r, bytes32 id, uint64 t)
        internal
        view
        returns (ChainlinkRoundResolver.Status, int256)
    {
        return r.priceAt(id, t);
    }

    // ------------------------------------------------------------------ the system

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

    function _deploySystem() internal {
        vm.startPrank(deployer);
        factory = new MarketFactory(IERC20(USDC), deployer);
        streams = new DataStreamsResolver(
            deployer, new MockStreamsVerifierProxy(vm.addr(signerKey)), 20, 30 minutes
        );
        streams.configureAsset(ETH, ETH_FEED);
        factory.grantRole(factory.CREATOR_ROLE(), deployer);
        factory.setAsset(ETH, streams, "ETH", true);
        vault = new ConvergeVault(
            IERC20(USDC),
            factory,
            streams,
            deployer,
            guardian,
            keeper,
            treasury,
            900,
            10 * U,
            5_000 * U,
            _params()
        );
        venue = new ForwardVenue(vault, 2, 4, 0.001 ether);
        vault.enableAsset(ETH, 0.4e18, 1.2e18);
        vault.setInitialVenue(address(venue));
        registry = new PartnerRegistry(factory, deployer, guardian, treasury);
        vault.setPartnerRegistry(IPartnerRegistry(address(registry)));
        registry.setVault(address(vault));
        registry.setConfig(10 * U, 500 * U, 50, treasury, address(vault));
        registry.setFeed(ETH, true);
        bytes32[] memory feeds = new bytes32[](1);
        feeds[0] = ETH;
        registry.approvePartner(partner, 40 * U, 3000, feeds);
        vm.stopPrank();
    }

    function _report(uint64 validFrom, uint64 obs, int192 px) internal view returns (bytes memory) {
        bytes memory data = abi.encode(
            ReportV3(
                ETH_FEED, uint32(validFrom), uint32(obs), 0, 0, uint32(obs + 1 days), px, px, px
            )
        );
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(keccak256(data));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        bytes32[3] memory ctx;
        return abi.encode(ctx, data, abi.encodePacked(r, s, v));
    }

    /// @dev A partner market, a taker and the vault on real USDC, resolved, with fees: the money
    ///      moves exactly as in the unit tests, through Circle's contract.
    function test_fork_partnerLifecycleOnRealUsdc() public {
        _deploySystem();
        deal(USDC, lp, 1000 * U);
        vm.startPrank(lp);
        IERC20(USDC).approve(address(vault), type(uint256).max);
        uint256 e0 = vault.requestDeposit(1000 * U);
        vm.stopPrank();
        vm.warp(vault.epochEnd(e0));
        vault.settleEpoch(e0, new bytes[](0));
        vm.prank(lp);
        vault.claimDeposit(e0, lp);

        deal(USDC, partner, 10 * U);
        vm.startPrank(partner);
        IERC20(USDC).approve(address(registry), type(uint256).max);
        registry.postBond(10 * U);
        Market m = Market(
            registry.createThresholdMarket(ETH, 3000e18, uint64(block.timestamp + 20 minutes))
        );
        vm.stopPrank();
        assertEq(uint8(m.state()), uint8(Market.State.OPEN));

        vm.startPrank(keeper);
        vault.setSigma(ETH, 0.6e18);
        vault.splitForInventory(m, 13 * U);
        vm.stopPrank();
        vault.checkpoint(new bytes[](0));

        deal(USDC, taker, 7 * U + 4);
        vm.deal(taker, 1 ether);
        vm.startPrank(taker);
        IERC20(USDC).approve(address(venue), type(uint256).max);
        uint256 id =
            venue.placeOrder{value: 0.001 ether}(m, ForwardVenue.Kind.BUY_UP, 10 * U, 0.7e18);
        vm.stopPrank();
        uint64 at = uint64(vm.getBlockTimestamp() + 2);
        vm.warp(at);
        vm.prank(makeAddr("executor")); // an account that can receive the reward
        (uint256 filled,) = venue.executeOrder(id, _report(at - 1, at + 1, 3000e18));
        assertGt(filled, 0);

        // end: UP wins, the taker redeems with the 0.5 % fee going to the market's own sink
        uint64 end = m.endTime();
        vm.warp(end + 1);
        streams.submit(ETH, end, _report(end - 1, end + 1, 3100e18));
        vm.warp(end + 21);
        m.resolve("");
        vm.prank(taker);
        m.redeem();
        uint256 fee = filled * 50 / 10_000;
        assertEq(
            IERC20(USDC).balanceOf(registry.feeSinkOf(address(m))),
            0,
            "the fee is accrued, not yet claimed"
        );
        assertEq(m.feesAccrued(), fee);
        vm.prank(makeAddr("anyone"));
        m.claimFees(); // a stranger claims it: it still lands in this market's sink
        assertEq(IERC20(USDC).balanceOf(registry.feeSinkOf(address(m))), fee);
        registry.collectFees(m);
        assertEq(registry.feesOwed(partner), fee * 3000 / 10_000);
        vault.redeemResolved(m);
        assertEq(IERC20(USDC).balanceOf(address(registry)), registry.liabilities());
    }

    /// @dev Circle can blacklist any address. A blacklisted treasury or partner must not be able to
    ///      stop anyone else from getting paid (fees are pulled, not pushed).
    function test_fork_aBlacklistedTreasuryCannotBlockPartnersOrUsers() public {
        _deploySystem();
        address blacklister = IFiatToken(USDC).blacklister();
        deal(USDC, partner, 10 * U);
        vm.startPrank(partner);
        IERC20(USDC).approve(address(registry), type(uint256).max);
        registry.postBond(10 * U);
        Market m = Market(
            registry.createThresholdMarket(ETH, 3000e18, uint64(block.timestamp + 20 minutes))
        );
        IERC20(USDC).approve(address(m), type(uint256).max);
        vm.stopPrank();
        deal(USDC, taker, 1000 * U);
        vm.startPrank(taker);
        IERC20(USDC).approve(address(m), type(uint256).max);
        m.split(1000 * U);
        vm.stopPrank();
        uint64 end = m.endTime();
        vm.warp(end + 1);
        streams.submit(ETH, end, _report(end - 1, end + 1, 3100e18));
        vm.warp(end + 21);
        m.resolve("");
        vm.prank(taker);
        m.redeem();

        vm.prank(blacklister);
        IFiatToken(USDC).blacklist(treasury);
        assertTrue(IFiatToken(USDC).isBlacklisted(treasury));

        registry.collectFees(m); // credits both sides; moves nothing to the treasury
        assertGt(registry.feesOwed(partner), 0);
        vm.prank(partner);
        registry.withdrawFees(partner); // the partner is paid
        assertGt(IERC20(USDC).balanceOf(partner), 0);
        vm.prank(treasury);
        vm.expectRevert(); // the treasury's own withdrawal fails, and only its own
        registry.withdrawFees(treasury);
    }

    // ------------------------------------------------------------------ the real Safe

    function _newSafe() internal returns (ISafe safe) {
        address[] memory owners = new address[](1);
        owners[0] = signer1;
        bytes memory init = abi.encodeCall(
            ISafe.setup, (owners, 1, address(0), "", address(0), address(0), 0, payable(address(0)))
        );
        safe = ISafe(ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(SAFE_L2, init, 1));
    }

    function _safeExec(ISafe safe, address to, bytes memory data) internal {
        // an "approved hash" signature: the owner sends the transaction itself (v = 1)
        bytes memory sig =
            abi.encodePacked(bytes32(uint256(uint160(signer1))), bytes32(0), uint8(1));
        vm.prank(signer1);
        bool ok =
            safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sig);
        assertTrue(ok, "the Safe transaction failed");
    }

    /// @dev The mainnet handover, on the real Safe contracts: the deployer proposes, the Safe
    ///      accepts, and from then on only the Safe can administer the system. This is the exact
    ///      sequence docs/ops/launch-checklist.md has the signers execute.
    function test_fork_theRealSafeTakesOverTheWholeSystem() public {
        ISafe safe = _newSafe();
        assertEq(safe.getThreshold(), 1);
        assertEq(safe.getOwners()[0], signer1);
        _deploySystem();

        vm.startPrank(deployer);
        vault.transferOwnership(address(safe));
        streams.transferOwnership(address(safe));
        registry.transferOwnership(address(safe));
        factory.grantRole(factory.DEFAULT_ADMIN_ROLE(), address(safe));
        vm.stopPrank();
        // pending until the Safe accepts: the deployer is still the owner
        assertEq(vault.owner(), deployer);
        assertEq(vault.pendingOwner(), address(safe));

        _safeExec(safe, address(vault), abi.encodeCall(Ownable2Step.acceptOwnership, ()));
        _safeExec(safe, address(streams), abi.encodeCall(Ownable2Step.acceptOwnership, ()));
        _safeExec(safe, address(registry), abi.encodeCall(Ownable2Step.acceptOwnership, ()));
        assertEq(vault.owner(), address(safe));
        assertEq(streams.owner(), address(safe));
        assertEq(registry.owner(), address(safe));

        // the deployer gives up the factory admin role (the Safe holds it)
        bytes32 admin = factory.DEFAULT_ADMIN_ROLE();
        vm.startPrank(deployer);
        factory.renounceRole(admin, deployer);
        factory.renounceRole(factory.CREATOR_ROLE(), deployer);
        vm.stopPrank();
        assertFalse(factory.hasRole(admin, deployer));
        assertTrue(factory.hasRole(admin, address(safe)));

        // the deployer can no longer administer anything
        vm.startPrank(deployer);
        vm.expectRevert();
        vault.setTvlCap(1);
        vm.expectRevert();
        registry.setConfig(0, 0, 0, treasury, treasury);
        vm.expectRevert();
        factory.setRedeemFee(10);
        vm.stopPrank();

        // the Safe can, including the emergency levers
        _safeExec(safe, address(vault), abi.encodeCall(ConvergeVault.setTvlCap, (2_500 * U)));
        assertEq(vault.tvlCap(), 2_500 * U);
        _safeExec(safe, address(vault), abi.encodeCall(ConvergeVault.pauseQuoting, ()));
        assertTrue(vault.quotingPaused());
        _safeExec(safe, address(vault), abi.encodeCall(ConvergeVault.resumeQuoting, ()));
        assertFalse(vault.quotingPaused());
        // the guardian can pause but never resume
        vm.prank(guardian);
        vault.pauseQuoting();
        vm.prank(guardian);
        vm.expectRevert();
        vault.resumeQuoting();
    }
}
