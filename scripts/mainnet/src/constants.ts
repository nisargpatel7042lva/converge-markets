/**
 * Facts about Monad mainnet (chain 143) that the deployment depends on. Every address is from
 * docs/EXTERNAL.md and was read from the chain on the date shown there; the deployer re-checks that
 * code exists at each of them before it sends anything.
 */
import type { Address } from "viem";

export const MAINNET_CHAIN_ID = 143;

export const USDC: Address = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603"; // native USDC (Circle), 6 dp
/** Chainlink Data Streams VerifierProxy 2.0.0 (s_feeManager() is 0 today: no fee is forwarded). */
export const VERIFIER_PROXY: Address = "0xEd813D895457907399E41D36Ec0bE103E32148c8";
/** Chainlink CRE KeystoneForwarder for `monad-mainnet`. */
export const CRE_FORWARDER: Address = "0x76c9cf548b4179F8901cda1f8623568b58215E62";
/** Chainlink MON/USD push feed (8 dp; heartbeat 3600 s; category "new"). */
export const MON_USD_FEED: Address = "0xBcD78f76005B7515837af6b50c7C52BCf73822fb";

/** Safe v1.4.1 on Monad (verified on chain 2026-10-04). */
export const SAFE = {
  singleton: "0x41675C099F32341bf84BFc5382aF534df5C7461a" as Address,
  singletonL2: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762" as Address,
  proxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" as Address,
  multiSend: "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526" as Address,
};

/** Data Streams resolver: the first proposal opens a window; no proposal by T + grace voids the round. */
export const FINALIZATION_WINDOW_SEC = 120n;
export const STREAMS_GRACE_SEC = 1800n;
/** Round-proof resolver (MON): a proof is rejected after T + 1 day; the oracle may lag at most 120 s. */
export const ROUND_LIVENESS_GRACE_SEC = 86_400n;
export const MON_MAX_ORACLE_DELAY_SEC = 120;

export const EPOCH_LENGTH_SEC = 900n;
/** Smallest deposit or redemption request: 10 USDC (must exceed the 1,000 locked dead shares). */
export const MIN_REQUEST = 10_000_000n;
/** The launch TVL cap in USDC base units unless Nisarg gives another number (CLAUDE.md: 5,000 USD). */
export const DEFAULT_TVL_CAP = 5_000_000_000n;

/** Venue: execute 2 s after placement, up to 4 s late; 0.001 MON minimum executor reward. */
export const VENUE_EXEC_DELAY = 2;
export const VENUE_MAX_LATENESS = 4;
export const VENUE_MIN_REWARD = 1_000_000_000_000_000n;

/** Sigma bands (annual volatility, WAD) the vault enforces on the keeper and uses for NAV marks. */
export const SIGMA_BANDS: Record<string, { min: bigint; max: bigint }> = {
  "BTC/USD": { min: 300_000_000_000_000_000n, max: 1_000_000_000_000_000_000n },
  "ETH/USD": { min: 400_000_000_000_000_000n, max: 1_300_000_000_000_000_000n },
};

/** Partner programme defaults if it is enabled (docs/partners.md). */
export const PARTNER_DEFAULTS = {
  minBond: 100_000_000n, // 100 USDC
  globalExposureCap: 250_000_000n, // 250 USDC
  redeemFeeBps: 50,
};
