import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const satMiningRoot = path.resolve(import.meta.dirname, "..");
const extensionEntryPath = path.join(satMiningRoot, "index.ts");
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

  it("keeps strategy and planner policy orchestration behind the Mining service", () => {
    const source = fs.readFileSync(extensionEntryPath, "utf8");

    expect(source).toContain('from "./src/mining-strategy-service.js"');
    expect(source).toContain("miningStrategyService.computeRoundStrategy(");
    expect(source).toContain("miningStrategyService.buildPlannerCycleRecord(");
    expect(source).not.toMatch(
      /from\s+["']\.\/src\/(?:strategy-engine|planner-policy|planner-analytics|planner-policy-eval)\.js["']/,
    );
  });

  it("does not retain operational JSON or NDJSON history readers and writers", () => {
    const source = fs.readFileSync(extensionEntryPath, "utf8");
    const retiredOperations = [
      "appendSatActionHistoryEntries",
      "appendSatPlannerHistoryOutcome",
      "clearSatActionHistory",
      "clearSatPlannerHistory",
      "readSatActionHistory",
      "readSatPlannerHistory",
      "writeSatAuditArtifacts",
      "writeSatRecentActions",
    ];

    for (const operation of retiredOperations) {
      expect(source).not.toContain(operation);
    }
    expect(source).toContain("const migrationFactory = async () =>");
    expect(source).toContain("migrationFactory,");
  });
});
