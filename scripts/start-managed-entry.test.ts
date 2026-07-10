import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("managed gateway entry selection", () => {
  it("prefers the lazy CLI entry before the compatibility index", () => {
    const script = fs.readFileSync(path.resolve(import.meta.dirname, "start-managed.sh"), "utf8");
    const start = script.indexOf("resolve_gateway_cli_entry() {");
    const end = script.indexOf("\n}\n", start);
    const resolver = script.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(resolver.indexOf("dist/entry.js")).toBeLessThan(resolver.indexOf("dist/index.js"));
    expect(resolver.indexOf("dist/entry.mjs")).toBeLessThan(resolver.indexOf("dist/index.mjs"));
  });
});
