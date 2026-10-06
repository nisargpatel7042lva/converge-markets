import type { Logger } from "pino";
import { errText } from "./errors";

export interface Alerter {
  alert(key: string, message: string): Promise<void>;
}

/**
 * Webhook alerts (Discord or Telegram), deduplicated per key with a cooldown. Delivery failures are
 * logged, never thrown: alerting must not stop the keeper. Nothing is sent when no webhook is set.
 */
export class WebhookAlerter implements Alerter {
  private readonly lastSent = new Map<string, number>();
  readonly sent: { key: string; message: string; atMs: number }[] = [];

  constructor(
    private readonly kind: "none" | "discord" | "telegram",
    private readonly url: string | undefined,
    private readonly chatId: string | undefined,
    private readonly log: Logger,
    private readonly cooldownMs = 5 * 60_000,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly onAlert?: (key: string) => void,
  ) {}

  async alert(key: string, message: string): Promise<void> {
    const t = this.now();
    const last = this.lastSent.get(key);
    if (last !== undefined && t - last < this.cooldownMs) return;
    this.lastSent.set(key, t); // set first: concurrent callers must not send the same alert twice
    this.sent.push({ key, message, atMs: t });
    if (this.sent.length > 500) this.sent.shift();
    this.onAlert?.(key);
    this.log.warn({ alert: key }, message);
    if (this.kind === "none" || !this.url) return;
    const text = `[converge-keeper] ${message}`;
    const body = this.kind === "discord" ? { content: text } : { chat_id: this.chatId, text };
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        this.log.error({ status: res.status }, "alert delivery failed");
        this.lastSent.delete(key); // not delivered: the next occurrence tries again
      }
    } catch (e) {
      this.log.error({ err: errText(e, 100) }, "alert delivery failed");
      this.lastSent.delete(key);
    }
  }
}
