// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../src/MarketFactory.sol";
import {ChainlinkRoundResolver} from "../src/resolvers/ChainlinkRoundResolver.sol";
import {DataStreamsResolver} from "../src/resolvers/DataStreamsResolver.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {IVerifierProxy} from "../src/interfaces/IVerifierProxy.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";
import {MockStreamsVerifierProxy} from "../test/mocks/MockStreamsVerifierProxy.sol";
import {SchedulerReceiver} from "../src/scheduler/SchedulerReceiver.sol";
import {SchedulerLens} from "../src/scheduler/SchedulerLens.sol";

/// @notice Phase 1 TESTNET deployment. Writes deployments/<network>.json.
/// @dev Testnet-only choices (never for mainnet, see docs/security/phase-1-notes.md):
///      - collateral is an open-mint 6-dp test token (tUSDC) so the lifecycle can split;
///      - the Data Streams resolver uses MockStreamsVerifierProxy (Monad testnet has no live
///        verifier): whoever holds STREAMS_TEST_SIGNER_KEY controls "TEST" prices;
///      - deployer holds every role.
///      BTC uses the real Chainlink BTC/USD testnet proxy through ChainlinkRoundResolver (testnet
///      heartbeat is 24h, so most BTC rounds will end INVALID; that path is shown honestly).
///
///      Env: DEPLOYER_PRIVATE_KEY, STREAMS_TEST_SIGNER (address), NETWORK_NAME (default
///      "testnet"), FINALIZATION_WINDOW (default 30), BTC_FEED (default testnet BTC/USD proxy).
contract Deploy is Script {
    bytes32 internal constant BTC = keccak256("BTC/USD");
    bytes32 internal constant TEST = keccak256("TEST/USD");
    /// @dev Arbitrary v3-prefixed feed id for the test stream (not a real Chainlink stream).
    bytes32 internal constant TEST_FEED =
        0x0003000000000000000000000000000000000000000000000000000000000001;
    /// @dev Chainlink BTC/USD proxy on Monad testnet (docs/EXTERNAL.md).
    address internal constant TESTNET_BTC_FEED = 0x12C0F44368a02081ce58a936d1C1F606BB301715;
    /// @dev CRE MockKeystoneForwarder on Monad testnet (simulation; docs/EXTERNAL.md). Production
    ///      testnet forwarder: 0xF8344CFd5c43616a4366C34E3EEE75af79a74482 (set CRE_FORWARDER).
    address internal constant TESTNET_CRE_MOCK_FORWARDER =
        0xB9F79d863261869B234c481D1f9A7af84AeAd192;

    error NotATestNetwork(uint256 chainId);

    /// @dev Addresses written to deployments/<network>.json (struct avoids stack-too-deep).
    struct Out {
        address deployer;
        address tusdc;
        MarketFactory factory;
        address roundResolver;
        address btcFeed;
        address verifier;
        address streamsSigner;
        address streams;
        address receiver;
        address creForwarder;
        address lens;
        uint64 window;
    }

    function run() external {
        // Testnet-only deployment: open-mint collateral + mock verifier must never reach mainnet.
        if (block.chainid != 10_143 && block.chainid != 31_337) {
            revert NotATestNetwork(block.chainid);
        }
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        Out memory o;
        o.deployer = vm.addr(pk);
        o.streamsSigner = vm.envAddress("STREAMS_TEST_SIGNER");
        o.window = uint64(vm.envOr("FINALIZATION_WINDOW", uint256(20)));
        o.creForwarder = vm.envOr("CRE_FORWARDER", TESTNET_CRE_MOCK_FORWARDER);
        o.btcFeed = vm.envOr("BTC_FEED", TESTNET_BTC_FEED);

        vm.startBroadcast(pk);
        _deployCore(o);
        _deployScheduler(o, vm.envOr("CRE_WORKFLOW_OWNER", o.deployer));
        vm.stopBroadcast();
        _write(o, vm.envOr("NETWORK_NAME", string("testnet")));
    }

    function _deployCore(Out memory o) internal {
        o.tusdc = address(new MockERC20("Converge Test USD", "tUSDC", 6));
        o.factory = new MarketFactory(IERC20(o.tusdc), o.deployer);
        ChainlinkRoundResolver roundResolver = new ChainlinkRoundResolver(o.deployer, 1 days);
        roundResolver.configureAsset(BTC, IAggregatorV3(o.btcFeed), 120);
        o.roundResolver = address(roundResolver);
        o.verifier = address(new MockStreamsVerifierProxy(o.streamsSigner));
        DataStreamsResolver streams =
            new DataStreamsResolver(o.deployer, IVerifierProxy(o.verifier), o.window, 30 minutes);
        streams.configureAsset(TEST, TEST_FEED);
        o.streams = address(streams);
        o.factory.grantRole(o.factory.CREATOR_ROLE(), o.deployer);
        o.factory.grantRole(o.factory.GUARDIAN_ROLE(), o.deployer);
        o.factory.setAsset(BTC, roundResolver, "BTC", true);
        o.factory.setAsset(TEST, streams, "TEST", true);
    }

    function _deployScheduler(Out memory o, address workflowOwner) internal {
        SchedulerReceiver receiver = new SchedulerReceiver(o.creForwarder, o.factory, o.deployer);
        receiver.setWorkflow(workflowOwner, bytes32(0));
        o.factory.grantRole(o.factory.CREATOR_ROLE(), address(receiver));
        o.receiver = address(receiver);
        o.lens = address(new SchedulerLens());
    }

    function _write(Out memory o, string memory network) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", block.number);
        vm.serializeAddress(k, "deployer", o.deployer);
        vm.serializeAddress(k, "collateral_tUSDC", o.tusdc);
        vm.serializeAddress(k, "marketFactory", address(o.factory));
        vm.serializeAddress(k, "marketImplementation", o.factory.marketImplementation());
        vm.serializeAddress(k, "outcomeTokenImplementation", o.factory.tokenImplementation());
        vm.serializeAddress(k, "chainlinkRoundResolver", o.roundResolver);
        vm.serializeAddress(k, "btcFeed", o.btcFeed);
        vm.serializeAddress(k, "mockStreamsVerifierProxy_TESTONLY", o.verifier);
        vm.serializeAddress(k, "streamsTestSigner", o.streamsSigner);
        vm.serializeAddress(k, "dataStreamsResolver", o.streams);
        vm.serializeAddress(k, "schedulerReceiver", o.receiver);
        vm.serializeAddress(k, "creForwarder", o.creForwarder);
        vm.serializeAddress(k, "schedulerLens", o.lens);
        vm.serializeBytes32(k, "assetBTC", BTC);
        vm.serializeBytes32(k, "assetTEST", TEST);
        vm.serializeBytes32(k, "testFeedId", TEST_FEED);
        string memory json = vm.serializeUint(k, "finalizationWindow", o.window);
        string memory path = string.concat(vm.projectRoot(), "/../deployments/", network, ".json");
        vm.writeJson(json, path);
        console2.log("wrote", path);
    }
}
