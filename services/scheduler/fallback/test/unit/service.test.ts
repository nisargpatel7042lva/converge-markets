import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { WebhookAlerter } from "../../src/alerts";
import { loadEnv } from "../../src/env";
import { startHealthServer, type HealthState } from "../../src/health";
import { withRetry } from "../../src/retry";

const log = pino({ level: "silent" });
const KEY = `0x${"ab".repeat(32)}`;
const base = {
  RPC_URL: "http://127.0.0.1:8545",
  FACTORY: `0x${"11".repeat(20)}`,
  LENS: `0x${"22".repeat(20)}`,
  RECEIVER: `0x${"33".repeat(20)}`,
  SCHEDULER_PRIVATE_KEY: KEY,
};

describe("env", () => {
  it("parses defaults and validates combinations", () => {
    const env = loadEnv(base);
    expect(env.LOOP_INTERVAL_MS).toBe(10_000);
    expect(env.STREAMS_SOURCE).toBe("none");
    expect(() => loadEnv({ ...base, ALERT_KIND: "discord" })).toThrow("ALERT_WEBHOOK_URL");
    expect(() =>
      loadEnv({ ...base, ALERT_KIND: "telegram", ALERT_WEBHOOK_URL: "https://x.y" }),
    ).toThrow("TELEGRAM_CHAT_ID");
    expect(() => loadEnv({ ...base, STREAMS_SOURCE: "rest" })).toThrow("DATA_STREAMS_API");
    expect(() => loadEnv({ ...base, STREAMS_SOURCE: "test-signer" })).toThrow(
      "STREAMS_TEST_SIGNER_KEY",
    );
    expect(() => loadEnv({ ...base, SCHEDULER_PRIVATE_KEY: "0x12" })).toThrow();
    expect(loadEnv({ ...base, EPOCH: "1790864100" }).EPOCH).toBe(1_790_864_100n);
    const { RECEIVER: _r, ...noReceiver } = base;
    void _r;
    expect(() => loadEnv(noReceiver)).toThrow("RECEIVER is required");
    expect(loadEnv({ ...noReceiver, STANDALONE: "true" }).STANDALONE).toBe(true);
    expect(loadEnv(base).HEALTH_HOST).toBe("127.0.0.1");
  });
});

describe("alerts", () => {
  it("posts Discord and Telegram payloads and deduplicates per key within the cooldown", async () => {
    let t = 0;
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("ok");
    }) as unknown as typeof fetch;
    const d = new WebhookAlerter(
      "discord",
      "https://discord/hook",
      undefined,
      log,
      1000,
      fetchImpl,
      () => t,
    );
    await d.alert("k", "first");
    await d.alert("k", "duplicate within cooldown");
    t = 1001;
    await d.alert("k", "after cooldown");
    await d.alert("other", "different key");
    expect(calls.map((c) => (c.body as { content: string }).content)).toEqual([
      "[converge-scheduler] first",
      "[converge-scheduler] after cooldown",
      "[converge-scheduler] different key",
    ]);
    const tg = new WebhookAlerter(
      "telegram",
      "https://api.telegram.org/botX/sendMessage",
      "42",
      log,
      1000,
      fetchImpl,
      () => 0,
    );
    await tg.alert("k", "hello");
    expect(calls.at(-1)).toEqual({
      url: "https://api.telegram.org/botX/sendMessage",
      body: { chat_id: "42", text: "[converge-scheduler] hello" },
    });
  });

  it("never throws when delivery fails", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const a = new WebhookAlerter("discord", "https://discord/hook", undefined, log, 0, fetchImpl);
    await expect(a.alert("k", "m")).resolves.toBeUndefined();
    const bad = new WebhookAlerter(
      "discord",
      "https://discord/hook",
      undefined,
      log,
      0,
      (async () => new Response("no", { status: 500 })) as unknown as typeof fetch,
    );
    await expect(bad.alert("k", "m")).resolves.toBeUndefined();
  });
});

describe("retry", () => {
  it("retries with exponential backoff and gives up after the limit", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const ok = await withRetry(
      async () => {
        if (++n < 3) throw new Error("transient");
        return "done";
      },
      { retries: 5, baseMs: 100, maxMs: 1000 },
      async (ms) => void sleeps.push(ms),
    );
    expect(ok).toBe("done");
    expect(sleeps).toEqual([100, 200]);
    await expect(
      withRetry(
        async () => Promise.reject(new Error("permanent")),
        { retries: 2, baseMs: 1 },
        async () => {},
      ),
    ).rejects.toThrow("permanent");
  });
});

describe("health", () => {
  it("is 200 only when the last tick succeeded recently", async () => {
    const state: HealthState = {
      startedAt: Date.now(),
      lastTickAt: null,
      lastTickOk: false,
      lastError: null,
      ticks: 0,
      leader: null,
      lateCount: 0,
      consecutiveBad: 0,
      unhealthyAfterBad: 3,
      intervalMs: 1000,
    };
    const port = 18_000 + Math.floor(Math.random() * 1000);
    const server = startHealthServer(port, () => state);
    await new Promise((r) => server.once("listening", r));
    const get = async (path = "/health") => (await fetch(`http://127.0.0.1:${port}${path}`)).status;
    expect(await get()).toBe(503);
    state.lastTickAt = Date.now();
    state.lastTickOk = true;
    expect(await get()).toBe(200);
    state.consecutiveBad = 3; // e.g. every action failing, or CRE late while we are passive
    expect(await get()).toBe(503);
    state.consecutiveBad = 0;
    state.lastTickAt = Date.now() - 10_000;
    expect(await get()).toBe(503);
    expect(await get("/other")).toBe(404);
    server.close();
  });
});
