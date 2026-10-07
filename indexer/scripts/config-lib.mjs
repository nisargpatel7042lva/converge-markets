/* Event lists and the config renderer (no side effects, imported by the tests). */
const MARKET_PARAMS =
  "(address factory, bytes32 assetId, address resolver, address collateral, address up, address down, uint64 startTime, uint64 endTime, uint16 redeemFeeBps)";

/** Events by contract. Signatures are copied from contracts/src; indexer/test/abi-parity.test.ts checks them. */
export const CONTRACTS = {
  MarketFactory: [
    "AssetSet(bytes32 indexed assetId, address resolver, string label, bool enabled)",
    `MarketCreated(address indexed market, bytes32 indexed assetId, uint64 indexed startTime, uint64 duration, ${MARKET_PARAMS} params)`,
  ],
  // Liquidity-as-a-service (ADR-008). The registry is a second market factory: its MarketCreated has
  // the factory's exact shape, and the rest of its events describe partners, bonds and governance.
  PartnerRegistry: [
    `MarketCreated(address indexed market, bytes32 indexed assetId, uint64 indexed startTime, uint64 duration, ${MARKET_PARAMS} params)`,
    "PartnerMarketCreated(address indexed market, address indexed partner, bytes32 indexed assetId, int256 strike, uint64 startTime, uint64 endTime, address resolver, uint16 feeShareBps)",
    "PartnerApproved(address indexed partner, uint256 exposureCap, uint16 feeShareBps, bytes32[] assets)",
    "PartnerTermsSet(address indexed partner, uint256 exposureCap, uint16 feeShareBps)",
    "PartnerSuspended(address indexed partner, bool suspended, address indexed by)",
    "BondPosted(address indexed partner, uint256 amount, uint256 bond)",
    "BondWithdrawalRequested(address indexed partner, uint256 amount, uint64 withdrawableAt)",
    "BondWithdrawalCancelled(address indexed partner, uint256 amount)",
    "BondWithdrawn(address indexed partner, uint256 amount)",
    "Slashed(address indexed partner, uint256 amount, address recipient, bytes32 reason)",
    "MarketVoided(address indexed market, address indexed partner, bytes32 reason)",
    "FeesCollected(address indexed market, address indexed partner, uint256 partnerShare, uint256 treasuryShare)",
  ],
  Market: [
    "Split(address indexed account, uint256 amount)",
    "Merged(address indexed account, uint256 amount)",
    "Opened(int256 strike)",
    "Resolved(uint8 indexed outcome, int256 strike, int256 endPrice)",
    "Invalidated(uint64 indexed boundary)",
    "Redeemed(address indexed account, uint256 upBurned, uint256 downBurned, uint256 payout, uint256 fee)",
  ],
  OutcomeToken: ["Transfer(address indexed from, address indexed to, uint256 value)"],
  ConvergeVault: [
    "DepositRequested(uint256 indexed epochId, address indexed owner, uint256 assets)",
    "RedeemRequested(uint256 indexed epochId, address indexed owner, uint256 shares, bool requeued)",
    "EpochSettled(uint256 indexed epochId, uint256 navLower, uint256 navUpper, uint256 supplyBefore, uint256 sharesMinted, uint256 sharesBurned, uint256 assetsPaid, uint256 depositsAccepted, bool depositRejected)",
    "EpochExpired(uint256 indexed epochId, uint256 depositsRefunded, uint256 redeemShares)",
    "DepositClaimed(uint256 indexed epochId, address indexed owner, address receiver, uint256 shares, uint256 refunded)",
    "RedeemClaimed(uint256 indexed epochId, address indexed owner, address receiver, uint256 assets, uint256 requeuedShares)",
    "NavSnapshot(uint256 navLower, uint256 navUpper, uint256 ppsLower, uint256 supply, bool settlement)",
    "PerformanceFee(uint256 feeShares, uint256 feeAssets, uint256 newHwm)",
    "Fill(address indexed market, bool upToken, bool vaultSells, uint256 units, uint256 premium, address indexed taker, int256 basis, int256 cash)",
    "InventorySplit(address indexed market, uint256 amount)",
    "InventoryMerged(address indexed market, uint256 amount)",
    "MarketRegistered(address indexed market, bytes32 indexed assetId)",
    "MarketUnregistered(address indexed market)",
    "QuotingPaused(address indexed by)",
    "QuotingResumed(address indexed by)",
    "QuotingHalted(address indexed keeper, bytes32 reason)",
    "QuotingUnhalted(address indexed keeper)",
    "BreakerTripped(uint256 ppsLower, uint256 dayStartPps)",
    "TvlCapSet(uint256 cap)",
    "FeeSet(uint256 bps)",
    "KeeperSet(address indexed keeper)",
    "VenueProposed(address indexed venue, uint64 eta)",
    "VenueSet(address indexed venue)",
    "PartnerRegistrySet(address indexed registry)",
    "Transfer(address indexed from, address indexed to, uint256 value)",
  ],
  ForwardVenue: [
    "OrderPlaced(uint256 indexed id, address indexed taker, address indexed market, uint8 kind, uint256 shares, uint256 limit, uint64 execAt, uint256 reward)",
    "OrderExecuted(uint256 indexed id, address indexed executor, uint256 filled, uint256 premium, uint256 reportPrice, uint32 reportValidFrom, uint32 reportObservations)",
    "OrderExpired(uint256 indexed id, address indexed caller)",
  ],
};

/**
 * @param {{chainId:number, header:string, factory:string, factoryBlock:number, vault:string,
 *   venue:string, vaultBlock:number, rpc?:string, pollingMs?:number, maxBlockRange?:number, rollbackOnReorg?:boolean}} o
 */
export function render(o) {
  const lines = [];
  lines.push(o.header.trimEnd());
  lines.push("name: converge-indexer");
  lines.push(
    "description: Converge Markets read side (markets, trades, positions, vault NAV/APY, stats)",
  );
  // Addresses are lowercased everywhere so ids never depend on checksum casing.
  lines.push("address_format: lowercase");
  if (o.rollbackOnReorg === false) lines.push("rollback_on_reorg: false");
  // Every handler records the transaction hash.
  lines.push("field_selection:");
  lines.push("  transaction_fields:");
  lines.push("    - hash");
  lines.push("contracts:");
  for (const [name, events] of Object.entries(CONTRACTS)) {
    lines.push(`  - name: ${name}`);
    lines.push("    events:");
    for (const e of events) lines.push(`      - event: "${e}"`);
  }
  lines.push("chains:");
  lines.push(`  - id: ${o.chainId}`);
  lines.push(`    start_block: ${o.factoryBlock}`);
  // Bounded evidence runs on a slow RPC source: stop at this block (the chain is read to here only).
  if (o.endBlock) lines.push(`    end_block: ${o.endBlock}`);
  if (o.rpc) {
    lines.push("    rpc:");
    lines.push(`      - url: ${o.rpc}`);
    lines.push("        for: sync");
    // Default 1000 ms; the local anvil chain makes ~4 blocks/s, so poll faster than the block time.
    lines.push(`        polling_interval: ${o.pollingMs ?? 250}`);
    if (o.maxBlockRange) {
      // The public Monad testnet RPC rejects eth_getLogs ranges above 100 blocks: do not start big and halve.
      lines.push(`        initial_block_interval: ${o.maxBlockRange}`);
      lines.push(`        interval_ceiling: ${o.maxBlockRange}`);
    }
  }
  lines.push("    contracts:");
  lines.push("      - name: MarketFactory");
  lines.push(`        address: "${o.factory}"`);
  lines.push(`        start_block: ${o.factoryBlock}`);
  lines.push("      - name: ConvergeVault");
  lines.push(`        address: "${o.vault}"`);
  lines.push(`        start_block: ${o.vaultBlock}`);
  lines.push("      - name: ForwardVenue");
  lines.push(`        address: "${o.venue}"`);
  lines.push(`        start_block: ${o.vaultBlock}`);
  lines.push(
    "      # Market and OutcomeToken have no address: contractRegister adds them on MarketCreated.",
  );
  lines.push("      - name: Market");
  lines.push("      - name: OutcomeToken");
  lines.push(
    "      # The PartnerRegistry has no address either: the vault announces it (PartnerRegistrySet).",
  );
  lines.push("      - name: PartnerRegistry");
  return lines.join("\n") + "\n";
}

/**
 * Initial vault state that no event carries (the constructor sets it). Generated per chain from
 * deployments/<net>.json; indexer/test + the reconcile script verify it against the chain.
 * performanceFeeBps is the contract's field initializer (ConvergeVault: `uint16 public
 * performanceFeeBps = 1_000`).
 * @param {{chainId:number, keeper:string|undefined, tvlCap:string|number|undefined}[]} entries
 */
export function renderDefaults(entries, header) {
  const rows = entries
    .map(
      (e) =>
        `  ${e.chainId}: { keeper: ${e.keeper ? JSON.stringify(e.keeper.toLowerCase()) : "undefined"}, tvlCap: ${BigInt(e.tvlCap ?? 0)}n, performanceFeeBps: 1000 },`,
    )
    .join("\n");
  const sys = entries
    .map(
      (e) =>
        `  ${e.chainId}: [${(e.systemAddresses ?? []).map((a) => JSON.stringify(a.toLowerCase())).join(", ")}],`,
    )
    .join("\n");
  return `${header}
export interface VaultDefaults {
  keeper: string | undefined;
  tvlCap: bigint;
  performanceFeeBps: number;
}

export const VAULT_DEFAULTS: Record<number, VaultDefaults> = {
${rows}
};

/**
 * Every vault and venue ever deployed on the chain (current and archived deployments): holders of
 * outcome tokens that are protocol contracts, never users. The pre-v3 vaults' fills are not indexed,
 * so without this list their takers would inherit the old vault's split cost.
 */
export const SYSTEM_ADDRESSES: Record<number, string[]> = {
${sys}
};
`;
}
