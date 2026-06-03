import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTaskRecord, resetTaskRegistryForTests } from "../tasks/task-registry.js";
import { recordPluginTaskProgress } from "./task-ledger-api.js";

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(async () => {
  previousStateDir = process.env.FASED_STATE_DIR;
  stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-plugin-task-api-"));
  process.env.FASED_STATE_DIR = stateDir;
  resetTaskRegistryForTests({ persist: true });
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.FASED_STATE_DIR;
  } else {
    process.env.FASED_STATE_DIR = previousStateDir;
  }
  resetTaskRegistryForTests({ persist: false });
  await rm(stateDir, { recursive: true, force: true });
});

describe("plugin task ledger API", () => {
  it("records progress and evidence without granting control authority", () => {
    createTaskRecord({
      taskId: "task:plugin-progress",
      runId: "plugin-progress-run",
      source: "CLI",
      runtime: "cli",
      taskKind: "workflow",
      task: "Plugin progress target",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "state_changes",
      agentId: "main",
      ownerKey: "agent:main",
      createdAt: 1,
      updatedAt: 2,
    });

    const result = recordPluginTaskProgress({
      pluginId: "demo-plugin",
      taskId: "task:plugin-progress",
      agentId: "main",
      status: "blocked",
      progressSummary: "Waiting for external artifact.",
      evidence: {
        artifact: "build-123",
        ok: false,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.task.status).toBe("blocked");
    expect(result.task.progressSummary).toBe("Waiting for external artifact.");
    expect(result.task.metadata).toMatchObject({
      pluginTaskApi: {
        enabled: true,
        lastPluginId: "demo-plugin",
        authority: "progress-and-evidence-only",
        canGrantAccess: false,
        canExecuteWorkflowScripts: false,
      },
      pluginProgress: [expect.objectContaining({ pluginId: "demo-plugin", status: "blocked" })],
      pluginEvidence: [
        expect.objectContaining({
          pluginId: "demo-plugin",
          evidence: { artifact: "build-123", ok: false },
        }),
      ],
    });
  });

  it("enforces selected Agent ownership and does not create tasks", () => {
    createTaskRecord({
      taskId: "task:agent-owned",
      source: "CLI",
      runtime: "cli",
      task: "Agent owned",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "state_changes",
      agentId: "main",
      ownerKey: "agent:main",
      createdAt: 1,
      updatedAt: 2,
    });

    expect(
      recordPluginTaskProgress({
        pluginId: "demo-plugin",
        taskId: "task:agent-owned",
        agentId: "other",
        progressSummary: "Should not write.",
      }),
    ).toEqual({ ok: false, error: "task not found for selected Agent" });

    expect(
      recordPluginTaskProgress({
        pluginId: "demo-plugin",
        taskId: "missing",
        progressSummary: "Should not create.",
      }),
    ).toEqual({ ok: false, error: "task not found" });
  });
});
