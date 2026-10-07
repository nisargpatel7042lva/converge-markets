// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../src/MarketFactory.sol";
import {DataStreamsResolver} from "../src/resolvers/DataStreamsResolver.sol";
import {ConvergeVault} from "../src/vault/ConvergeVault.sol";
import {ForwardVenue} from "../src/vault/ForwardVenue.sol";
import {QuoteMath} from "../src/vault/QuoteMath.sol";
import {PartnerRegistry} from "../src/partners/PartnerRegistry.sol";
import {IPartnerRegistry} from "../src/partners/IPartnerRegistry.sol";

/// @notice Phase 8 TESTNET deployment of vault v4 (the vault that accepts partner markets), a new
///         forward venue and the PartnerRegistry, on top of the Phase 1/2 stack in
///         deployments/<network>.json. The previous vault stays on chain, archived in the file as
///         `vault_v3_pre_partners` (an immutable vault cannot be upgraded; ADR-008).
///         Writes deployments/<network>.partners.json (merged by deploy-partners.sh).
/// @dev Testnet-only (the Data Streams verifier behind the TEST asset is a mock). Roles as in
///      DeployVault: the deployer is owner, guardian and treasury, KEEPER_ADDRESS is the keeper.
///      The demo partner (PARTNER_ADDRESS) is approved with a 40 USD cap and posts its own bond.
///      Env: DEPLOYER_PRIVATE_KEY, KEEPER_ADDRESS, PARTNER_ADDRESS, NETWORK_NAME (default "testnet").
contract DeployPartners is Script {
    bytes32 internal constant TEST = keccak256("TEST/USD");
    uint64 internal constant EPOCH = 900;
    uint256 internal constant U = 1e6;
    /// @dev Demo terms (testnet): see docs/partners.md for what the mainnet values are decided by.
    uint256 internal constant MIN_BOND = 10 * U;
    uint256 internal constant GLOBAL_CAP = 500 * U;
    uint256 internal constant PARTNER_CAP = 40 * U;
    uint16 internal constant REDEEM_FEE_BPS = 50;
    uint16 internal constant PARTNER_FEE_SHARE_BPS = 3000;

    error NotATestNetwork(uint256 chainId);

    /// @notice Everything the deployment does, callable from a test as the deployer.
    function deploy(
        MarketFactory factory,
        DataStreamsResolver streams,
        address deployer,
        address keeper,
        address partner
    ) public returns (ConvergeVault vault, ForwardVenue venue, PartnerRegistry registry) {
        vault = new ConvergeVault(
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
            launchParams()
        );
        venue = new ForwardVenue(vault, 2, 4, 0.001 ether);
        vault.enableAsset(TEST, 0.4e18, 1.2e18); // a tight sigma band (threat model R3)
        vault.setInitialVenue(address(venue));

        registry = new PartnerRegistry(factory, deployer, deployer, deployer);
        // Slashed bonds go to the vault: the LPs bear the risk, so they are compensated first.
        registry.setConfig(MIN_BOND, GLOBAL_CAP, REDEEM_FEE_BPS, deployer, address(vault));
        registry.setVault(address(vault));
        registry.setFeed(TEST, true);
        bytes32[] memory feeds = new bytes32[](1);
        feeds[0] = TEST;
        registry.approvePartner(partner, PARTNER_CAP, PARTNER_FEE_SHARE_BPS, feeds);
        vault.setPartnerRegistry(IPartnerRegistry(address(registry)));
    }

    function run() external {
        if (block.chainid != 10_143 && block.chainid != 31_337) {
            revert NotATestNetwork(block.chainid);
        }
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address keeper = vm.envAddress("KEEPER_ADDRESS");
        address partner = vm.envAddress("PARTNER_ADDRESS");
        string memory network = vm.envOr("NETWORK_NAME", string("testnet"));
        string memory json =
            vm.readFile(string.concat(vm.projectRoot(), "/../deployments/", network, ".json"));
        MarketFactory factory = MarketFactory(vm.parseJsonAddress(json, ".marketFactory"));
        DataStreamsResolver streams =
            DataStreamsResolver(payable(vm.parseJsonAddress(json, ".dataStreamsResolver")));

        vm.startBroadcast(pk);
        (ConvergeVault vault, ForwardVenue venue, PartnerRegistry registry) =
            deploy(factory, streams, deployer, keeper, partner);
        vm.stopBroadcast();

        string memory k = "partners";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", block.number);
        vm.serializeAddress(k, "vault", address(vault));
        vm.serializeAddress(k, "forwardVenue", address(venue));
        vm.serializeAddress(k, "partnerRegistry", address(registry));
        vm.serializeAddress(
            k, "thresholdResolverImplementation", registry.thresholdImplementation()
        );
        vm.serializeAddress(k, "ownerGuardianTreasury", deployer);
        vm.serializeAddress(k, "vaultKeeper", keeper);
        vm.serializeAddress(k, "demoPartner", partner);
        vm.serializeUint(k, "epochLength", EPOCH);
        vm.serializeUint(k, "tvlCap", 5_000 * U);
        vm.serializeUint(k, "execDelaySeconds", 2);
        vm.serializeUint(k, "maxLatenessSeconds", 4);
        vm.serializeUint(k, "minBond", MIN_BOND);
        vm.serializeUint(k, "globalExposureCap", GLOBAL_CAP);
        vm.serializeUint(k, "demoPartnerCap", PARTNER_CAP);
        string memory out = vm.serializeUint(k, "redeemFeeBps", REDEEM_FEE_BPS);
        string memory path =
            string.concat(vm.projectRoot(), "/../deployments/", network, ".partners.json");
        vm.writeJson(out, path);
        console2.log("vault v4", address(vault));
        console2.log("venue", address(venue));
        console2.log("registry", address(registry));
    }

    /// @dev config/strategy.default.json (forward-priced design), in WAD. Same as DeployVault.
    function launchParams() internal pure returns (QuoteMath.Params memory) {
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
