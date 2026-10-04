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

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address streamsSigner = vm.envAddress("STREAMS_TEST_SIGNER");
        string memory network = vm.envOr("NETWORK_NAME", string("testnet"));
        uint64 window = uint64(vm.envOr("FINALIZATION_WINDOW", uint256(30)));
        address btcFeed = vm.envOr("BTC_FEED", TESTNET_BTC_FEED);

        vm.startBroadcast(pk);
        MockERC20 tusdc = new MockERC20("Converge Test USD", "tUSDC", 6);
        MarketFactory factory = new MarketFactory(IERC20(address(tusdc)), deployer);
        ChainlinkRoundResolver roundResolver = new ChainlinkRoundResolver(deployer, 1 days);
        roundResolver.configureAsset(BTC, IAggregatorV3(btcFeed), 120);
        MockStreamsVerifierProxy verifier = new MockStreamsVerifierProxy(streamsSigner);
        DataStreamsResolver streams = new DataStreamsResolver(
            deployer, IVerifierProxy(address(verifier)), window, 30 minutes
        );
        streams.configureAsset(TEST, TEST_FEED);
        factory.grantRole(factory.CREATOR_ROLE(), deployer);
        factory.grantRole(factory.GUARDIAN_ROLE(), deployer);
        factory.setAsset(BTC, roundResolver, "BTC", true);
        factory.setAsset(TEST, streams, "TEST", true);
        vm.stopBroadcast();

        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "deployBlock", block.number);
        vm.serializeAddress(o, "deployer", deployer);
        vm.serializeAddress(o, "collateral_tUSDC", address(tusdc));
        vm.serializeAddress(o, "marketFactory", address(factory));
        vm.serializeAddress(o, "marketImplementation", factory.marketImplementation());
        vm.serializeAddress(o, "outcomeTokenImplementation", factory.tokenImplementation());
        vm.serializeAddress(o, "chainlinkRoundResolver", address(roundResolver));
        vm.serializeAddress(o, "btcFeed", btcFeed);
        vm.serializeAddress(o, "mockStreamsVerifierProxy_TESTONLY", address(verifier));
        vm.serializeAddress(o, "streamsTestSigner", streamsSigner);
        vm.serializeAddress(o, "dataStreamsResolver", address(streams));
        vm.serializeBytes32(o, "assetBTC", BTC);
        vm.serializeBytes32(o, "assetTEST", TEST);
        vm.serializeBytes32(o, "testFeedId", TEST_FEED);
        string memory json = vm.serializeUint(o, "finalizationWindow", window);
        string memory path = string.concat(vm.projectRoot(), "/../deployments/", network, ".json");
        vm.writeJson(json, path);
        console2.log("wrote", path);
    }
}
