/* Event lists and the config renderer (no side effects, imported by the tests). */
const MARKET_PARAMS =
  "(address factory, bytes32 assetId, address resolver, address collateral, address up, address down, uint64 startTime, uint64 endTime, uint16 redeemFeeBps)";

/** Events by contract. Signatures are copied from contracts/src; indexer/test/abi-parity.test.ts checks them. */
export const CONTRACTS = {
  MarketFactory: [
    "AssetSet(bytes32 indexed assetId, address resolver, string label, bool enabled)",
    `MarketCreated(address indexed market, bytes32 indexed assetId, uint64 indexed startTime, uint64 duration, ${MARKET_PARAMS} params)`,
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
    "VenueSet(address indexed venue)",
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
 *   venue:string, vaultBlock:number, rpc?:string}} o
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
  if (o.rpc) {
    lines.push("    rpc:");
    lines.push(`      - url: ${o.rpc}`);
    lines.push("        for: sync");
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
  return `${header}
export interface VaultDefaults {
  keeper: string | undefined;
  tvlCap: bigint;
  performanceFeeBps: number;
}

export const VAULT_DEFAULTS: Record<number, VaultDefaults> = {
${rows}
};
`;
}
