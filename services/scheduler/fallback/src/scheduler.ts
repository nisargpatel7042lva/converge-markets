/**
 * The fallback scheduler: same planning logic as the CRE workflow (@converge/sdk), executed with
 * an EOA that holds the factory's CREATOR_ROLE. Exactly one of {CRE, fallback} acts, as selected
 * by SchedulerReceiver.leader(); the passive one only alerts when actions are late.
 */
import {
  ActionKind,
  describe,
  lateItems,
  lateWaiting,
  marketAbi,
  marketFactoryAbi,
  plan,
  readSnapshot,
  roundProofEvidence,
  runAsync,
  schedulerReceiverAbi,
  type PlannedAction,
  type SeriesConfig,
  type StreamsReportSource,
} from "@converge/sdk";
import {
  BaseError,
  ContractFunctionRevertedError,
  zeroAddress,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import type { Logger } from "pino";
import type { Alerter } from "./alerts";
import { withRetry } from "./retry";

export type ActionOutcome =
  | { status: "sent"; hash: Hex; blockTimestamp: bigint }
  | { status: "noop"; reason: string } // someone else already did it (idempotent re-run)
  | { status: "waiting"; reason: string } // evidence not available yet
  | { status: "failed"; error: string };

export type TickResult = {
  now: bigint;
  leader: "cre" | "fallback" | "standalone";
  acting: boolean;
  planned: number;
  outcomes: { action: string; kind: ActionKind; outcome: ActionOutcome; delay: bigint }[];
  late: string[];
  missed: string[];
};

export type SchedulerDeps = {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  factory: Address;
  receiver?: Address;
  config: SeriesConfig;
  streams: StreamsReportSource | null;
  alerter: Alerter;
  log: Logger;
  gasMultiplierPct: number;
  maxRetries: number;
  epoch?: bigint;
};

/** Revert reasons that mean "already done / not needed" when racing another scheduler. */
const NOOP_ERRORS = new Set(["MarketExists", "WrongState", "StartInPast"]);

export class Scheduler {
  private ticks = 0;
  constructor(private readonly d: SchedulerDeps) {}

  async leader(): Promise<"cre" | "fallback" | "standalone"> {
    if (!this.d.receiver) return "standalone";
    const l = await this.d.publicClient.readContract({
      address: this.d.receiver,
      abi: schedulerReceiverAbi,
      functionName: "leader",
    });
    return Number(l) === 1 ? "fallback" : "cre";
  }

  async tick(opts: { deep?: boolean } = {}): Promise<TickResult> {
    const { publicClient, config, log } = this.d;
    this.ticks += 1;
    const block = await withRetry(() => publicClient.getBlock(), { retries: this.d.maxRetries });
    const now = block.timestamp; // chain time, not wall clock
    const leader = await withRetry(() => this.leader(), { retries: this.d.maxRetries });
    const acting = leader !== "cre";
    const snapshot = await withRetry(
      () =>
        runAsync(
          readSnapshot({
            factory: this.d.factory,
            config,
            now,
            deep: opts.deep ?? false,
            ...(this.d.epoch === undefined ? {} : { epoch: this.d.epoch }),
          }),
          publicClient,
          block.number,
        ),
      { retries: this.d.maxRetries },
    );
    const p = plan(snapshot);
    const result: TickResult = {
      now,
      leader,
      acting,
      planned: p.actions.length,
      outcomes: [],
      late: [],
      missed: p.missed.map((s) => `${s.label} ${s.duration}s @${s.startTime}`),
    };

    if (acting) {
      for (const a of p.actions) {
        const outcome = await this.execute(a);
        const delay = (outcome.status === "sent" ? outcome.blockTimestamp : now) - a.dueAt;
        result.outcomes.push({ action: describe(a), kind: a.kind, outcome, delay });
        log.info(
          {
            event: "action",
            kind: ActionKind[a.kind],
            asset: a.label,
            duration: Number(a.duration),
            startTime: Number(a.startTime),
            boundary: a.boundary === null ? null : Number(a.boundary),
            status: outcome.status,
            delaySeconds: Number(delay),
            ...(outcome.status === "sent" ? { tx: outcome.hash } : {}),
            ...(outcome.status === "failed" ||
            outcome.status === "noop" ||
            outcome.status === "waiting"
              ? { reason: outcome.status === "failed" ? outcome.error : outcome.reason }
              : {}),
          },
          "action",
        );
      }
    }

    // Lateness is judged on the plan made before acting; anything we just sent is not late.
    const sentKeys = new Set(
      result.outcomes.filter((o) => o.outcome.status === "sent").map((o) => o.action),
    );
    const lateAfter = BigInt(config.lateAfterSeconds);
    for (const a of lateItems(p, now, lateAfter)) {
      if (sentKeys.has(describe(a))) continue;
      result.late.push(describe(a));
      await this.d.alerter.alert(
        `late:${describe(a)}`,
        `${leader === "cre" ? "CRE (leader) is" : "scheduler is"} late: ${describe(a)} due ${now - a.dueAt}s ago`,
      );
    }
    for (const w of lateWaiting(p, now, lateAfter + 300n)) {
      const k = `${w.slot.label} ${w.slot.duration}s @${w.slot.startTime}`;
      result.late.push(`finalizing ${k}`);
      await this.d.alerter.alert(`finalizing:${k}`, `streams proposal still finalizing: ${k}`);
    }
    for (const m of result.missed) {
      await this.d.alerter.alert(`missed:${m}`, `round started without a market: ${m}`);
    }
    log.info(
      {
        event: "tick",
        tick: this.ticks,
        now: Number(now),
        leader,
        acting,
        planned: p.actions.length,
        waiting: p.waiting.length,
        late: result.late.length,
        missed: result.missed.length,
      },
      "tick",
    );
    return result;
  }

  /** Gets evidence (or null if not available yet) for an action that needs it. */
  private async evidence(
    a: PlannedAction,
    resolver: Address,
  ): Promise<{ data: Hex | null; why: string }> {
    if (a.boundary === null) return { data: "0x", why: "" };
    if (a.resolverKind === "round") {
      const ev = await runAsync(
        roundProofEvidence(resolver, a.assetId, a.boundary),
        this.d.publicClient,
      );
      return { data: ev.evidence, why: ev.finding.kind };
    }
    if (!this.d.streams) return { data: null, why: "no streams source configured" };
    const feedId = this.d.config.assets.find((x) => x.label === a.label)?.streamsFeedId as Hex;
    const data = await this.d.streams.reportAt(feedId, a.boundary);
    return { data, why: data ? "report" : "report not available yet" };
  }

  async execute(a: PlannedAction): Promise<ActionOutcome> {
    const { publicClient, factory } = this.d;
    try {
      let address: Address = factory;
      let call: {
        abi: typeof marketAbi | typeof marketFactoryAbi;
        functionName: string;
        args: readonly unknown[];
      };
      if (a.kind === ActionKind.CREATE) {
        call = {
          abi: marketFactoryAbi,
          functionName: "createMarket",
          args: [a.assetId, a.duration, a.startTime],
        };
      } else {
        address = await publicClient.readContract({
          address: factory,
          abi: marketFactoryAbi,
          functionName: "getMarket",
          args: [a.assetId, a.duration, a.startTime],
        });
        if (address === zeroAddress) return { status: "failed", error: "market not found" };
        if (a.kind === ActionKind.INVALIDATE) {
          call = { abi: marketAbi, functionName: "invalidate", args: [] };
        } else {
          let evidence: Hex = "0x";
          if (a.needsEvidence) {
            const resolver = await publicClient.readContract({
              address,
              abi: marketAbi,
              functionName: "resolver",
            });
            const ev = await this.evidence(a, resolver);
            if (ev.data === null) return { status: "waiting", reason: ev.why };
            evidence = ev.data;
          }
          call = {
            abi: marketAbi,
            functionName: a.kind === ActionKind.OPEN ? "open" : "resolve",
            args: [evidence],
          };
        }
      }
      return await this.send(address, call);
    } catch (e) {
      return { status: "failed", error: errorName(e) };
    }
  }

  private async send(
    address: Address,
    call: {
      abi: typeof marketAbi | typeof marketFactoryAbi;
      functionName: string;
      args: readonly unknown[];
    },
  ): Promise<ActionOutcome> {
    const { publicClient, walletClient } = this.d;
    const account = walletClient.account;
    const params = {
      address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
      account,
    } as never;
    try {
      await publicClient.simulateContract(params);
    } catch (e) {
      const name = errorName(e);
      if (NOOP_ERRORS.has(name)) return { status: "noop", reason: name };
      if (name === "PriceNotFinal") return { status: "waiting", reason: name };
      return { status: "failed", error: name };
    }
    // Monad bills the gas limit: estimate + small headroom instead of a blanket limit.
    const est = await withRetry(() => publicClient.estimateContractGas(params), {
      retries: this.d.maxRetries,
    });
    const gas = (est * BigInt(this.d.gasMultiplierPct)) / 100n;
    const hash = await withRetry(
      () =>
        walletClient.writeContract({
          ...(params as object),
          gas,
          chain: walletClient.chain,
        } as never),
      { retries: this.d.maxRetries },
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
    if (receipt.status !== "success") return { status: "failed", error: `reverted ${hash}` };
    const blk = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    return { status: "sent", hash, blockTimestamp: blk.timestamp };
  }
}

export function errorName(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return revert.data?.errorName ?? revert.shortMessage;
    }
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}
