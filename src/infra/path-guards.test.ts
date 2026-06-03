import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPathInside } from "./path-guards.js";

describe("isPathInside", () => {
  it("allows in-root paths whose basename starts with parent-directory dots", () => {
    const root = path.resolve("/workspace/root");
    expect(isPathInside(root, path.join(root, "..file.txt"))).toBe(true);
  });

  it("rejects real parent-directory escapes", () => {
    const root = path.resolve("/workspace/root");
    expect(isPathInside(root, path.join(root, "..", "escape.txt"))).toBe(false);
  });
});
