import type { Logger } from "pino";

export interface Alerter {
  alert(key: string, message: string): Promise<void>;
}

/**
 * Webhook alerts (Discord or Telegram). Deduplicated per key with a cooldown so a stuck market
 * produces one alert per `cooldownMs`, not one per loop. Delivery failures are logged, never thrown
 * (alerting must not stop the scheduler).
 */
export class WebhookAlerter implements Alerter {
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly kind: "none" | "discord" | "telegram",
    private readonly url: string | undefined,
    private readonly chatId: string | undefined,
    private readonly log: Logger,
    private readonly cooldownMs = 15 * 60_000,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async alert(key: string, message: string): Promise<void> {
    const t = this.now();
    if (this.lastSent.size > 1000) {
      for (const [k, v] of this.lastSent) if (t - v >= this.cooldownMs) this.lastSent.delete(k);
    }
    const last = this.lastSent.get(key);
    if (last !== undefined && t - last < this.cooldownMs) return;
    this.lastSent.set(key, t);
    this.log.warn({ alert: key }, message);
    if (this.kind === "none" || !this.url) return;
    const body =
      this.kind === "discord"
        ? { content: `[converge-scheduler] ${message}` }
        : { chat_id: this.chatId, text: `[converge-scheduler] ${message}` };
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) this.log.error({ status: res.status }, "alert delivery failed");
    } catch (e) {
      this.log.error({ err: String(e) }, "alert delivery failed");
    }
  }
}
