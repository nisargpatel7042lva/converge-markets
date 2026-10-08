import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  concatHex,
  encodeAbiParameters,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  pad,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convergeVaultAbi } from "@converge/sdk";
import { SAFE, USDC, VERIFIER_PROXY } from "../../src/constants";
import { Deployer, type DeployConfig } from "../../src/deploy";
import { repoRoot } from "../../src/params";
import {
  handoverBatch,
  launchExecuteBatch,
  launchScheduleBatch,
  timelockAbi,
} from "../../src/safe";
import { readState, statePath } from "../../src/state";
import { render, verifyDeployment } from "../../src/verify";
import { verifyCommands } from "../../src/explorer";
import { pollOnce } from "../../src/timelock-watch";
import { verifyAsCallers } from "../../src/check-streams";
import { judgeRounds, judgeTrades, overall } from "../../src/canary/analysis";
import { collectRounds, readNav } from "../../src/canary/chain";

/**
 * The mainnet deployment, rehearsed end to end on a local anvil FORK of Monad mainnet: the real USDC,
 * the real VerifierProxy and the real Safe v1.4.1 contracts are in the state it runs against. Needs
 * FORK_RPC (a Monad mainnet RPC, default https://rpc.monad.xyz), anvil on the PATH and a forge build.
 * Nothing here can reach the real chain: anvil forks it read-only and the tool refuses the
 * "rehearsal" network on anything that is not anvil.
 */
const FORK_RPC = process.env.FORK_RPC ?? "https://rpc.monad.xyz";
const PORT = 8643;
const URL = `http://127.0.0.1:${PORT}`;
// anvil's well-known development key #0 (not a secret): the stand-in deployer
const DEPLOYER_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;
const OWNER1 = addr(0x5af01);
const OWNER2 = addr(0x5af02);
const OWNER3 = addr(0x5af03);
const GUARDIAN = addr(0x600d);
const KEEPER = addr(0x6e11);
const SCHEDULER = addr(0x5c4ed);
const DELAY = 86_400; // the production default: 24 h
const FEED = (n: number): Hex => `0x0003${n.toString(16).padStart(2, "0").repeat(30)}`;

const chain = defineChain({
  id: 143,
  name: "monad-fork",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [URL] } },
});
const pub = createPublicClient({ chain, transport: http(URL) });
const account = privateKeyToAccount(DEPLOYER_KEY);
const wallet = createWalletClient({ account, chain, transport: http(URL) });

const safeAbi = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function approveHash(bytes32 hashToApprove)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
]);
const factoryAbi = parseAbi([
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "event ProxyCreation(address indexed proxy, address singleton)",
]);

let anvil: ChildProcess;
const rpc = async (method: string, params: unknown[]) => {
  const r = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
const hex = (n: bigint) => `0x${n.toString(16)}`;

async function startFork() {
  const bin = `${process.env.HOME}/.foundry/bin/anvil`;
  anvil = spawn(
    bin,
    [
      "--fork-url",
      FORK_RPC,
      "--port",
      String(PORT),
      "--chain-id",
      "143",
      "--silent",
      "--no-rate-limit",
      "--code-size-limit",
      "131072",
    ],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 120; i++) {
    try {
      await rpc("eth_chainId", []);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("anvil did not start");
}

async function newSafe(owners: Address[], threshold: number, salt: bigint): Promise<Address> {
  await rpc("anvil_setBalance", [OWNER1, hex(10n ** 20n)]);
  await rpc("anvil_impersonateAccount", [OWNER1]);
  const init = encodeFunctionData({
    abi: safeAbi,
    functionName: "setup",
    args: [
      owners,
      BigInt(threshold),
      "0x0000000000000000000000000000000000000000",
      "0x",
      "0x0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000",
      0n,
      "0x0000000000000000000000000000000000000000",
    ],
  });
  const data = encodeFunctionData({
    abi: factoryAbi,
    functionName: "createProxyWithNonce",
    args: [SAFE.singletonL2, init, salt],
  });
  const hash = (await rpc("eth_sendTransaction", [
    { from: OWNER1, to: SAFE.proxyFactory, data, gas: "0x1e8480" },
  ])) as Hex;
  const r = await pub.waitForTransactionReceipt({ hash });
  const log = r.logs.find((l) => l.address.toLowerCase() === SAFE.proxyFactory.toLowerCase());
  return `0x${log!.topics[1]!.slice(26)}` as Address;
}

/** Executes `to.data` through a 2-of-3 Safe with "approved hash" signatures (no private keys needed). */
async function safeExec(safe: Address, to: Address, data: Hex): Promise<void> {
  const nonce = (await pub.readContract({
    address: safe,
    abi: safeAbi,
    functionName: "nonce",
  })) as bigint;
  const zero = "0x0000000000000000000000000000000000000000" as Address;
  const txHash = (await pub.readContract({
    address: safe,
    abi: safeAbi,
    functionName: "getTransactionHash",
    args: [to, 0n, data, 0, 0n, 0n, 0n, zero, zero, nonce],
  })) as Hex;
  for (const o of [OWNER1, OWNER2]) {
    await rpc("anvil_setBalance", [o, hex(10n ** 20n)]);
    await rpc("anvil_impersonateAccount", [o]);
    await rpc("eth_sendTransaction", [
      {
        from: o,
        to: safe,
        data: encodeFunctionData({ abi: safeAbi, functionName: "approveHash", args: [txHash] }),
        gas: "0x30d40",
      },
    ]);
  }
  // signatures sorted by signer address; type 1 = approved hash
  const sorted = [OWNER1, OWNER2].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const sigs = concatHex(
    sorted.flatMap((o) => [pad(o, { size: 32 }), pad("0x00", { size: 32 }), "0x01" as Hex]),
  );
  const exec = encodeFunctionData({
    abi: safeAbi,
    functionName: "execTransaction",
    args: [to, 0n, data, 0, 0n, 0n, 0n, zero, zero, sigs],
  });
  const h = (await rpc("eth_sendTransaction", [
    { from: OWNER1, to: safe, data: exec, gas: "0x7a120" },
  ])) as Hex;
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error("the Safe transaction reverted");
  // execTransaction returns false (and does not revert) if the inner call fails: check the event
  const failed = r.logs.some(
    (l) => l.topics[0] === "0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23",
  );
  if (failed) throw new Error("the inner call of the Safe transaction failed");
}

function cfgFor(network: string, safe: Address, partners: boolean): DeployConfig {
  return {
    network,
    chainId: 143,
    safe,
    guardian: GUARDIAN,
    keeper: KEEPER,
    scheduler: SCHEDULER,
    treasury: safe,
    tvlCap: 5_000_000_000n,
    enablePartners: partners,
    leader: "fallback",
    timelockDelaySec: DELAY,
    assets: [
      { label: "BTC/USD", symbol: "BTC", resolver: "streams", streamsFeedId: FEED(0xb1) },
      { label: "ETH/USD", symbol: "ETH", resolver: "streams", streamsFeedId: FEED(0xe1) },
      { label: "MON/USD", symbol: "MON", resolver: "round" },
    ],
  };
}

const cleanup = (network: string) => rmSync(statePath(network), { force: true });

describe.skipIf(
  !existsSync(resolve(repoRoot, "contracts/out/ConvergeVault.sol/ConvergeVault.json")),
)("mainnet deployment rehearsal on a fork", () => {
  let safe: Address;

  beforeAll(async () => {
    await startFork();
    await rpc("anvil_setBalance", [account.address, hex(10n ** 22n)]);
    safe = await newSafe([OWNER1, OWNER2, OWNER3], 2, 7n);
  }, 240_000);

  afterAll(() => {
    anvil?.kill();
    cleanup("rehearsal-full");
    cleanup("rehearsal-crash");
  });

  it("the fork has the real external contracts the deployment depends on", async () => {
    for (const a of [USDC, VERIFIER_PROXY, SAFE.singletonL2, SAFE.proxyFactory]) {
      expect((await pub.getCode({ address: a }))?.length ?? 0).toBeGreaterThan(2);
    }
    expect(await pub.getChainId()).toBe(143);
  });

  it("deploys everything, hands it to the Safe, and re-running changes nothing", async () => {
    cleanup("rehearsal-full");
    const cfg = cfgFor("rehearsal-full", safe, true);
    const d = new Deployer(pub, wallet, cfg, () => undefined);
    const state = await d.run();
    const st0 = state;
    const txs = state.transactions.length;
    expect(txs).toBeGreaterThan(30);
    expect(state.vault?.vault).toBeDefined();
    expect(state.handover?.done).toBe(false);
    expect(state.handover?.pendingSafeAcceptance.length).toBeGreaterThanOrEqual(4);

    // verify: no FAIL; the pending acceptances and the paused vault are WARNs, not silence
    let checks = await verifyDeployment(
      pub,
      readState("rehearsal-full", 143),
      cfg,
      account.address,
    );
    expect(
      checks.filter((c) => c.level === "FAIL"),
      render(checks),
    ).toEqual([]);
    expect(
      checks
        .filter((c) => c.level === "WARN")
        .map((c) => c.what)
        .join("\n"),
    ).toMatch(/PENDING/);
    expect(checks.some((c) => c.level === "WARN" && /PAUSED/.test(c.what))).toBe(true);
    // the deployer key keeps nothing
    const vault = state.vault!.vault;
    const owner = (await pub.readContract({
      address: vault,
      abi: parseAbi(["function owner() view returns (address)"]),
      functionName: "owner",
    })) as Address;
    expect(owner.toLowerCase()).toBe(account.address.toLowerCase()); // still the deployer until the Safe accepts

    // re-running is a no-op
    const again = new Deployer(pub, wallet, cfg, () => undefined);
    await again.run();
    expect(readState("rehearsal-full", 143).transactions.length).toBe(txs);

    // the Safe (2 of 3) runs the handover batch: schedule + execute through the timelock
    const tl = readState("rehearsal-full", 143).timelock!;
    const delayOf = async () =>
      (await pub.readContract({
        address: tl,
        abi: timelockAbi,
        functionName: "getMinDelay",
      })) as bigint;
    expect(await delayOf()).toBe(0n); // boot state
    for (const t of handoverBatch(readState("rehearsal-full", 143), DELAY).transactions)
      await safeExec(safe, t.to, t.data);
    expect(await delayOf()).toBe(BigInt(DELAY));
    checks = await verifyDeployment(pub, readState("rehearsal-full", 143), cfg, account.address);
    expect(
      checks.filter((c) => c.level === "FAIL"),
      render(checks),
    ).toEqual([]);
    expect(checks.some((c) => /PENDING|pending/.test(c.what))).toBe(false);
    expect(checks.some((c) => /timelock delay is 86400 s/.test(c.what))).toBe(true);
    // everything is owned by the timelock, not by the Safe or the deployer
    for (const a of [
      vault,
      st0.dataStreamsResolver!,
      st0.chainlinkRoundResolver!,
      st0.partners!.partnerRegistry,
    ]) {
      const o = (await pub.readContract({
        address: a,
        abi: parseAbi(["function owner() view returns (address)"]),
        functionName: "owner",
      })) as Address;
      expect(o.toLowerCase()).toBe(tl.toLowerCase());
    }

    // neither the deployer nor the Safe itself can do an owner thing any more: only the timelock can
    await expect(
      wallet.writeContract({
        address: vault,
        abi: convergeVaultAbi,
        functionName: "setTvlCap",
        args: [1n],
        chain,
      }),
    ).rejects.toThrow();
    const tvlCall = encodeFunctionData({
      abi: convergeVaultAbi,
      functionName: "setTvlCap",
      args: [1n],
    });
    await expect(safeExec(safe, vault, tvlCall)).rejects.toThrow(); // the Safe is not the owner

    // launch: resumeQuoting must be scheduled, and cannot run before the delay has passed
    const [sch] = launchScheduleBatch(readState("rehearsal-full", 143), DELAY).transactions;
    await safeExec(safe, sch!.to, sch!.data);
    const [exe] = launchExecuteBatch(readState("rehearsal-full", 143)).transactions;
    await expect(safeExec(safe, exe!.to, exe!.data)).rejects.toThrow(); // still waiting
    await rpc("evm_increaseTime", [DELAY - 60]);
    await rpc("evm_mine", []);
    await expect(safeExec(safe, exe!.to, exe!.data)).rejects.toThrow(); // one minute short
    await rpc("evm_increaseTime", [61]);
    await rpc("evm_mine", []);
    await safeExec(safe, exe!.to, exe!.data);
    expect(
      (await pub.readContract({
        address: vault,
        abi: convergeVaultAbi,
        functionName: "quotingPaused",
      })) as boolean,
    ).toBe(false);

    // the guardian pauses instantly (no timelock)
    await rpc("anvil_setBalance", [GUARDIAN, hex(10n ** 20n)]);
    await rpc("anvil_impersonateAccount", [GUARDIAN]);
    const pauseHash = (await rpc("eth_sendTransaction", [
      {
        from: GUARDIAN,
        to: vault,
        data: encodeFunctionData({ abi: convergeVaultAbi, functionName: "pauseQuoting" }),
        gas: "0x30d40",
      },
    ])) as Hex;
    const pauseReceipt = await pub.waitForTransactionReceipt({ hash: pauseHash });
    expect(pauseReceipt.status, "the guardian's pause transaction").toBe("success");
    expect(
      (await pub.readContract({
        address: vault,
        abi: convergeVaultAbi,
        functionName: "quotingPaused",
      })) as boolean,
    ).toBe(true);

    // timelock-watch saw all of it: the handover, the delay change, the scheduled resume and its execution
    const times = new Map<bigint, number>();
    const events = await pollOnce(
      pub,
      tl,
      BigInt(readState("rehearsal-full", 143).deployBlock ?? 0),
      await pub.getBlockNumber(),
      async (b) => {
        if (!times.has(b)) times.set(b, Number((await pub.getBlock({ blockNumber: b })).timestamp));
        return times.get(b)!;
      },
    );
    const text = events.map((e) => e.text).join("\n");
    expect(events.filter((e) => e.kind === "scheduled").length).toBeGreaterThanOrEqual(5); // 4 accepts + updateDelay + resume
    expect(text).toMatch(/OWNER ACTION SCHEDULED: ConvergeVault\.acceptOwnership\(\)/);
    expect(text).toMatch(/OWNER ACTION SCHEDULED: ConvergeVault\.resumeQuoting\(\)/);
    expect(text).toMatch(/OWNER ACTION EXECUTED: ConvergeVault\.resumeQuoting\(\)/);
    expect(text).toMatch(/TIMELOCK DELAY CHANGED: 0 s -> 86400 s/);
    const resume = events.find((e) => e.kind === "scheduled" && /resumeQuoting/.test(e.text))!;
    expect(resume.readyAt).toBeGreaterThan(0);

    // explorer commands are produced from the creation transactions
    const cmds = await verifyCommands(pub, readState("rehearsal-full", 143));
    expect(cmds.filter((c) => c.startsWith("forge verify-contract")).length).toBeGreaterThanOrEqual(
      8,
    );

    // evidence: the gas the real deployment will bill (limit x price), from the fork
    const st = readState("rehearsal-full", 143);
    const totalWei = st.transactions.reduce((a, t) => a + BigInt(t.costWei), 0n);
    const gas = st.transactions.reduce((a, t) => a + BigInt(t.gasLimit), 0n);
    mkdirSync(resolve(repoRoot, "docs/evidence/phase-9"), { recursive: true });
    writeFileSync(
      resolve(repoRoot, "docs/evidence/phase-9/mainnet-rehearsal.json"),
      JSON.stringify(
        {
          what: "rehearsal of scripts/mainnet on a local anvil fork of Monad mainnet (real USDC, VerifierProxy and Safe v1.4.1); fake Data Streams feed ids",
          transactions: st.transactions.length,
          totalGasLimit: gas.toString(),
          totalCostMON: Number(totalWei) / 1e18,
          forkGasPriceWei: (totalWei / gas).toString(),
          // Monad bills the gas LIMIT; 102 gwei is the price observed on mainnet (docs/EXTERNAL.md)
          totalCostMONAt102Gwei: Number(gas * 102_000_000_000n) / 1e18,
          perStep: st.transactions.map((t) => ({
            step: t.step,
            gasLimit: t.gasLimit,
            gasUsed: t.gasUsed,
            costMON: Number(t.costWei) / 1e18,
          })),
          contracts: { vault: st.vault, partners: st.partners, marketFactory: st.marketFactory },
        },
        null,
        2,
      ) + "\n",
    );
  });

  it("the canary report reads the deployed system and fails an empty one (nothing was scheduled)", async () => {
    const dep = readState("rehearsal-full", 143);
    const now = Number((await pub.getBlock()).timestamp);
    const series = [{ label: "BTC/USD", durations: [900] }];
    const window = { from: now - 7200, to: now };
    const obs = await collectRounds(pub, dep, series, window, BigInt(dep.deployBlock ?? 0));
    const rounds = judgeRounds(obs, series, window);
    expect(rounds.expected).toBeGreaterThanOrEqual(7);
    expect(rounds.missed).toHaveLength(rounds.expected); // no scheduler ran on the fork
    expect(rounds.missed.every((m) => m.reason === "not-created")).toBe(true);
    const nav = await readNav(pub, dep.vault!.vault);
    expect(nav.supply).toBe(0n);
    expect(overall(12, 12, rounds, judgeTrades([], now)).pass).toBe(false);
  });

  it("resumes after a crash in the middle and ends in the same state", async () => {
    cleanup("rehearsal-crash");
    const cfg = cfgFor("rehearsal-crash", safe, false);
    let sends = 0;
    class Crashing extends Deployer {
      // fail the 12th transaction: after the factory, the resolvers and part of the assets
      protected override async recordHook(): Promise<void> {
        if (++sends === 12) throw new Error("simulated crash");
      }
    }
    await expect(new Crashing(pub, wallet, cfg, () => undefined).run()).rejects.toThrow(
      /simulated crash/,
    );
    const partial = readState("rehearsal-crash", 143);
    expect(partial.transactions.length).toBeGreaterThan(5);
    expect(partial.vault).toBeUndefined();
    const done = await new Deployer(pub, wallet, cfg, () => undefined).run();
    expect(done.vault?.vault).toBeDefined();
    const checks = await verifyDeployment(
      pub,
      readState("rehearsal-crash", 143),
      cfg,
      account.address,
    );
    expect(
      checks.filter((c) => c.level === "FAIL"),
      render(checks),
    ).toEqual([]);
    // the contracts deployed before the crash were reused, not deployed twice
    expect(done.marketFactory).toBe(partial.marketFactory);
    expect(done.dataStreamsResolver).toBe(partial.dataStreamsResolver);
  });

  it("the live-report check calls the real VerifierProxy as each contract, and rejects a forged report", async () => {
    // a payload that is not DON-signed: the real proxy must refuse it for every caller. (The success
    // path needs a real signed report and Chainlink credentials: docs/ops/launch-checklist.md.)
    const forged = encodeAbiParameters(
      [
        { type: "bytes32[3]" },
        { type: "bytes" },
        { type: "bytes32[]" },
        { type: "bytes32[]" },
        { type: "bytes32" },
      ],
      [[pad("0x01"), pad("0x02"), pad("0x03")], "0x00030000", [], [], pad("0x00")],
    );
    const checks = await verifyAsCallers(pub, VERIFIER_PROXY, forged, "0x", {
      vault: addr(1),
      venue: addr(2),
      resolver: addr(3),
    });
    expect(checks).toHaveLength(3);
    expect(checks.every((c) => c.level === "FAIL" && /REVERTS/.test(c.what))).toBe(true);
  });

  it("refuses a Safe that is not a real multisig, a placeholder feed id, and a deployer key that is a signer", async () => {
    const eoa = addr(0xbeef);
    cleanup("rehearsal-bad");
    await expect(
      new Deployer(pub, wallet, cfgFor("rehearsal-bad", eoa, false), () => undefined).run(),
    ).rejects.toThrow(/no code|must be a deployed Safe/);
    const bad = cfgFor("rehearsal-bad", safe, false);
    bad.assets[0]!.streamsFeedId = `0x${"00".repeat(32)}`;
    await expect(new Deployer(pub, wallet, bad, () => undefined).run()).rejects.toThrow(
      /placeholder/,
    );
    const withDeployerSigner = await newSafe([OWNER1, account.address], 2, 9n);
    await expect(
      new Deployer(
        pub,
        wallet,
        cfgFor("rehearsal-bad", withDeployerSigner, false),
        () => undefined,
      ).run(),
    ).rejects.toThrow(/signer of the Safe/);
    cleanup("rehearsal-bad");
    expect(existsSync(statePath("rehearsal-bad"))).toBe(false);
  });
});
