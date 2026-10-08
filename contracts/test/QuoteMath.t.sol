// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {QuoteMath as Q} from "../src/vault/QuoteMath.sol";

/// @dev Harness so library reverts and memory structs can be exercised through `this`.
contract QuoteMathHarness {
    function quote(
        uint256 spot,
        uint256 strike,
        uint256 sigma,
        uint256 tauSec,
        uint256 roundSec,
        uint256 nav,
        Q.Pos memory pos,
        Q.Params memory q
    ) external pure returns (Q.Quote memory) {
        return Q.quote(spot, strike, sigma, tauSec, roundSec, nav, pos, q);
    }
}

/// @notice Parity of the Solidity pricing library with the TypeScript twin (golden vectors from
///         packages/strategy/scripts/gen-vectors.ts), plus properties of the quote.
contract QuoteMathTest is Test {
    QuoteMathHarness internal h = new QuoteMathHarness();

    uint256 internal constant ABS = 4e9; // 4e-9 in WAD: float vs fixed point
    string internal constant DIR = "test/vectors/";

    function _near(uint256 a, uint256 b, uint256 tol, string memory what) internal pure {
        uint256 d = a > b ? a - b : b - a;
        require(d <= tol + (b > a ? b : a) / 1e8, what); // absolute 4e-9 plus 1e-8 relative
    }

    function _nearI(int256 a, int256 b, uint256 tol, string memory what) internal pure {
        uint256 d = a > b ? uint256(a - b) : uint256(b - a);
        uint256 mag = uint256(a < 0 ? -a : a);
        require(d <= tol + mag / 1e8, what);
    }

    // ------------------------------------------------------------------ primitives

    function test_normCdf_matchesTypescript() public {
        string memory f = string.concat(DIR, "cdf.jsonl");
        vm.closeFile(f);
        uint256 n;
        for (string memory line = vm.readLine(f); bytes(line).length != 0; line = vm.readLine(f)) {
            int256 x = vm.parseJsonInt(line, ".x");
            uint256 p = vm.parseJsonUint(line, ".p");
            _near(Q.normCdf(x), p, 2e9, "cdf");
            n++;
        }
        vm.closeFile(f);
        assertGt(n, 300);
    }

    function test_normCdf_knownValuesAndSymmetry() public pure {
        assertApproxEqAbs(Q.normCdf(0), 0.5e18, 1);
        assertApproxEqAbs(Q.normCdf(1e18), 0.8413447460685429e18, 2e3);
        assertApproxEqAbs(Q.normCdf(-3e18), 0.0013498980316301e18, 2e3);
        assertApproxEqAbs(Q.normCdf(1.96e18), 0.9750021048517795e18, 2e3);
        assertEq(Q.normCdf(38e18), 1e18);
        assertEq(Q.normCdf(-38e18), 0);
        for (int256 x = -8e18; x <= 8e18; x += 0.37e18) {
            assertApproxEqAbs(Q.normCdf(x) + Q.normCdf(-x), 1e18, 4e3);
        }
    }

    function test_normCdf_monotone() public pure {
        uint256 prev;
        for (int256 x = -9e18; x <= 9e18; x += 0.05e18) {
            uint256 c = Q.normCdf(x);
            assertGe(c + 3e3, prev, "monotone up to rounding");
            prev = c;
        }
    }

    function test_normPdf_matchesTypescript() public {
        string memory f = string.concat(DIR, "pdf.jsonl");
        vm.closeFile(f);
        for (string memory line = vm.readLine(f); bytes(line).length != 0; line = vm.readLine(f)) {
            _near(Q.normPdf(vm.parseJsonInt(line, ".x")), vm.parseJsonUint(line, ".p"), 2e9, "pdf");
        }
        vm.closeFile(f);
    }

    function test_d2_matchesTypescript() public {
        string memory f = string.concat(DIR, "d2.jsonl");
        vm.closeFile(f);
        for (string memory line = vm.readLine(f); bytes(line).length != 0; line = vm.readLine(f)) {
            int256 got = Q.d2(
                vm.parseJsonUint(line, ".spot"),
                vm.parseJsonUint(line, ".strike"),
                vm.parseJsonUint(line, ".sigma"),
                vm.parseJsonUint(line, ".tau")
            );
            _nearI(got, vm.parseJsonInt(line, ".d2"), 5e9, "d2");
        }
        vm.closeFile(f);
    }

    function test_d2_degenerateAndTies() public pure {
        // tau = 0 or sigma = 0: decided by the sign of ln(S/K), ties go UP.
        // a strike so far above the spot that spot / strike rounds to zero must not revert
        assertEq(Q.d2(3000e18, 1e40, 0.6e18, 3600), -Q.D2_MAX);
        assertEq(Q.d2(3000e18, uint256(uint192(type(int192).max)), 0.6e18, 3600), -Q.D2_MAX);
        assertEq(Q.d2(100e18, 100e18, 0.5e18, 0), Q.D2_MAX);
        assertEq(Q.d2(101e18, 100e18, 0, 100), Q.D2_MAX);
        assertEq(Q.d2(99e18, 100e18, 0.5e18, 0), -Q.D2_MAX);
        // clamped when huge
        assertEq(Q.d2(1e24, 1e18, 0.001e18, 1), Q.D2_MAX);
    }

    function test_tanh_matchesTypescriptAndSaturates() public {
        string memory f = string.concat(DIR, "tanh.jsonl");
        vm.closeFile(f);
        for (string memory line = vm.readLine(f); bytes(line).length != 0; line = vm.readLine(f)) {
            _nearI(Q.tanhWad(vm.parseJsonInt(line, ".x")), vm.parseJsonInt(line, ".y"), 2e9, "tanh");
        }
        vm.closeFile(f);
        assertEq(Q.tanhWad(25e18), 1e18);
        assertEq(Q.tanhWad(-25e18), -1e18);
        assertEq(Q.tanhWad(0), 0);
    }

    // ------------------------------------------------------------------ the quote

    function _params(string memory line) internal pure returns (Q.Params memory q) {
        q.minHalfSpread = vm.parseJsonUint(line, ".params.minHalfSpread");
        q.maxHalfSpread = vm.parseJsonUint(line, ".params.maxHalfSpread");
        q.volSpreadK = vm.parseJsonUint(line, ".params.volSpreadK");
        q.stalenessSec = vm.parseJsonUint(line, ".params.stalenessSec");
        q.inventorySkewMax = vm.parseJsonUint(line, ".params.inventorySkewMax");
        q.inventorySkewK = vm.parseJsonUint(line, ".params.inventorySkewK");
        q.noQuoteWindowSec = vm.parseJsonUint(line, ".params.noQuoteWindowSec");
        q.priceMin = vm.parseJsonUint(line, ".params.priceMin");
        q.priceMax = vm.parseJsonUint(line, ".params.priceMax");
        q.tick = vm.parseJsonUint(line, ".params.tick");
        q.levels = vm.parseJsonUint(line, ".params.levels");
        q.baseRangeTicks = vm.parseJsonUint(line, ".params.baseRangeTicks");
        q.minRangeTicks = vm.parseJsonUint(line, ".params.minRangeTicks");
        q.liquidityNavFraction = vm.parseJsonUint(line, ".params.liquidityNavFraction");
        q.minLevelSize = vm.parseJsonUint(line, ".params.minLevelSize");
        q.perMarketMaxFraction = vm.parseJsonUint(line, ".params.perMarketMaxFraction");
        q.totalAtRiskMaxFraction = vm.parseJsonUint(line, ".params.totalAtRiskMaxFraction");
    }

    function _pos(string memory line) internal pure returns (Q.Pos memory p) {
        p.basis = vm.parseJsonInt(line, ".pos.basis");
        p.cash = vm.parseJsonInt(line, ".pos.cash");
        p.up = vm.parseJsonUint(line, ".pos.up");
        p.down = vm.parseJsonUint(line, ".pos.down");
    }

    function test_quote_matchesTypescript() public {
        string memory f = string.concat(DIR, "quotes.jsonl");
        vm.closeFile(f);
        uint256 n;
        uint256 quoting;
        for (string memory line = vm.readLine(f); bytes(line).length != 0; line = vm.readLine(f)) {
            Q.Params memory q = _params(line);
            Q.Quote memory got = Q.quote(
                vm.parseJsonUint(line, ".spot"),
                vm.parseJsonUint(line, ".strike"),
                vm.parseJsonUint(line, ".sigma"),
                vm.parseJsonUint(line, ".tau"),
                vm.parseJsonUint(line, ".roundSec"),
                vm.parseJsonUint(line, ".nav"),
                _pos(line),
                q
            );
            assertEq(got.quoting, vm.parseJsonBool(line, ".quoting"), "quoting flag");
            if (got.quoting) {
                quoting++;
                _near(got.fair, vm.parseJsonUint(line, ".fair"), ABS, "fair");
                _near(got.halfSpread, vm.parseJsonUint(line, ".half"), ABS, "half-spread");
                _nearI(got.skew, vm.parseJsonInt(line, ".skew"), ABS, "skew");
                uint256[] memory bp = vm.parseJsonUintArray(line, ".bp");
                uint256[] memory bs = vm.parseJsonUintArray(line, ".bs");
                uint256[] memory ap = vm.parseJsonUintArray(line, ".ap");
                uint256[] memory as_ = vm.parseJsonUintArray(line, ".as");
                assertEq(got.bids.length, bp.length, "bid count");
                assertEq(got.asks.length, ap.length, "ask count");
                for (uint256 i; i < bp.length; i++) {
                    assertEq(got.bids[i].price, bp[i], "bid price");
                    _near(got.bids[i].size, bs[i], 1e12, "bid size");
                }
                for (uint256 i; i < ap.length; i++) {
                    assertEq(got.asks[i].price, ap[i], "ask price");
                    _near(got.asks[i].size, as_[i], 1e12, "ask size");
                }
            }
            n++;
        }
        vm.closeFile(f);
        assertGt(n, 500);
        assertGt(quoting, 300, "enough vectors exercise the ladder");
    }

    // ------------------------------------------------------------------ properties

    function _launch() internal pure returns (Q.Params memory q) {
        q.minHalfSpread = 0.05e18;
        q.maxHalfSpread = 0.2e18;
        q.volSpreadK = 1e18;
        q.stalenessSec = 4e18;
        q.inventorySkewMax = 0.1e18;
        q.inventorySkewK = 2e18;
        q.noQuoteWindowSec = 30;
        q.priceMin = 0.02e18;
        q.priceMax = 0.98e18;
        q.tick = 0.01e18;
        q.levels = 2;
        q.baseRangeTicks = 8e18;
        q.minRangeTicks = 2e18;
        q.liquidityNavFraction = 0.12e18;
        q.minLevelSize = 1e18;
        q.perMarketMaxFraction = 0.01e18;
        q.totalAtRiskMaxFraction = 0.08e18;
    }

    function testFuzz_quoteInvariants(
        uint256 mSeed,
        uint256 tau,
        uint256 posSeed,
        uint256 sigmaSeed
    ) public view {
        Q.Params memory q = _launch();
        uint256 strike = 70_000e18;
        int256 m = int256(bound(mSeed, 0, 40_000)) - 20_000; // ±2% in units of 1e-6
        uint256 spot = uint256(int256(strike) + int256(strike) * m / 1_000_000);
        tau = bound(tau, 0, 3600);
        uint256 sigma = bound(sigmaSeed, 0.1e18, 2e18);
        Q.Pos memory pos;
        pos.up = bound(posSeed, 0, 800e18);
        pos.down = bound(posSeed >> 64, 0, 800e18);
        pos.basis = int256((pos.up > pos.down ? pos.up : pos.down) + 10e18);
        pos.cash = int256(bound(posSeed >> 128, 0, 100e18));
        Q.Quote memory r = Q.quote(spot, strike, sigma, tau, 3600, 5000e18, pos, q);
        if (!r.quoting) {
            assertEq(r.bids.length + r.asks.length, 0);
            return;
        }
        assertGt(tau, q.noQuoteWindowSec);
        assertGe(r.halfSpread, q.minHalfSpread);
        assertLe(r.halfSpread, q.maxHalfSpread);
        for (uint256 i; i < r.bids.length; i++) {
            assertGe(r.bids[i].price, q.priceMin);
            assertLe(r.bids[i].price, q.priceMax);
            assertEq(r.bids[i].price % q.tick, 0, "bid on grid");
            assertGt(r.bids[i].size, 0);
            if (i > 0) assertLt(r.bids[i].price, r.bids[i - 1].price, "bids descend");
            assertLe(
                int256(r.bids[i].price),
                int256(r.fair) - int256(0.2e18 * r.halfSpread / 1e18),
                "bid below fair"
            );
        }
        for (uint256 i; i < r.asks.length; i++) {
            assertGe(r.asks[i].price, q.priceMin);
            assertLe(r.asks[i].price, q.priceMax);
            assertEq(r.asks[i].price % q.tick, 0, "ask on grid");
            if (i > 0) assertGt(r.asks[i].price, r.asks[i - 1].price, "asks ascend");
            assertGe(
                int256(r.asks[i].price),
                int256(r.fair) + int256(0.2e18 * r.halfSpread / 1e18),
                "ask above fair"
            );
        }
        if (r.bids.length > 0 && r.asks.length > 0) {
            assertLt(r.bids[0].price, r.asks[0].price, "never crossed");
        }
    }

    function test_quote_noQuoteWindowAndBadInputs() public view {
        Q.Params memory q = _launch();
        Q.Pos memory pos;
        assertFalse(h.quote(70_000e18, 70_000e18, 0.5e18, 30, 900, 5000e18, pos, q).quoting);
        assertFalse(h.quote(70_000e18, 70_000e18, 0.5e18, 0, 900, 5000e18, pos, q).quoting);
        assertFalse(h.quote(0, 70_000e18, 0.5e18, 600, 900, 5000e18, pos, q).quoting);
        assertFalse(h.quote(70_000e18, 0, 0.5e18, 600, 900, 5000e18, pos, q).quoting);
        assertFalse(h.quote(70_000e18, 70_000e18, 0.5e18, 600, 900, 0, pos, q).quoting);
        assertFalse(h.quote(70_000e18, 70_000e18, 0.5e18, 600, 0, 5000e18, pos, q).quoting);
        // dust: depth below the minimum level size
        Q.Params memory dust = _launch();
        dust.minLevelSize = 1e30;
        assertFalse(h.quote(70_000e18, 70_000e18, 0.5e18, 600, 900, 5000e18, pos, dust).quoting);
        // a quote exists at the money
        Q.Quote memory ok = h.quote(70_000e18, 70_000e18, 0.5e18, 600, 900, 5000e18, pos, q);
        assertTrue(ok.quoting);
        assertEq(ok.bids.length, 2);
        assertEq(ok.asks.length, 2);
    }

    function test_quote_skewLeansAgainstInventory() public view {
        Q.Params memory q = _launch();
        Q.Pos memory flat;
        Q.Pos memory longUp;
        longUp.up = 500e18;
        longUp.basis = 500e18;
        Q.Pos memory shortUp;
        shortUp.down = 500e18;
        shortUp.basis = 500e18;
        int256 s0 = h.quote(70_000e18, 70_000e18, 0.5e18, 600, 900, 5000e18, flat, q).skew;
        int256 sLong = h.quote(70_000e18, 70_000e18, 0.5e18, 600, 900, 5000e18, longUp, q).skew;
        int256 sShort = h.quote(70_000e18, 70_000e18, 0.5e18, 600, 900, 5000e18, shortUp, q).skew;
        assertEq(s0, 0);
        assertLt(sLong, 0, "long UP: quotes shift down to sell UP");
        assertGt(sShort, 0, "short UP: quotes shift up to buy UP");
    }

    function test_quote_depthShrinksTowardExpiry() public view {
        Q.Params memory q = _launch();
        Q.Pos memory pos;
        uint256 prev = type(uint256).max;
        for (uint256 tau = 900; tau > 70; tau -= 70) {
            Q.Quote memory r = h.quote(70_000e18, 70_000e18, 0.3e18, tau, 900, 5000e18, pos, q);
            if (!r.quoting) continue;
            if (prev != type(uint256).max) {
                assertLe(r.asks[0].size, prev + 1e12, "size non-increasing as expiry nears");
            }
            prev = r.asks[0].size;
        }
    }

    // ------------------------------------------------------------------ risk room

    function test_rooms_matchTypescript() public {
        string memory f = string.concat(DIR, "rooms.jsonl");
        vm.closeFile(f);
        uint256 n;
        for (string memory line = vm.readLine(f); bytes(line).length != 0; line = vm.readLine(f)) {
            Q.Pos memory p = _pos(line);
            Q.Params memory q;
            q.perMarketMaxFraction = vm.parseJsonUint(line, ".perMax");
            q.totalAtRiskMaxFraction = vm.parseJsonUint(line, ".totalMax");
            uint256 ceiling = Q.lossCeiling(
                p, vm.parseJsonUint(line, ".nav"), vm.parseJsonUint(line, ".other"), q
            );
            _near(ceiling, vm.parseJsonUint(line, ".ceiling"), ABS, "ceiling");
            uint256 price = vm.parseJsonUint(line, ".price");
            _near(
                Q.sellRoom(p.basis, p.cash, p.up, p.down, price, ceiling),
                vm.parseJsonUint(line, ".sellUp"),
                1e10,
                "sellUp"
            );
            _near(
                Q.buyRoom(p.basis, p.cash, p.up, p.down, price, ceiling),
                vm.parseJsonUint(line, ".buyUp"),
                1e10,
                "buyUp"
            );
            _near(
                Q.sellRoom(p.basis, p.cash, p.down, p.up, price, ceiling),
                vm.parseJsonUint(line, ".sellDown"),
                1e10,
                "sellDown"
            );
            _near(
                Q.buyRoom(p.basis, p.cash, p.down, p.up, price, ceiling),
                vm.parseJsonUint(line, ".buyDown"),
                1e10,
                "buyDown"
            );
            n++;
        }
        vm.closeFile(f);
        assertGt(n, 300);
    }

    /// The closed-form room is exact: filling it never pushes the loss past the ceiling, and a
    /// little more does (unless a cap binds).
    function testFuzz_rooms_areExactAgainstTheLossFunction(
        uint256 upS,
        uint256 downS,
        uint256 cashS,
        uint256 priceS,
        uint256 ceilS
    ) public pure {
        Q.Pos memory p;
        p.up = bound(upS, 0, 500e18);
        p.down = bound(downS, 0, 500e18);
        p.basis = int256((p.up > p.down ? p.up : p.down) + bound(upS >> 40, 0, 30e18));
        p.cash = int256(bound(cashS, 0, 300e18)) - 100e18;
        uint256 price = bound(priceS, 0.02e18, 0.98e18);
        uint256 ceiling = Q.loss(p) + bound(ceilS, 0, 60e18);

        // vault sells UP
        uint256 x = Q.sellRoom(p.basis, p.cash, p.up, p.down, price, ceiling);
        assertLe(x, p.up);
        Q.Pos memory a = Q.Pos(p.basis, p.cash + int256(x * price / 1e18), p.up - x, p.down);
        assertLe(Q.loss(a), ceiling + 1e6, "sell UP stays inside the ceiling");

        // vault buys UP
        uint256 y = Q.buyRoom(p.basis, p.cash, p.up, p.down, price, ceiling);
        Q.Pos memory b = Q.Pos(p.basis, p.cash - int256(y * price / 1e18), p.up + y, p.down);
        assertLe(Q.loss(b), ceiling + 1e6, "buy UP stays inside the ceiling");

        // vault sells DOWN / buys DOWN (roles swapped)
        uint256 z = Q.sellRoom(p.basis, p.cash, p.down, p.up, price, ceiling);
        assertLe(z, p.down);
        Q.Pos memory c = Q.Pos(p.basis, p.cash + int256(z * price / 1e18), p.up, p.down - z);
        assertLe(Q.loss(c), ceiling + 1e6, "sell DOWN stays inside the ceiling");
        uint256 w = Q.buyRoom(p.basis, p.cash, p.down, p.up, price, ceiling);
        Q.Pos memory d = Q.Pos(p.basis, p.cash - int256(w * price / 1e18), p.up, p.down + w);
        assertLe(Q.loss(d), ceiling + 1e6, "buy DOWN stays inside the ceiling");
    }

    /// @dev Selling the surplus of one side (or buying the missing side) never adds risk, so it is
    ///      allowed even with no ceiling left (audit F-07, mutants BB and BC).
    function test_rooms_freeBranchesAreAllowedAtZeroCeiling() public pure {
        assertEq(Q.sellRoom(100e18, 0, 100e18, 60e18, 0.5e18, 0), 40e18);
        assertEq(Q.buyRoom(100e18, 0, 60e18, 100e18, 0.5e18, 0), 40e18);
        // with a ceiling that is already used up nothing beyond the free part is allowed
        assertEq(Q.sellRoom(100e18, 0, 100e18, 100e18, 0.5e18, 0), 0);
        assertEq(Q.buyRoom(100e18, 0, 100e18, 100e18, 0.5e18, 0), 0);
    }

    function test_lossAndCeilingBasics() public pure {
        Q.Pos memory p = Q.Pos(100e18, 30e18, 40e18, 40e18); // paid 100 into pairs, got 30 in premium
        assertEq(Q.loss(p), 30e18); // 100 - 30 - 40
        Q.Pos memory safe = Q.Pos(100e18, 90e18, 50e18, 50e18);
        assertEq(Q.loss(safe), 0);
        Q.Params memory q = _launch();
        // ceiling is never below the current loss
        assertEq(Q.lossCeiling(p, 100e18, 0, q), 30e18);
        // otherwise the per-market cap or the remaining total room
        assertEq(Q.lossCeiling(safe, 1000e18, 0, q), 10e18);
        assertEq(Q.lossCeiling(safe, 1000e18, 75e18, q), 5e18);
        assertEq(Q.lossCeiling(safe, 1000e18, 500e18, q), 0);
        assertEq(Q.sellRoom(0, 0, 0, 0, 0.5e18, 100e18), 0, "nothing to sell");
        assertEq(Q.sellRoom(0, 0, 10e18, 0, 1e18, 100e18), 0, "price 1");
        assertEq(Q.buyRoom(0, 0, 0, 0, 0, 100e18), 0, "price 0");
    }
}
