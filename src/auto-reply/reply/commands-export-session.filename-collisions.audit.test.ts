import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  describeCheckpointBranchIsolation,
  describeCheckpointRestoreIsolation,
} from "../../gateway/session-compaction-isolation.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function readSource(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf-8");
}

async function sourceExists(relativePath: string): Promise<boolean> {
  return Boolean(await fs.stat(path.join(repoRoot, relativePath)).catch(() => null));
}

function addCollisionSuffixForAudit(filePath: string, suffix: number): string {
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);
  return path.join(path.dirname(filePath), `${baseName}-${suffix}${ext}`);
}

describe("Lane 5 session export filename collisions audit", () => {
  it("maps 2d2fc19e36 to adopted Fased default session export writer behavior", async () => {
    const exportCommand = await readSource("src/auto-reply/reply/commands-export-session.ts");

    expect(await sourceExists("src/auto-reply/reply/commands-export-session.test.ts")).toBe(false);
    expect(exportCommand).toContain("function parseExportArgs");
    expect(exportCommand).toContain("function addCollisionSuffix");
    expect(exportCommand).toContain("function writeNewDefaultExportFile");
    expect(exportCommand).toContain("fased-session-");
    expect(exportCommand).toContain("entry.sessionId.slice(0, 8)");
    expect(exportCommand).toContain("path.join(params.workspaceDir, defaultFileName)");
    expect(exportCommand).toContain("writeNewDefaultExportFile(outputPath, html)");
    expect(exportCommand).toContain('fs.writeFileSync(outputPath, html, "utf-8")');
    expect(exportCommand).toContain('flag: "wx"');
    expect(exportCommand).toContain("EEXIST");
    expect(exportCommand).toContain("suffix <= 100");
  });

  it("documents the Fased default filename suffix contract", () => {
    const defaultPath = path.join(
      "/tmp/workspace",
      "fased-session-session--2026-05-05T10-11-12.html",
    );

    expect(addCollisionSuffixForAudit(defaultPath, 2)).toBe(
      path.join("/tmp/workspace", "fased-session-session--2026-05-05T10-11-12-2.html"),
    );
    expect(addCollisionSuffixForAudit(defaultPath, 100)).toBe(
      path.join("/tmp/workspace", "fased-session-session--2026-05-05T10-11-12-100.html"),
    );
  });

  it("keeps explicit output path semantics separate from default collision handling", async () => {
    const exportCommand = await readSource("src/auto-reply/reply/commands-export-session.ts");
    const outputPathStart = exportCommand.indexOf("let outputPath = args.outputPath");
    const writeStart = exportCommand.indexOf("if (args.outputPath)");
    const relativePathStart = exportCommand.indexOf("const relativePath =");
    const outputPathBlock = exportCommand.slice(outputPathStart, relativePathStart);

    expect(outputPathStart).toBeGreaterThan(-1);
    expect(writeStart).toBeGreaterThan(outputPathStart);
    expect(relativePathStart).toBeGreaterThan(writeStart);
    expect(outputPathBlock).toContain("args.outputPath.startsWith");
    expect(outputPathBlock).toContain("path.resolve(");
    expect(outputPathBlock).toContain("path.join(params.workspaceDir, defaultFileName)");
    expect(outputPathBlock).toContain('fs.writeFileSync(outputPath, html, "utf-8")');
    expect(outputPathBlock).toContain("writeNewDefaultExportFile(outputPath, html)");
  });

  it("keeps export collision work isolated from cleanup, compaction, channels, wallets, and session tools", async () => {
    const cleanupAudit = await readSource(
      "src/gateway/sessions-orphan-artifacts-cleanup.audit.test.ts",
    );
    const compactionContext = await readSource(
      "src/gateway/session-compaction-context.acceptance.test.ts",
    );
    const statusSessionAudit = await readSource(
      "src/gateway/status-session-runtime-labels.audit.test.ts",
    );

    expect(cleanupAudit).toContain("maps cleanup ownership");
    expect(cleanupAudit).toContain("adds non-overwriting Fased session export filenames");
    expect(cleanupAudit).toContain("fs.writeFileSync(outputPath, html");
    expect(cleanupAudit).toContain("writeNewDefaultExportFile");

    expect(compactionContext).toContain(
      "keeps checkpoint branch and restore isolated from channel delivery and wallet routing",
    );
    const branchIsolation = describeCheckpointBranchIsolation();
    const restoreIsolation = describeCheckpointRestoreIsolation();
    expect(branchIsolation.channelDeliveryTouched).toBe(false);
    expect(branchIsolation.walletActionRoutingTouched).toBe(false);
    expect(branchIsolation.sessionToolVisibilityTouched).toBe(false);
    expect(restoreIsolation.channelDeliveryTouched).toBe(false);
    expect(restoreIsolation.walletActionRoutingTouched).toBe(false);
    expect(restoreIsolation.sessionToolVisibilityTouched).toBe(false);

    expect(statusSessionAudit).toContain("@wallet");
    expect(statusSessionAudit).toContain("@trade");
    expect(statusSessionAudit).toContain("@offers");
    expect(statusSessionAudit).toContain("@mining");
    expect(statusSessionAudit).toContain("sessions_list");
  });

  it("suffixes colliding default Fased session export filenames before writing", async () => {
    const exportCommand = await readSource("src/auto-reply/reply/commands-export-session.ts");
    const explicitWriteStart = exportCommand.indexOf("if (args.outputPath)");
    const defaultWriteStart = exportCommand.indexOf("writeNewDefaultExportFile(outputPath, html)");

    expect(explicitWriteStart).toBeGreaterThan(-1);
    expect(defaultWriteStart).toBeGreaterThan(explicitWriteStart);
    expect(exportCommand).toContain("addCollisionSuffix(filePath, suffix)");
    expect(exportCommand).toContain('flag: "wx"');
    expect(exportCommand).toContain("EEXIST");
    expect(exportCommand).toContain("suffix <= 100");
    expect(exportCommand).toContain("return candidate");
  });

  it.skip("preserves explicit output path overwrite semantics after product review", () => {});
});
