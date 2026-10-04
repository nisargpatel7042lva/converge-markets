import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index";

describe("@converge/sdk", () => {
  it("is wired into the workspace", () => {
    expect(PACKAGE_NAME).toBe("@converge/sdk");
  });
});
