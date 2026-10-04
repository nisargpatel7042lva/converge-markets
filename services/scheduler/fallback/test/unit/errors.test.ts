import { describe, expect, it } from "vitest";
import { BaseError, ContractFunctionRevertedError } from "viem";
import { marketFactoryAbi } from "@converge/sdk";
import { errorName, redact } from "../../src/scheduler";

describe("errorName", () => {
  it("decodes custom revert names (used to classify idempotent no-ops)", () => {
    // MarketExists(address) = 0x735852fc (cast sig), arg 0x...dead
    const err = new ContractFunctionRevertedError({
      abi: marketFactoryAbi,
      functionName: "createMarket",
      data: "0x735852fc000000000000000000000000000000000000000000000000000000000000dead",
    });
    expect(errorName(new BaseError("call failed", { cause: err }))).toBe("MarketExists");
    expect(errorName(new Error("plain"))).toBe("plain");
    expect(errorName("str")).toBe("str");
  });

  it("redacts RPC URL paths/queries and key-sized hex from error text", () => {
    const msg = `HTTP request failed. URL: https://monad-mainnet.g.alchemy.com/v2/SECRETKEY?x=1 key 0x${"ab".repeat(32)}`;
    const r = redact(msg);
    expect(r).not.toContain("SECRETKEY");
    expect(r).toContain("https://monad-mainnet.g.alchemy.com/<redacted>");
    expect(r).not.toContain("ab".repeat(32));
  });
});
