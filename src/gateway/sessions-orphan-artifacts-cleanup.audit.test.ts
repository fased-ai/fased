import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatSessionArchiveTimestamp,
  isPrimarySessionTranscriptFileName,
  isSessionArchiveArtifactName,
  isSessionCompactionCheckpointArtifactName,
  type SessionEntry,
} from "../config/sessions.js";
import { enforceSessionDiskBudget } from "../config/sessions/disk-budget.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const createdDirs: string[] = [];

async function readSource(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf-8");
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

async function fileExists(filePath: string): Promise<boolean> {
  const stat = await fs.stat(filePath).catch(() => null);
  return Boolean(stat?.isFile());
}

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("Lane 3 sessions orphan artifact cleanup audit", () => {
  it("classifies cleanup candidates without treating compaction checkpoints as orphan transcripts", () => {
    const checkpointName = "active.checkpoint.00000000-0000-4000-8000-000000000000.jsonl";
    const archiveName = `old.jsonl.deleted.${formatSessionArchiveTimestamp(
      Date.parse("2026-05-01T00:00:00.000Z"),
    )}`;

    expect(isPrimarySessionTranscriptFileName("active.jsonl")).toBe(true);
    expect(isSessionArchiveArtifactName(archiveName)).toBe(true);
    expect(isPrimarySessionTranscriptFileName(archiveName)).toBe(false);
    expect(isSessionCompactionCheckpointArtifactName(checkpointName)).toBe(true);
    expect(isPrimarySessionTranscriptFileName(checkpointName)).toBe(false);
    expect(isSessionArchiveArtifactName(checkpointName)).toBe(false);
    expect(isPrimarySessionTranscriptFileName("sessions.json")).toBe(false);
  });

  it("preserves checkpoint snapshots while disk budget removes only approved orphan/archive files", async () => {
    const dir = await makeTempDir("fased-session-orphan-artifact-audit-");
    const storePath = path.join(dir, "sessions.json");
    const activeTranscript = path.join(dir, "active.jsonl");
    const orphanTranscript = path.join(dir, "orphan.jsonl");
    const archiveTranscript = path.join(
      dir,
      `old.jsonl.deleted.${formatSessionArchiveTimestamp(Date.parse("2026-05-01T00:00:00.000Z"))}`,
    );
    const checkpointSnapshot = path.join(
      dir,
      "active.checkpoint.00000000-0000-4000-8000-000000000000.jsonl",
    );
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "active",
        updatedAt: Date.now(),
      },
    };

    await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
    await fs.writeFile(activeTranscript, "a".repeat(64), "utf-8");
    await fs.writeFile(orphanTranscript, "o".repeat(500), "utf-8");
    await fs.writeFile(archiveTranscript, "d".repeat(500), "utf-8");
    await fs.writeFile(checkpointSnapshot, "c".repeat(64), "utf-8");

    const result = await enforceSessionDiskBudget({
      store,
      storePath,
      activeSessionKey: "agent:main:main",
      maintenance: {
        maxDiskBytes: 900,
        highWaterBytes: 350,
      },
      warnOnly: false,
    });

    expect(result).toEqual(
      expect.objectContaining({
        removedFiles: 2,
        removedEntries: 0,
        overBudget: true,
      }),
    );
    await expect(fileExists(activeTranscript)).resolves.toBe(true);
    await expect(fileExists(checkpointSnapshot)).resolves.toBe(true);
    await expect(fileExists(orphanTranscript)).resolves.toBe(false);
    await expect(fileExists(archiveTranscript)).resolves.toBe(false);
    expect(store["agent:main:main"]?.sessionId).toBe("active");
  });

  it("maps cleanup ownership without importing session tools or memory retention", async () => {
    const sessionsCleanup = await readSource("src/commands/sessions-cleanup.ts");
    const doctorStateIntegrity = await readSource("src/commands/doctor-state-integrity.ts");
    const sessionsListTool = await readSource("src/agents/tools/sessions-list-tool.ts");
    const sessionsHistoryTool = await readSource("src/agents/tools/sessions-history-tool.ts");
    const exportSessionCommand = await readSource(
      "src/auto-reply/reply/commands-export-session.ts",
    );

    expect(sessionsCleanup).toContain("pruneMissingTranscriptEntries");
    expect(sessionsCleanup).toContain("enforceSessionDiskBudget");
    expect(sessionsCleanup).not.toMatch(
      /memory[_/-]|compactionCheckpoints|cleanupSessionCompaction/,
    );
    expect(sessionsCleanup).not.toContain("sessions-list-tool");
    expect(sessionsCleanup).not.toContain("sessions-history-tool");

    expect(doctorStateIntegrity).toContain("orphan transcript file");
    expect(doctorStateIntegrity).toContain("isPrimarySessionTranscriptFileName");
    expect(doctorStateIntegrity).not.toContain("repairHeartbeatPoisonedMainSession");

    expect(sessionsListTool).toContain("createSessionVisibilityGuard");
    expect(sessionsHistoryTool).toContain("createSessionVisibilityGuard");
    expect(`${sessionsListTool}\n${sessionsHistoryTool}`).not.toMatch(
      /sessions-cleanup|doctor-state-integrity|enforceSessionDiskBudget/,
    );

    expect(exportSessionCommand).toContain("fased-session-");
    expect(exportSessionCommand).toContain("writeNewDefaultExportFile(outputPath, html)");
    expect(exportSessionCommand).toContain('flag: "wx"');
    expect(exportSessionCommand).toContain('fs.writeFileSync(outputPath, html, "utf-8")');
  });

  it.skip("adds orphan checkpoint snapshot cleanup only after checkpoint retention rules are approved", () => {});

  it.skip("adds non-overwriting Fased session export filenames after product wording review", () => {});
});
