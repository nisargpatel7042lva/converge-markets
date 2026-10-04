import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index";

describe("@converge/scheduler", () => {
  it("is wired into the workspace", () => {
    expect(PACKAGE_NAME).toBe("@converge/scheduler");
  });
});
