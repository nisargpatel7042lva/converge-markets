import type { Address, Hex, LocalAccount } from "viem";
import { BaseError, UserRejectedRequestError } from "viem";
import { chain, publicClient, walletFor } from "./chain";

export type TxRequest = { to: Address; data: Hex; value?: bigint };

/** Gas margin over the estimate: Monad bills the gas limit, so keep it tight. */
const GAS_MARGIN_PCT = 120n;

/**
 * Sends the transactions in order from one signer (one passkey prompt for all of them) and waits
 * for each receipt. Throws on a revert, with the failing step's name.
 */
export async function sendAll(
  account: LocalAccount,
  steps: { label: string; tx: TxRequest }[],
  onStep?: (label: string, hash: Hex) => void,
): Promise<Hex[]> {
  const wallet = walletFor(account);
  const hashes: Hex[] = [];
  let nonce = await publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  const fees = await publicClient.estimateFeesPerGas();
  for (const { label, tx } of steps) {
    const gas =
      ((await publicClient.estimateGas({
        account: account.address,
        to: tx.to,
        data: tx.data,
        ...(tx.value === undefined ? {} : { value: tx.value }),
      })) *
        GAS_MARGIN_PCT) /
      100n;
    const hash = await wallet.sendTransaction({
      account,
      chain,
      to: tx.to,
      data: tx.data,
      ...(tx.value === undefined ? {} : { value: tx.value }),
      gas,
      nonce: nonce++,
      ...(fees.maxFeePerGas ? { maxFeePerGas: fees.maxFeePerGas } : {}),
      ...(fees.maxPriorityFeePerGas ? { maxPriorityFeePerGas: fees.maxPriorityFeePerGas } : {}),
    });
    onStep?.(label, hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
    if (receipt.status !== "success") throw new Error(`${label} did not go through`);
    hashes.push(hash);
  }
  return hashes;
}

/** Contract and wallet errors as a sentence for a person. */
export function explainTxError(e: unknown): string {
  const text = e instanceof BaseError ? `${e.shortMessage} ${e.details ?? ""}` : String(e);
  if (e instanceof UserRejectedRequestError) return "You cancelled the confirmation.";
  if (/insufficient funds|exceeds the balance|gas required exceeds/i.test(text))
    return "Not enough gas money (MON) in this account. Add a little MON and try again.";
  if (/MarketNotTradable|not tradable/i.test(text))
    return "This market isn't open for trading right now.";
  if (/transfer amount exceeds balance|insufficient balance|ERC20/i.test(text))
    return "Not enough dollars in this account for that amount.";
  if (/RewardTooLow/i.test(text)) return "The network fee setting changed. Reload and try again.";
  if (/LimitOutOfRange/i.test(text)) return "That price is out of range. Try a different amount.";
  if (/PriceNotFinal|WrongState/i.test(text))
    return "This round isn't ready yet. Try again in a moment.";
  if (/NothingToRedeem/i.test(text)) return "There is nothing to collect here.";
  if (/passkey|NotAllowedError|cancel/i.test(text)) return "The passkey prompt was cancelled.";
  return e instanceof BaseError
    ? e.shortMessage
    : e instanceof Error
      ? e.message
      : "Something went wrong.";
}
