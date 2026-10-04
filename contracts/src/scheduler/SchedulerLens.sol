// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MarketFactory} from "../MarketFactory.sol";
import {Market} from "../Market.sol";
import {IPriceResolver} from "../interfaces/IPriceResolver.sol";
import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {ChainlinkRoundResolver} from "../resolvers/ChainlinkRoundResolver.sol";
import {DataStreamsResolver} from "../resolvers/DataStreamsResolver.sol";

/// @title SchedulerLens
/// @notice Read-only aggregator for the scheduler (Phase 2). Chainlink CRE allows only 15 EVM
///         reads per workflow execution (docs.chain.link/cre/service-quotas), so the whole
///         planning snapshot -- including the round-proof search for MON-style boundaries -- is
///         computed here in ONE eth_call. Stateless and permissionless; never used onchain.
/// @dev Returns only slots the planner can act on: missing markets (to create, or to report as
///      missed) and markets whose next boundary has passed but which are still CREATED/OPEN.
///      Settled and not-yet-due markets are omitted, so a long lookback (deep sweep) stays small.
// View-only aggregator: external calls in loops are its purpose (one eth_call, never a tx).
// forge-lint: disable-start(calls-loop, require-revert-in-loop, unused-return)
contract SchedulerLens {
    enum ResolverKind {
        STREAMS,
        ROUND
    }

    /// @dev Round search outcome (mirrors packages/sdk/src/rounds.ts RoundFinding).
    enum Finding {
        NONE, // not searched (not a round boundary / not due / not pending)
        FOUND,
        NOT_YET,
        FIRST_OF_PHASE,
        MISSING_ROUND
    }

    struct AssetQuery {
        bytes32 assetId;
        ResolverKind kind;
        uint64[] durations;
    }

    struct Query {
        MarketFactory factory;
        AssetQuery[] assets;
        uint64 now_;
        uint8 lookahead;
        /// @dev Unsettled markets are scanned back this far (deep sweep).
        uint64 lookback;
        /// @dev Missing past rounds (missed creates) are only reported back this far, which bounds
        ///      the response size at go-live and after long outages.
        uint64 missedLookback;
        /// @dev Ignore rounds starting before this time (scheduler go-live).
        uint64 epoch;
    }

    struct Slot {
        bytes32 assetId;
        uint64 duration;
        uint64 startTime;
        address market; // zero if missing
        uint8 state; // Market.State, 255 if missing
        address resolver;
        uint64 boundary; // 0 if not due
        uint8 boundaryStatus; // IPriceResolver.Status; 255 not due; 254 oracle call reverted
        bool proposalPending; // Data Streams: a proposal exists for `boundary`
        Finding finding; // ROUND + PENDING boundaries only
        uint80 roundId; // FOUND: the proof to submit
    }

    uint256 internal constant MAX_SLOTS = 256;
    /// @notice Gas forwarded to the per-slot oracle evaluation. Bounds what one broken or
    ///         malicious resolver/feed can burn; a mainnet round search costs well under this.
    uint256 public constant ORACLE_GAS = 1_500_000;
    /// @notice boundaryStatus value when the resolver/feed evaluation failed for this slot only
    ///         (revert, out of gas, or undecodable return data).
    uint8 public constant STATUS_ORACLE_ERROR = 254;

    struct OracleView {
        uint8 status;
        bool proposalPending;
        Finding finding;
        uint80 roundId;
    }

    /// @dev Per-series cursor for the round-robin pass over past slots.
    struct Cursor {
        bytes32 assetId;
        ResolverKind kind;
        address resolver;
        uint64 d;
        uint64 first;
        uint64 next; // next past start to visit (newest first)
        bool done;
    }

    /// @notice Snapshot of every actionable slot (see contract notes). One call.
    /// @dev Pass 1 returns upcoming missing markets (creates) for every series; pass 2 visits past
    ///      slots newest-first, round-robin across series, so truncation (at MAX_SLOTS, flagged by
    ///      `truncated`) cannot starve a whole asset. Each slot's oracle evaluation runs in a
    ///      gas-capped self-call: a reverting, gas-burning or malformed resolver/feed flags only its
    ///      own slots (STATUS_ORACLE_ERROR).
    function snapshot(Query calldata q) external view returns (Slot[] memory out, bool truncated) {
        Slot[] memory buf = new Slot[](MAX_SLOTS);
        uint256 n = 0;
        uint256 series = 0;
        for (uint256 i = 0; i < q.assets.length; ++i) {
            series += q.assets[i].durations.length;
        }
        Cursor[] memory cur = new Cursor[](series);
        uint256 c = 0;
        // Pass 1: upcoming starts (strictly after now), for every series.
        for (uint256 i = 0; i < q.assets.length; ++i) {
            AssetQuery calldata a = q.assets[i];
            address resolver = address(q.factory.asset(a.assetId).resolver);
            for (uint256 j = 0; j < a.durations.length; ++j) {
                uint64 d = a.durations[j];
                uint64 first = q.now_ - (q.now_ % d) + d; // first start strictly after now
                cur[c] = Cursor(a.assetId, a.kind, resolver, d, first, first - d, first < d);
                (n, truncated) = _upcoming(q, cur[c++], buf, n);
                if (truncated) return (_trim(buf, n), true);
            }
        }
        // Pass 2: past starts, one per series per round, until every series is exhausted.
        bool any = true;
        while (any) {
            any = false;
            for (uint256 k = 0; k < series; ++k) {
                if (cur[k].done) continue;
                bool visited;
                (n, truncated, visited) = _past(q, cur[k], buf, n);
                if (truncated) return (_trim(buf, n), true);
                any = any || visited;
            }
        }
        out = _trim(buf, n);
    }

    /// @dev Visits the next past start of one series (advancing its cursor) and appends it if
    ///      actionable. `visited` is false once the series is exhausted.
    function _past(Query calldata q, Cursor memory x, Slot[] memory buf, uint256 n)
        private
        view
        returns (uint256, bool truncated, bool visited)
    {
        uint64 s = x.next;
        if (s < q.epoch || s + q.lookback <= q.now_) {
            x.done = true;
            return (n, false, false);
        }
        if (s < x.d) x.done = true;
        else x.next = s - x.d;
        Slot memory slot = _slot(q.factory, x, s, q.now_);
        bool report = slot.market == address(0) && s + q.missedLookback > q.now_;
        if (report || slot.boundary != 0) {
            if (n == MAX_SLOTS) return (n, true, true);
            buf[n++] = slot;
        }
        return (n, false, true);
    }

    function _trim(Slot[] memory buf, uint256 n) private pure returns (Slot[] memory out) {
        out = new Slot[](n);
        for (uint256 k = 0; k < n; ++k) {
            out[k] = buf[k];
        }
    }

    /// @dev Appends the upcoming missing markets of one series (newest first).
    function _upcoming(Query calldata q, Cursor memory x, Slot[] memory buf, uint256 n)
        private
        view
        returns (uint256, bool)
    {
        for (uint64 k = q.lookahead; k > 0; --k) {
            uint64 s = x.first + (k - 1) * x.d;
            if (s < q.epoch) continue;
            Slot memory slot = _slot(q.factory, x, s, q.now_);
            if (slot.market == address(0)) {
                if (n == MAX_SLOTS) return (n, true);
                buf[n++] = slot;
            }
        }
        return (n, false);
    }

    function _slot(MarketFactory factory, Cursor memory x, uint64 s, uint64 now_)
        private
        view
        returns (Slot memory slot)
    {
        (bytes32 assetId, address resolver, uint64 d) = (x.assetId, x.resolver, x.d);
        slot.assetId = assetId;
        slot.duration = d;
        slot.startTime = s;
        slot.resolver = resolver;
        slot.state = 255;
        slot.boundaryStatus = 255;
        slot.market = factory.getMarket(assetId, d, s);
        if (slot.market == address(0)) return slot;
        Market m = Market(slot.market);
        slot.state = uint8(m.state());
        uint64 b;
        if (slot.state == uint8(Market.State.CREATED)) b = s;
        else if (slot.state == uint8(Market.State.OPEN)) b = s + d;
        else return slot;
        if (now_ < b) return slot;
        slot.boundary = b;
        // Isolated and gas-capped: any failure inside (revert, OOG, bad return data) lands here.
        try this.oracleView{gas: ORACLE_GAS}(resolver, x.kind, assetId, b) returns (
            OracleView memory v
        ) {
            slot.boundaryStatus = v.status;
            slot.proposalPending = v.proposalPending;
            (slot.finding, slot.roundId) = (v.finding, v.roundId);
        } catch {
            slot.boundaryStatus = STATUS_ORACLE_ERROR;
        }
    }

    /// @notice Oracle evaluation of one due boundary (called by `snapshot` via a gas-capped
    ///         self-call; reverts on any resolver/feed failure, including out-of-range enums).
    // Only the needed tuple fields are used.
    // slither-disable-next-line unused-return
    function oracleView(address resolver, ResolverKind kind, bytes32 assetId, uint64 b)
        external
        view
        returns (OracleView memory v)
    {
        (IPriceResolver.Status st,) = IPriceResolver(resolver).priceAt(assetId, b);
        v.status = uint8(st);
        if (st != IPriceResolver.Status.PENDING) return v;
        if (kind == ResolverKind.STREAMS) {
            v.proposalPending =
                DataStreamsResolver(payable(resolver)).proposal(assetId, b).firstProposedAt != 0;
        } else {
            (IAggregatorV3 feed,) = ChainlinkRoundResolver(resolver).assetConfig(assetId);
            (v.finding, v.roundId) = firstRoundAtOrAfter(feed, b);
        }
    }

    /// @notice First round of the proxy's CURRENT phase with updatedAt >= t (binary search; the
    ///         same rule ChainlinkRoundResolver verifies).
    // Only the needed tuple fields are used.
    // slither-disable-next-line unused-return
    function firstRoundAtOrAfter(IAggregatorV3 feed, uint64 t)
        public
        view
        returns (Finding, uint80)
    {
        (uint80 latestId,,, uint256 latestUpdatedAt,) = feed.latestRoundData();
        if (latestUpdatedAt < t) return (Finding.NOT_YET, 0);
        uint80 phase = latestId >> 64;
        uint64 lo = 1;
        // Intentional truncation: low 64 bits = aggregator round id. Invariant: `hi` has updatedAt >= t.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 hi = uint64(latestId);
        while (lo < hi) {
            uint64 mid = lo + (hi - lo) / 2;
            (bool ok, uint256 u) = _updatedAt(feed, (phase << 64) | mid);
            if (!ok) return (Finding.MISSING_ROUND, (phase << 64) | mid);
            if (u >= t) hi = mid;
            else lo = mid + 1;
        }
        uint80 id = (phase << 64) | hi;
        (bool ok2,) = _updatedAt(feed, id);
        if (!ok2) return (Finding.MISSING_ROUND, id);
        if (hi == 1) return (Finding.FIRST_OF_PHASE, id);
        return (Finding.FOUND, id);
    }

    // Only the needed tuple fields are used.
    // slither-disable-next-line unused-return
    function _updatedAt(IAggregatorV3 feed, uint80 id) private view returns (bool, uint256) {
        try feed.getRoundData(id) returns (uint80, int256, uint256, uint256 u, uint80) {
            return (u != 0, u);
        } catch {
            return (false, 0);
        }
    }
}
// forge-lint: disable-end(calls-loop, require-revert-in-loop, unused-return)
