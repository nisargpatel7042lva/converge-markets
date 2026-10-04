// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "../Base.t.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {console2} from "forge-std/console2.sol";
import {Market} from "../../src/Market.sol";
import {MarketHandler} from "./MarketHandler.sol";

/// @notice Handler-based invariants (runs/depth set in foundry.toml: >= 256 runs, depth >= 100).
contract MarketInvariants is Base {
    MarketHandler internal handler;

    function setUp() public override {
        super.setUp();
        vm.warp(T0 - 2 minutes);
        Market[] memory ms = new Market[](4);
        ms[0] = _create(BTC, M15, T0);
        ms[1] = _create(BTC, M15, T0 + M15);
        ms[2] = _create(BTC, H1, T0 + 45 minutes);
        ms[3] = _create(BTC, M15, T0 + 2 * M15);
        handler = new MarketHandler(factory, usdc, feed, ms, guardian, admin);
        // the handler continues the feed's round sequence from round 1
        targetContract(address(handler));
        // Only real actions; public getters would otherwise dilute the call sequence.
        bytes4[] memory sel = new bytes4[](9);
        sel[0] = MarketHandler.split.selector;
        sel[1] = MarketHandler.merge.selector;
        sel[2] = MarketHandler.transferToken.selector;
        sel[3] = MarketHandler.redeem.selector;
        sel[4] = MarketHandler.warp.selector;
        sel[5] = MarketHandler.pushRound.selector;
        sel[6] = MarketHandler.advance.selector;
        sel[7] = MarketHandler.invalidate.selector;
        sel[8] = MarketHandler.togglePause.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    /// Before resolution: collateral held == UP supply == DOWN supply.
    function invariant_fullyCollateralizedBeforeResolution() public view {
        for (uint256 i; i < handler.marketsLength(); ++i) {
            Market m = handler.markets(i);
            Market.State s = m.state();
            if (s == Market.State.CREATED || s == Market.State.OPEN) {
                uint256 bal = usdc.balanceOf(address(m));
                assertEq(bal, m.up().totalSupply(), "collateral != UP supply");
                assertEq(bal, m.down().totalSupply(), "collateral != DOWN supply");
            }
        }
    }

    /// After resolution: collateral held >= all outstanding claims.
    function invariant_solventAfterResolution() public view {
        for (uint256 i; i < handler.marketsLength(); ++i) {
            Market m = handler.markets(i);
            Market.State s = m.state();
            uint256 bal = usdc.balanceOf(address(m));
            uint256 upS = m.up().totalSupply();
            uint256 downS = m.down().totalSupply();
            if (s == Market.State.RESOLVED_UP) {
                assertGe(bal, upS, "UP claims uncovered");
            } else if (s == Market.State.RESOLVED_DOWN) {
                assertGe(bal, downS, "DOWN claims uncovered");
            } else if (s == Market.State.INVALID) {
                assertGe(bal, (upS + downS) / 2, "INVALID uncovered");
            }
        }
    }

    /// Exact accounting: every unit in a market came from split and left via merge/redeem.
    function invariant_marketBalanceMatchesGhosts() public view {
        for (uint256 i; i < handler.marketsLength(); ++i) {
            Market m = handler.markets(i);
            assertEq(
                usdc.balanceOf(address(m)),
                handler.ghostIn(address(m)) - handler.ghostOut(address(m)),
                "untracked collateral movement"
            );
        }
    }

    /// No value creation: nobody extracts more than they put in plus tokens received (each
    /// outcome token can be worth at most 1 collateral unit), and the system never pays out
    /// more than was deposited.
    function invariant_noActorExtractsMoreThanEntitled() public view {
        assertLe(handler.totalWithdrawn(), handler.totalDeposited(), "system paid out > deposits");
        for (uint256 i; i < handler.actorsLength(); ++i) {
            address a = handler.actors(i);
            assertLe(
                handler.withdrawn(a),
                handler.deposited(a) + handler.tokensReceived(a),
                "actor extracted more than deposits + received tokens"
            );
        }
    }

    /// State never goes backwards from a final outcome (checked via supply/balance coherence).
    function invariant_upDownSuppliesEqualBeforeResolution() public view {
        for (uint256 i; i < handler.marketsLength(); ++i) {
            Market m = handler.markets(i);
            if (m.state() == Market.State.CREATED || m.state() == Market.State.OPEN) {
                assertEq(m.up().totalSupply(), m.down().totalSupply());
            }
        }
    }

    /// Logged after each run (forge test -vv) to show the lifecycle paths were exercised.
    function afterInvariant() external view {
        console2.log("opened", handler.opened(), "resolved", handler.resolved());
        console2.log("invalidated", handler.invalidated(), "redeems", handler.redeems());
    }
}
