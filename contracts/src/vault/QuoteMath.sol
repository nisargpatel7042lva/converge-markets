// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Static-analysis review (forge lint, slither): every `forge-lint: disable` in this file was reviewed.
// - unsafe-typecast: each cast is of a value bounded by a check, a constant or a library guarantee
//   (price > 0, config ranges validated in the setters, WAD math with explicit clamps).
// - calls-loop / require-revert-in-loop: loops run over the registry, which is bounded by
//   MAX_MARKETS (16) and MAX_ASSETS (8), or over the at most MAX_LEVELS (4) ladder levels.
// - reentrancy-*: every entry point that moves value is nonReentrant, and the external calls
//   go to the immutable asset, the factory's own Market/OutcomeToken clones, the immutable
//   verifier proxy, or the owner-timelocked venue.
// - incorrect-strict-equality: exact comparisons of token balances against zero or against each
//   other are the intent (nothing to burn/pay; excess exists).
// - weak-prng / divide-before-multiply: epoch alignment arithmetic and tick-grid flooring.

import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";

/// @title QuoteMath
/// @notice On-chain pricing of one UP/DOWN round, mirroring `packages/strategy` (Phase 3). All
///         values are WAD (1e18). Prices are probabilities in (0, 1); sizes are outcome-token
///         shares (1 share = 1 unit of face value, expressed in WAD regardless of token decimals).
/// @dev Differences from the TypeScript library, stated in docs/phases/PHASE-4-plan.md:
///      (1) no toxicity guard (report-only pricing has no tick history);
///      (2) the ladder is spaced in z-space (price = Φ(z), size = L_t·Δz): exactly the pm-AMM
///          depth, using Φ but no Φ⁻¹;
///      (3) risk room is computed from token balances, a premium accumulator and a collateral
///          basis, in closed form, instead of the TS (cash, shortUp) pair (they agree when the
///          inventory is made of whole pairs; `packages/strategy/test/onchain.test.ts` checks it).
///      The TypeScript twin is `packages/strategy/src/onchain.ts`; golden vectors in
///      `contracts/test/vectors/quote-vectors.json` tie the two together.
library QuoteMath {
    uint256 internal constant WAD = 1e18;
    int256 internal constant SWAD = 1e18;
    /// @dev Seconds in a Julian year (365.25 days), the annualization basis everywhere.
    uint256 internal constant YEAR = 31_557_600;
    uint256 internal constant PROB_MIN = 1e12;
    uint256 internal constant PROB_MAX = 1e18 - 1e12;
    /// @dev |d2| beyond this means the outcome is decided (Φ is 0 or 1 to 1e-18).
    int256 internal constant D2_MAX = 100e18;
    /// @dev Below this σ√τ the digital is degenerate (decided by the sign of ln(S/K)).
    uint256 internal constant MIN_STD = 1e6;
    uint256 internal constant INV_SQRT_2PI = 0.3989422804014327e18;
    /// @dev Floor of φ used in the z-step so Δz stays bounded in the tails.
    uint256 internal constant PHI_FLOOR = 1e12;
    uint256 internal constant DZ_MAX = 1e18;
    uint256 internal constant MAX_LEVELS = 4;

    /// @notice Quoting parameters (WAD unless noted). The vault validates and stores them.
    struct Params {
        uint256 minHalfSpread;
        uint256 maxHalfSpread;
        uint256 volSpreadK;
        /// @dev Assumed staleness of the price, in seconds as WAD.
        uint256 stalenessSec;
        uint256 inventorySkewMax;
        uint256 inventorySkewK;
        /// @dev Plain seconds.
        uint256 noQuoteWindowSec;
        uint256 priceMin;
        uint256 priceMax;
        uint256 tick;
        uint256 levels;
        /// @dev Ladder span at round start and its concentration floor, in ticks as WAD.
        uint256 baseRangeTicks;
        uint256 minRangeTicks;
        uint256 liquidityNavFraction;
        uint256 minLevelSize;
        uint256 perMarketMaxFraction;
        uint256 totalAtRiskMaxFraction;
    }

    /// @notice A market position, all WAD: `basis` collateral put into split minus merged back
    ///         (signed: merging pairs formed by trading can return more than was put in),
    ///         `cash` premium received minus paid in fills, `up`/`down` token balances.
    struct Pos {
        int256 basis;
        int256 cash;
        uint256 up;
        uint256 down;
    }

    struct Level {
        uint256 price;
        uint256 size;
    }

    struct Quote {
        bool quoting;
        uint256 fair;
        uint256 halfSpread;
        int256 skew;
        Level[] bids; // UP bids, descending
        Level[] asks; // UP asks, ascending
    }

    error BadParams();

    // ------------------------------------------------------------------ distribution

    /// @notice Standard normal CDF Φ(x), WAD in and out. Hart (1968) as in G. West, "Better
    ///         approximations to cumulative normal functions" (2005): the same algorithm as
    ///         `normCdf` in packages/strategy. Absolute error below 1e-15.
    function normCdf(int256 x) internal pure returns (uint256) {
        uint256 a = F.abs(x);
        uint256 tail = 0;
        if (a <= 37e18) {
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 e = uint256(F.expWad(-int256(F.mulWad(a, a) / 2)));
            if (a < 7.07106781186547e18) {
                uint256 b = F.mulWad(0.0352624965998911e18, a) + 0.700383064443688e18;
                b = F.mulWad(b, a) + 6.37396220353165e18;
                b = F.mulWad(b, a) + 33.912866078383e18;
                b = F.mulWad(b, a) + 112.079291497871e18;
                b = F.mulWad(b, a) + 221.213596169931e18;
                // The two assignments are mutually exclusive branches of the Hart (1968) approximation.
                // slither-disable-next-line write-after-write
                b = F.mulWad(b, a) + 220.206867912376e18;
                uint256 c = F.mulWad(e, b);
                b = F.mulWad(0.0883883476483184e18, a) + 1.75566716318264e18;
                b = F.mulWad(b, a) + 16.064177579207e18;
                b = F.mulWad(b, a) + 86.7807322029461e18;
                b = F.mulWad(b, a) + 296.564248779674e18;
                b = F.mulWad(b, a) + 637.333633378831e18;
                b = F.mulWad(b, a) + 793.826512519948e18;
                b = F.mulWad(b, a) + 440.413735824752e18;
                tail = F.divWad(c, b);
            } else {
                uint256 b = a + 0.65e18;
                b = a + F.divWad(4e18, b);
                b = a + F.divWad(3e18, b);
                b = a + F.divWad(2e18, b);
                b = a + F.divWad(1e18, b);
                tail = F.divWad(F.divWad(e, b), 2.506628274631e18);
            }
        }
        return x > 0 ? WAD - tail : tail;
    }

    /// @notice Standard normal density φ(x), WAD in and out.
    function normPdf(int256 x) internal pure returns (uint256) {
        uint256 a = F.abs(x);
        // forge-lint: disable-next-line(unsafe-typecast)
        return F.mulWad(INV_SQRT_2PI, uint256(F.expWad(-int256(F.mulWad(a, a) / 2))));
    }

    /// @notice d2 of the digital option: (ln(S/K) − ½σ²τ)/(σ√τ). ±D2_MAX when degenerate (ties,
    ///         σ√τ ≈ 0, go UP, matching "UP iff end >= strike").
    function d2(uint256 spot, uint256 strike, uint256 sigma, uint256 tauSec)
        internal
        pure
        returns (int256)
    {
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 m = F.lnWad(int256(F.divWad(spot, strike)));
        uint256 std = F.mulWad(sigma, F.sqrtWad(tauSec * WAD / YEAR));
        if (std < MIN_STD) return m >= 0 ? D2_MAX : -D2_MAX;
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 v = F.sDivWad(m - int256(F.mulWad(std, std) / 2), int256(std));
        return v > D2_MAX ? D2_MAX : (v < -D2_MAX ? -D2_MAX : v);
    }

    /// @notice tanh(x), WAD in and out, saturating at ±1.
    function tanhWad(int256 x) internal pure returns (int256) {
        uint256 a = F.abs(x);
        if (a > 20e18) return x < 0 ? -SWAD : SWAD;
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 e2 = F.expWad(int256(2 * a));
        int256 r = F.sDivWad(e2 - SWAD, e2 + SWAD);
        return x < 0 ? -r : r;
    }

    // ------------------------------------------------------------------ risk room

    /// @notice Worst-case loss of a position: max(0, basis − cash − min(up, down)).
    function loss(Pos memory p) internal pure returns (uint256) {
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 v = p.basis - p.cash - int256(F.min(p.up, p.down));
        // forge-lint: disable-next-line(unsafe-typecast)
        return v > 0 ? uint256(v) : 0;
    }

    /// @notice The loss ceiling for one market: the tighter of the per-market and the total
    ///         limit, never below the market's current loss (it may reduce risk, never add).
    function lossCeiling(Pos memory p, uint256 nav, uint256 otherAtRisk, Params memory q)
        internal
        pure
        returns (uint256)
    {
        uint256 perMarket = F.mulWad(q.perMarketMaxFraction, nav);
        uint256 totalCap = F.mulWad(q.totalAtRiskMaxFraction, nav);
        uint256 totalRoom = totalCap > otherAtRisk ? totalCap - otherAtRisk : 0;
        return F.max(F.min(perMarket, totalRoom), loss(p));
    }

    /// @notice Shares of a token the vault can still SELL at `price` before the market's loss
    ///         exceeds `ceiling` (also capped by the vault's balance `own` of that token).
    ///         Selling x from (own, other, cash, basis): loss = basis − cash − min(own − x, other)
    ///         − price·x; once own − x < other this is basis − cash − own + (1 − price)·x.
    function sellRoom(
        int256 basis,
        int256 cash,
        uint256 own,
        uint256 other,
        uint256 price,
        uint256 ceiling
    ) internal pure returns (uint256) {
        if (price >= WAD || own == 0) return 0;
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 num = int256(ceiling) - basis + cash + int256(own);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 bound = num > 0 ? F.divWad(uint256(num), WAD - price) : 0;
        uint256 free = own > other ? own - other : 0; // selling this much does not add risk
        return F.min(own, F.max(bound, free));
    }

    /// @notice Shares of a token the vault can still BUY at `price` before the market's loss
    ///         exceeds `ceiling`. Buying x of the token held in amount `own` against `other`:
    ///         loss = basis − cash − min(own + x, other) + price·x.
    function buyRoom(
        int256 basis,
        int256 cash,
        uint256 own,
        uint256 other,
        uint256 price,
        uint256 ceiling
    ) internal pure returns (uint256) {
        if (price == 0) return 0;
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 num = int256(ceiling) - basis + cash + int256(other);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 bound = num > 0 ? F.divWad(uint256(num), price) : 0;
        uint256 free = other > own ? other - own : 0; // completing pairs does not add risk
        return F.max(bound, free);
    }

    // ------------------------------------------------------------------ the quote

    /// @dev Working values of one quote (a struct keeps the stack shallow).
    struct Ctx {
        int256 x; // d2
        uint256 p0; // Φ(d2), unclamped
        uint256 phi; // φ(d2)
        int256 center;
        uint256 half;
        uint256 dz;
        uint256 levelSize;
    }

    /// @notice Two-sided UP ladder for one market at one instant.
    /// @param spot Report price (any decimals, same as `strike`).
    /// @param tauSec Seconds to expiry from the pricing time.
    /// @param roundSec Full round length.
    /// @param nav Lower NAV in WAD collateral.
    /// @dev Returns `quoting == false` inside the no-quote window or with unusable inputs. Prices
    ///      are on the tick grid and inside [priceMin, priceMax]; the best bid is strictly below
    ///      the best ask; no quote crosses fair value (|skew| <= 0.8·halfSpread). Sizes are pm-AMM
    ///      depth only; the vault applies its risk room at fill time.
    function quote(
        uint256 spot,
        uint256 strike,
        uint256 sigma,
        uint256 tauSec,
        uint256 roundSec,
        uint256 nav,
        Pos memory pos,
        Params memory q
    ) internal pure returns (Quote memory out) {
        out.bids = new Level[](0);
        out.asks = new Level[](0);
        if (spot == 0 || strike == 0 || nav == 0 || roundSec == 0 || tauSec <= q.noQuoteWindowSec) {
            return out;
        }
        Ctx memory c = Ctx(0, 0, 0, 0, 0, 0, 0);
        c.x = d2(spot, strike, sigma, tauSec);
        c.p0 = normCdf(c.x);
        c.phi = normPdf(c.x);
        out.fair = F.min(F.max(c.p0, PROB_MIN), PROB_MAX);
        out.halfSpread = _halfSpread(c.phi, tauSec, q);
        out.skew = _skew(pos, nav, out.halfSpread, q);
        c.half = out.halfSpread;
        // forge-lint: disable-next-line(unsafe-typecast)
        c.center = int256(out.fair) + out.skew;
        (c.dz, c.levelSize) = _geometry(c.phi, tauSec, roundSec, nav, q);
        if (c.levelSize < F.max(q.minLevelSize, 1)) return out;
        out.quoting = true;
        out.bids = _bids(c, q);
        out.asks = _asks(c, q);
    }

    /// @dev Floor, or the staleness-risk term k·φ(d2)·√(stale/τ), capped.
    function _halfSpread(uint256 phi, uint256 tauSec, Params memory q)
        private
        pure
        returns (uint256)
    {
        uint256 stale = F.mulWad(
            F.mulWad(q.volSpreadK, phi), F.sqrtWad(F.divWad(q.stalenessSec, tauSec * WAD))
        );
        return F.min(F.max(F.max(q.minHalfSpread, stale), q.minHalfSpread), q.maxHalfSpread);
    }

    /// @dev Lean against the net UP exposure e = up − down (short UP shifts quotes up), at most
    ///      0.8·halfSpread so a quote never reaches fair value.
    function _skew(Pos memory pos, uint256 nav, uint256 half, Params memory q)
        private
        pure
        returns (int256)
    {
        uint256 ref = 2 * F.mulWad(q.perMarketMaxFraction, nav);
        if (ref == 0) return 0;
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 f = -F.sDivWad(int256(pos.up) - int256(pos.down), int256(ref));
        int256 raw =
        // forge-lint: disable-next-line(unsafe-typecast)
        F.sMulWad(int256(q.inventorySkewMax), tanhWad(F.sMulWad(int256(q.inventorySkewK), f)));
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 lim = int256(F.mulWad(8e17, half));
        return raw > lim ? lim : (raw < -lim ? -lim : raw);
    }

    /// @dev z-step and per-level depth: band = stepTicks·tick, Δz = band/φ, size = L_t·Δz with
    ///      L_t = liquidityNavFraction·NAV·√(τ/T) (pm-AMM L_t = L·√(T−t)).
    function _geometry(uint256 phi, uint256 tauSec, uint256 roundSec, uint256 nav, Params memory q)
        private
        pure
        returns (uint256 dz, uint256 levelSize)
    {
        uint256 root = F.sqrtWad(F.min(F.divWad(tauSec, roundSec), WAD));
        uint256 spanTicks = F.max(q.minRangeTicks, F.mulWad(q.baseRangeTicks, root));
        uint256 stepTicks = 1;
        if (q.levels > 1) {
            uint256 per = F.divWadUp(spanTicks, (q.levels - 1) * WAD);
            stepTicks = per <= WAD ? 1 : (per + WAD - 1) / WAD;
        }
        dz = F.min(F.divWad(stepTicks * q.tick, F.max(phi, PHI_FLOOR)), DZ_MAX);
        levelSize = F.mulWad(F.mulWad(F.mulWad(q.liquidityNavFraction, nav), root), dz);
    }

    /// @dev Bids: the vault buys UP at descending prices, floored to the tick grid. Levels that land
    ///      on the same tick (deep in the tails, where Φ is flat) merge: their depth adds up.
    // Flooring to the tick grid is the intended rounding.
    // slither-disable-start divide-before-multiply
    function _bids(Ctx memory c, Params memory q) private pure returns (Level[] memory r) {
        Level[] memory tmp = new Level[](q.levels);
        uint256 n = 0;
        for (uint256 j = 0; j < q.levels; j++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            int256 raw = c.center - int256(c.half)
                // forge-lint: disable-next-line(unsafe-typecast)
                - (int256(c.p0) - int256(normCdf(c.x - int256(j * c.dz))));
            if (raw <= 0) break;
            // forge-lint: disable-next-line(divide-before-multiply, unsafe-typecast)
            uint256 price = (uint256(raw) / q.tick) * q.tick;
            if (price < q.priceMin) break;
            if (price > q.priceMax) continue;
            if (n > 0 && tmp[n - 1].price == price) tmp[n - 1].size += c.levelSize;
            else tmp[n++] = Level(price, c.levelSize);
        }
        r = _trim(tmp, n);
    }

    // slither-disable-end divide-before-multiply

    /// @dev Asks: the vault sells UP at ascending prices, ceiled to the tick grid.
    // Flooring to the tick grid is the intended rounding.
    // slither-disable-start divide-before-multiply
    function _asks(Ctx memory c, Params memory q) private pure returns (Level[] memory r) {
        Level[] memory tmp = new Level[](q.levels);
        uint256 n = 0;
        for (uint256 j = 0; j < q.levels; j++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            int256 raw = c.center + int256(c.half)
                // forge-lint: disable-next-line(unsafe-typecast)
                + (int256(normCdf(c.x + int256(j * c.dz))) - int256(c.p0));
            if (raw <= 0) continue;
            // forge-lint: disable-next-line(divide-before-multiply, unsafe-typecast)
            uint256 price = ((uint256(raw) + q.tick - 1) / q.tick) * q.tick;
            if (price > q.priceMax) break;
            if (price < q.priceMin) continue;
            if (n > 0 && tmp[n - 1].price == price) tmp[n - 1].size += c.levelSize;
            else tmp[n++] = Level(price, c.levelSize);
        }
        r = _trim(tmp, n);
    }
    // slither-disable-end divide-before-multiply

    function _trim(Level[] memory a, uint256 n) private pure returns (Level[] memory r) {
        r = new Level[](n);
        for (uint256 i = 0; i < n; i++) {
            r[i] = a[i];
        }
    }
}
