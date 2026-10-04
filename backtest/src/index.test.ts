import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index";

describe("@converge/backtest", () => {
  it("is wired into the workspace", () => {
    expect(PACKAGE_NAME).toBe("@converge/backtest");
  });
});
