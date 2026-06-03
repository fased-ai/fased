import { describe, expect, it, vi } from "vitest";

describe("FasedAgentApp task workflow launch", () => {
  it("does not open source-owned run history rows as workflow templates by default", async () => {
    const { FasedAgentApp } = await import("./app.ts");
    const { listTaskWorkflowTemplates } = await import("../../../src/tasks/workflow-templates.js");
    const tasks = [
      {
        source: "wallet" as const,
        runtime: "wallet" as const,
        taskKind: "wallet_approval",
        taskId: "wallet:source",
        runId: "wallet-source",
        task: "Wallet source task",
      },
      {
        source: "marketplace" as const,
        runtime: "marketplace" as const,
        taskKind: "marketplace_order",
        taskId: "marketplace:source",
        runId: "marketplace-source",
        task: "Marketplace source task",
      },
      {
        source: "channel" as const,
        runtime: "channel" as const,
        taskKind: "channel-triggered-agent",
        taskId: "channel:source",
        runId: "channel-source",
        task: "Channel source task",
      },
      {
        source: "media" as const,
        runtime: "media" as const,
        taskKind: "image_generation",
        taskId: "media:source",
        runId: "media-source",
        task: "Media source task",
      },
      {
        source: "mining" as const,
        runtime: "mining" as const,
        taskKind: "mining_cycle",
        taskId: "mining:source",
        runId: "mining-source",
        task: "Mining source task",
      },
    ] as const;

    for (const sourceTask of tasks) {
      const app = new FasedAgentApp();
      app.taskWorkflowTemplates = listTaskWorkflowTemplates();
      app.startTaskWorkflowFromLedgerTask("beta", {
        ...sourceTask,
        agentId: "beta",
        status: "succeeded",
        deliveryStatus: "not_applicable",
        notifyPolicy: "state_changes",
        createdAt: 1,
        updatedAt: 2,
        metadata: { sourceRecord: true },
      });

      expect(app.taskWorkflowDraft).toBeNull();
      expect(app.taskWorkflowGraphDraft).toBeNull();
      expect(app.taskWorkflowError).toBe(
        `No workflow template is available for ${sourceTask.source} tasks.`,
      );
    }
  });

  it("does not turn mining history records into workflow review graphs", async () => {
    const { FasedAgentApp } = await import("./app.ts");
    const { listTaskWorkflowTemplates } = await import("../../../src/tasks/workflow-templates.js");
    const app = new FasedAgentApp();
    app.taskWorkflowTemplates = listTaskWorkflowTemplates();

    app.startTaskWorkflowFromLedgerTask("beta", {
      source: "mining",
      runtime: "mining",
      taskKind: "mining_cycle",
      taskId: "mining:submit:source",
      runId: "mining-submit-source",
      task: "Mining submit cycle",
      agentId: "beta",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      notifyPolicy: "state_changes",
      createdAt: 1,
      updatedAt: 2,
      metadata: {
        action: "submitCycle",
        cycleId: "5933368",
      },
    });

    expect(app.taskWorkflowDraft).toBeNull();
    expect(app.taskWorkflowGraphDraft).toBeNull();
    expect(app.taskWorkflowError).toBe("No workflow template is available for mining tasks.");
  });

  it("loads task ledger detail through tasks.detail and caches the result", async () => {
    const { FasedAgentApp } = await import("./app.ts");
    const app = new FasedAgentApp();
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      expect(method).toBe("tasks.detail");
      expect(params).toEqual({ taskId: "media:detail" });
      return {
        task: {
          taskId: "media:detail",
          runId: "media-detail",
          source: "media",
          runtime: "media",
          taskKind: "image_generation",
          agentId: "beta",
          task: "Detailed media task",
          status: "succeeded",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          createdAt: 1,
          updatedAt: 2,
          metadata: { mediaIds: ["detail-image"] },
        },
      };
    });
    app.connected = true;
    app.client = { request, stop: vi.fn() } as unknown as typeof app.client;

    await app.loadTaskLedgerDetail("media:detail");
    await app.loadTaskLedgerDetail("media:detail");

    expect(request).toHaveBeenCalledTimes(1);
    expect(app.taskLedgerDetails["media:detail"]).toMatchObject({
      task: "Detailed media task",
      metadata: { mediaIds: ["detail-image"] },
    });
    expect(app.taskLedgerDetailLoading["media:detail"]).toBeUndefined();
    expect(app.taskLedgerDetailErrors["media:detail"]).toBeUndefined();
  });

  it("overlays the latest saved graph workflow run from the task ledger", async () => {
    const { FasedAgentApp } = await import("./app.ts");
    const app = new FasedAgentApp();
    const definition = {
      id: "release-graph",
      agentId: "beta",
      mode: "graph" as const,
      name: "Release graph",
      task: "Run release graph.",
      notifyPolicy: "state_changes" as const,
      steps: [
        { id: "start", label: "Start", type: "checkpoint" as const },
        { id: "approval", label: "Approve", type: "approval" as const },
        { id: "done", label: "Done", type: "handoff" as const },
      ],
      graph: {
        version: 2 as const,
        startNodeId: "start",
        nodes: [
          { id: "start", type: "start" as const, label: "Start" },
          { id: "approval", type: "approval" as const, label: "Approve" },
          { id: "done", type: "end" as const, label: "Done" },
        ],
        edges: [
          { id: "start-success-approval", from: "start", to: "approval", on: "success" as const },
          { id: "approval-approved-done", from: "approval", to: "done", on: "approved" as const },
        ],
      },
      createdAt: 1,
      updatedAt: 2,
    };
    app.taskFlowRuns = {
      generatedAt: 30,
      total: 1,
      summary: { total: 1, active: 1, terminal: 0, blocked: 1, byStatus: { blocked: 1 } },
      flows: [
        {
          flowId: "flow:release-graph",
          syncMode: "workflow",
          revision: 0,
          status: "blocked",
          goal: "Release graph",
          notifyPolicy: "state_changes",
          agentId: "beta",
          definitionId: "release-graph",
          taskIds: ["workflow:release-latest"],
          currentTaskId: "workflow:release-latest",
          currentStep: "approval",
          blockedTaskId: "workflow:release-latest",
          createdAt: 10,
          updatedAt: 30,
        },
      ],
    };
    app.taskLedger = {
      generatedAt: 30,
      total: 2,
      summary: {
        total: 2,
        queued: 0,
        running: 0,
        terminal: 1,
        failed: 0,
        lost: 0,
        bySource: { CLI: 2 },
        byStatus: { succeeded: 1, blocked: 1 },
      },
      audit: { findings: [] },
      tasks: [
        {
          taskId: "workflow:release-old",
          runId: "release-old",
          source: "CLI",
          runtime: "cli",
          taskKind: "workflow",
          sourceId: "release-graph",
          agentId: "beta",
          task: "Old release graph",
          status: "succeeded",
          deliveryStatus: "not_applicable",
          notifyPolicy: "done_only",
          createdAt: 5,
          updatedAt: 6,
          steps: [{ id: "approval", label: "Approve", status: "succeeded" }],
        },
        {
          taskId: "workflow:release-latest",
          runId: "release-latest",
          source: "CLI",
          runtime: "cli",
          taskKind: "workflow",
          agentId: "beta",
          task: "Latest release graph",
          status: "blocked",
          deliveryStatus: "not_applicable",
          notifyPolicy: "state_changes",
          createdAt: 20,
          updatedAt: 30,
          steps: [
            { id: "start", label: "Start", status: "succeeded" },
            {
              id: "approval",
              label: "Approve",
              status: "blocked",
              error: "Approval required.",
            },
            { id: "done", label: "Done", status: "queued" },
          ],
          metadata: { workflowDefinitionId: "release-graph" },
        },
      ],
    };

    app.editTaskWorkflowGraphDefinition(definition);

    expect(app.taskWorkflowGraphDraft?.runState).toMatchObject({
      taskId: "workflow:release-latest",
      status: "blocked",
      steps: [
        { id: "start", status: "succeeded" },
        { id: "approval", status: "blocked" },
        { id: "done", status: "queued" },
      ],
    });
    expect(app.taskWorkflowMessage).toBe("Editing graph Release graph. Latest run blocked.");
  });

  it("opens a workflow run graph with that run's ledger state", async () => {
    const { FasedAgentApp } = await import("./app.ts");
    const app = new FasedAgentApp();
    const definition = {
      id: "wallet-graph",
      agentId: "beta",
      mode: "graph" as const,
      name: "Wallet approval graph",
      task: "Review wallet approval.",
      notifyPolicy: "state_changes" as const,
      steps: [
        { id: "review", label: "Review", type: "checkpoint" as const },
        { id: "approve", label: "Approve", type: "approval" as const },
      ],
      graph: {
        version: 2 as const,
        startNodeId: "start",
        nodes: [
          { id: "start", type: "start" as const, label: "Start" },
          { id: "review", type: "task" as const, label: "Review" },
          { id: "approve", type: "approval" as const, label: "Approve" },
          { id: "done", type: "end" as const, label: "Done" },
        ],
        edges: [
          { id: "start-success-review", from: "start", to: "review", on: "success" as const },
          { id: "review-success-approve", from: "review", to: "approve", on: "success" as const },
          { id: "approve-approved-done", from: "approve", to: "done", on: "approved" as const },
        ],
      },
      createdAt: 1,
      updatedAt: 2,
    };
    app.taskWorkflowDefinitions = { agentId: "beta", definitions: [definition] };
    app.taskLedger = {
      generatedAt: 20,
      total: 2,
      summary: {
        total: 2,
        queued: 0,
        running: 1,
        terminal: 1,
        failed: 0,
        lost: 0,
        bySource: { wallet: 2 },
        byStatus: { succeeded: 1, blocked: 1 },
      },
      audit: { findings: [] },
      tasks: [
        {
          taskId: "workflow:wallet-old",
          runId: "wallet-old",
          source: "wallet",
          runtime: "wallet",
          taskKind: "workflow",
          agentId: "beta",
          task: "Old wallet approval",
          status: "succeeded",
          deliveryStatus: "not_applicable",
          notifyPolicy: "done_only",
          createdAt: 4,
          updatedAt: 5,
          steps: [{ id: "approve", label: "Approve", status: "succeeded" }],
        },
        {
          taskId: "workflow:wallet-current",
          runId: "wallet-current",
          source: "wallet",
          runtime: "wallet",
          taskKind: "workflow",
          agentId: "beta",
          task: "Current wallet approval",
          status: "blocked",
          deliveryStatus: "pending",
          notifyPolicy: "state_changes",
          createdAt: 10,
          updatedAt: 20,
          steps: [
            { id: "review", label: "Review", status: "succeeded" },
            { id: "approve", label: "Approve", status: "blocked", error: "Needs approval." },
          ],
        },
      ],
    };

    app.openTaskWorkflowRunGraph({
      flowId: "flow:wallet-graph",
      syncMode: "workflow",
      revision: 0,
      status: "blocked",
      goal: "Wallet approval graph",
      notifyPolicy: "state_changes",
      agentId: "beta",
      definitionId: "wallet-graph",
      taskIds: ["workflow:wallet-old", "workflow:wallet-current"],
      currentTaskId: "workflow:wallet-current",
      currentStep: "approve",
      blockedTaskId: "workflow:wallet-current",
      createdAt: 10,
      updatedAt: 20,
    });

    expect(app.taskWorkflowGraphDraft?.name).toBe("Wallet approval graph");
    expect(app.taskWorkflowGraphDraft?.runState).toMatchObject({
      taskId: "workflow:wallet-current",
      status: "blocked",
      deliveryStatus: "pending",
      steps: [
        { id: "review", status: "succeeded" },
        { id: "approve", status: "blocked" },
      ],
    });
    expect(app.taskWorkflowMessage).toBe(
      "Viewing graph Wallet approval graph. Run flow:wallet-graph is blocked.",
    );
  });
});
