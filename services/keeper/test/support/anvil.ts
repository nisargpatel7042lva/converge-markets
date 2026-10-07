import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";

export type Anvil = { url: string; port: number; stop: () => Promise<void> };

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

/** Starts a local anvil with 0.4 s blocks (the Monad block time) and no contract size limit. */
export async function startAnvil(blockTime = 0.4): Promise<Anvil> {
  const port = await freePort();
  const bin = `${homedir()}/.foundry/bin/anvil`;
  const child: ChildProcess = spawn(
    bin,
    [
      "--port",
      String(port),
      "--block-time",
      String(blockTime),
      "--disable-code-size-limit",
      "--silent",
      "--accounts",
      "10",
    ],
    { stdio: "ignore" },
  );
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (r.ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    port,
    stop: () =>
      new Promise((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => resolve(), 2000).unref();
      }),
  };
}
