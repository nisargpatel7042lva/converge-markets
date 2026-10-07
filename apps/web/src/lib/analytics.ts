import { deployment, env, isProd } from "@/config/deployment";

/**
 * Privacy-respecting funnel analytics: anonymous random id kept in this browser, no address, no
 * handle, no IP-derived properties we send, no session recording. Without a PostHog key nothing
 * leaves the browser. Each funnel step is sent at most once per browser.
 */
export type FunnelEvent =
  "landing_view" | "account_created" | "funded" | "first_trade" | "lp_deposit";

const ID_KEY = "converge.aid";
const SENT_KEY = "converge.funnel";

function anonId(): string {
  try {
    let id = localStorage.getItem(ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(ID_KEY, id);
    }
    return id;
  } catch {
    return "anonymous";
  }
}

function alreadySent(ev: string): boolean {
  try {
    const sent = JSON.parse(localStorage.getItem(SENT_KEY) ?? "[]") as string[];
    if (sent.includes(ev)) return true;
    localStorage.setItem(SENT_KEY, JSON.stringify([...sent, ev]));
  } catch {
    // no storage: fall through and send
  }
  return false;
}

export function track(event: FunnelEvent, props: Record<string, string | number | boolean> = {}) {
  if (typeof window === "undefined") return;
  if (alreadySent(event)) return;
  const body = {
    api_key: env.posthogKey,
    event,
    distinct_id: anonId(),
    properties: {
      ...props,
      network: deployment.network,
      $process_person_profile: false,
      $ip: null,
    },
  };
  if (!env.posthogKey) {
    if (!isProd) console.debug("[analytics]", event, props);
    return;
  }
  try {
    const url = `${env.posthogHost}/capture/`;
    const data = JSON.stringify(body);
    if (!navigator.sendBeacon?.(url, data))
      void fetch(url, { method: "POST", body: data, keepalive: true });
  } catch {
    // analytics must never break the app
  }
}
