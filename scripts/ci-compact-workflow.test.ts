import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

async function workflow(name: string) {
  const source = await readFile(resolve(repoRoot, `.github/workflows/${name}`), "utf8");
  return { source, document: parse(source) as { jobs?: Record<string, unknown> } };
}

describe("compact CI topology", () => {
  it("exposes exactly four ordinary PR jobs", async () => {
    const { document } = await workflow("pr.yml");
    expect(Object.keys(document.jobs ?? {})).toEqual([
      "classify",
      "selected-tests",
      "security",
      "checks",
    ]);
  });

  it("keeps the broad matrix outside pull requests", async () => {
    const { source } = await workflow("ci.yml");
    expect(source).not.toMatch(/^\s*pull_request:/mu);
    expect(source).toMatch(/^\s*schedule:/mu);
    expect(source).toMatch(/^\s*workflow_dispatch:/mu);
  });
});
