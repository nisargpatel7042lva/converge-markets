/**
 * The gas money (native token) an account needs before the app lets it act: enough for an approval
 * and an order (with the executor reward and a margin) or a claim. One number for the trade sheet,
 * the funding page and the relayer, so they cannot disagree. Monad bills the gas limit; the
 * placeOrder gas on testnet was not measured (see the Phase 7 report), so this is deliberately
 * generous: 0.05 MON is about 70 % of one keeper execution at 100 gwei.
 */
export const GAS_RESERVE_WEI = 50n * 10n ** 15n;
/** Below this the relayer tops an account up (it must be under the reserve to be useful). */
export const GAS_TOPUP_BELOW_WEI = GAS_RESERVE_WEI + 2n * 10n ** 15n; // reserve + reward + margin: an account the sheet refuses is always one the relayer tops up
