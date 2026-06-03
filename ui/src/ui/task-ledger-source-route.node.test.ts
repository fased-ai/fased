import { describe, expect, it } from "vitest";
import { resolveTaskLedgerSourceRoute, taskLedgerAnchorId } from "./task-ledger-source-route.ts";
import type { TaskRecord } from "./types.ts";

function task(source: TaskRecord["source"], patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: `${source}-task`,
    source,
    runtime: source === "CLI" ? "cli" : source,
    task: `${source} task`,
    status: "succeeded",
    deliveryStatus: "none",
    notifyPolicy: "done_only",
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  } as TaskRecord;
}

describe("task ledger source route", () => {
  it("builds stable ids for source anchors", () => {
    expect(taskLedgerAnchorId("wallet-approval", "wallet request/123")).toBe(
      "wallet-approval-wallet-request-123",
    );
    expect(taskLedgerAnchorId("task-ledger", "")).toBe("task-ledger");
  });

  it("routes wallet records to the exact approval row", () => {
    expect(
      resolveTaskLedgerSourceRoute(
        task("wallet", {
          metadata: { approvalId: "approval-123" },
        }),
      ),
    ).toMatchObject({
      tab: "wallet",
      walletMainPanel: "wallets",
      walletApprovalsFilter: "all",
      hash: "wallet-approval-approval-123",
    });
  });

  it("routes marketplace records to order anchors", () => {
    expect(
      resolveTaskLedgerSourceRoute(
        task("marketplace", {
          metadata: { orderId: "order-456", requestId: "request-1" },
        }),
      ),
    ).toMatchObject({
      tab: "marketplace",
      hash: "marketplace-order-order-456",
    });
  });

  it("routes mining records to recent activity with cycle filters", () => {
    expect(
      resolveTaskLedgerSourceRoute(
        task("mining", {
          metadata: { currentCycleId: "cycle-9", action: "commit" },
        }),
      ),
    ).toMatchObject({
      tab: "mining",
      miningActivityFilter: "cycle",
      miningActivityWindow: "all",
      hash: "mining-cycle-cycle-9",
    });
  });

  it("routes channel records to Agent Channels messages", () => {
    expect(
      resolveTaskLedgerSourceRoute(
        task("channel", {
          metadata: { messageId: "telegram:42" },
        }),
      ),
    ).toMatchObject({
      tab: "agents",
      agentsPanel: "channels",
      channelsView: "messages",
      loadChannels: true,
      hash: "channel-message-telegram:42",
    });
  });

  it("routes media records with sessions to chat transcripts", () => {
    expect(
      resolveTaskLedgerSourceRoute(
        task("media", {
          sessionKey: "agent:main:webchat:direct:media",
          metadata: { artifactId: "image-1" },
        }),
      ),
    ).toMatchObject({
      tab: "chat",
      sessionKey: "agent:main:webchat:direct:media",
      hash: "media-artifact-image-1",
    });
  });

  it("routes webhook, cron, subagent, and CLI records back to Agent Tasks", () => {
    expect(
      resolveTaskLedgerSourceRoute(task("webhook", { metadata: { triggerId: "hook-a" } })),
    ).toMatchObject({
      tab: "agents",
      agentsPanel: "cron",
      taskLedgerSourceFilter: "webhook",
      loadCron: true,
      hash: "webhook-trigger-hook-a",
    });

    expect(
      resolveTaskLedgerSourceRoute(task("cron", { definitionId: "daily-brief" })),
    ).toMatchObject({
      taskLedgerSourceFilter: "cron",
      hash: "scheduled-task-daily-brief",
    });
    expect(resolveTaskLedgerSourceRoute(task("cron"))).toMatchObject({
      taskLedgerSourceFilter: "cron",
      hash: "task-ledger-cron-task",
    });
    expect(resolveTaskLedgerSourceRoute(task("subagent"))).toMatchObject({
      taskLedgerSourceFilter: "subagent",
      hash: "task-ledger-subagent-task",
    });
    expect(resolveTaskLedgerSourceRoute(task("CLI"))).toMatchObject({
      taskLedgerSourceFilter: "CLI",
      hash: "task-ledger-CLI-task",
    });
  });
});
