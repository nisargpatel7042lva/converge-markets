import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

/** The Mera guide's derivation: BIP-39 entropy = the passkey's 32 PRF bytes, BIP-44 account 0. */
export const DERIVATION_PATH = "m/44'/60'/0'/0/0";

export function mnemonicFromPrf(prfOutput: Uint8Array): string {
  if (prfOutput.length !== 32) throw new Error("the passkey returned an unexpected secret");
  return entropyToMnemonic(prfOutput, wordlist);
}

/** The account's private key: the same one MetaMask or Rabby derives from the exported phrase. */
export function privateKeyFromPrf(prfOutput: Uint8Array): Uint8Array {
  const seed = mnemonicToSeedSync(mnemonicFromPrf(prfOutput));
  const key = HDKey.fromMasterSeed(seed).derive(DERIVATION_PATH).privateKey;
  seed.fill(0);
  if (!key) throw new Error("could not derive the account");
  return key;
}
