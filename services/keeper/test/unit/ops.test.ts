import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { WebhookAlerter } from "../../src/alerts";
import { CostLedger, summarize, type CostRow } from "../../src/costs";
import { KillSwitch } from "../../src/killswitch";
import { Metrics } from "../../src/metrics";
import { startServer, type Status } from "../../src/server";
import { WsPriceSource, parseBinance, parseCoinbase } from "../../src/price/sources";
import type { TxResult } from "../../src/chain/tx";

const log = pino({ level: "silent" });

describe("kill switch", () => {
  it("any one of env, file and http kills; clearing one does not clear the others", () => {
    const dir = mkdtempSync(join(tmpdir(), "kill-"));
    const file = join(dir, "KILL");
    const k = new KillSwitch(false, file);
    expect(k.killed).toBe(false);
    writeFileSync(file, "");
    expect(k.killed).toBe(true);
    k.setHttp(true);
    rmSync(file);
    expect(k.killed).toBe(true); // http still holds
    k.setHttp(false);
    expect(k.killed).toBe(false);
    expect(new KillSwitch(true, file).killed).toBe(true);
    rmSync(dir, { recursive: true });
  });
});

describe("kill switch persistence", () => {
  it("the HTTP kill is written to the file and survives a restart; /unkill removes only that file", () => {
    const dir = mkdtempSync(join(tmpdir(), "kill-"));
    const file = join(dir, "KILL");
    const a = new KillSwitch(false, file);
    expect(a.setHttp(true)).toBe(true);
    expect(new KillSwitch(false, file).killed).toBe(true); // a restarted process
    expect(a.setHttp(false)).toBe(true);
    expect(new KillSwitch(false, file).killed).toBe(false);
    // an operator's own file is not the endpoint's to remove
    writeFileSync(file, "maintenance window\n");
    a.setHttp(true);
    a.setHttp(false);
    expect(new KillSwitch(false, file).killed).toBe(true);
    // a file that cannot be written is reported
    writeFileSync(join(dir, "plain-file"), "x");
    expect(new KillSwitch(false, join(dir, "plain-file", "KILL")).setHttp(true)).toBe(false);
    rmSync(dir, { recursive: true });
  });
});

describe("webhook alerter", () => {
  const make = (kind: "discord" | "telegram" | "none", t: { now: number }, calls: unknown[]) =>
    new WebhookAlerter(
      kind,
      "http://hook.invalid/x",
      "42",
      log,
      1000,
      (async (_u: unknown, init: { body: string }) => {
        calls.push(JSON.parse(init.body));
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch,
      () => t.now,
    );

  it("posts the discord and telegram shapes and deduplicates per key within the cooldown", async () => {
    const t = { now: 0 };
    const calls: unknown[] = [];
    const d = make("discord", t, calls);
    await d.alert("pull-all", "pulled");
    await d.alert("pull-all", "pulled again");
    expect(calls).toEqual([{ content: "[converge-keeper] pulled" }]);
    await d.alert("error", "other key");
    expect(calls).toHaveLength(2);
    t.now = 1500;
    await d.alert("pull-all", "after cooldown");
    expect(calls).toHaveLength(3);
    const tgCalls: unknown[] = [];
    await make("telegram", t, tgCalls).alert("k", "hello");
    expect(tgCalls).toEqual([{ chat_id: "42", text: "[converge-keeper] hello" }]);
  });

  it("sends nothing when no webhook is configured and never throws on delivery failure", async () => {
    const calls: unknown[] = [];
    const none = make("none", { now: 0 }, calls);
    await none.alert("k", "m");
    expect(calls).toHaveLength(0);
    expect(none.sent).toHaveLength(1);
    const failing = new WebhookAlerter(
      "discord",
      "http://x.invalid",
      undefined,
      log,
      0,
      (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch,
    );
    await expect(failing.alert("k", "m")).resolves.toBeUndefined();
  });
});

describe("cost ledger", () => {
  const tx = (kind: string, price: bigint, limit: bigint, latencyMs: number): TxResult =>
    ({
      kind,
      hash: "0xaa",
      blockNumber: 7n,
      status: "success",
      gasLimit: limit,
      gasUsed: limit / 2n,
      effectiveGasPrice: price,
      costWei: limit * price,
      latencyMs,
      attempts: 1,
      nonce: 1,
      sentAtMs: 0,
      minedAtMs: latencyMs,
    }) as unknown as TxResult;

  it("writes one JSON line per tx and summarises per kind, largest spender first", () => {
    const dir = mkdtempSync(join(tmpdir(), "cost-"));
    const path = join(dir, "sub", "ledger.jsonl");
    const l = new CostLedger(path);
    const rows: CostRow[] = [
      l.record(tx("executeOrder", 100n * 10n ** 9n, 600_000n, 800)),
      l.record(tx("executeOrder", 100n * 10n ** 9n, 600_000n, 1200)),
      l.record(tx("setSigma", 100n * 10n ** 9n, 100_000n, 500)),
    ];
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] as string).block).toBe("7");
    const s = summarize(rows);
    expect(s.map((x) => x.kind)).toEqual(["executeOrder", "setSigma"]);
    expect(s[0]?.count).toBe(2);
    expect(s[0]?.avgCostMon).toBeCloseTo(0.06, 6);
    expect(s[0]?.totalCostMon).toBeCloseTo(0.12, 6);
    expect(s[0]?.p95LatencyMs).toBe(1200);
    expect(summarize([])).toEqual([]);
    rmSync(dir, { recursive: true });
  });
});

describe("http server", () => {
  const servers: ReturnType<typeof startServer>[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  const boot = async (status: Partial<Status>, token: string | undefined) => {
    const kill = new KillSwitch(false, join(mkdtempSync(join(tmpdir(), "kill-srv-")), "KILL"));
    const events: boolean[] = [];
    const s = startServer(0, "127.0.0.1", {
      status: () => ({
        mode: "live",
        startedAt: 0,
        lastTickAt: Date.now(),
        tickIntervalMs: 1000,
        ready: true,
        readyReasons: [],
        halted: false,
        vaultPaused: false,
        ...status,
      }),
      metrics: new Metrics(),
      kill,
      killToken: token,
      onKill: (on) => events.push(on),
    });
    servers.push(s);
    if (!s.listening) await new Promise((r) => s.once("listening", r));
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    return { base, kill, events };
  };

  it("/health is 200 while ticking and 503 once the loop stalls", async () => {
    const a = await boot({}, "t");
    expect((await fetch(`${a.base}/health`)).status).toBe(200);
    const b = await boot({ lastTickAt: Date.now() - 60_000 }, "t");
    expect((await fetch(`${b.base}/health`)).status).toBe(503);
    const c = await boot({ lastTickAt: null }, "t");
    expect((await fetch(`${c.base}/health`)).status).toBe(503);
  });

  it("/ready reflects whether the keeper can quote", async () => {
    const a = await boot({ ready: false, readyReasons: ["sources"] }, "t");
    const r = await fetch(`${a.base}/ready`);
    expect(r.status).toBe(503);
    expect((await r.json()) as { readyReasons: string[] }).toMatchObject({
      readyReasons: ["sources"],
    });
  });

  it("/kill needs the bearer token; without a configured token the endpoint does not exist", async () => {
    const a = await boot({}, "s3cret");
    expect((await fetch(`${a.base}/kill`, { method: "POST" })).status).toBe(401);
    expect(
      (
        await fetch(`${a.base}/kill`, {
          method: "POST",
          headers: { authorization: "Bearer nope!!" },
        })
      ).status,
    ).toBe(401);
    expect(a.kill.killed).toBe(false);
    const ok = await fetch(`${a.base}/kill`, {
      method: "POST",
      headers: { authorization: "Bearer s3cret" },
    });
    expect(ok.status).toBe(200);
    expect(a.kill.killed).toBe(true);
    await fetch(`${a.base}/unkill`, {
      method: "POST",
      headers: { authorization: "Bearer s3cret" },
    });
    expect(a.kill.killed).toBe(false);
    expect(a.events).toEqual([true, false]);
    expect((await fetch(`${a.base}/kill`)).status).toBe(404); // GET is not an action

    const b = await boot({}, undefined);
    expect((await fetch(`${b.base}/kill`, { method: "POST" })).status).toBe(404);
  });

  it("/kill answers 500 when the kill could not be persisted (it holds now, not across a restart)", async () => {
    const a = await boot({}, "s3cret");
    const dir = mkdtempSync(join(tmpdir(), "kill-bad-"));
    writeFileSync(join(dir, "f"), "x");
    // swap in a kill switch whose file cannot be written
    Object.assign(a.kill, { file: join(dir, "f", "KILL") });
    const res = await fetch(`${a.base}/kill`, {
      method: "POST",
      headers: { authorization: "Bearer s3cret" },
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { persisted: boolean; killed: boolean }).persisted).toBe(false);
    expect(a.kill.killed).toBe(true);
  });

  it("/metrics serves the Prometheus exposition", async () => {
    const a = await boot({}, "t");
    const body = await (await fetch(`${a.base}/metrics`)).text();
    expect(body).toContain("# TYPE");
  });
});

describe("exchange message parsing", () => {
  it("parses binance bookTicker and coinbase ticker and rejects garbage", () => {
    expect(parseBinance('{"b":"3000.0","a":"3000.2"}', () => 5)).toEqual({
      source: "binance",
      price: 3000.1,
      tsMs: 5,
    });
    expect(parseBinance('{"b":"3000","a":"2999"}')).toBeNull(); // crossed
    expect(parseBinance("not json")).toBeNull();
    expect(
      parseCoinbase('{"type":"ticker","best_bid":"10","best_ask":"12","price":"99"}', () => 1)
        ?.price,
    ).toBe(11);
    expect(parseCoinbase('{"type":"ticker","price":"9.5"}')?.price).toBe(9.5);
    expect(parseCoinbase('{"type":"heartbeat"}')).toBeNull();
  });
});

describe("reconnecting websocket price source", () => {
  it("reconnects after the server drops it and after silence (watchdog)", async () => {
    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as AddressInfo).port;
    let conns = 0;
    wss.on("connection", (s) => {
      conns += 1;
      s.send('{"b":"100","a":"102"}');
      if (conns === 1) setTimeout(() => s.close(), 50); // dropped by the server
      // later connections stay silent: the watchdog must kill and reopen them
    });
    const ticks: number[] = [];
    const src = new WsPriceSource({
      name: "t",
      url: `ws://127.0.0.1:${port}`,
      parse: parseBinance,
      onTick: (t) => ticks.push(t.price),
      log,
      watchdogMs: 300,
    });
    src.start();
    const deadline = Date.now() + 15_000;
    while (conns < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    src.stop();
    wss.close();
    expect(conns).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.every((p) => p === 101)).toBe(true);
  }, 30_000);
});

describe("rpc rate limiter", () => {
  it("counts calls by method, caps reads at maxRps, never delays a transaction submission", async () => {
    const { limitedFetch } = await import("../../src/chain/clients");
    let t = 0;
    const waits: number[] = [];
    const calls = new Map<string, number>();
    const f = limitedFetch(
      10,
      calls,
      () => t,
      async (ms) => {
        waits.push(ms);
        t += ms;
      },
      (async () => ({ ok: true })) as unknown as typeof fetch,
    );
    const body = (...methods: string[]) => ({
      body: JSON.stringify(methods.map((method) => ({ jsonrpc: "2.0", id: 1, method }))),
    });
    for (let i = 0; i < 10; i++) await f("http://x", body("eth_call")); // the burst allowance
    expect(waits).toHaveLength(0);
    await f("http://x", body("eth_call")); // the 11th must wait about 100 ms
    expect(waits.length).toBeGreaterThan(0);
    expect(waits[0]).toBeGreaterThanOrEqual(100);
    const before = waits.length;
    await f("http://x", body("eth_sendRawTransaction"));
    expect(waits.length).toBe(before); // urgent: no wait
    await f("http://x", body("eth_call", "eth_blockNumber", "eth_call"));
    expect(calls.get("eth_call")).toBe(13);
    expect(calls.get("eth_sendRawTransaction")).toBe(1);
    expect(calls.get("eth_blockNumber")).toBe(1);
  });
});
