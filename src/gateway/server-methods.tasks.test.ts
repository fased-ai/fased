import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveCronStore } from "../cron/store.js";
import {
  enqueueCronTaskRunQueueItem,
  checkpointCronTaskRunQueueStep,
} from "../cron/task-run-queue.js";
import type { CronJob } from "../cron/types.js";
import { resetStandingOrdersForTests } from "../tasks/standing-orders.js";
import { createTaskRecord, resetTaskRegistryForTests } from "../tasks/task-registry.js";
import type { TaskListResult } from "../tasks/task-registry.types.js";
import { tasksHandlers } from "./server-methods/tasks.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(async () => {
  previousStateDir = process.env.FASED_STATE_DIR;
  stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-task-methods-"));
  process.env.FASED_STATE_DIR = stateDir;
  resetTaskRegistryForTests({ persist: true });
  resetStandingOrdersForTests({ persist: true });
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.FASED_STATE_DIR;
  } else {
    process.env.FASED_STATE_DIR = previousStateDir;
  }
  resetTaskRegistryForTests({ persist: false });
  resetStandingOrdersForTests({ persist: false });
  await rm(stateDir, { recursive: true, force: true });
});

function makeOptions(
  method:
    | "tasks.detail"
    | "tasks.cancel"
    | "tasks.notify"
    | "tasks.retry"
    | "tasks.workflow.resume"
    | "tasks.workflow.graph.resume"
    | "tasks.standingOrders.list"
    | "tasks.standingOrders.save"
    | "tasks.standingOrders.remove"
    | "tasks.standingOrders.propose",
  params: Record<string, unknown>,
  respond = vi.fn(),
): GatewayRequestHandlerOptions {
  return {
    method,
    params,
    respond,
    context: {
      cronStorePath: path.join(stateDir, "cron-queue.json"),
      cron: {},
    },
  } as unknown as GatewayRequestHandlerOptions;
}

describe("task server methods", () => {
  it("enforces selected Agent ownership for task detail and controls", async () => {
    createTaskRecord({
      taskId: "task:main-owned",
      runId: "main-owned-run",
      source: "CLI",
      runtime: "cli",
      taskKind: "workflow",
      task: "Main owned task",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "state_changes",
      agentId: "main",
      sessionKey: "agent:main:webchat:direct",
      createdAt: 1,
      updatedAt: 2,
      steps: [{ id: "run", label: "Run", status: "running" }],
      metadata: {
        workflow: true,
        steps: [{ id: "run", label: "Run", type: "checkpoint" }],
      },
    });

    const allowedDetail = vi.fn();
    await tasksHandlers["tasks.detail"](
      makeOptions("tasks.detail", { taskId: "task:main-owned", agentId: "main" }, allowedDetail),
    );
    expect(allowedDetail).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ task: expect.objectContaining({ taskId: "task:main-owned" }) }),
      undefined,
    );

    for (const method of ["tasks.detail", "tasks.cancel", "tasks.retry", "tasks.notify"] as const) {
      const respond = vi.fn();
      await tasksHandlers[method](
        makeOptions(
          method,
          {
            taskId: "task:main-owned",
            agentId: "other",
            notifyPolicy: "state_changes",
          },
          respond,
        ),
      );
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: "Task not found for selected Agent.",
        }),
      );
    }
  });

  it("hides orphaned cron queue records from the normal task list", async () => {
    const now = Date.now();
    const cronStorePath = path.join(stateDir, "cron", "jobs.json");
    const liveJob: CronJob = {
      id: "live-job",
      agentId: "main",
      sessionKey: "agent:main:webchat:direct",
      name: "Live scheduled task",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "Run live task." },
      delivery: { mode: "none" },
      state: {},
    };
    const deletedJob: CronJob = {
      ...liveJob,
      id: "deleted-job",
      name: "Deleted scheduled task",
    };
    await saveCronStore(cronStorePath, { version: 1, jobs: [liveJob] });
    await enqueueCronTaskRunQueueItem({
      storePath: cronStorePath,
      job: liveJob,
      runId: "live-run",
      trigger: "manual",
      nowMs: now,
    });
    await checkpointCronTaskRunQueueStep({
      storePath: cronStorePath,
      runId: "live-run",
      stepId: "reserve",
      nowMs: now,
      checkpoint: {
        coordinationEvidence: [
          {
            agentId: "agent-2",
            mode: "consult",
            status: "completed",
            childSessionKey: "agent:agent-2:cron:run:live-run",
            runId: "helper-run",
            summary: "Helper checked the plan.",
          },
        ],
      },
    });
    await enqueueCronTaskRunQueueItem({
      storePath: cronStorePath,
      job: deletedJob,
      runId: "orphan-run",
      trigger: "manual",
      nowMs: now + 1,
    });

    const respond = vi.fn();
    await tasksHandlers["tasks.list"]({
      method: "tasks.list",
      params: { agentId: "main" },
      respond,
      context: {
        cronStorePath,
        cron: {},
      },
    } as unknown as GatewayRequestHandlerOptions);

    expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    const result = respond.mock.calls[0]?.[1] as TaskListResult;
    expect(result.tasks.map((task) => task.runId)).toEqual(["live-run"]);
    expect(result.tasks[0]).toMatchObject({
      definitionId: "live-job",
      task: "Live scheduled task",
      source: "cron",
      metadata: {
        coordinationEvidence: [
          expect.objectContaining({
            agentId: "agent-2",
            status: "completed",
            summary: "Helper checked the plan.",
          }),
        ],
      },
    });
  });

  it("keeps wallet marketplace and mining ledger records view-only", async () => {
    for (const source of ["wallet", "marketplace", "mining"] as const) {
      createTaskRecord({
        taskId: `${source}:view-only`,
        runId: `${source}-view-only`,
        source,
        runtime: source,
        taskKind: `${source}-record`,
        task: `${source} record`,
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "state_changes",
        createdAt: 1,
        updatedAt: 2,
      });

      const cancelRespond = vi.fn();
      await tasksHandlers["tasks.cancel"](
        makeOptions("tasks.cancel", { taskId: `${source}:view-only` }, cancelRespond),
      );
      expect(cancelRespond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );

      const notifyRespond = vi.fn();
      await tasksHandlers["tasks.notify"](
        makeOptions(
          "tasks.notify",
          { taskId: `${source}:view-only`, notifyPolicy: "state_changes" },
          notifyRespond,
        ),
      );
      expect(notifyRespond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );

      const retryRespond = vi.fn();
      await tasksHandlers["tasks.retry"](
        makeOptions("tasks.retry", { taskId: `${source}:view-only` }, retryRespond),
      );
      expect(retryRespond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    }
  });

  it("reports the full filtered activity total separately from the page limit", async () => {
    for (let index = 0; index < 3; index += 1) {
      createTaskRecord({
        taskId: `mining:history:${index}`,
        runId: `mining-history-${index}`,
        source: "mining",
        runtime: "mining",
        taskKind: "mining_record",
        task: `Mining record ${index}`,
        status: "succeeded",
        deliveryStatus: "not_applicable",
        notifyPolicy: "state_changes",
        agentId: "main",
        createdAt: index + 1,
        updatedAt: index + 1,
      });
    }

    const respond = vi.fn();
    await tasksHandlers["tasks.list"]({
      method: "tasks.list",
      params: { agentId: "main", limit: 1 },
      respond,
      context: {
        cronStorePath: path.join(stateDir, "cron-queue.json"),
        cron: {},
      },
    } as unknown as GatewayRequestHandlerOptions);

    const result = respond.mock.calls[0]?.[1] as TaskListResult;
    expect(result.tasks).toHaveLength(1);
    expect(result.total).toBe(3);
    expect(result.summary.total).toBe(3);
    expect(result.summary.bySource.mining).toBe(3);
  });

  it("blocks direct workflow resume controls for source-owned mirror records", async () => {
    createTaskRecord({
      taskId: "wallet:workflow-blocked",
      runId: "wallet-workflow-blocked",
      source: "wallet",
      runtime: "wallet",
      taskKind: "workflow",
      task: "Wallet mirrored workflow",
      status: "blocked",
      deliveryStatus: "not_applicable",
      notifyPolicy: "state_changes",
      createdAt: 1,
      updatedAt: 2,
      steps: [{ id: "approval", label: "Approve spend", status: "blocked" }],
      metadata: {
        workflow: true,
        steps: [{ id: "approval", label: "Approve spend", type: "approval" }],
      },
    });
    createTaskRecord({
      taskId: "marketplace:graph-blocked",
      runId: "marketplace-graph-blocked",
      source: "marketplace",
      runtime: "marketplace",
      taskKind: "workflow",
      task: "Marketplace mirrored graph workflow",
      status: "blocked",
      deliveryStatus: "not_applicable",
      notifyPolicy: "state_changes",
      createdAt: 3,
      updatedAt: 4,
      steps: [{ id: "approval", label: "Approve delivery", status: "blocked" }],
      metadata: {
        workflow: true,
        workflowGraphVersion: 2,
        blockedNodeId: "approval",
        graph: {
          version: 2,
          startNodeId: "start",
          nodes: [
            { id: "start", type: "start", label: "Start" },
            { id: "approval", type: "approval", label: "Approve delivery" },
            { id: "done", type: "end", label: "Done" },
          ],
          edges: [
            { id: "start-success-approval", from: "start", to: "approval", on: "success" },
            { id: "approval-approved-done", from: "approval", to: "done", on: "approved" },
          ],
        },
      },
    });

    const resumeRespond = vi.fn();
    await tasksHandlers["tasks.workflow.resume"](
      makeOptions(
        "tasks.workflow.resume",
        { taskId: "wallet:workflow-blocked", actor: "operator" },
        resumeRespond,
      ),
    );
    expect(resumeRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );

    const graphResumeRespond = vi.fn();
    await tasksHandlers["tasks.workflow.graph.resume"](
      makeOptions(
        "tasks.workflow.graph.resume",
        { taskId: "marketplace:graph-blocked", actor: "operator", decision: "approved" },
        graphResumeRespond,
      ),
    );
    expect(graphResumeRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("exposes Agent-scoped standing orders as proposal-only task records", async () => {
    const saveRespond = vi.fn();
    await tasksHandlers["tasks.standingOrders.save"](
      makeOptions(
        "tasks.standingOrders.save",
        {
          agentId: "main",
          name: "Service health program",
          instructions: "Propose service health checks when needed.",
          proposalKind: "task",
        },
        saveRespond,
      ),
    );

    expect(saveRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        order: expect.objectContaining({ agentId: "main", approvalRequired: true }),
      }),
      undefined,
    );
    const orderId = saveRespond.mock.calls[0]?.[1]?.order?.id as string;

    const proposeRespond = vi.fn();
    await tasksHandlers["tasks.standingOrders.propose"](
      makeOptions("tasks.standingOrders.propose", { agentId: "main", id: orderId }, proposeRespond),
    );

    expect(proposeRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        task: expect.objectContaining({
          agentId: "main",
          status: "blocked",
          metadata: expect.objectContaining({
            authority: "proposal-only",
            forbiddenGrants: ["wallet", "tools", "mining"],
          }),
        }),
      }),
      undefined,
    );
  });
});
