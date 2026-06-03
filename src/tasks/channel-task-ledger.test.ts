import { beforeEach, describe, expect, it } from "vitest";
import { updateLatestChannelTaskDelivery } from "./channel-task-ledger.js";
import { createRunningTaskRun, completeTaskRunByRunId } from "./task-executor.js";
import { listTaskRecords, resetTaskRegistryForTests } from "./task-registry.js";

describe("channel task ledger", () => {
  beforeEach(() => {
    resetTaskRegistryForTests({ persist: false });
  });

  it("updates the latest channel-triggered Agent task with dispatch delivery state", () => {
    createRunningTaskRun({
      runtime: "channel",
      runId: "channel-run",
      sourceId: "channel:telegram:m1",
      ownerKey: "agent:main:telegram:default",
      requesterSessionKey: "agent:main:telegram:default",
      sessionKey: "agent:main:telegram:default",
      agentId: "main",
      channel: "telegram",
      taskKind: "channel-triggered-agent",
      task: "answer channel question",
      deliveryStatus: "pending",
    });
    completeTaskRunByRunId({
      runId: "channel-run",
      summary: "Prepared channel reply.",
      deliveryStatus: "pending",
    });

    const updated = updateLatestChannelTaskDelivery({
      sessionKey: "agent:main:telegram:default",
      channel: "telegram",
      deliveryStatus: "delivered",
      delivery: {
        channel: "telegram",
        target: "ops",
        messageId: "m-delivered",
        deliveredAt: 123,
      },
      summary: "Final reply delivered to Telegram.",
      metadata: {
        replyCounts: { final: 1 },
        dispatchRoute: "origin",
      },
    });

    expect(updated).toMatchObject({
      source: "channel",
      runtime: "channel",
      status: "succeeded",
      deliveryStatus: "delivered",
      terminalSummary: "Final reply delivered to Telegram.",
      delivery: {
        channel: "telegram",
        target: "ops",
        messageId: "m-delivered",
        deliveredAt: 123,
      },
      metadata: {
        replyCounts: { final: 1 },
        dispatchRoute: "origin",
      },
    });
    expect(listTaskRecords({ source: "channel" }).tasks).toHaveLength(1);
  });
});
