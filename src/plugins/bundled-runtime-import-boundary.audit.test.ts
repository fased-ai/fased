import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const extensionsRoot = path.resolve(import.meta.dirname, "..", "..", "extensions");
const relativeCoreImportRe = /(?:from\s+|import\s*\(\s*)["'](?:\.\.\/)+src\//;

function listRuntimeSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules") {
      continue;
    }
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRuntimeSourceFiles(fullPath));
      continue;
    }
    if (!/\.(?:c|m)?tsx?$/.test(entry.name)) {
      continue;
    }
    if (
      entry.name.includes(".test.") ||
      entry.name.includes(".test-") ||
      entry.name.includes("test-harness") ||
      entry.name.includes("test-utils")
    ) {
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

describe("bundled plugin runtime import boundary", () => {
  it("does not reach into core through relative src imports", () => {
    const offenders = listRuntimeSourceFiles(extensionsRoot)
      .filter((file) => relativeCoreImportRe.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(path.resolve(extensionsRoot, ".."), file))
      .toSorted();

    expect(offenders).toEqual([]);
  });
});
