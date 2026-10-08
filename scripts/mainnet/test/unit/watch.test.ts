import { encodeFunctionData, parseAbi } from "viem";
import { convergeVaultAbi } from "@converge/sdk";
import { describe, expect, it } from "vitest";
import { describeCall, webhookNotifier } from "../../src/timelock-watch";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;

describe("timelock watch", () => {
  it("names known owner calls with their arguments", () => {
    expect(
      describeCall(
        encodeFunctionData({ abi: convergeVaultAbi, functionName: "setKeeper", args: [A(7)] }),
      ),
    ).toBe(`ConvergeVault.setKeeper("${A(7)}")`);
    expect(
      describeCall(
        encodeFunctionData({ abi: convergeVaultAbi, functionName: "setTvlCap", args: [123n] }),
      ),
    ).toBe("ConvergeVault.setTvlCap(123)");
    expect(
      describeCall(encodeFunctionData({ abi: convergeVaultAbi, functionName: "resumeQuoting" })),
    ).toBe("ConvergeVault.resumeQuoting()");
    expect(
      describeCall(
        encodeFunctionData({
          abi: parseAbi(["function acceptOwnership()"]),
          functionName: "acceptOwnership",
        }),
      ),
    ).toMatch(/acceptOwnership\(\)/);
  });

  it("does not hide a call it cannot decode", () => {
    expect(describeCall("0xdeadbeef")).toBe("unknown call 0xdeadbeef");
  });

  it("delivers to every configured channel, tolerates one failing, and is loud when none delivers", async () => {
    const calls: string[] = [];
    const f = ((url: string, init: { body: string }) => {
      calls.push(`${url}|${init.body}`);
      return Promise.resolve(
        new Response(url.includes("discord") ? null : "", {
          status: url.includes("discord") ? 204 : 200,
        }),
      );
    }) as unknown as typeof fetch;
    const env = {
      ALERT_WEBHOOK_URL: "https://discord.test/hook",
      TELEGRAM_BOT_TOKEN: "1:x",
      TELEGRAM_CHAT_ID: "-100",
    };
    await webhookNotifier(env, f).send("hello");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/discord.*converge-timelock\] hello/);
    expect(calls[1]).toMatch(/api.telegram.org\/bot1:x\/sendMessage/);

    const oneDown = ((url: string) =>
      Promise.resolve(
        new Response("", { status: url.includes("discord") ? 500 : 200 }),
      )) as unknown as typeof fetch;
    await expect(webhookNotifier(env, oneDown).send("x")).resolves.toBeUndefined();
    const allDown = (() =>
      Promise.resolve(new Response("", { status: 500 }))) as unknown as typeof fetch;
    await expect(webhookNotifier(env, allDown).send("x")).rejects.toThrow(/no channel delivered/);
    expect(() => webhookNotifier({}, f)).toThrow(/no channel configured/);

    // an enormous argument is cut so both channels accept it, and the tail (the operation id) survives
    const seen: string[] = [];
    const rec = ((url: string, init: { body: string }) => {
      seen.push(init.body);
      return Promise.resolve(
        new Response(url.includes("discord") ? null : "", {
          status: url.includes("discord") ? 204 : 200,
        }),
      );
    }) as unknown as typeof fetch;
    await webhookNotifier(env, rec).send(`SCHEDULED ${"x".repeat(9000)} (operation 0xabc)`);
    for (const b of seen) {
      expect(b.length).toBeLessThan(1900);
      expect(b).toMatch(/operation 0xabc/);
    }
  });
});
