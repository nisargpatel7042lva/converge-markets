import type { Address, LocalAccount } from "viem";

// Mera and the key derivation are only needed when a passkey is used: they are loaded then, so
// they stay out of the first load of every page.
const mera = () => import("@category-labs/mera");
const meraViem = () => import("@category-labs/mera/viem");
const derive = () => import("./derive");

/**
 * Mera is the whole account layer: a passkey (WebAuthn PRF) gives 32 bytes, those bytes are the
 * account. Nothing secret is stored: only the credential id and the address, to show the account
 * and to ask the right passkey. Signing happens in a session that exists for one confirmation
 * and zeroes the key when it ends.
 */
export type Profile = {
  credentialId: string;
  transports?: string[];
  address: Address;
  createdAt: number;
};

const KEY = "converge.profile.v1";
const listeners = new Set<() => void>();
let cached: { raw: string | null; value: Profile | null } = { raw: null, value: null };

export function loadProfile(): Profile | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === cached.raw) return cached.value;
    cached = { raw, value: raw ? (JSON.parse(raw) as Profile) : null };
    return cached.value;
  } catch {
    return null;
  }
}

export function subscribeProfile(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

function saveProfile(p: Profile | null) {
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify(p));
    else localStorage.removeItem(KEY);
  } catch {
    // private mode: the account still works for this tab
  }
  listeners.forEach((l) => l());
}

export function forgetAccount() {
  saveProfile(null);
}

const rp = () => ({ id: window.location.hostname, name: "Converge" });

async function addressFromPrf(prf: Uint8Array): Promise<Address> {
  const [{ createSecp256k1SigningSession }, { toViemAccount }, { privateKeyFromPrf }] =
    await Promise.all([mera(), meraViem(), derive()]);
  const key = privateKeyFromPrf(prf);
  const session = createSecp256k1SigningSession({ privateKey: key });
  try {
    return toViemAccount(session).address;
  } finally {
    session.end();
    key.fill(0);
  }
}

/** Why a passkey step failed, in words a person can act on. */
export function explainAccountError(e: unknown): string {
  if (e instanceof Error && e.name === "MeraError") {
    const code = (e as Error & { code?: string }).code;
    switch (code) {
      case "PRF_UNAVAILABLE":
        return "This device or browser can't make a Converge account yet. Try Safari on iPhone (iOS 18+), Chrome on Android, or a password manager passkey such as 1Password.";
      case "PASSKEY_OPERATION_FAILED":
        return "The passkey prompt was cancelled or isn't available. Try again.";
      default:
        return "Something went wrong with the passkey. Try again.";
    }
  }
  return e instanceof Error ? e.message : "Something went wrong. Try again.";
}

export async function createAccount(): Promise<Profile> {
  const { createPasskeyWithPrfOutput } = await mera();
  const created = await createPasskeyWithPrfOutput({
    rp: rp(),
    user: { name: `converge-${Date.now().toString(36)}`, displayName: "Converge account" },
  });
  const profile: Profile = {
    credentialId: created.credentialId,
    ...(created.transports ? { transports: [...created.transports] } : {}),
    address: await addressFromPrf(created.prfOutput),
    createdAt: Date.now(),
  };
  created.prfOutput.fill(0);
  saveProfile(profile);
  return profile;
}

/** On a new device: pick any Converge passkey the platform offers. */
export async function restoreAccount(): Promise<Profile> {
  const { getPasskeyPrfOutput } = await mera();
  const got = await getPasskeyPrfOutput({ rpId: window.location.hostname });
  const profile: Profile = {
    credentialId: got.credentialId,
    address: await addressFromPrf(got.prfOutput),
    createdAt: Date.now(),
  };
  got.prfOutput.fill(0);
  saveProfile(profile);
  return profile;
}

async function prfForProfile(p: Profile) {
  const { getPasskeyPrfOutput } = await mera();
  return getPasskeyPrfOutput({
    rpId: window.location.hostname,
    credential: {
      credentialId: p.credentialId,
      ...(p.transports ? { transports: p.transports } : {}),
    },
  });
}

/**
 * One passkey prompt, one signing session, then the key is gone. Everything `fn` signs (the
 * approval and the order of one trade) shares that single prompt.
 */
export async function withSigner<T>(
  p: Profile,
  fn: (account: LocalAccount) => Promise<T>,
): Promise<T> {
  const [{ createSecp256k1SigningSession }, { toViemAccount }, { privateKeyFromPrf }] =
    await Promise.all([mera(), meraViem(), derive()]);
  const got = await prfForProfile(p);
  const key = privateKeyFromPrf(got.prfOutput);
  got.prfOutput.fill(0);
  const session = createSecp256k1SigningSession({ privateKey: key });
  key.fill(0);
  try {
    const account = toViemAccount(session);
    if (account.address.toLowerCase() !== p.address.toLowerCase())
      throw new Error("This passkey belongs to a different account.");
    return await fn(account);
  } finally {
    session.end();
  }
}

/** The recovery phrase for exporting to MetaMask or Rabby; shown only after a passkey prompt. */
export async function revealRecoveryPhrase(p: Profile): Promise<string> {
  const { mnemonicFromPrf } = await derive();
  const got = await prfForProfile(p);
  const phrase = mnemonicFromPrf(got.prfOutput);
  got.prfOutput.fill(0);
  return phrase;
}
