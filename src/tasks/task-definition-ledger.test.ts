import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listStandingOrders,
  removeStandingOrder,
  resetStandingOrdersForTests,
  resolveStandingOrdersPath,
  saveStandingOrder,
} from "./standing-orders.js";
import {
  getTaskFlowById,
  listTaskFlows,
  resetTaskFlowRegistryForTests,
  resolveTaskFlowRegistryPath,
  runTaskFlowRegistryMaintenance,
  upsertTaskFlowFromTask,
} from "./task-flow-registry.js";
import { openTaskLedgerStore, type TaskDefinitionCollection } from "./task-ledger-store.js";
import {
  resetTaskRegistryForTests,
  resolveTaskLedgerPath,
  resolveTaskRegistryPath,
} from "./task-registry.js";
import {
  listSavedTaskWorkflowDefinitions,
  removeTaskWorkflowDefinition,
  resetTaskWorkflowDefinitionsForTests,
  resolveTaskWorkflowDefinitionsPath,
  saveTaskWorkflowDefinition,
} from "./workflow-definitions.js";

let stateDir: string;
let previousStateDir: string | undefined;

function marker(
  store: ReturnType<typeof openTaskLedgerStore>,
  collection: TaskDefinitionCollection,
): boolean {
  return store.isDefinitionCollectionImported(collection);
}

beforeEach(async () => {
  previousStateDir = process.env.FASED_STATE_DIR;
  stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-task-definition-ledger-"));
  process.env.FASED_STATE_DIR = stateDir;
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
  resetTaskRegistryForTests({ persist: true });
  resetTaskFlowRegistryForTests({ persist: true });
  resetStandingOrdersForTests({ persist: true });
  resetTaskWorkflowDefinitionsForTests({ persist: true });
  await rm(stateDir, { recursive: true, force: true });
  if (previousStateDir === undefined) {
    delete process.env.FASED_STATE_DIR;
  } else {
    process.env.FASED_STATE_DIR = previousStateDir;
  }
});

describe("task definition ledger", () => {
  it("keeps all three persist-false definition resets isolated and entirely in memory", () => {
    resetTaskFlowRegistryForTests({
      persist: false,
      flows: [
        {
          flowId: "ephemeral-flow",
          syncMode: "workflow",
          revision: 0,
          status: "queued",
          goal: "Ephemeral flow",
          notifyPolicy: "done_only",
          taskIds: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    resetStandingOrdersForTests({
      persist: false,
      orders: [
        {
          id: "ephemeral-order",
          agentId: "main",
          name: "Ephemeral order",
          instructions: "Keep this in memory.",
          proposalKind: "task",
          status: "enabled",
          approvalRequired: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    resetTaskWorkflowDefinitionsForTests({
      persist: false,
      definitions: [
        {
          id: "ephemeral-workflow",
          agentId: "main",
          mode: "steps",
          name: "Ephemeral workflow",
          task: "Keep this in memory.",
          notifyPolicy: "done_only",
          steps: [{ id: "start", label: "Start", type: "checkpoint" }],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const updatedFlow = upsertTaskFlowFromTask(
      {
        taskId: "flow-task",
        source: "CLI",
        runtime: "cli",
        task: "Updated ephemeral flow",
        taskKind: "workflow",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "done_only",
        createdAt: 2,
        updatedAt: 2,
      },
      { flowId: "ephemeral-flow" },
    );
    expect(updatedFlow?.revision).toBe(1);
    expect(runTaskFlowRegistryMaintenance({ nowMs: 30_000_000, staleFlowMs: 1 }).updated).toBe(1);
    expect(getTaskFlowById("ephemeral-flow")?.status).toBe("lost");

    saveStandingOrder({
      id: "ephemeral-order",
      agentId: "main",
      name: "Updated ephemeral order",
      instructions: "Still in memory.",
    });
    expect(removeStandingOrder({ agentId: "main", id: "ephemeral-order" }).orders).toEqual([]);

    saveTaskWorkflowDefinition({
      id: "ephemeral-workflow",
      agentId: "main",
      name: "Updated ephemeral workflow",
      steps: [{ label: "Updated", type: "checkpoint" }],
    });
    expect(
      removeTaskWorkflowDefinition({ agentId: "main", id: "ephemeral-workflow" }).definitions,
    ).toEqual([]);

    resetStandingOrdersForTests({ persist: false });
    expect(listTaskFlows().flows).toHaveLength(1);
    expect(listSavedTaskWorkflowDefinitions({ agentId: "main" }).definitions).toEqual([]);
    expect(fs.existsSync(resolveTaskLedgerPath())).toBe(false);
  });

  it("imports tasks.json when a definition API initializes the ledger first", async () => {
    const tasksPath = resolveTaskRegistryPath();
    fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
    await writeFile(
      tasksPath,
      '{"version":1,"tasks":[{"taskId":"legacy-task","source":"cron","runtime":"cron","task":"Legacy task","status":"queued","createdAt":1}]}\n',
    );

    expect(listStandingOrders().orders).toEqual([]);
    const store = openTaskLedgerStore(resolveTaskLedgerPath());
    try {
      expect(store.list().map((record) => record.taskId)).toEqual(["legacy-task"]);
    } finally {
      store.close();
    }
  });

  it("imports every valid legacy definition collection once without changing its bytes", async () => {
    const flowsPath = resolveTaskFlowRegistryPath();
    const ordersPath = resolveStandingOrdersPath();
    const workflowsPath = resolveTaskWorkflowDefinitionsPath();
    const fixtures = new Map([
      [
        flowsPath,
        '{"version":1,"flows":[{"flowId":"flow-1","status":"queued","goal":"Legacy flow","taskIds":[],"createdAt":1,"updatedAt":1}]}\n',
      ],
      [
        ordersPath,
        '{"version":1,"orders":[{"id":"order-1","agentId":"main","name":"Legacy order","instructions":"Propose safely","createdAt":1,"updatedAt":1}]}\n',
      ],
      [
        workflowsPath,
        '{"version":1,"definitions":[{"id":"workflow-1","agentId":"main","name":"Legacy workflow","task":"Do work","steps":[{"label":"Start","type":"checkpoint"}],"createdAt":1,"updatedAt":1}]}\n',
      ],
    ]);
    fs.mkdirSync(path.dirname(flowsPath), { recursive: true });
    for (const [filePath, bytes] of fixtures) {
      await writeFile(filePath, bytes);
    }

    expect(getTaskFlowById("flow-1")?.goal).toBe("Legacy flow");
    expect(listStandingOrders({ agentId: "main" }).orders[0]?.id).toBe("order-1");
    expect(listSavedTaskWorkflowDefinitions({ agentId: "main" }).definitions[0]?.id).toBe(
      "workflow-1",
    );
    for (const [filePath, bytes] of fixtures) {
      expect(fs.readFileSync(filePath, "utf8")).toBe(bytes);
      await writeFile(filePath, '{"version":1}\n');
    }

    expect(getTaskFlowById("flow-1")).toBeTruthy();
    expect(listStandingOrders({ agentId: "main" }).orders).toHaveLength(1);
    expect(listSavedTaskWorkflowDefinitions({ agentId: "main" }).definitions).toHaveLength(1);
  });

  it("leaves a malformed collection unmarked and does not affect another committed collection", async () => {
    const ordersPath = resolveStandingOrdersPath();
    const workflowsPath = resolveTaskWorkflowDefinitionsPath();
    fs.mkdirSync(path.dirname(ordersPath), { recursive: true });
    await writeFile(
      ordersPath,
      '{"version":1,"orders":[{"id":"order-1","agentId":"main","name":"Order","instructions":"Safe","createdAt":1,"updatedAt":1}]}\n',
    );
    const malformed = '{"definitions":';
    await writeFile(workflowsPath, malformed);

    expect(listStandingOrders({ agentId: "main" }).orders).toHaveLength(1);
    expect(() => listSavedTaskWorkflowDefinitions()).toThrow("workflows.json is malformed");
    expect(fs.readFileSync(workflowsPath, "utf8")).toBe(malformed);
    const store = openTaskLedgerStore(resolveTaskLedgerPath());
    try {
      expect(marker(store, "standing_order")).toBe(true);
      expect(marker(store, "workflow_definition")).toBe(false);
      expect(store.listDefinitionRecords("workflow_definition")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("keeps distinct definition writes from independently opened ledger handles", () => {
    listStandingOrders();
    const first = openTaskLedgerStore(resolveTaskLedgerPath());
    const second = openTaskLedgerStore(resolveTaskLedgerPath());
    try {
      first.importDefinitionCollection("standing_order", []);
      first.updateDefinitionRecord(
        "standing_order",
        "one",
        "first",
        () => ({ id: "first", agentId: "one", updatedAt: 1 }),
        (record) => record.updatedAt,
      );
      second.updateDefinitionRecord(
        "standing_order",
        "two",
        "second",
        () => ({ id: "second", agentId: "two", updatedAt: 2 }),
        (record) => record.updatedAt,
      );
      expect(
        first
          .listDefinitionRecords("standing_order")
          .map((entry) => entry.recordId)
          .toSorted(),
      ).toEqual(["first", "second"]);
    } finally {
      first.close();
      second.close();
    }
  });
});
