import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index";

describe("@converge/strategy", () => {
  it("is wired into the workspace", () => {
    expect(PACKAGE_NAME).toBe("@converge/strategy");
  });
});
