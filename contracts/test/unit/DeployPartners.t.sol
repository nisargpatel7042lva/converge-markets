// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "../Base.t.sol";
import {Market} from "../../src/Market.sol";
import {ConvergeVault} from "../../src/vault/ConvergeVault.sol";
import {ForwardVenue} from "../../src/vault/ForwardVenue.sol";
import {PartnerRegistry} from "../../src/partners/PartnerRegistry.sol";
import {DeployPartners} from "../../script/DeployPartners.s.sol";

/// @notice The Phase 8 deployment script's wiring, run on a local fixture (the script itself only
///         adds the broadcast and the JSON). The script contract plays the deployer, so every
///         owner-only call in `deploy` is authorized exactly as it is under a broadcast.
contract DeployPartnersTest is Base {
    bytes32 internal constant TEST = keccak256("TEST/USD");
    bytes32 internal constant TEST_FEED =
        0x0003000000000000000000000000000000000000000000000000000000000001;
    uint256 internal constant U = 1e6;

    DeployPartners internal script;
    address internal keeper = makeAddr("keeper");
    address internal partner = makeAddr("partner");

    ConvergeVault internal vault;
    ForwardVenue internal venue;
    PartnerRegistry internal registry;

    function setUp() public override {
        super.setUp();
        vm.startPrank(admin);
        streamsResolver.configureAsset(TEST, TEST_FEED);
        factory.setAsset(TEST, streamsResolver, "TEST", true);
        vm.stopPrank();
        script = new DeployPartners();
        (vault, venue, registry) =
            script.deploy(factory, streamsResolver, address(script), keeper, partner);
    }

    function test_wiring() public view {
        assertEq(vault.owner(), address(script));
        assertEq(vault.keeper(), keeper);
        assertEq(vault.venue(), address(venue));
        assertEq(address(vault.partnerRegistry()), address(registry));
        (bool enabled,,,,,) = vault.assetCfg(TEST);
        assertTrue(enabled);
        assertEq(registry.owner(), address(script));
        assertEq(registry.vault(), address(vault));
        assertTrue(registry.feedEnabled(TEST));
        assertEq(registry.slashRecipient(), address(vault));
        assertEq(registry.minBond(), 10 * U);
        assertEq(registry.globalExposureCap(), 500 * U);
        assertEq(registry.redeemFeeBps(), 50);
        PartnerRegistry.Partner memory p = registry.partnerOf(partner);
        assertTrue(p.approved);
        assertEq(p.exposureCap, 40 * U);
        assertEq(p.feeShareBps, 3000);
        assertTrue(registry.allowedFeed(partner, TEST));
        assertEq(address(venue.vault()), address(vault));
    }

    function test_theDemoPartnerCanCreateAfterPostingItsBond() public {
        usdc.mint(partner, 10 * U);
        vm.startPrank(partner);
        usdc.approve(address(registry), 10 * U);
        registry.postBond(10 * U);
        Market m = Market(
            registry.createThresholdMarket(TEST, 3000e18, uint64(block.timestamp) + 1 hours)
        );
        vm.stopPrank();
        assertEq(uint8(m.state()), uint8(Market.State.OPEN));
        assertEq(m.factory(), address(registry));
    }

    function test_refusesAMainnetChain() public {
        vm.chainId(143);
        vm.expectRevert(abi.encodeWithSelector(DeployPartners.NotATestNetwork.selector, 143));
        script.run();
    }
}
