import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/** All Prometheus metrics of the keeper, on one registry. */
export class Metrics {
  readonly registry = new Registry();

  readonly txSent = new Counter({
    name: "keeper_tx_sent_total",
    help: "Transactions sent, by kind and result",
    labelNames: ["kind", "result"],
    registers: [this.registry],
  });
  readonly txInclusionMs = new Histogram({
    name: "keeper_tx_inclusion_ms",
    help: "Milliseconds from the first broadcast to the receipt",
    labelNames: ["kind"],
    buckets: [100, 250, 500, 800, 1200, 2000, 4000, 8000, 20000],
    registers: [this.registry],
  });
  readonly txGas = new Counter({
    name: "keeper_tx_gas_limit_total",
    help: "Gas limit paid for (Monad bills the limit), by kind",
    labelNames: ["kind"],
    registers: [this.registry],
  });
  readonly txCostMon = new Counter({
    name: "keeper_tx_cost_mon_total",
    help: "MON spent on gas, by kind",
    labelNames: ["kind"],
    registers: [this.registry],
  });
  readonly quotesSent = new Counter({
    name: "keeper_quotes_sent_total",
    help: "Quote-maintaining actions sent (sigma updates, inventory splits and merges), by kind",
    labelNames: ["kind"],
    registers: [this.registry],
  });
  readonly quoteAgeBlocks = new Histogram({
    name: "keeper_quote_age_blocks",
    help: "Blocks between an order's pricing time (first block at or after it) and the block that executed it",
    buckets: [0, 1, 2, 3, 4, 6, 10, 20],
    registers: [this.registry],
  });
  readonly orderExecLatencyMs = new Histogram({
    name: "keeper_order_exec_latency_ms",
    help: "Milliseconds from seeing the pricing-time block to the execution receipt",
    buckets: [200, 400, 800, 1200, 2000, 4000, 8000],
    registers: [this.registry],
  });
  readonly fills = new Counter({
    name: "keeper_fills_total",
    help: "Orders executed, by outcome (filled, unfilled, simulated)",
    labelNames: ["outcome"],
    registers: [this.registry],
  });
  readonly filledUsd = new Counter({
    name: "keeper_filled_premium_usd_total",
    help: "Premium of filled orders in dollars",
    registers: [this.registry],
  });
  readonly errors = new Counter({
    name: "keeper_errors_total",
    help: "Errors, by kind",
    labelNames: ["kind"],
    registers: [this.registry],
  });
  readonly halts = new Counter({
    name: "keeper_halts_total",
    help: "Quotes pulled, by reason",
    labelNames: ["reason"],
    registers: [this.registry],
  });
  readonly haltBlocks = new Histogram({
    name: "keeper_halt_latency_blocks",
    help: "Blocks between the first block seen after the trigger and the block that included the halt",
    buckets: [0, 1, 2, 3, 5, 10],
    registers: [this.registry],
  });
  readonly violations = new Counter({
    name: "keeper_quote_violations_total",
    help: "Crossed, off-grid or out-of-bounds levels seen in the live ladder",
    labelNames: ["kind"],
    registers: [this.registry],
  });
  readonly loopMs = new Histogram({
    name: "keeper_loop_duration_ms",
    help: "Duration of a slow tick",
    buckets: [10, 50, 100, 250, 500, 1000, 2000, 5000],
    registers: [this.registry],
  });
  readonly alerts = new Counter({
    name: "keeper_alerts_total",
    help: "Alerts raised, by key",
    labelNames: ["key"],
    registers: [this.registry],
  });

  readonly halted = new Gauge({
    name: "keeper_halted",
    help: "1 while the keeper has pulled its quotes",
    registers: [this.registry],
  });
  readonly killed = new Gauge({
    name: "keeper_killed",
    help: "1 while the kill switch is on",
    registers: [this.registry],
  });
  readonly vaultPaused = new Gauge({
    name: "keeper_vault_paused",
    help: "1 while the vault is paused (guardian, owner or breaker)",
    registers: [this.registry],
  });
  readonly mode = new Gauge({
    name: "keeper_mode",
    help: "1 for the running mode",
    labelNames: ["mode"],
    registers: [this.registry],
  });
  readonly block = new Gauge({
    name: "keeper_block_height",
    help: "Latest block seen",
    registers: [this.registry],
  });
  readonly blockLagMs = new Gauge({
    name: "keeper_block_lag_ms",
    help: "Milliseconds since the last block",
    registers: [this.registry],
  });
  readonly rpcRequests = new Counter({
    name: "keeper_rpc_requests_total",
    help: "JSON-RPC calls made, by method",
    labelNames: ["method"],
    registers: [this.registry],
  });
  readonly rpcErrors = new Gauge({
    name: "keeper_rpc_consecutive_errors",
    help: "Consecutive failed RPC calls",
    registers: [this.registry],
  });
  readonly price = new Gauge({
    name: "keeper_reference_price",
    help: "Reference price (median of the healthy sources)",
    labelNames: ["asset"],
    registers: [this.registry],
  });
  readonly priceHealthy = new Gauge({
    name: "keeper_price_healthy",
    help: "1 when the reference price may be used",
    labelNames: ["asset"],
    registers: [this.registry],
  });
  readonly sourceHealthy = new Gauge({
    name: "keeper_source_healthy",
    help: "1 when a price source is fresh",
    labelNames: ["asset", "source"],
    registers: [this.registry],
  });
  readonly sourceAgeMs = new Gauge({
    name: "keeper_source_age_ms",
    help: "Age of the last tick of a source",
    labelNames: ["asset", "source"],
    registers: [this.registry],
  });
  readonly shockBps = new Gauge({
    name: "keeper_price_shock_bps",
    help: "Largest recent move of the median (bps)",
    labelNames: ["asset"],
    registers: [this.registry],
  });
  readonly divergenceBps = new Gauge({
    name: "keeper_source_divergence_bps",
    help: "Largest distance of a source from the median (bps)",
    labelNames: ["asset"],
    registers: [this.registry],
  });
  readonly chainlinkBps = new Gauge({
    name: "keeper_chainlink_distance_bps",
    help: "Distance of the median from Chainlink (bps)",
    labelNames: ["asset"],
    registers: [this.registry],
  });
  readonly sigma = new Gauge({
    name: "keeper_sigma",
    help: "Annual volatility stored in the vault",
    labelNames: ["asset"],
    registers: [this.registry],
  });
  readonly sigmaEstimate = new Gauge({
    name: "keeper_sigma_estimate",
    help: "The keeper's own volatility estimate",
    labelNames: ["asset"],
    registers: [this.registry],
  });
  readonly eligibleMarkets = new Gauge({
    name: "keeper_eligible_markets",
    help: "Open rounds the keeper should keep quoted",
    registers: [this.registry],
  });
  readonly tradableMarkets = new Gauge({
    name: "keeper_tradable_markets",
    help: "Eligible rounds that are tradable now",
    registers: [this.registry],
  });
  readonly tradable = new Gauge({
    name: "keeper_market_tradable",
    help: "1 when a round is tradable",
    labelNames: ["market"],
    registers: [this.registry],
  });
  readonly inventory = new Gauge({
    name: "keeper_inventory_tokens",
    help: "Outcome tokens held by the vault",
    labelNames: ["market", "side"],
    registers: [this.registry],
  });
  readonly lossRatio = new Gauge({
    name: "keeper_market_loss_ratio",
    help: "Worst-case loss over the per-market ceiling",
    labelNames: ["market"],
    registers: [this.registry],
  });
  readonly totalLossRatio = new Gauge({
    name: "keeper_total_loss_ratio",
    help: "Worst-case loss of all rounds over the total ceiling",
    registers: [this.registry],
  });
  readonly excessFraction = new Gauge({
    name: "keeper_excess_nav_fraction",
    help: "Spare tokens over the lower NAV",
    registers: [this.registry],
  });
  readonly pnlRealized = new Gauge({
    name: "keeper_pnl_realized_usd",
    help: "Realized P&L of resolved rounds",
    registers: [this.registry],
  });
  readonly pnlUnrealized = new Gauge({
    name: "keeper_pnl_unrealized_usd",
    help: "Unrealized P&L of open rounds at fair",
    registers: [this.registry],
  });
  readonly navLower = new Gauge({
    name: "keeper_vault_nav_lower_usd",
    help: "Vault lower NAV",
    registers: [this.registry],
  });
  readonly navAgeSec = new Gauge({
    name: "keeper_vault_nav_age_seconds",
    help: "Age of the vault's stored NAV",
    registers: [this.registry],
  });
  readonly sigmaAgeSec = new Gauge({
    name: "keeper_sigma_age_seconds",
    help: "Age of the sigma stored in the vault",
    labelNames: ["asset"],
    registers: [this.registry],
  });
  readonly pendingOrders = new Gauge({
    name: "keeper_pending_orders",
    help: "Orders waiting to be executed",
    registers: [this.registry],
  });
  readonly keeperBalanceMon = new Gauge({
    name: "keeper_wallet_balance_mon",
    help: "Keeper wallet balance in MON",
    registers: [this.registry],
  });
  readonly lastTickTs = new Gauge({
    name: "keeper_last_tick_timestamp_seconds",
    help: "Unix time of the last slow tick",
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: "keeper_process_" });
  }
}
