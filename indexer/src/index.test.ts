import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index";

describe("@converge/indexer", () => {
  it("is wired into the workspace", () => {
    expect(PACKAGE_NAME).toBe("@converge/indexer");
  });
});
