// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "../Base.t.sol";
import {Market} from "../../src/Market.sol";
import {MarketHandler} from "./MarketHandler.sol";

/// @notice Handler-based invariants (runs/depth set in foundry.toml: >= 256 runs, depth >= 100).
///         Markets: round-proof (BTC) and Data Streams (ETH), 15m and 1h, one with a 1% fee.
contract MarketInvariants is Base {
    MarketHandler internal handler;

    function setUp() public override {
        super.setUp();
        vm.warp(T0 - 2 minutes);
        Market[] memory ms = new Market[](6);
        ms[0] = _create(BTC, M15, T0);
        ms[1] = _create(BTC, M15, T0 + M15);
        ms[2] = _create(BTC, H1, T0 + 45 minutes);
        ms[3] = _create(ETH, M15, T0);
        ms[4] = _create(ETH, M15, T0 + M15);
        vm.startPrank(admin);
        factory.setRedeemFee(100);
        factory.setFeeRecipient(treasury);
        vm.stopPrank();
        ms[5] = _create(BTC, M15, T0 + 2 * M15); // 1% redeem fee
        handler = new MarketHandler(
            MarketHandler.Setup({
                factory: factory,
                usdc: usdc,
                feed: feed,
                streams: streamsResolver,
                streamsFeedId: ETH_FEED,
                signerKey: signerKey,
                guardian: guardian,
                admin: admin
            }),
            ms
        );
        targetContract(address(handler));
        // Only real actions; public getters would otherwise dilute the call sequence.
        bytes4[] memory sel = new bytes4[](10);
        sel[0] = MarketHandler.split.selector;
        sel[1] = MarketHandler.merge.selector;
        sel[2] = MarketHandler.transferToken.selector;
        sel[3] = MarketHandler.redeem.selector;
        sel[4] = MarketHandler.warp.selector;
        sel[5] = MarketHandler.pushRound.selector;
        sel[6] = MarketHandler.advance.selector;
        sel[7] = MarketHandler.invalidate.selector;
        sel[8] = MarketHandler.togglePause.selector;
        sel[9] = MarketHandler.claimFees.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    /// Exits never fail for an eligible holder and always pay exactly the entitlement (lower
    /// bound; the invariants below give the upper bounds).
    function invariant_exitsAlwaysWorkAndPayExactly() public view {
        assertEq(handler.violations(), 0, handler.lastViolation());
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
                assertEq(m.feesAccrued(), 0, "fees before outcome");
            }
        }
    }

    /// After resolution: collateral held >= outstanding claims + unclaimed fees.
    function invariant_solventAfterResolution() public view {
        for (uint256 i; i < handler.marketsLength(); ++i) {
            Market m = handler.markets(i);
            Market.State s = m.state();
            uint256 bal = usdc.balanceOf(address(m));
            uint256 upS = m.up().totalSupply();
            uint256 downS = m.down().totalSupply();
            uint256 fees = m.feesAccrued();
            if (s == Market.State.RESOLVED_UP) {
                assertGe(bal, upS + fees, "UP claims uncovered");
            } else if (s == Market.State.RESOLVED_DOWN) {
                assertGe(bal, downS + fees, "DOWN claims uncovered");
            } else if (s == Market.State.INVALID) {
                assertGe(bal, (upS + downS) / 2 + fees, "INVALID uncovered");
            }
        }
    }

    /// Exact accounting: every unit in a market came from split and left via merge, redeem or
    /// claimFees.
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
    /// outcome token is worth at most 1 collateral unit), and users + fee recipient together
    /// never receive more than was deposited.
    function invariant_noActorExtractsMoreThanEntitled() public view {
        assertLe(
            handler.totalWithdrawn() + handler.totalFeesClaimed(),
            handler.totalDeposited(),
            "system paid out > deposits"
        );
        assertEq(usdc.balanceOf(treasury), handler.totalFeesClaimed(), "fee leak");
        for (uint256 i; i < handler.actorsLength(); ++i) {
            address a = handler.actors(i);
            assertLe(
                handler.withdrawn(a),
                handler.deposited(a) + handler.tokensReceived(a),
                "actor extracted more than deposits + received tokens"
            );
        }
    }

    /// With INVARIANT_PATH_LOG=true (script/invariant-path-coverage.sh), appends this run's
    /// lifecycle counters to docs/evidence/phase-1/invariant-paths.log.
    function afterInvariant() external {
        if (!vm.envOr("INVARIANT_PATH_LOG", false)) return;
        vm.writeLine(
            "../docs/evidence/phase-1/invariant-paths.log",
            string.concat(
                vm.toString(handler.opened()),
                " ",
                vm.toString(handler.resolved()),
                " ",
                vm.toString(handler.invalidated()),
                " ",
                vm.toString(handler.redeems())
            )
        );
    }
}
