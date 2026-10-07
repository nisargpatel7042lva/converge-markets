// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {VaultBase} from "../VaultBase.t.sol";
import {ConvergeVault} from "../../src/vault/ConvergeVault.sol";
import {Market} from "../../src/Market.sol";
import {PartnerRegistry} from "../../src/partners/PartnerRegistry.sol";
import {IPartnerRegistry} from "../../src/partners/IPartnerRegistry.sol";

/// @notice Stateful fuzzing of the partner caps with a MALICIOUS KEEPER: random market creation by
///         three partners, random (including enormous) allocations, merges, cap changes by the
///         owner, suspensions, voids and time. The property: after every successful allocation the
///         partner's exposure is within its cap, the exposure of all partners is within the global
///         cap and the vault's own fraction of NAV, and the slot limit holds. Same convention as
///         the other invariant suites: failures are recorded in `violations`.
contract PartnerCapInvariants is VaultBase {
    PartnerRegistry internal reg;
    address internal pOwner = makeAddr("pOwner");
    address internal pGuardian = makeAddr("pGuardian");
    address internal pTreasury = makeAddr("pTreasury");
    address[3] internal partners;
    Market[] internal ms;

    uint256 public violations;
    string public lastViolation;
    uint256 public cCreates;
    uint256 public cAllocs;
    uint256 public cAllocRejected;
    uint256 public cMerges;
    uint256 public cCapChanges;
    uint256 public cStatus;
    uint256 public navAtStart;

    function setUp() public override {
        super.setUp();
        partners = [makeAddr("pa"), makeAddr("pb"), makeAddr("pc")];
        reg = new PartnerRegistry(factory, pOwner, pGuardian, pTreasury);
        vm.startPrank(pOwner);
        reg.setConfig(10 * U, 120 * U, 50, pTreasury, pTreasury);
        reg.setVault(address(vault));
        reg.setFeed(ETH, true);
        bytes32[] memory feeds = new bytes32[](1);
        feeds[0] = ETH;
        for (uint256 i = 0; i < 3; i++) {
            reg.approvePartner(partners[i], 50 * U, 3000, feeds);
        }
        vm.stopPrank();
        for (uint256 i = 0; i < 3; i++) {
            usdc.mint(partners[i], 10 * U);
            vm.startPrank(partners[i]);
            usdc.approve(address(reg), 10 * U);
            reg.postBond(10 * U);
            vm.stopPrank();
        }
        vm.prank(vOwner);
        vault.setPartnerRegistry(IPartnerRegistry(address(reg)));
        _fund(alice, 1000 * U);
        _setSigma(0.6e18);
        navAtStart = vault.quoteNavLower();

        targetContract(address(this));
        bytes4[] memory sel = new bytes4[](8);
        sel[0] = this.h_create.selector;
        sel[1] = this.h_alloc.selector;
        sel[2] = this.h_alloc.selector; // allocations weigh triple
        sel[3] = this.h_alloc.selector;
        sel[4] = this.h_merge.selector;
        sel[5] = this.h_capChange.selector;
        sel[6] = this.h_status.selector;
        sel[7] = this.h_warp.selector;
        targetSelector(FuzzSelector({addr: address(this), selectors: sel}));
    }

    function _violate(string memory why) internal {
        violations++;
        lastViolation = why;
    }

    function h_create(uint256 who, uint256 strikeSeed, uint256 durSeed) external {
        address p = partners[who % 3];
        uint64 dur = uint64(15 minutes + (durSeed % (7 days - 15 minutes)));
        int256 strike = int256(2000e18 + (strikeSeed % 2000e18));
        vm.prank(p);
        try reg.createThresholdMarket(ETH, strike, uint64(block.timestamp) + dur) returns (
            address m
        ) {
            ms.push(Market(m));
            cCreates++;
        } catch {}
    }

    /// @dev The keeper asks for any amount, from dust to far above NAV.
    function h_alloc(uint256 pick, uint256 amountSeed) external {
        if (ms.length == 0) return;
        Market m = ms[pick % ms.length];
        uint256 amount =
            amountSeed % 3 == 0 ? 1 + (amountSeed % 5000 * U) : 1 + (amountSeed % (30 * U));
        vm.prank(vKeeper);
        try vault.splitForInventory(m, amount) {
            cAllocs++;
            _check(m);
        } catch {
            cAllocRejected++;
        }
    }

    function h_merge(uint256 pick, uint256 amountSeed) external {
        if (ms.length == 0) return;
        Market m = ms[pick % ms.length];
        if (!vault.isRegistered(address(m))) return;
        (int256 basis,) = vault.positionOf(address(m));
        if (basis <= 0) return;
        uint256 amount = 1 + (amountSeed % uint256(basis));
        vm.prank(vKeeper);
        try vault.mergeInventory(m, amount) {
            cMerges++;
        } catch {}
    }

    function h_capChange(uint256 who, uint256 cap, uint256 globalCap) external {
        vm.startPrank(pOwner);
        reg.setPartnerTerms(partners[who % 3], cap % (80 * U), 3000);
        reg.setConfig(10 * U, globalCap % (200 * U), 50, pTreasury, pTreasury);
        vm.stopPrank();
        cCapChanges++;
    }

    function h_status(uint256 who, uint256 action) external {
        address p = partners[who % 3];
        if (action % 3 == 0) {
            vm.prank(pGuardian);
            reg.suspendPartner(p);
        } else if (action % 3 == 1) {
            vm.prank(pOwner);
            reg.unsuspendPartner(p);
        } else if (ms.length != 0) {
            vm.prank(pOwner);
            reg.voidMarket(address(ms[action % ms.length]), 0);
        }
        cStatus++;
    }

    function h_warp(uint256 secs) external {
        // up to an hour at a time; the vault's NAV is not refreshed, so keep inside navMaxAge
        vm.warp(block.timestamp + (secs % 600));
    }

    // ------------------------------------------------------------------ the properties

    /// @dev Checked right after every successful allocation, against the caps in force then.
    function _check(Market m) internal {
        IPartnerRegistry.Limits memory l = reg.limits(address(m));
        address p = l.partner;
        if (!l.exists || !l.active) {
            _violate("allocated to an unknown or inactive market");
            return;
        }
        uint256 mine;
        uint256 all;
        for (uint256 i = 0; i < vault.marketCount(); i++) {
            address mk = vault.marketAt(i);
            address owner_ = vault.partnerOf(mk);
            if (owner_ == address(0)) continue;
            (int256 b,) = vault.positionOf(mk);
            if (b <= 0) continue;
            all += uint256(b);
            if (owner_ == p) mine += uint256(b);
        }
        if (mine > l.partnerCap) _violate("partner exposure above its cap");
        if (all > l.globalCap) _violate("partner exposure above the registry's global cap");
        if (all > (vault.quoteNavLower() * vault.maxPartnerFraction()) / 1e18) {
            _violate("partner exposure above the vault's fraction of NAV");
        }
    }

    function invariant_noPartnerEverExceedsItsCaps() public view {
        assertEq(violations, 0, lastViolation);
    }

    function invariant_slotsAreBounded() public view {
        assertLe(vault.partnerMarketCount(), vault.MAX_PARTNER_MARKETS());
        assertLe(vault.marketCount(), vault.MAX_MARKETS());
    }

    function invariant_navIsNotMovedByAllocation() public view {
        // splits and merges are value neutral: free collateral + complete pairs equal the deposit
        uint256 pairs;
        for (uint256 i = 0; i < vault.marketCount(); i++) {
            (int256 b,) = vault.positionOf(vault.marketAt(i));
            if (b > 0) pairs += uint256(b);
        }
        assertEq(usdc.balanceOf(address(vault)) + pairs, 1000 * U);
    }

    /// @dev Path counters, printed with -vv, so a run that never allocated or created anything
    ///      is visible in the evidence instead of passing silently.
    function afterInvariant() public view {
        console2.log("creates", cCreates);
        console2.log("allocations accepted", cAllocs);
        console2.log("allocations rejected", cAllocRejected);
        console2.log("merges", cMerges);
        console2.log("cap changes", cCapChanges);
        console2.log("status changes", cStatus);
    }
}
