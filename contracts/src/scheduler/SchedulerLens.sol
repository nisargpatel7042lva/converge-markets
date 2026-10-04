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
        /// @dev Unsettled markets are scanned back this far.
        uint64 lookback;
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
        uint8 boundaryStatus; // IPriceResolver.Status, 255 if not due
        bool proposalPending; // Data Streams: a proposal exists for `boundary`
        Finding finding; // ROUND + PENDING boundaries only
        uint80 roundId; // FOUND: the proof to submit
    }

    uint256 internal constant MAX_SLOTS = 512;

    error TooManySlots();

    /// @notice Snapshot of every actionable slot (see contract notes). One call.
    function snapshot(Query calldata q) external view returns (Slot[] memory out) {
        Slot[] memory buf = new Slot[](MAX_SLOTS);
        uint256 n = 0;
        for (uint256 i; i < q.assets.length; ++i) {
            AssetQuery calldata a = q.assets[i];
            address resolver = address(q.factory.asset(a.assetId).resolver);
            for (uint256 j; j < a.durations.length; ++j) {
                uint64 d = a.durations[j];
                uint64 first = q.now_ - (q.now_ % d) + d; // first start strictly after now
                uint64 s = first + uint64(q.lookahead - 1) * d; // last upcoming start
                while (true) {
                    if (s < q.epoch) break;
                    if (s < first && s + q.lookback <= q.now_) break; // older than lookback
                    Slot memory slot = _slot(q, a, resolver, d, s);
                    // actionable: missing (create, or report missed) or a due, unsettled boundary
                    if (slot.market == address(0) || slot.boundary != 0) {
                        if (n == MAX_SLOTS) revert TooManySlots();
                        buf[n++] = slot;
                    }
                    if (s < d) break;
                    s -= d;
                }
            }
        }
        out = new Slot[](n);
        for (uint256 k; k < n; ++k) {
            out[k] = buf[k];
        }
    }

    // Only the needed tuple fields are used.
    // slither-disable-next-line unused-return
    function _slot(Query calldata q, AssetQuery calldata a, address resolver, uint64 d, uint64 s)
        private
        view
        returns (Slot memory slot)
    {
        slot.assetId = a.assetId;
        slot.duration = d;
        slot.startTime = s;
        slot.resolver = resolver;
        slot.state = 255;
        slot.boundaryStatus = 255;
        slot.market = q.factory.getMarket(a.assetId, d, s);
        if (slot.market == address(0)) return slot;
        Market m = Market(slot.market);
        slot.state = uint8(m.state());
        uint64 b;
        if (slot.state == uint8(Market.State.CREATED)) b = s;
        else if (slot.state == uint8(Market.State.OPEN)) b = s + d;
        else return slot;
        if (q.now_ < b) return slot;
        slot.boundary = b;
        (IPriceResolver.Status st,) = IPriceResolver(resolver).priceAt(a.assetId, b);
        slot.boundaryStatus = uint8(st);
        if (st != IPriceResolver.Status.PENDING) return slot;
        if (a.kind == ResolverKind.STREAMS) {
            slot.proposalPending =
                DataStreamsResolver(payable(resolver)).proposal(a.assetId, b).firstProposedAt != 0;
        } else {
            (IAggregatorV3 feed,) = ChainlinkRoundResolver(resolver).assetConfig(a.assetId);
            (slot.finding, slot.roundId) = firstRoundAtOrAfter(feed, b);
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
