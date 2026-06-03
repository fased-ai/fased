import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FederationMarketplaceOrderConfig } from "../config/types.federation.js";
import { saveCronStore } from "../cron/store.js";
import { enqueueCronTaskRunQueueItem, finishCronTaskRunQueueItem } from "../cron/task-run-queue.js";
import type { CronJob } from "../cron/types.js";
import { syncMarketplaceOrderTask } from "../federation/marketplace-task-ledger.js";
import { tasksHandlers } from "../gateway/server-methods/tasks.js";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import { syncMiningGatewayTask } from "../mining/mining-task-ledger.js";
import type { WalletSendApprovalRequest } from "../wallet/wallet-send-approvals.js";
import { syncWalletApprovalTask } from "../wallet/wallet-task-ledger.js";
import {
  completeTaskRunByRunId,
  createRunningTaskRun,
  recordTaskRunAccountingByRunId,
} from "./task-executor.js";
import { resetTaskFlowRegistryForTests } from "./task-flow-registry.js";
import { resetTaskRegistryForTests } from "./task-registry.js";
import type { TaskListResult } from "./task-registry.types.js";

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(async () => {
  previousStateDir = process.env.FASED_STATE_DIR;
  stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-task-ledger-composite-"));
  process.env.FASED_STATE_DIR = stateDir;
  resetTaskRegistryForTests({ persist: true });
  resetTaskFlowRegistryForTests({ persist: true });
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.FASED_STATE_DIR;
  } else {
    process.env.FASED_STATE_DIR = previousStateDir;
  }
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  await rm(stateDir, { recursive: true, force: true });
});

describe("composite task ledger smoke", () => {
  it("records webhook, agent, channel, media, wallet, marketplace, and mining work in one ledger", async () => {
    const now = Date.now();
    const cronStorePath = path.join(stateDir, "cron-runs.json");

    async function listTasksViaGateway(params: Record<string, unknown>): Promise<TaskListResult> {
      const respond = vi.fn();
      await tasksHandlers["tasks.list"]({
        method: "tasks.list",
        params,
        respond,
        context: {
          cronStorePath,
          cron: {},
        },
      } as unknown as GatewayRequestHandlerOptions);
      expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
      return respond.mock.calls[0]?.[1] as TaskListResult;
    }

    const webhookTask = createRunningTaskRun({
      runtime: "webhook",
      runId: "webhook-smoke",
      sourceId: "webhook:orders",
      agentId: "main",
      sessionKey: "agent:main:webhook:orders",
      label: "Webhook trigger smoke",
      task: "Run Agent task from webhook payload.",
      taskKind: "webhook-trigger",
      deliveryStatus: "pending",
      notifyPolicy: "state_changes",
      metadata: { triggerId: "orders", path: "/hooks/orders" },
    });
    completeTaskRunByRunId({
      runId: "webhook-smoke",
      summary: "Webhook payload ran.",
      deliveryStatus: "delivered",
      delivery: { channel: "telegram", target: "ops", messageId: "tg-webhook" },
    });

    createRunningTaskRun({
      runtime: "acp",
      runId: "acp-smoke",
      sourceId: "acp:research",
      agentId: "main",
      requesterSessionKey: "agent:main:webchat:direct",
      childSessionKey: "agent:main:subagent:research",
      label: "ACP subagent smoke",
      task: "Delegate a detached subagent task.",
      rootTaskId: webhookTask.rootTaskId,
      parentTaskId: webhookTask.taskId,
      correlationId: webhookTask.correlationId,
      taskKind: "acp-spawn",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
      loadedSkills: ["diagram-maker"],
      loadedTools: ["web.search"],
      memoryScope: "agent",
      metadata: { mode: "run" },
    });
    completeTaskRunByRunId({
      runId: "acp-smoke",
      summary: "Subagent result returned.",
      deliveryStatus: "delivered",
      delivery: { channel: "webchat", target: "parent", messageId: "acp-result" },
    });

    const scheduledAgentJob: CronJob = {
      id: "job-smoke",
      name: "Scheduled Agent task smoke",
      agentId: "main",
      sessionKey: "agent:main:webchat:direct",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "Run scheduled smoke." },
      delivery: { mode: "announce", channel: "telegram", to: "ops" },
      state: {},
    };
    await saveCronStore(cronStorePath, { version: 1, jobs: [scheduledAgentJob] });
    await enqueueCronTaskRunQueueItem({
      storePath: cronStorePath,
      job: scheduledAgentJob,
      runId: "scheduled-smoke",
      trigger: "manual",
      nowMs: now,
    });
    await finishCronTaskRunQueueItem({
      storePath: cronStorePath,
      runId: "scheduled-smoke",
      nowMs: now + 500,
      status: "ok",
      result: {
        status: "ok",
        summary: "Scheduled Agent task smoke completed.",
        delivered: true,
        provider: "openai",
        model: "gpt-5.4-mini",
        sessionKey: "agent:main:webchat:direct",
        usage: {
          input_tokens: 4,
          output_tokens: 6,
          total_tokens: 10,
        },
      },
    });

    createRunningTaskRun({
      runtime: "cli",
      runId: "cli-smoke",
      sourceId: "cli:doctor",
      agentId: "main",
      label: "CLI/system task smoke",
      task: "Run a local operator CLI/system task.",
      taskKind: "cli-command",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      metadata: { command: "fased doctor", scope: "system" },
    });
    completeTaskRunByRunId({
      runId: "cli-smoke",
      summary: "CLI/system task completed.",
      deliveryStatus: "not_applicable",
    });

    createRunningTaskRun({
      runtime: "channel",
      runId: "channel-smoke",
      sourceId: "telegram:default",
      agentId: "main",
      channel: "telegram",
      sessionKey: "agent:main:telegram:default",
      label: "Channel delivery smoke",
      task: "Reply to a channel message.",
      taskKind: "channel-triggered-agent",
      deliveryStatus: "pending",
      notifyPolicy: "state_changes",
      loadedSkills: ["fased-test"],
      loadedTools: ["telegram.send"],
      memoryScope: "session",
    });
    completeTaskRunByRunId({
      runId: "channel-smoke",
      summary: "Channel reply delivered.",
      deliveryStatus: "delivered",
      delivery: { channel: "telegram", target: "397848047", messageId: "tg-channel" },
    });

    createRunningTaskRun({
      runtime: "media",
      runId: "media-smoke",
      sourceId: "image.generate",
      agentId: "main",
      sessionKey: "agent:main:webchat:direct",
      label: "Media task smoke",
      task: "Generate preview media.",
      taskKind: "image_generation",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      provider: "local",
      model: "media-service",
    });
    recordTaskRunAccountingByRunId({
      runId: "media-smoke",
      metadata: {
        providerHint: "local",
        mediaPaths: ["/tmp/fased/generated/smoke.png"],
        mediaContentTypes: ["image/png"],
      },
      deliveryStatus: "not_applicable",
    });
    completeTaskRunByRunId({
      runId: "media-smoke",
      summary: "Generated media artifact.",
      deliveryStatus: "not_applicable",
    });

    syncWalletApprovalTask({
      request: {
        id: "wallet-smoke",
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        status: "executed",
        requestedBy: "main",
        approvedBy: "operator",
        decisionAt: new Date(now + 1_000).toISOString(),
        payload: {
          chain: "solana",
          actionKind: "send",
          assetSymbol: "SOL",
          amount: "10000000",
          amountDisplay: "0.01 SOL",
          walletId: "agent-1",
          walletName: "Agent wallet",
          to: "dest111111111111111111111111111111111111111",
        },
        result: { txHash: "wallet-tx-smoke" },
      } satisfies WalletSendApprovalRequest,
    });

    syncMarketplaceOrderTask({
      agentId: "main",
      order: {
        id: "order-smoke",
        status: "delivered",
        source: "local",
        title: "Smoke order",
        serviceKind: "content.summarize",
        offerId: "offer-smoke",
        buyerHandle: "@buyer",
        sellerHandle: "@seller",
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now + 2_000).toISOString(),
        paymentIntent: { status: "verified", currency: "SOL", amount: 0.01 },
        settlement: { status: "settled", mode: "direct", currency: "SOL", amount: 0.01 },
        delivery: {
          status: "delivered",
          targetKind: "channel",
          targetMasked: "telegram ops",
          deliveredAt: new Date(now + 2_000).toISOString(),
          resultRef: "artifact://order-smoke",
        },
        receipt: { status: "issued", receiptId: "receipt-smoke" },
      } satisfies FederationMarketplaceOrderConfig,
    });

    syncMiningGatewayTask({
      method: "sat.startMining",
      requestId: "mining-smoke",
      requestParams: { walletId: "mining-1" },
      nowMs: now + 3_000,
      responsePayload: {
        ok: true,
        payload: {
          started: true,
          status: {
            running: true,
            enabledWanted: true,
            walletId: "mining-1",
            currentCycleId: 7,
            currentCapitalLockedLamports: "5000",
          },
        },
      },
    });

    const result = await listTasksViaGateway({ agentId: "main", limit: 50, includeAudit: true });
    expect(result.summary.total).toBeGreaterThanOrEqual(9);
    expect(result.summary.bySource).toMatchObject({
      webhook: 1,
      subagent: 1,
      cron: 1,
      CLI: 1,
      channel: 1,
      media: 1,
      wallet: 1,
      marketplace: 1,
      mining: 1,
    });
    expect(result.tasks.map((task) => task.task)).toEqual(
      expect.arrayContaining([
        "Webhook trigger smoke",
        "ACP subagent smoke",
        "Scheduled Agent task smoke",
        "CLI/system task smoke",
        "Channel delivery smoke",
        "Media task smoke",
        "Wallet approval: 0.01 SOL to dest111111111111111111111111111111111111111",
        "Marketplace order: Smoke order",
        "Mining: Start mining",
      ]),
    );
    expect(result.tasks.find((task) => task.source === "channel")).toMatchObject({
      deliveryStatus: "delivered",
      loadedSkills: ["fased-test"],
      loadedTools: ["telegram.send"],
    });
    expect(result.tasks.find((task) => task.source === "wallet")?.metadata).toMatchObject({
      approvalId: "wallet-smoke",
      txHash: "wallet-tx-smoke",
    });
    expect(result.tasks.find((task) => task.source === "marketplace")?.metadata).toMatchObject({
      orderId: "order-smoke",
      deliveryStatus: "delivered",
    });
    expect(result.tasks.find((task) => task.source === "mining")?.metadata).toMatchObject({
      action: "startMining",
      walletId: "mining-1",
    });
    expect(result.tasks.every((task) => task.rootTaskId && task.correlationId)).toBe(true);
    expect(result.tasks.find((task) => task.source === "webhook")).toMatchObject({
      definitionKind: "trigger",
      definitionId: "webhook:orders",
      rootTaskId: "webhook:webhook-smoke",
      correlationId: "webhook:webhook-smoke",
    });
    expect(result.tasks.find((task) => task.source === "subagent")).toMatchObject({
      rootTaskId: "webhook:webhook-smoke",
      parentTaskId: "webhook:webhook-smoke",
      correlationId: "webhook:webhook-smoke",
    });
    expect(result.tasks.find((task) => task.source === "cron")).toMatchObject({
      definitionKind: "task",
      definitionId: "job-smoke",
      rootTaskId: "cron:scheduled-smoke",
      correlationId: "cron:scheduled-smoke",
    });

    expect(result.audit?.findings).toEqual([]);
    expect(result.summary.bySource).toMatchObject({
      webhook: 1,
      subagent: 1,
      cron: 1,
      CLI: 1,
      channel: 1,
      media: 1,
      wallet: 1,
      marketplace: 1,
      mining: 1,
    });
    expect(result.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "webhook", task: "Webhook trigger smoke" }),
        expect.objectContaining({
          source: "subagent",
          runtime: "acp",
          taskKind: "acp-spawn",
          task: "ACP subagent smoke",
          loadedSkills: ["diagram-maker"],
          loadedTools: ["web.search"],
        }),
        expect.objectContaining({
          source: "cron",
          runtime: "cron",
          taskKind: "scheduled-task",
          task: "Scheduled Agent task smoke",
          usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
        }),
        expect.objectContaining({
          source: "CLI",
          runtime: "cli",
          taskKind: "cli-command",
          task: "CLI/system task smoke",
        }),
        expect.objectContaining({
          source: "channel",
          taskKind: "channel-triggered-agent",
          task: "Channel delivery smoke",
        }),
        expect.objectContaining({
          source: "media",
          taskKind: "image_generation",
          task: "Media task smoke",
        }),
        expect.objectContaining({ source: "wallet", taskKind: "wallet_approval" }),
        expect.objectContaining({ source: "marketplace", taskKind: "marketplace_order" }),
        expect.objectContaining({ source: "mining", taskKind: "mining_control" }),
      ]),
    );

    const cronOnly = await listTasksViaGateway({ agentId: "main", source: "cron", limit: 10 });
    expect(cronOnly).toMatchObject({
      total: 1,
      summary: { bySource: { cron: 1 } },
      tasks: [
        expect.objectContaining({
          taskId: "cron:scheduled-smoke",
          source: "cron",
          deliveryStatus: "delivered",
        }),
      ],
    });
  });
});
