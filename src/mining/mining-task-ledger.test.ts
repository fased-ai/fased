import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listTaskRecords, resetTaskRegistryForTests } from "../tasks/task-registry.js";
import { shouldMirrorMiningGatewayTask, syncMiningGatewayTask } from "./mining-task-ledger.js";

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(async () => {
  previousStateDir = process.env.FASED_STATE_DIR;
  stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-mining-ledger-"));
  process.env.FASED_STATE_DIR = stateDir;
  resetTaskRegistryForTests({ persist: true });
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.FASED_STATE_DIR;
  } else {
    process.env.FASED_STATE_DIR = previousStateDir;
  }
  resetTaskRegistryForTests();
  await rm(stateDir, { recursive: true, force: true });
});

describe("mining task ledger", () => {
  it("records a successful mining start without changing mining runtime state", () => {
    const task = syncMiningGatewayTask({
      method: "sat.startMining",
      requestId: "req-start",
      requestParams: { walletId: "mining" },
      responsePayload: {
        ok: true,
        payload: {
          started: true,
          status: {
            running: true,
            enabledWanted: true,
            walletId: "mining",
            currentCycleId: 42,
            strategyMode: "skill",
            strategyExecution: "auto",
          },
        },
      },
      nowMs: 1000,
    });

    expect(task).toMatchObject({
      taskId: "mining:startMining:req-start",
      source: "mining",
      runtime: "mining",
      taskKind: "mining_control",
      status: "succeeded",
      agentId: "main",
      deliveryStatus: "not_applicable",
      metadata: {
        action: "startMining",
        walletId: "mining",
        running: true,
        enabledWanted: true,
        currentCycleId: "42",
        strategyMode: "skill",
        strategyExecution: "auto",
      },
    });
    expect(listTaskRecords({ source: "mining" }).tasks).toHaveLength(1);
  });

  it("records stop-drain acceptance as terminal history instead of a running task", () => {
    const task = syncMiningGatewayTask({
      method: "sat.stopMining",
      requestId: "req-stop-drain",
      requestParams: { walletId: "mining" },
      responsePayload: {
        ok: true,
        payload: {
          stopped: true,
          status: {
            running: true,
            drainOnly: true,
            enabledWanted: false,
            walletId: "mining",
            currentCapitalPendingCycleCount: 2,
          },
        },
      },
      nowMs: 1500,
    });

    expect(task).toMatchObject({
      taskId: "mining:stopMining:req-stop-drain",
      source: "mining",
      runtime: "mining",
      taskKind: "mining_control",
      status: "succeeded",
      endedAt: 1500,
      terminalSummary: "Stop requested; clearing continues in Mining.",
      metadata: {
        action: "stopMining",
        walletId: "mining",
        running: true,
        drainOnly: true,
        enabledWanted: false,
        currentCapitalPendingCycleCount: "2",
      },
    });
    expect(task.progressSummary).toBeUndefined();
    expect(listTaskRecords({ source: "mining" }).tasks).toHaveLength(1);
  });

  it("does not mirror mining readiness polling unless explicitly requested", () => {
    const mutationMethods = new Set<string>(["sat.startMining"]);
    const healthyReadiness = {
      ok: true,
      payload: {
        checks: [{ key: "wallet", ok: true }],
      },
    };
    expect(
      shouldMirrorMiningGatewayTask({
        method: "sat.getMiningReadiness",
        responsePayload: healthyReadiness,
        requestParams: {},
        mutationMethods,
      }),
    ).toBe(false);

    const blockedReadiness = {
      ok: true,
      payload: {
        checks: [
          { key: "wallet", ok: false, detail: "missing mining wallet", remediation: "attach one" },
        ],
      },
    };
    expect(
      shouldMirrorMiningGatewayTask({
        method: "sat.getMiningReadiness",
        responsePayload: blockedReadiness,
        requestParams: {},
        mutationMethods,
      }),
    ).toBe(false);

    const task = syncMiningGatewayTask({
      method: "sat.getMiningReadiness",
      requestId: "readiness-1",
      responsePayload: blockedReadiness,
      nowMs: 2000,
    });

    expect(task).toMatchObject({
      source: "mining",
      taskKind: "mining_readiness",
      status: "blocked",
      progressSummary: "attach one",
      metadata: {
        action: "getMiningReadiness",
        readinessChecks: [
          { key: "wallet", ok: false, detail: "missing mining wallet", remediation: "attach one" },
        ],
      },
    });
    expect(task.steps?.find((step) => step.id === "readiness")).toMatchObject({
      status: "blocked",
      error: "attach one",
    });
  });

  it("can mirror explicit mining audits", () => {
    expect(
      shouldMirrorMiningGatewayTask({
        method: "sat.getMiningReadiness",
        responsePayload: { ok: true, payload: { checks: [{ key: "wallet", ok: true }] } },
        requestParams: { recordTaskLedger: true },
        mutationMethods: new Set<string>(),
      }),
    ).toBe(true);
    expect(
      shouldMirrorMiningGatewayTask({
        method: "sat.startMining",
        responsePayload: { ok: true, payload: { started: true } },
        requestParams: { recordTaskLedger: true },
        mutationMethods: new Set<string>(["sat.startMining"]),
      }),
    ).toBe(true);
    expect(
      shouldMirrorMiningGatewayTask({
        method: "sat.startMining",
        responsePayload: { ok: true, payload: { started: true } },
        requestParams: {},
        mutationMethods: new Set<string>(["sat.startMining"]),
      }),
    ).toBe(false);
  });
});
