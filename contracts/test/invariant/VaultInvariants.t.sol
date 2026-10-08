// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultBase} from "../VaultBase.t.sol";
import {ConvergeVault} from "../../src/vault/ConvergeVault.sol";
import {ForwardVenue} from "../../src/vault/ForwardVenue.sol";
import {QuoteMath} from "../../src/vault/QuoteMath.sol";
import {Market} from "../../src/Market.sol";
import {IPriceResolver} from "../../src/interfaces/IPriceResolver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {FakeMarket} from "../unit/VaultInventory.t.sol";

/// @notice Stateful fuzzing of the whole vault: LPs, a market lifecycle driver, takers trading
///         through the venue, price moves, and a MALICIOUS KEEPER that tries to move value out of
///         the vault or to exceed every bound. This contract is its own handler (target).
///         Convention from Phase 1 (fail_on_revert = true): every handler guards its preconditions;
///         actions whose failure is an expected outcome use try/catch, and any outcome that must
///         never happen (an attack succeeding, an exit reverting, a drifting share price) is
///         recorded in `violations` and asserted to be zero.
contract VaultInvariants is VaultBase {
    // ------------------------------------------------------------------ ghosts

    uint256 public violations;
    string public lastViolation;
    uint256 public maxNavSeen;
    Market[] internal ms;
    int192 internal spot = 3000e18;
    address[3] internal lps;
    uint256[] internal usedEpochs;
    mapping(uint256 => bool) internal usedSeen;
    FakeMarket internal fake;
    Market internal btcMarket;

    // path coverage counters
    uint256 public cDeposits;
    uint256 public cRedeems;
    uint256 public cSettles;
    uint256 public cClaims;
    uint256 public cSplits;
    uint256 public cMerges;
    uint256 public cSigma;
    uint256 public cOrders;
    uint256 public cFilled;
    uint256 public cUnfilled;
    uint256 public cResolved;
    uint256 public cInvalid;
    uint256 public cRedeemedResolved;
    uint256 public cRedeemDeferred;
    uint256 public cAttacks;
    uint256 public cPauses;
    uint256 public cBreakerOrPaused;
    uint256 public cPartialRedeem;
    uint256 public cExecFail;
    uint256 public cExpired;

    function setUp() public override {
        super.setUp();
        vm.prank(vOwner);
        vault.setPerformanceFee(0); // the fee has its own unit tests; here it would blur the PPS check
        lps = [alice, bob, address(0xC0FFEE)];
        fake = new FakeMarket(ETH, T0, T0 + 900);
        btcMarket = _create(BTC, M15, T0 + 7200);
        _fund(alice, 1000 * U);
        h_createOpen();
        _setSigma(0.6e18);
        vm.prank(vKeeper);
        vault.splitForInventory(ms[0], 100 * U);
        vault.checkpoint(_noReports());
        _track();

        targetContract(address(this));
        bytes4[] memory sel = new bytes4[](21);
        sel[0] = this.h_warp.selector;
        sel[1] = this.h_move.selector;
        sel[2] = this.h_createOpen.selector;
        sel[3] = this.h_resolve.selector;
        sel[4] = this.h_lpDeposit.selector;
        sel[5] = this.h_lpRedeem.selector;
        sel[6] = this.h_settle.selector;
        sel[7] = this.h_claim.selector;
        sel[8] = this.h_setSigma.selector;
        sel[9] = this.h_split.selector;
        sel[10] = this.h_merge.selector;
        sel[11] = this.h_trade.selector;
        sel[12] = this.h_checkpoint.selector;
        sel[13] = this.h_pause.selector;
        sel[14] = this.h_attack.selector;
        sel[15] = this.h_trade.selector; // trades weigh double
        sel[16] = this.h_settle.selector; // so do settlements and inventory moves
        sel[17] = this.h_split.selector;
        sel[18] = this.h_lpRedeem.selector;
        sel[19] = this.h_halt.selector;
        sel[20] = this.h_haltAttack.selector;
        targetSelector(FuzzSelector({addr: address(this), selectors: sel}));
    }

    // ------------------------------------------------------------------ bookkeeping

    function _violate(string memory why) internal {
        violations++;
        lastViolation = why;
    }

    function _track() internal {
        uint256 n = vault.quoteNavLower();
        if (n > maxNavSeen) maxNavSeen = n;
        if (vault.quotingPaused()) cBreakerOrPaused++;
    }

    /// @dev Value that keeper actions must leave exactly unchanged: free collateral plus complete
    ///      pairs held in registered markets.
    function _hardValue() internal view returns (uint256 h) {
        uint256 bal = usdc.balanceOf(address(vault));
        uint256 reserved = vault.pendingDeposits() + vault.claimableAssets();
        h = bal > reserved ? bal - reserved : 0;
        for (uint256 i = 0; i < vault.marketCount(); i++) {
            Market m = Market(vault.marketAt(i));
            uint256 u = IERC20(address(m.up())).balanceOf(address(vault));
            uint256 d = IERC20(address(m.down())).balanceOf(address(vault));
            h += u < d ? u : d;
        }
    }

    function _lossOf(Market m) internal view returns (uint256) {
        (int256 basis, int256 cash) = vault.positionOf(address(m));
        QuoteMath.Pos memory p = QuoteMath.Pos(
            basis * 1e12,
            cash * 1e12,
            IERC20(address(m.up())).balanceOf(address(vault)) * 1e12,
            IERC20(address(m.down())).balanceOf(address(vault)) * 1e12
        );
        return QuoteMath.loss(p) / 1e12;
    }

    /// @dev Biases toward the two most recent markets, where trading is possible.
    function _pick(uint256 i) internal view returns (Market) {
        uint256 n = ms.length < 2 ? ms.length : 2;
        return ms[ms.length - 1 - (i % n)];
    }

    /// @dev What the honest keeper does between trades: fresh sigma and a fresh NAV snapshot.
    function _refresh() internal {
        (,, uint128 sg, uint64 at,,) = vault.assetCfg(ETH);
        uint256 maxAge = vault.sigmaMaxAge();
        if (block.timestamp > uint256(at) + maxAge / 2) {
            if (sg != 0 && block.timestamp < uint256(at) + vault.sigmaMinInterval()) return;
            uint256 target =
                (sg == 0 || block.timestamp > uint256(at) + maxAge) ? 0.6e18 : uint256(sg);
            vm.prank(vKeeper);
            vault.setSigma(ETH, target);
            cSigma++;
        }
        if (block.timestamp > uint256(vault.navUpdatedAt()) + 600) {
            vault.checkpoint(_freshMarks());
        }
    }

    function _sel(bytes memory err) internal pure returns (bytes4 s) {
        if (err.length >= 4) {
            assembly {
                s := mload(add(err, 32))
            }
        }
    }

    /// @dev A fresh mark for the breaker (checkpoint marks are optional; passing one is normal).
    function _freshMarks() internal view returns (bytes[] memory r) {
        return vault.marketCount() == 0 ? _noReports() : _markNow(spot);
    }

    // ------------------------------------------------------------------ environment

    function h_warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 120));
        _track();
    }

    function h_move(int256 bps) external {
        bps = bound(bps, -150, 150);
        spot = int192((int256(spot) * (10_000 + bps)) / 10_000);
    }

    function h_createOpen() public {
        if (ms.length >= 12) return;
        // open the next round only when the latest one is more than half over
        if (ms.length > 0 && block.timestamp + 300 < ms[ms.length - 1].endTime()) return;
        // forge-lint: disable-next-line(environment-read-across-mutation)
        uint64 start = uint64((block.timestamp / 900 + 1) * 900);
        while (factory.getMarket(ETH, M15, start) != address(0)) {
            start += 900;
        }
        Market m = _create(ETH, M15, start);
        vm.warp(start + 1);
        streamsResolver.submit(
            ETH, start, _report(ETH_FEED, uint32(start - 1), uint32(start + 1), spot)
        );
        vm.warp(start + WINDOW + 1);
        m.open("");
        ms.push(m);
    }

    function h_resolve(uint256 i) external {
        if (ms.length == 0) return;
        Market m = _pick(i);
        if (m.state() != Market.State.OPEN) return;
        _resolveMarket(m);
        _track();
    }

    /// @dev Resolves a round the way the system does: through the next round's start report
    ///      (same boundary), by submitting the end report, or, when nobody did in time, by
    ///      invalidating it. Then pulls the vault's winnings back (anyone may).
    function _resolveMarket(Market m) internal {
        uint64 end = m.endTime();
        if (_status(streamsResolver, ETH, end) == IPriceResolver.Status.FINAL) {
            m.resolve("");
            cResolved++;
        } else if (block.timestamp > end + GRACE) {
            m.invalidate();
            cInvalid++;
        } else {
            if (block.timestamp < end) vm.warp(end + 1);
            else vm.warp(block.timestamp + 1);
            streamsResolver.submit(
                ETH, end, _report(ETH_FEED, uint32(end - 1), uint32(end + 1), spot)
            );
            vm.warp(block.timestamp + WINDOW + 1);
            m.resolve("");
            cResolved++;
        }
        if (vault.isRegistered(address(m))) {
            uint256 u = IERC20(address(m.up())).balanceOf(address(vault));
            uint256 d = IERC20(address(m.down())).balanceOf(address(vault));
            try vault.redeemResolved(m) {
                cRedeemedResolved++;
            } catch (bytes memory err) {
                // Deliberate, time-limited exception (review finding 3): while an epoch's
                // settlement is pending, realising a resolved market is deferred so that nobody can
                // choose between the mark and the outcome. Any other revert is a violation.
                bool deferred =
                    err.length >= 4 && bytes4(err) == ConvergeVault.SettlementPending.selector;
                if (deferred) cRedeemDeferred++;
                else if (u != 0 || d != 0) _violate("redeemResolved reverted with tokens held");
            }
        }
    }

    // ------------------------------------------------------------------ LPs

    function h_lpDeposit(uint256 who, uint256 amt) external {
        address lp = lps[who % 3];
        amt = bound(amt, 10 * U, 500 * U);
        if (vault.lastNavUpper() + vault.pendingDeposits() + amt > vault.tvlCap()) return;
        uint256 e = _requestDeposit(lp, amt);
        _use(e);
        cDeposits++;
    }

    function h_lpRedeem(uint256 who, uint256 pct) external {
        address lp = lps[who % 3];
        uint256 bal = vault.balanceOf(lp);
        uint256 amt = (bal * bound(pct, 1, 100)) / 100;
        if (amt == 0) return;
        vm.prank(lp);
        uint256 e = vault.requestRedeem(amt);
        _use(e);
        cRedeems++;
    }

    function _use(uint256 e) internal {
        if (!usedSeen[e]) {
            usedSeen[e] = true;
            usedEpochs.push(e);
        }
    }

    /// @dev Settles the first ended epoch with requests (resolving the rounds that ended first,
    ///      as a settler would). The share price must not change from the flows alone (beyond
    ///      rounding in the vault's favour); an epoch left past its window must expire cleanly.
    function h_settle() external {
        for (uint256 i = 0; i < usedEpochs.length; i++) {
            uint256 e = usedEpochs[i];
            (uint128 dd, uint128 rr, bool settled,,,,) = vault.epochs(e);
            if (settled || e >= vault.currentEpoch() || (dd == 0 && rr == 0)) continue;
            _settleOne(e);
            break;
        }
        _track();
    }

    function _settleOne(uint256 e) internal {
        uint256 end = vault.epochEnd(e);
        bool late = block.timestamp > end + vault.settleWindow();
        bytes[] memory marks = _noReports();
        if (!late) {
            (, address[] memory pending) = vault.settlementPlan(e);
            for (uint256 i = 0; i < pending.length; i++) {
                _resolveMarket(Market(pending[i]));
            }
            late = block.timestamp > end + vault.settleWindow(); // resolving takes time
            (bytes32[] memory feeds,) = vault.settlementPlan(e);
            if (!late && feeds.length > 0) marks = _markAt(end, spot);
        }
        vm.recordLogs();
        vault.settleEpoch(e, marks);
        cSettles++;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == ConvergeVault.EpochExpired.selector) {
                cExpired++;
                return;
            }
            if (logs[i].topics[0] == ConvergeVault.EpochSettled.selector) {
                _checkFlowPrice(e, logs[i].data);
            }
        }
    }

    function _checkFlowPrice(uint256 e, bytes memory data) internal {
        (uint256 lo, uint256 hi, uint256 supplyBefore,,,,,) =
            abi.decode(data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256, bool));
        uint256 supply1 = vault.totalSupply();
        // 1e-9 relative slack for the integer division in the check itself
        if ((vault.quoteNavLower() * 1e18) / supply1 + 1e9 < (lo * 1e18) / supplyBefore) {
            _violate("lower share price fell from flows");
        }
        if ((vault.lastNavUpper() * 1e18) / supply1 + 1e9 < (hi * 1e18) / supplyBefore) {
            _violate("upper share price fell from flows");
        }
        (, uint128 r,,,, uint128 filled, uint128 paid) = _ep(e);
        if (r != 0 && filled < r && paid != 0) cPartialRedeem++;
    }

    function _ep(uint256 e)
        internal
        view
        returns (
            uint128 d,
            uint128 r,
            bool st,
            bool rej,
            uint128 minted,
            uint128 filled,
            uint128 paid
        )
    {
        (d, r, st, rej, minted, filled, paid) = vault.epochs(e);
    }

    /// @dev Claims must work in every state, paused or not.
    function h_claim(uint256 who) external {
        address lp = lps[who % 3];
        for (uint256 i = 0; i < usedEpochs.length; i++) {
            uint256 e = usedEpochs[i];
            (,, bool settled,,,,) = vault.epochs(e);
            if (!settled) continue;
            if (vault.depositRequest(e, lp) != 0) {
                vm.prank(lp);
                try vault.claimDeposit(e, lp) {
                    cClaims++;
                } catch {
                    _violate("claimDeposit reverted");
                }
            }
            if (vault.redeemRequest(e, lp) != 0) {
                vm.prank(lp);
                try vault.claimRedeem(e, lp) {
                    cClaims++;
                } catch {
                    _violate("claimRedeem reverted");
                }
                // the re-queued remainder lands in the current epoch
                if (vault.redeemRequest(vault.currentEpoch(), lp) != 0) _use(vault.currentEpoch());
            }
        }
        _track();
    }

    // ------------------------------------------------------------------ honest keeper (bounded actions)

    function h_setSigma(uint256 v) external {
        (,, uint128 prev, uint64 at,,) = vault.assetCfg(ETH);
        uint256 s = bound(v, 0.3e18, 2e18);
        if (prev != 0) {
            // forge-lint: disable-next-line(environment-read-across-mutation)
            if (block.timestamp < uint256(at) + vault.sigmaMinInterval()) {
                vm.warp(uint256(at) + vault.sigmaMinInterval());
            }
            if (block.timestamp <= uint256(at) + vault.sigmaMaxAge()) {
                uint256 lo = (uint256(prev) * 8000 + 9999) / 10_000; // round up: stay inside the step limit
                uint256 hi = (uint256(prev) * 12_000) / 10_000;
                s = s < lo ? lo : (s > hi ? hi : s);
                if (s < 0.3e18) s = 0.3e18;
                if (s > 2e18) s = 2e18;
            }
        }
        uint256 h0 = _hardValue();
        vm.prank(vKeeper);
        vault.setSigma(ETH, s);
        if (_hardValue() != h0) _violate("setSigma changed hard value");
        cSigma++;
    }

    function h_split(uint256 i, uint256 amt) external {
        if (ms.length == 0 || vault.quotingPaused()) return;
        Market m = _pick(i);
        Market.State st = m.state();
        if (st != Market.State.OPEN && st != Market.State.CREATED) return;
        if (block.timestamp + 30 >= m.endTime()) return;
        amt = bound(amt, 1, 60 * U);
        uint256 h0 = _hardValue();
        vm.prank(vKeeper);
        try vault.splitForInventory(m, amt) {
            cSplits++;
            if (_hardValue() != h0) _violate("split changed hard value");
        } catch (bytes memory err) {
            bytes4 s = _sel(err);
            if (s == ConvergeVault.InsufficientLiquidity.selector) {
                // allowed only when the split really would dip into collateral owed to others
                uint256 owed = vault.pendingDeposits() + vault.claimableAssets();
                uint256 bal = usdc.balanceOf(address(vault));
                uint256 free = bal > owed ? bal - owed : 0;
                if (amt <= free) _violate("split refused although the liquidity was free");
            } else if (
                s != ConvergeVault.PairCapExceeded.selector
                    && s != ConvergeVault.InventoryCapExceeded.selector
                    && s != ConvergeVault.TooManyMarkets.selector
            ) {
                _violate("split reverted for an unexpected reason");
            }
        }
        _track();
    }

    function h_merge(uint256 i, uint256 amt) external {
        if (ms.length == 0) return;
        Market m = _pick(i);
        if (!vault.isRegistered(address(m))) return;
        uint256 u = IERC20(address(m.up())).balanceOf(address(vault));
        uint256 d = IERC20(address(m.down())).balanceOf(address(vault));
        uint256 pairs = u < d ? u : d;
        if (pairs == 0) return;
        amt = bound(amt, 1, pairs);
        uint256 h0 = _hardValue();
        vm.prank(vKeeper);
        vault.mergeInventory(m, amt);
        cMerges++;
        if (_hardValue() != h0) _violate("merge changed hard value");
        _track();
    }

    function h_checkpoint() external {
        vault.checkpoint(_freshMarks());
        _track();
    }

    function h_pause(uint256 x) external {
        if (x % 2 == 0) {
            if (vault.quotingPaused()) return;
            vm.prank(vGuardian);
            vault.pauseQuoting();
            cPauses++;
        } else if (vault.quotingPaused()) {
            vm.prank(vOwner);
            vault.resumeQuoting();
        }
    }

    // ------------------------------------------------------------------ takers

    function h_trade(uint256 i, uint256 kind, uint256 size, uint256 limit) external {
        if (ms.length == 0) return;
        Market m = _pick(i);
        if (m.state() != Market.State.OPEN || block.timestamp + DELAY + 40 >= m.endTime()) return;
        _refresh();
        if (!vault.isRegistered(address(m)) && !vault.quotingPaused()) {
            vm.prank(vKeeper);
            try vault.splitForInventory(m, 50 * U) {
                cSplits++;
            } catch {}
        }
        if (!vault.isRegistered(address(m)) || !vault.venueView(m).tradable) return;
        ForwardVenue.Kind k = ForwardVenue.Kind(kind % 4);
        size = bound(size, 1_000, 30 * U);
        limit = bound(limit, 0.03e18, 0.97e18);
        uint256 id = _placeAs(taker, m, k, size, limit);
        cOrders++;
        (,,, uint64 at,,,,,) = venue.orders(id);
        vm.warp(at);
        bytes memory rep = _repWindow(at - 1, at + 1, spot, at + 1 days);
        vm.prank(executor);
        try venue.executeOrder(id, rep) returns (uint256 filled, uint256) {
            if (filled > 0) cFilled++;
            else cUnfilled++;
        } catch {
            cExecFail++;
            _violate("executeOrder reverted");
        }
        _track();
    }

    /// @dev The keeper's own off switch: a legitimate toggle (it never touches the pause).
    function h_halt(uint256 x) external {
        bool wasPaused = vault.quotingPaused();
        vm.prank(vKeeper);
        if (x % 2 == 0) vault.haltQuoting("FUZZ");
        else vault.unhaltQuoting();
        if (vault.quotingPaused() != wasPaused) _violate("the keeper changed the pause");
    }

    /// @dev Nobody but the keeper can halt or unhalt.
    function h_haltAttack(uint256 who) external {
        address a = who % 3 == 0 ? vOwner : (who % 3 == 1 ? vGuardian : alice);
        vm.startPrank(a);
        try vault.haltQuoting("ATTACK") {
            _violate("a non-keeper halted the vault");
        } catch {}
        try vault.unhaltQuoting() {
            _violate("a non-keeper unhalted the vault");
        } catch {}
        vm.stopPrank();
        cAttacks++;
    }

    // ------------------------------------------------------------------ the malicious keeper

    /// @dev Every call here must revert: a success is recorded as a violation. The keeper tries
    ///      to leave its bounds (sigma, caps, markets, assets), to call owner/guardian/venue
    ///      functions, and to move vault funds with plain ERC-20 calls.
    function h_attack(uint256 seed) external {
        cAttacks++;
        uint256 pick = seed % 16;
        vm.startPrank(vKeeper);
        bool ok;
        if (pick == 0) {
            try vault.setSigma(ETH, 0.29e18) {
                ok = true;
            } catch {}
        } else if (pick == 1) {
            try vault.setSigma(ETH, 2.01e18) {
                ok = true;
            } catch {}
        } else if (pick == 2) {
            try vault.splitForInventory(Market(address(fake)), 1 * U) {
                ok = true;
            } catch {}
        } else if (pick == 3) {
            try vault.splitForInventory(btcMarket, 1 * U) {
                ok = true;
            } catch {}
        } else if (pick == 4) {
            ConvergeVault.FillParams memory f;
            f.market = ms.length > 0 ? ms[0] : btcMarket;
            f.units = 1 * U;
            f.premium = 1 * U / 2;
            f.taker = vKeeper;
            try vault.venueFill(f) {
                ok = true;
            } catch {}
        } else if (pick == 5) {
            try vault.setKeeper(vKeeper) {
                ok = true;
            } catch {}
        } else if (pick == 6) {
            try vault.setTvlCap(type(uint256).max) {
                ok = true;
            } catch {}
        } else if (pick == 7) {
            try vault.setQuoteParams(_launchParams()) {
                ok = true;
            } catch {}
        } else if (pick == 8) {
            try vault.proposeVenue(vKeeper) {
                ok = true;
            } catch {}
        } else if (pick == 9) {
            try vault.pauseQuoting() {
                ok = true;
            } catch {}
        } else if (pick == 10) {
            try vault.resumeQuoting() {
                ok = true;
            } catch {}
        } else if (pick == 11) {
            // plain ERC-20 pulls from the vault: there is no allowance for anyone
            try usdc.transferFrom(address(vault), vKeeper, 1) {
                ok = true;
            } catch {}
        } else if (pick == 12) {
            if (ms.length > 0) {
                try IERC20(address(ms[0].up())).transferFrom(address(vault), vKeeper, 1) {
                    ok = true;
                } catch {}
            }
        } else if (pick == 13) {
            try vault.mergeInventory(ms.length > 0 ? ms[0] : btcMarket, type(uint256).max) {
                ok = true;
            } catch {}
        } else if (pick == 14) {
            try vault.setPerformanceFee(0) {
                ok = true;
            } catch {}
        } else {
            // a split far above any cap
            if (ms.length > 0) {
                try vault.splitForInventory(ms[0], 1_000_000 * U) {
                    ok = true;
                } catch {}
            }
        }
        vm.stopPrank();
        if (ok) _violate("a keeper attack succeeded");
    }

    // ------------------------------------------------------------------ invariants

    function invariant_noViolation() public view {
        assertEq(violations, 0, lastViolation);
    }

    /// @dev The keeper (and the guardian) never hold value taken from the vault.
    function invariant_keeperAndGuardianHoldNothing() public view {
        assertEq(usdc.balanceOf(vKeeper), 0);
        assertEq(usdc.balanceOf(vGuardian), 0);
        assertEq(vault.balanceOf(vKeeper), 0);
        for (uint256 i = 0; i < ms.length; i++) {
            assertEq(IERC20(address(ms[i].up())).balanceOf(vKeeper), 0);
            assertEq(IERC20(address(ms[i].down())).balanceOf(vKeeper), 0);
        }
    }

    /// @dev Everything owed to claimants and pending depositors is in the vault.
    function invariant_sumOfClaimableAssetsBackedByBalance() public view {
        assertLe(vault.pendingDeposits() + vault.claimableAssets(), usdc.balanceOf(address(vault)));
    }

    function invariant_noStandingApprovals() public view {
        address[4] memory who = [address(venue), vKeeper, vGuardian, vOwner];
        for (uint256 j = 0; j < 4; j++) {
            assertEq(usdc.allowance(address(vault), who[j]), 0);
            for (uint256 i = 0; i < ms.length; i++) {
                assertEq(usdc.allowance(address(vault), address(ms[i])), 0);
                assertEq(IERC20(address(ms[i].up())).allowance(address(vault), who[j]), 0);
                assertEq(IERC20(address(ms[i].down())).allowance(address(vault), who[j]), 0);
            }
        }
    }

    /// @dev The venue and the vault's bounds: no market's worst-case loss exceeds the per-market
    ///      cap, and all markets together stay within the total cap, measured against the largest
    ///      NAV the vault ever had (the ceiling is set from the NAV at fill time).
    function invariant_lossWithinConfiguredCaps() public view {
        QuoteMath.Params memory p = vault.quoteParams();
        uint256 perCap = (p.perMarketMaxFraction * maxNavSeen) / 1e18;
        uint256 totCap = (p.totalAtRiskMaxFraction * maxNavSeen) / 1e18;
        uint256 total;
        for (uint256 i = 0; i < vault.marketCount(); i++) {
            uint256 l = _lossOf(Market(vault.marketAt(i)));
            assertLe(l, perCap + 4, "per-market loss above the cap");
            total += l;
        }
        assertLe(total, totCap + 4 * 16, "total loss above the cap");
    }

    function invariant_navBandIsOrdered() public view {
        assertLe(vault.quoteNavLower(), vault.lastNavUpper());
        assertGe(vault.totalSupply(), vault.balanceOf(vault.treasury()));
    }

    function invariant_registryBounded() public view {
        assertLe(vault.marketCount(), vault.MAX_MARKETS());
    }

    /// @dev Appends this run's path counters to the evidence log (summed by
    ///      script/invariant-path-coverage-vault.sh): proof the fuzzer reached every path.
    function afterInvariant() public {
        string memory l = _kv("", "deposits", cDeposits);
        l = _kv(l, "redeems", cRedeems);
        l = _kv(l, "settles", cSettles);
        l = _kv(l, "claims", cClaims);
        l = _kv(l, "splits", cSplits);
        l = _kv(l, "merges", cMerges);
        l = _kv(l, "sigma", cSigma);
        l = _kv(l, "orders", cOrders);
        l = _kv(l, "filled", cFilled);
        l = _kv(l, "unfilled", cUnfilled);
        l = _kv(l, "resolved", cResolved);
        l = _kv(l, "invalidated", cInvalid);
        l = _kv(l, "redeemResolved", cRedeemedResolved);
        l = _kv(l, "redeemResolved deferred (settlement pending)", cRedeemDeferred);
        l = _kv(l, "attacks", cAttacks);
        l = _kv(l, "pauses", cPauses);
        l = _kv(l, "partial", cPartialRedeem);
        l = _kv(l, "execfail", cExecFail);
        l = _kv(l, "expired", cExpired);
        vm.writeLine("../docs/evidence/phase-4/invariant-paths.log", l);
    }

    function _kv(string memory acc, string memory k, uint256 v)
        internal
        pure
        returns (string memory)
    {
        return string.concat(acc, k, "=", vm.toString(v), " ");
    }
}
