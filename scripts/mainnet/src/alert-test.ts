/**
 * Fires a test alert through Alertmanager and proves, per channel, that it was delivered: the
 * `alertmanager_notification_requests_total{integration=...}` counter must rise by more than
 * `alertmanager_notification_requests_failed_total` does (a delivery is an attempt that did not fail). This is the machine-checkable half of "every alert channel works";
 * the human half (someone saw the message on their phone) is a line in docs/ops/launch-checklist.md.
 *
 *   ALERTMANAGER_URL=http://127.0.0.1:9093 pnpm --filter @converge/mainnet alert-test [--expect discord,telegram]
 */
export interface Counters {
  /** Delivery attempts per integration (`alertmanager_notification_requests_total`). */
  attempts: Record<string, number>;
  /** Attempts that failed (`alertmanager_notification_requests_failed_total`), counted at once. */
  failed: Record<string, number>;
}

export interface ChannelResult {
  integration: string;
  delivered: boolean;
  detail: string;
}

/**
 * Parses the per-ATTEMPT counters. (`alertmanager_notifications_failed_total` only moves after the
 * retries are exhausted, up to a whole group interval later, so it cannot prove an outage quickly;
 * verified against alertmanager v0.28.1 with an unreachable receiver.)
 */
export function parseCounters(text: string): Counters {
  const out: Counters = { attempts: {}, failed: {} };
  const re =
    /^(alertmanager_notification_requests(?:_failed)?_total)\{([^}]*)\}\s+([0-9.eE+-]+)\s*$/;
  for (const line of text.split("\n")) {
    const m = re.exec(line);
    if (!m) continue;
    const integration = /integration="([^"]+)"/.exec(m[2]!)?.[1];
    if (!integration) continue;
    const bucket = m[1] === "alertmanager_notification_requests_total" ? out.attempts : out.failed;
    bucket[integration] = (bucket[integration] ?? 0) + Number(m[3]);
  }
  return out;
}

export function judge(before: Counters, after: Counters, expect: string[]): ChannelResult[] {
  return expect.map((integration) => {
    const attempts = (after.attempts[integration] ?? 0) - (before.attempts[integration] ?? 0);
    const failed = (after.failed[integration] ?? 0) - (before.failed[integration] ?? 0);
    const ok = attempts - failed;
    if (ok > 0)
      return {
        integration,
        delivered: true,
        detail: `${ok} notification(s) delivered${failed ? ` (after ${failed} failed attempt(s))` : ""}`,
      };
    if (failed > 0)
      return {
        integration,
        delivered: false,
        detail: `${failed} delivery attempt(s) FAILED, none succeeded`,
      };
    return {
      integration,
      delivered: false,
      detail: "no notification was sent (not routed, or not yet)",
    };
  });
}

export interface AlertTestOptions {
  baseUrl: string;
  expect: string[];
  timeoutMs?: number;
  pollMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

async function counters(base: string, f: typeof fetch): Promise<Counters> {
  const r = await f(`${base}/metrics`, { signal: AbortSignal.timeout(5_000) });
  if (!r.ok) throw new Error(`Alertmanager /metrics answered ${r.status}`);
  return parseCounters(await r.text());
}

export async function runAlertTest(o: AlertTestOptions): Promise<ChannelResult[]> {
  const f = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = o.baseUrl.replace(/\/$/, "");
  const before = await counters(base, f);
  const stamp = new Date().toISOString();
  const alert = {
    // unique per run: Alertmanager de-duplicates an alert in a group it already notified, so a
    // repeated fixed name would be (correctly) silent and look like a failed channel
    labels: {
      alertname: `ConvergeTestAlert_${stamp.replace(/\D/g, "").slice(8, 17)}`,
      severity: "page",
      service: "alert-test",
    },
    annotations: {
      summary: `TEST ALERT ${stamp}: if you can read this on this channel, delivery works. No action needed.`,
    },
    startsAt: stamp,
  };
  const post = await f(`${base}/api/v2/alerts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([alert]),
    signal: AbortSignal.timeout(5_000),
  });
  if (!post.ok)
    throw new Error(`Alertmanager refused the test alert: ${post.status} ${await post.text()}`);

  const deadline = Date.now() + (o.timeoutMs ?? 90_000);
  let results: ChannelResult[] = [];
  while (Date.now() < deadline) {
    await sleep(o.pollMs ?? 2_000);
    results = judge(before, await counters(base, f), o.expect);
    if (results.every((r) => r.delivered)) break;
  }
  // resolve it, so it does not sit in the active list (a resolved notice is sent too: send_resolved)
  await f(`${base}/api/v2/alerts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([{ ...alert, endsAt: new Date().toISOString() }]),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
  return results;
}

if (process.argv[1]?.endsWith("alert-test.ts")) {
  const i = process.argv.indexOf("--expect");
  const expect = (i > 0 ? process.argv[i + 1]! : "discord,telegram").split(",").filter(Boolean);
  const base = process.env.ALERTMANAGER_URL ?? "http://127.0.0.1:9093";
  runAlertTest({ baseUrl: base, expect })
    .then((results) => {
      for (const r of results)
        console.log(`${r.delivered ? "PASS" : "FAIL"}  ${r.integration}: ${r.detail}`);
      process.exit(results.length > 0 && results.every((r) => r.delivered) ? 0 : 1);
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
