import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeNodePendingWork,
  drainNodePendingWork,
  enqueueNodePendingWork,
  getNodePendingWorkStateCountForTests,
  resetNodePendingWorkForTests,
} from "./node-pending-work.js";

describe("node pending work queue", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetNodePendingWorkForTests();
  });

  it("returns a synthetic baseline status item when no explicit status is queued", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T00:00:00.000Z"));

    const drained = drainNodePendingWork("node-1");

    expect(drained).toMatchObject({
      revision: 0,
      hasMore: false,
      items: [
        {
          id: "baseline-status",
          type: "status.request",
          priority: "default",
          expiresAtMs: null,
        },
      ],
    });
  });

  it("orders explicit work by priority and omits baseline status when status is explicit", () => {
    enqueueNodePendingWork({
      nodeId: "node-1",
      type: "status.request",
      priority: "normal",
      nowMs: 100,
    });
    enqueueNodePendingWork({
      nodeId: "node-1",
      type: "location.request",
      priority: "high",
      nowMs: 200,
    });

    const drained = drainNodePendingWork("node-1", { maxItems: 10, nowMs: 300 });

    expect(drained.items.map((item) => item.type)).toEqual(["location.request", "status.request"]);
    expect(drained.items.every((item) => item.id !== "baseline-status")).toBe(true);
  });

  it("dedupes by node and work type without advancing the revision", () => {
    const first = enqueueNodePendingWork({
      nodeId: "node-1",
      type: "location.request",
      nowMs: 100,
    });
    const second = enqueueNodePendingWork({
      nodeId: "node-1",
      type: "location.request",
      priority: "high",
      nowMs: 200,
    });

    expect(second.deduped).toBe(true);
    expect(second.item.id).toBe(first.item.id);
    expect(second.revision).toBe(first.revision);
  });

  it("prunes expired items and removes empty node state", () => {
    enqueueNodePendingWork({
      nodeId: "node-1",
      type: "location.request",
      expiresInMs: 1_000,
      nowMs: 100,
    });

    const drained = drainNodePendingWork("node-1", { nowMs: 1_100 });

    expect(drained.items).toEqual([
      expect.objectContaining({ id: "baseline-status", type: "status.request" }),
    ]);
    expect(getNodePendingWorkStateCountForTests()).toBe(0);
  });

  it("acks only explicit ids and ignores baseline or unknown ids", () => {
    const queued = enqueueNodePendingWork({
      nodeId: "node-1",
      type: "location.request",
      nowMs: 100,
    });

    const acked = acknowledgeNodePendingWork({
      nodeId: "node-1",
      itemIds: ["baseline-status", "missing", queued.item.id],
    });

    expect(acked.removedItemIds).toEqual([queued.item.id]);
    expect(acked.remainingCount).toBe(0);
    expect(drainNodePendingWork("node-1", { nowMs: 200 }).items).toEqual([
      expect.objectContaining({ id: "baseline-status" }),
    ]);
  });
});
