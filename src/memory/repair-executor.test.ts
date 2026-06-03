import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";

const getMemorySearchManager = vi.hoisted(() => vi.fn(async () => ({ manager: null })));
const resolveAgentWorkspaceDir = vi.hoisted(() =>
  vi.fn((cfg: FasedAgentConfig, agentId: string) => {
    const agent = cfg.agents?.list?.find((entry) => entry.id === agentId);
    return agent?.workspace ?? path.join(os.tmpdir(), "fased-memory-repair-executor");
  }),
);

vi.mock("./index.js", () => ({
  getMemorySearchManager,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir,
}));

import { executeMemoryRepair } from "./repair-executor.js";

describe("memory repair executor", () => {
  it("executes a supported file creation proposal with backup, audit, and lock records", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-memory-repair-executor-"));
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await fs.mkdir(workspaceDir);
    await fs.mkdir(stateDir);

    const result = await executeMemoryRepair({
      cfg: {
        agents: { list: [{ id: "main", workspace: workspaceDir }] },
        plugins: { slots: { memory: "none" } },
      } as FasedAgentConfig,
      agentId: "main",
      proposalIds: ["memory-repair-preview-1"],
      surface: "cli",
      confirmation: "cli-yes",
      allowWrites: true,
      acceptCurrentPreview: true,
      acceptCurrentAuditPlan: true,
      executionId: "repair-test-1",
      now: new Date("2026-05-01T12:00:00.000Z"),
      env: { FASED_STATE_DIR: stateDir },
    });

    expect(result.status, JSON.stringify(result, null, 2)).toBe("success");
    expect(result.noWritePerformed).toBe(false);
    expect(result.summary).toMatchObject({
      selected: 1,
      backupSucceeded: 1,
      writeSucceeded: 1,
      failed: 0,
    });
    await expect(fs.stat(path.join(workspaceDir, "MEMORY.md"))).resolves.toMatchObject({
      size: 0,
    });
    await expect(fs.stat(result.backupManifestPath ?? "")).resolves.toBeTruthy();
    await expect(fs.stat(result.auditRecordPath ?? "")).resolves.toBeTruthy();
    await expect(fs.stat(result.lockPath ?? "")).resolves.toBeTruthy();
    const audit = await fs.readFile(result.auditRecordPath ?? "", "utf-8");
    expect(audit).toContain('"event":"started"');
    expect(audit).toContain('"event":"finished"');
    expect(audit).not.toMatch(/transcript body|message body/i);
  });

  it("denies execution before writing when the write gate is disabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-memory-repair-denied-"));
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await fs.mkdir(workspaceDir);
    await fs.mkdir(stateDir);

    const result = await executeMemoryRepair({
      cfg: {
        agents: { list: [{ id: "main", workspace: workspaceDir }] },
        plugins: { slots: { memory: "none" } },
      } as FasedAgentConfig,
      agentId: "main",
      proposalIds: ["memory-repair-preview-1"],
      surface: "cli",
      confirmation: "cli-yes",
      allowWrites: false,
      acceptCurrentPreview: true,
      acceptCurrentAuditPlan: true,
      executionId: "repair-denied-1",
      env: { FASED_STATE_DIR: stateDir },
    });

    expect(result.status).toBe("denied");
    expect(result.noWritePerformed).toBe(true);
    expect(result.reasons, JSON.stringify(result, null, 2)).toContain(
      "memory repair write mode is disabled",
    );
    await expect(fs.stat(path.join(workspaceDir, "MEMORY.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
