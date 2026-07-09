import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const satMiningRoot = path.resolve(import.meta.dirname, "..");
const srcImportRe = /(?:from\s+|import\s*\(\s*)["'](?:\.\.\/)+src\//;

function listRuntimeSourceFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRuntimeSourceFiles(fullPath));
      continue;
    }
    if (!/\.(?:c|m)?tsx?$/.test(entry.name)) {
      continue;
    }
    if (entry.name.includes(".test.") || entry.name.includes(".test-")) {
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

describe("sat-mining runtime import boundary", () => {
  it("does not import Fased internals through relative src paths", () => {
    const offenders = listRuntimeSourceFiles(satMiningRoot)
      .filter((file) => srcImportRe.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(path.resolve(satMiningRoot, "..", ".."), file));

    expect(offenders).toEqual([]);
  });
});
