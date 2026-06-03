import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listSavedTaskWorkflowDefinitions,
  removeTaskWorkflowDefinition,
  resetTaskWorkflowDefinitionsForTests,
  saveTaskWorkflowDefinition,
} from "./workflow-definitions.js";

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(async () => {
  previousStateDir = process.env.FASED_STATE_DIR;
  stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-task-workflow-definitions-"));
  process.env.FASED_STATE_DIR = stateDir;
  resetTaskWorkflowDefinitionsForTests({ persist: true });
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.FASED_STATE_DIR;
  } else {
    process.env.FASED_STATE_DIR = previousStateDir;
  }
  resetTaskWorkflowDefinitionsForTests({ persist: false });
  await rm(stateDir, { recursive: true, force: true });
});

describe("saved task workflow definitions", () => {
  it("saves, normalizes, and filters definitions per agent", () => {
    const saved = saveTaskWorkflowDefinition({
      agentId: "main",
      name: "Release check",
      task: "Check release",
      notifyPolicy: "state_changes",
      steps: [
        { label: "Prepare docs", type: "note" },
        { label: "Wait for smoke", type: "wait", durationMs: 300_000 },
        { label: "Approve publish", type: "approval", input: "Review output." },
      ],
    });
    saveTaskWorkflowDefinition({
      agentId: "beta",
      name: "Other agent",
      steps: [{ label: "Run", type: "checkpoint" }],
    });

    expect(saved).toMatchObject({
      id: "Release-check",
      agentId: "main",
      mode: "steps",
      name: "Release check",
      task: "Check release",
      notifyPolicy: "state_changes",
    });
    expect(saved.steps).toEqual([
      expect.objectContaining({ id: "Prepare-docs", type: "note" }),
      expect.objectContaining({ id: "Wait-for-smoke", type: "wait", durationMs: 300_000 }),
      expect.objectContaining({ id: "Approve-publish", type: "approval" }),
    ]);
    expect(listSavedTaskWorkflowDefinitions({ agentId: "main" }).definitions).toEqual([saved]);
    expect(listSavedTaskWorkflowDefinitions().definitions).toHaveLength(2);
  });

  it("saves structured graph workflow definitions", () => {
    const saved = saveTaskWorkflowDefinition({
      agentId: "main",
      id: "deploy-graph",
      name: "Deploy graph",
      task: "Run deploy graph",
      notifyPolicy: "state_changes",
      graph: {
        nodes: [
          { id: "start", type: "start", label: "Start" },
          { id: "approve", type: "approval", label: "Approve deploy" },
          { id: "done", type: "end", label: "Done" },
        ],
        edges: [
          { from: "start", to: "approve", on: "success" },
          { from: "approve", to: "done", on: "approved" },
        ],
        layout: {
          nodes: {
            start: { x: 12, y: 34 },
            approve: { x: 250, y: 34 },
            done: { x: 500, y: 34 },
          },
        },
      },
    });

    expect(saved).toMatchObject({
      id: "deploy-graph",
      agentId: "main",
      mode: "graph",
      name: "Deploy graph",
      notifyPolicy: "state_changes",
      graph: {
        version: 2,
        startNodeId: "start",
        layout: {
          nodes: {
            start: { x: 12, y: 34 },
            approve: { x: 250, y: 34 },
            done: { x: 500, y: 34 },
          },
        },
      },
    });
    expect(saved.steps).toEqual([
      expect.objectContaining({ id: "start", type: "checkpoint" }),
      expect.objectContaining({ id: "approve", type: "checkpoint" }),
      expect.objectContaining({ id: "done", type: "checkpoint" }),
    ]);
    expect(listSavedTaskWorkflowDefinitions({ agentId: "main" }).definitions).toEqual([saved]);
  });

  it("updates and removes definitions without touching another agent", () => {
    const first = saveTaskWorkflowDefinition({
      id: "smoke",
      agentId: "main",
      name: "Smoke",
      task: "Old",
      steps: [{ label: "Old step", type: "checkpoint" }],
    });
    saveTaskWorkflowDefinition({
      id: "smoke",
      agentId: "beta",
      name: "Beta smoke",
      steps: [{ label: "Beta", type: "checkpoint" }],
    });

    const updated = saveTaskWorkflowDefinition({
      id: "smoke",
      agentId: "main",
      name: "Smoke",
      task: "New",
      notifyPolicy: "silent",
      steps: [{ label: "New step", type: "handoff" }],
    });

    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    expect(updated.task).toBe("New");
    expect(updated.steps).toEqual([expect.objectContaining({ type: "handoff" })]);

    const remaining = removeTaskWorkflowDefinition({ agentId: "main", id: "smoke" });
    expect(remaining.definitions).toHaveLength(0);
    expect(listSavedTaskWorkflowDefinitions({ agentId: "beta" }).definitions).toHaveLength(1);
  });

  it("rejects invalid definitions", () => {
    expect(() => saveTaskWorkflowDefinition({ name: "Missing agent", steps: [] })).toThrow(
      "requires agentId",
    );
    expect(() =>
      saveTaskWorkflowDefinition({
        agentId: "main",
        name: "Bad",
        steps: [{ label: "Shell", type: "shell" }],
      }),
    ).toThrow("unsupported type");
    expect(() => removeTaskWorkflowDefinition({ agentId: "main" })).toThrow(
      "requires agentId and id",
    );
  });
});
