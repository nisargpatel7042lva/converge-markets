import { aggregatorV3Abi } from "@converge/sdk";
import { createPublicClient, http, type Address } from "viem";
import type { Logger } from "pino";
import { errText } from "../errors";

/** Polls a Chainlink push feed (sanity check for the reference price). */
export class ChainlinkSanity {
  private timer: NodeJS.Timeout | null = null;
  private decimals: number | null = null;

  constructor(
    private readonly rpcUrl: string,
    private readonly feed: Address,
    private readonly onAnswer: (price: number, updatedAtMs: number) => void,
    private readonly log: Logger,
    private readonly everyMs = 15_000,
  ) {}

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async poll(): Promise<void> {
    try {
      const client = createPublicClient({ transport: http(this.rpcUrl, { timeout: 8_000 }) });
      if (this.decimals === null) {
        this.decimals = Number(
          await client.readContract({
            address: this.feed,
            abi: aggregatorV3Abi,
            functionName: "decimals",
          }),
        );
      }
      const [, answer, , updatedAt] = await client.readContract({
        address: this.feed,
        abi: aggregatorV3Abi,
        functionName: "latestRoundData",
      });
      this.onAnswer(Number(answer) / 10 ** this.decimals, Number(updatedAt) * 1000);
    } catch (e) {
      this.log.warn({ err: errText(e, 120) }, "chainlink sanity read failed");
    }
  }
}
