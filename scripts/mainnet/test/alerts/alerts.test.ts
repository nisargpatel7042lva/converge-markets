import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { judge, parseCounters, runAlertTest } from "../../src/alert-test";
import { repoRoot } from "../../src/params";

const METRICS = (discord: [number, number], telegram: [number, number]) => `
# HELP alertmanager_notification_requests_total x
alertmanager_notification_requests_total{integration="discord"} ${discord[0]}
alertmanager_notification_requests_total{integration="telegram"} ${telegram[0]}
alertmanager_notification_requests_total{integration="webhook"} 99
alertmanager_notification_requests_failed_total{integration="discord"} ${discord[1]}
alertmanager_notification_requests_failed_total{integration="telegram"} ${telegram[1]}
alertmanager_notifications_total{integration="discord"} 1000
`;

describe("alert test: judging delivery per channel", () => {
  it("parses the counters, summing reasons", () => {
    const c = parseCounters(METRICS([3, 1], [4, 0]));
    expect(c.attempts).toMatchObject({ discord: 3, telegram: 4, webhook: 99 });
    expect(c.failed).toMatchObject({ discord: 1, telegram: 0 });
  });

  it("passes only channels whose sent counter rose and whose failed counter did not", () => {
    const before = parseCounters(METRICS([1, 0], [1, 0]));
    const ok = judge(before, parseCounters(METRICS([2, 0], [2, 0])), ["discord", "telegram"]);
    expect(ok.every((r) => r.delivered)).toBe(true);
    const tgFailed = judge(before, parseCounters(METRICS([2, 0], [2, 1])), ["discord", "telegram"]);
    expect(tgFailed.find((r) => r.integration === "telegram")).toMatchObject({ delivered: false });
    expect(tgFailed.find((r) => r.integration === "discord")).toMatchObject({ delivered: true });
    // an attempt that failed is not a delivery, even though the attempts counter rose
    const onlyAttempt = judge(before, parseCounters(METRICS([2, 1], [2, 0])), ["discord"]);
    expect(onlyAttempt[0]).toMatchObject({ delivered: false });
    const silent = judge(before, parseCounters(METRICS([2, 0], [1, 0])), ["discord", "telegram"]);
    expect(silent.find((r) => r.integration === "telegram")?.detail).toMatch(/no notification/);
    // a channel that is not configured at all never passes
    expect(judge(before, before, ["pagerduty"])[0]!.delivered).toBe(false);
  });

  it("posts a page-severity test alert, waits for the counters, then resolves it", async () => {
    const posts: unknown[] = [];
    let polls = 0;
    const fake = (async (url: string, init?: { method?: string; body?: string }) => {
      if (url.endsWith("/metrics")) {
        polls++;
        return new Response(polls === 1 ? METRICS([0, 0], [0, 0]) : METRICS([1, 0], [1, 0]));
      }
      posts.push(JSON.parse(init!.body!));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await runAlertTest({
      baseUrl: "http://am",
      expect: ["discord", "telegram"],
      fetchImpl: fake,
      sleep: async () => undefined,
    });
    expect(res.map((r) => r.delivered)).toEqual([true, true]);
    expect(posts).toHaveLength(2);
    const first = (posts[0] as { labels: Record<string, string> }[])[0]!;
    expect(first.labels.alertname).toMatch(/^ConvergeTestAlert_\d+$/);
    expect(first.labels.severity).toBe("page");
    expect((posts[1] as { endsAt?: string }[])[0]!.endsAt).toBeDefined();
  });

  it("surfaces a refused alert as an error", async () => {
    const fake = (async (url: string) =>
      url.endsWith("/metrics")
        ? new Response(METRICS([0, 0], [0, 0]))
        : new Response("nope", { status: 400 })) as unknown as typeof fetch;
    await expect(
      runAlertTest({
        baseUrl: "http://am",
        expect: ["discord"],
        fetchImpl: fake,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/refused/);
  });
});

const hasDocker =
  spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" })
    .status === 0;

/**
 * The real thing: the pinned Alertmanager image with the mainnet routing config, a mock Discord
 * and a mock Telegram API, and the alert-test tool against it. Proves the routing sends a
 * page-severity alert to BOTH channels and a warn-severity alert to Discord only.
 */
describe.skipIf(!hasDocker)("alert test against a real Alertmanager (docker)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "am-"));
  const hits: { channel: string; body: string }[] = [];
  let mock: Server;
  const container = `converge-am-test-${process.pid}`;
  const MOCK_PORT = 19181;
  const AM_PORT = 19193;

  let startAlertmanager: () => Promise<void>;
  beforeAll(async () => {
    mock = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        const channel = req.url?.startsWith("/discord")
          ? "discord"
          : req.url?.includes("/sendMessage")
            ? "telegram"
            : "other";
        hits.push({ channel, body: b });
        res.writeHead(channel === "discord" ? 204 : 200, { "content-type": "application/json" });
        res.end(
          channel === "telegram"
            ? JSON.stringify({
                ok: true,
                result: {
                  message_id: 1,
                  date: 1,
                  chat: { id: -1001234567890, type: "supergroup" },
                },
              })
            : "",
        );
      });
    });
    await new Promise<void>((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
    const tmpl = readFileSync(
      resolve(repoRoot, "ops/alertmanager/alertmanager.mainnet.tmpl.yml"),
      "utf8",
    )
      .replace("__TELEGRAM_CHAT_ID__", "-1001234567890")
      .replace(
        "bot_token_file: /run/secrets/telegram_token",
        `bot_token_file: /run/secrets/telegram_token\n        api_url: http://127.0.0.1:${MOCK_PORT}`,
      )
      // the test must not wait for the production 10 s grouping
      .replace("group_wait: 10s", "group_wait: 1s");
    writeFileSync(resolve(dir, "alertmanager.yml"), tmpl);
    writeFileSync(resolve(dir, "alert_webhook"), `http://127.0.0.1:${MOCK_PORT}/discord`);
    writeFileSync(resolve(dir, "telegram_token"), "123456:TESTTOKEN");
    chmodSync(dir, 0o755);
    for (const f of ["alertmanager.yml", "alert_webhook", "telegram_token"])
      chmodSync(resolve(dir, f), 0o644);
    startAlertmanager = async () => {
      spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
      execFileSync("docker", [
        "run",
        "-d",
        "--rm",
        "--name",
        container,
        "--network",
        "host",
        "-v",
        `${resolve(dir, "alertmanager.yml")}:/etc/alertmanager/alertmanager.yml:ro`,
        "-v",
        `${resolve(dir, "alert_webhook")}:/run/secrets/alert_webhook:ro`,
        "-v",
        `${resolve(dir, "telegram_token")}:/run/secrets/telegram_token:ro`,
        "prom/alertmanager:v0.28.1",
        "--config.file=/etc/alertmanager/alertmanager.yml",
        `--web.listen-address=127.0.0.1:${AM_PORT}`,
        "--storage.path=/tmp/am",
      ]);
      for (let i = 0; i < 40; i++) {
        try {
          if ((await fetch(`http://127.0.0.1:${AM_PORT}/-/ready`)).ok) return;
        } catch {
          /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error("alertmanager did not start");
    };
    await startAlertmanager();
  }, 120_000);

  afterAll(async () => {
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    await new Promise((r) => mock?.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  it("a page-severity test alert reaches Discord and Telegram", async () => {
    const res = await runAlertTest({
      baseUrl: `http://127.0.0.1:${AM_PORT}`,
      expect: ["discord", "telegram"],
      timeoutMs: 40_000,
    });
    expect(res, JSON.stringify(res)).toEqual([
      expect.objectContaining({ integration: "discord", delivered: true }),
      expect.objectContaining({ integration: "telegram", delivered: true }),
    ]);
    const discord = hits.find((h) => h.channel === "discord")!;
    expect(discord.body).toMatch(/ConvergeTestAlert/);
    expect(discord.body).toMatch(/PAGE/);
    const telegram = hits.find((h) => h.channel === "telegram")!;
    expect(telegram.body).toMatch(/ConvergeTestAlert/);
    expect(telegram.body).toMatch(/-1001234567890/);
  }, 60_000);

  it("a warn-severity alert goes to Discord only, never to the pager channel", async () => {
    const before = hits.filter((h) => h.channel === "telegram").length;
    const stamp = new Date().toISOString();
    await fetch(`http://127.0.0.1:${AM_PORT}/api/v2/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          labels: { alertname: "WarnOnlyTest", severity: "warn" },
          annotations: { summary: "warn" },
          startsAt: stamp,
        },
      ]),
    });
    for (
      let i = 0;
      i < 20 && !hits.some((h) => h.channel === "discord" && h.body.includes("WarnOnlyTest"));
      i++
    )
      await new Promise((r) => setTimeout(r, 500));
    expect(hits.some((h) => h.channel === "discord" && h.body.includes("WarnOnlyTest"))).toBe(true);
    expect(hits.filter((h) => h.channel === "telegram").length).toBe(before);
  }, 30_000);

  it("a channel that is down is reported as FAILED, not silently skipped", async () => {
    // keep-alive connections would otherwise keep being served after close()
    mock.closeAllConnections();
    await new Promise((r) => mock.close(r));
    // a fresh Alertmanager: its counters start at zero, so earlier "resolved" notices cannot leak in
    await startAlertmanager();
    const res = await runAlertTest({
      baseUrl: `http://127.0.0.1:${AM_PORT}`,
      expect: ["discord", "telegram"],
      timeoutMs: 40_000,
    });
    expect(
      res.every((r) => !r.delivered),
      JSON.stringify(res),
    ).toBe(true);
    expect(res.some((r) => r.detail.includes("FAILED"))).toBe(true);
  }, 60_000);
});
