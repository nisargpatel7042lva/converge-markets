// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Market} from "../../src/Market.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OutcomeToken} from "../../src/OutcomeToken.sol";
import {ReportV3} from "../../src/interfaces/IVerifierProxy.sol";
import {DataStreamsResolver} from "../../src/resolvers/DataStreamsResolver.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";

/// @notice Drives random sequences of user + oracle + admin actions against several markets
///         (round-proof and Data Streams resolvers, with and without a redeem fee).
///         Ghost variables track every collateral unit entering or leaving each market.
///         Exit failures and wrong payouts are recorded as `violations` (asserting inside the
///         handler would be swallowed because fail_on_revert = false); an invariant requires 0.
contract MarketHandler is Test {
    bytes32 internal constant STREAMS_ASSET = keccak256("ETH/USD");

    MarketFactory public factory;
    MockERC20 public usdc;
    MockAggregator public feed;
    DataStreamsResolver public streams;
    bytes32 public streamsFeedId;
    uint256 internal signerKey;
    address public guardian;
    address public admin;

    Market[] public markets;
    address[] public actors;

    mapping(address market => uint256) public ghostIn;
    mapping(address market => uint256) public ghostOut;
    mapping(address actor => uint256) public deposited;
    mapping(address actor => uint256) public withdrawn;
    /// @dev Outcome tokens received from other actors (each worth at most 1 collateral unit).
    mapping(address actor => uint256) public tokensReceived;
    uint256 public totalDeposited;
    uint256 public totalWithdrawn;
    uint256 public totalFeesClaimed;
    /// @dev Count of exits that reverted for an eligible holder or paid the wrong amount.
    uint256 public violations;
    string public lastViolation;
    /// @dev Coverage counters: prove the run reached every lifecycle path.
    uint256 public opened;
    uint256 public resolved;
    uint256 public invalidated;
    uint256 public redeems;

    uint16 internal phase = 1;
    uint64 internal aggRound = 1;

    struct Setup {
        MarketFactory factory;
        MockERC20 usdc;
        MockAggregator feed;
        DataStreamsResolver streams;
        bytes32 streamsFeedId;
        uint256 signerKey;
        address guardian;
        address admin;
    }

    constructor(Setup memory s, Market[] memory ms) {
        factory = s.factory;
        usdc = s.usdc;
        feed = s.feed;
        streams = s.streams;
        streamsFeedId = s.streamsFeedId;
        signerKey = s.signerKey;
        guardian = s.guardian;
        admin = s.admin;
        for (uint256 i; i < ms.length; ++i) {
            markets.push(ms[i]);
        }
        actors.push(makeAddr("actor0"));
        actors.push(makeAddr("actor1"));
        actors.push(makeAddr("actor2"));
    }

    function marketsLength() external view returns (uint256) {
        return markets.length;
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function _m(uint256 i) internal view returns (Market) {
        return markets[i % markets.length];
    }

    function _a(uint256 i) internal view returns (address) {
        return actors[i % actors.length];
    }

    function _violate(string memory why) internal {
        violations += 1;
        lastViolation = why;
    }

    // ------------------------------------------------------------------ user actions

    function split(uint256 ai, uint256 mi, uint256 amount) external {
        Market m = _m(mi);
        address a = _a(ai);
        amount = bound(amount, 1, 1_000_000e6);
        Market.State s = m.state();
        if (factory.paused() || (s != Market.State.CREATED && s != Market.State.OPEN)) return;
        usdc.mint(a, amount);
        vm.startPrank(a);
        usdc.approve(address(m), amount);
        m.split(amount);
        vm.stopPrank();
        ghostIn[address(m)] += amount;
        deposited[a] += amount;
        totalDeposited += amount;
    }

    /// @dev A holder of both sides must always be able to merge (any state, paused or not).
    function merge(uint256 ai, uint256 mi, uint256 amount) external {
        Market m = _m(mi);
        address a = _a(ai);
        uint256 maxAmt = _min(m.up().balanceOf(a), m.down().balanceOf(a));
        if (maxAmt == 0) return;
        amount = bound(amount, 1, maxAmt);
        uint256 before = usdc.balanceOf(a);
        vm.prank(a);
        try m.merge(amount) {
            uint256 got = usdc.balanceOf(a) - before;
            if (got != amount) _violate("merge paid wrong amount");
            ghostOut[address(m)] += got;
            withdrawn[a] += got;
            totalWithdrawn += got;
        } catch {
            _violate("merge reverted for a holder");
        }
    }

    function transferToken(uint256 fromI, uint256 toI, uint256 mi, bool upSide, uint256 amount)
        external
    {
        Market m = _m(mi);
        address from = _a(fromI);
        address to = _a(toI);
        if (from == to) return;
        OutcomeToken t = upSide ? m.up() : m.down();
        uint256 bal = t.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(from);
        t.transfer(to, amount);
        tokensReceived[to] += amount;
    }

    /// @dev After an outcome, a holder must always be able to redeem, and must receive exactly
    ///      the state-dependent entitlement minus the market's fee.
    function redeem(uint256 ai, uint256 mi) external {
        address a = _a(ai);
        // Scan from `mi` for a market with an outcome where the actor holds tokens.
        Market m;
        Market.State s;
        uint256 upBal;
        uint256 downBal;
        for (uint256 k; k < markets.length; ++k) {
            Market c = _m(mi + k);
            Market.State cs = c.state();
            if (cs == Market.State.CREATED || cs == Market.State.OPEN) continue;
            uint256 u = c.up().balanceOf(a);
            uint256 d = c.down().balanceOf(a);
            if (u == 0 && d == 0) continue;
            (m, s, upBal, downBal) = (c, cs, u, d);
            break;
        }
        if (address(m) == address(0)) return;
        uint256 entitled;
        if (s == Market.State.RESOLVED_UP) entitled = upBal;
        else if (s == Market.State.RESOLVED_DOWN) entitled = downBal;
        else entitled = (upBal + downBal) / 2;
        uint256 fee =
            factory.feeRecipient() == address(0) ? 0 : entitled * m.redeemFeeBps() / 10_000;
        uint256 before = usdc.balanceOf(a);
        vm.prank(a);
        try m.redeem() {
            redeems += 1;
            uint256 got = usdc.balanceOf(a) - before;
            if (got != entitled - fee) _violate("redeem paid wrong amount");
            if (m.up().balanceOf(a) != 0 || m.down().balanceOf(a) != 0) {
                _violate("redeem left tokens");
            }
            ghostOut[address(m)] += got;
            withdrawn[a] += got;
            totalWithdrawn += got;
        } catch {
            _violate("redeem reverted for a holder");
        }
    }

    function claimFees(uint256 mi) external {
        Market m = _m(mi);
        uint256 amount = m.feesAccrued();
        if (amount == 0 || factory.feeRecipient() == address(0)) return;
        m.claimFees();
        ghostOut[address(m)] += amount;
        totalFeesClaimed += amount;
    }

    // ------------------------------------------------------------------ oracle + time

    /// @dev Advances time up to 10 minutes. For every 15-minute boundary crossed, a healthy feed
    ///      publishes a round 0-59 s after it; about 1 in 7 boundaries is skipped (stale feed),
    ///      which drives the INVALID paths.
    function warp(uint256 secs) external {
        secs = bound(secs, 1, 10 minutes);
        uint256 from = vm.getBlockTimestamp();
        uint256 to = from + secs;
        uint256 b = from - (from % 15 minutes) + 15 minutes;
        for (; b <= to; b += 15 minutes) {
            if (uint256(keccak256(abi.encode(b, secs))) % 7 == 0) continue;
            uint256 at = b + (secs % 60);
            if (at > to) at = to;
            vm.warp(at);
            aggRound += 1;
            int256 px = int256(99e8 + (uint256(keccak256(abi.encode(b))) % 3) * 1e8);
            feed.setRound(phase, aggRound, px, at);
        }
        vm.warp(to);
    }

    /// @dev Publishes a feed round now with a random price.
    function pushRound(uint256 price) external {
        aggRound += 1;
        feed.setRound(phase, aggRound, int256(bound(price, 99e8, 101e8)), block.timestamp);
    }

    /// @dev Submits evidence for the boundary the market waits on and opens/resolves.
    function advance(uint256 mi, uint256 price) external {
        // Scan from `mi` for a market whose next boundary has passed.
        Market m;
        Market.State s;
        uint64 boundary;
        for (uint256 k; k < markets.length; ++k) {
            Market c = _m(mi + k);
            Market.State cs = c.state();
            uint64 bd;
            if (cs == Market.State.CREATED) bd = c.startTime();
            else if (cs == Market.State.OPEN) bd = c.endTime();
            else continue;
            if (block.timestamp < bd) continue;
            (m, s, boundary) = (c, cs, bd);
            break;
        }
        if (address(m) == address(0)) return;
        bytes memory evidence = address(m.resolver()) == address(streams)
            ? _streamsEvidence(boundary, price)
            : _roundEvidence(boundary);
        if (s == Market.State.CREATED) {
            try m.open(evidence) {} catch {}
        } else {
            try m.resolve(evidence) {} catch {}
        }
        _count(s, m.state());
    }

    function invalidate(uint256 mi) external {
        Market m = _m(mi);
        Market.State s = m.state();
        if (s != Market.State.CREATED && s != Market.State.OPEN) return;
        try m.invalidate() {} catch {}
        _count(s, m.state());
    }

    // ------------------------------------------------------------------ admin

    function togglePause(bool p) external {
        if (p && !factory.paused()) {
            vm.prank(guardian);
            factory.pause();
        } else if (!p && factory.paused()) {
            vm.prank(admin);
            factory.unpause();
        }
    }

    // ------------------------------------------------------------------ internals

    function _count(Market.State before, Market.State afterS) internal {
        if (before == afterS) return;
        if (afterS == Market.State.OPEN) opened += 1;
        else if (afterS == Market.State.INVALID) invalidated += 1;
        else resolved += 1;
    }

    function _roundEvidence(uint64 boundary) internal returns (bytes memory proof) {
        proof = _firstRoundProof(boundary);
        // Model a live feed: if nothing was published since the boundary and we are still
        // within the oracle delay, publish a round now.
        if (proof.length == 0 && block.timestamp <= uint256(boundary) + 120) {
            aggRound += 1;
            int256 px = int256(
                99e8 + (uint256(keccak256(abi.encode(block.timestamp, boundary))) % 3) * 1e8
            );
            feed.setRound(phase, aggRound, px, block.timestamp);
            proof = _firstRoundProof(boundary);
        }
    }

    /// @dev A signed report whose window [boundary, boundary] contains the boundary; empty when
    ///      a proposal already exists (wait for finalization) or the grace period has passed.
    function _streamsEvidence(uint64 boundary, uint256 price) internal view returns (bytes memory) {
        if (streams.proposal(STREAMS_ASSET, boundary).firstProposedAt != 0) return "";
        if (block.timestamp > uint256(boundary) + streams.grace()) return "";
        bytes memory reportData = abi.encode(
            ReportV3({
                feedId: streamsFeedId,
                validFromTimestamp: uint32(boundary),
                observationsTimestamp: uint32(boundary),
                nativeFee: 0,
                linkFee: 0,
                expiresAt: uint32(boundary) + 1 days,
                price: int192(int256(bound(price, 2990e18, 3010e18))),
                bid: 0,
                ask: 0
            })
        );
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(keccak256(reportData));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        bytes32[3] memory ctx;
        return abi.encode(ctx, reportData, abi.encodePacked(r, s, v));
    }

    /// @dev Finds the first round (current phase) with updatedAt >= boundary, if any.
    function _firstRoundProof(uint64 boundary) internal view returns (bytes memory) {
        uint64 first;
        for (uint64 r = aggRound; r >= 2; --r) {
            (,,, uint256 u,) = feed.getRoundData(feed.id(phase, r));
            if (u >= boundary) first = r;
            else break;
        }
        if (first == 0) return "";
        return abi.encode(feed.id(phase, first));
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
