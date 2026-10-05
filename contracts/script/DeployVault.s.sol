// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../src/MarketFactory.sol";
import {DataStreamsResolver} from "../src/resolvers/DataStreamsResolver.sol";
import {ConvergeVault} from "../src/vault/ConvergeVault.sol";
import {ForwardVenue} from "../src/vault/ForwardVenue.sol";
import {QuoteMath} from "../src/vault/QuoteMath.sol";

/// @notice Phase 4 TESTNET deployment of the vault and the forward venue, on top of the Phase 1/2
///         stack written by Deploy.s.sol to deployments/<network>.json. Writes
///         deployments/<network>.vault.json (merged into <network>.json by deploy-vault.sh).
/// @dev Testnet-only (the Data Streams verifier behind the factory's TEST asset is a mock, see
///      Deploy.s.sol). Launch parameters are config/strategy.default.json. Roles: the deployer is
///      owner, guardian and treasury; the keeper is KEEPER_ADDRESS (a separate key).
///      Env: DEPLOYER_PRIVATE_KEY, KEEPER_ADDRESS, NETWORK_NAME (default "testnet").
contract DeployVault is Script {
    bytes32 internal constant TEST = keccak256("TEST/USD");
    uint64 internal constant EPOCH = 900;
    uint256 internal constant U = 1e6;

    error NotATestNetwork(uint256 chainId);

    function run() external {
        if (block.chainid != 10_143 && block.chainid != 31_337) {
            revert NotATestNetwork(block.chainid);
        }
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address keeper = vm.envAddress("KEEPER_ADDRESS");
        string memory network = vm.envOr("NETWORK_NAME", string("testnet"));
        string memory json =
            vm.readFile(string.concat(vm.projectRoot(), "/../deployments/", network, ".json"));
        MarketFactory factory = MarketFactory(vm.parseJsonAddress(json, ".marketFactory"));
        DataStreamsResolver streams =
            DataStreamsResolver(payable(vm.parseJsonAddress(json, ".dataStreamsResolver")));

        vm.startBroadcast(pk);
        ConvergeVault vault = new ConvergeVault(
            IERC20(address(factory.collateral())),
            factory,
            streams,
            deployer, // owner (a Safe on mainnet)
            deployer, // guardian
            keeper,
            deployer, // treasury
            EPOCH,
            10 * U, // minimum request
            5_000 * U, // launch TVL cap (CLAUDE.md)
            _launchParams()
        );
        ForwardVenue venue = new ForwardVenue(vault, 2, 30, 0.001 ether);
        vault.enableAsset(TEST, 0.3e18, 2e18);
        vault.setInitialVenue(address(venue));
        vm.stopBroadcast();

        string memory k = "vault";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", block.number);
        vm.serializeAddress(k, "vault", address(vault));
        vm.serializeAddress(k, "forwardVenue", address(venue));
        vm.serializeAddress(k, "vaultOwnerGuardianTreasury", deployer);
        vm.serializeAddress(k, "vaultKeeper", keeper);
        vm.serializeUint(k, "epochLength", EPOCH);
        vm.serializeUint(k, "tvlCap", 5_000 * U);
        vm.serializeUint(k, "execDelaySeconds", 2);
        string memory out = vm.serializeUint(k, "maxLatenessSeconds", 30);
        string memory path =
            string.concat(vm.projectRoot(), "/../deployments/", network, ".vault.json");
        vm.writeJson(out, path);
        console2.log("vault", address(vault));
        console2.log("venue", address(venue));
    }

    /// @dev config/strategy.default.json (forward-priced design), in WAD.
    function _launchParams() internal pure returns (QuoteMath.Params memory) {
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
}
