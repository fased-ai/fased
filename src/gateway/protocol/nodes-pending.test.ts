import { describe, expect, it } from "vitest";
import {
  validateNodePendingAckParams,
  validateNodePendingDrainParams,
  validateNodePendingEnqueueParams,
  validateNodePendingPullParams,
} from "./index.js";

describe("node pending protocol validators", () => {
  it("accepts bounded enqueue params for typed pending work", () => {
    expect(
      validateNodePendingEnqueueParams({
        nodeId: "node-1",
        type: "status.request",
        priority: "high",
        expiresInMs: 60_000,
        wake: false,
      }),
    ).toBe(true);
  });

  it("rejects arbitrary commands and unknown pending work types", () => {
    expect(
      validateNodePendingEnqueueParams({
        nodeId: "node-1",
        type: "shell.exec",
      }),
    ).toBe(false);
    expect(
      validateNodePendingEnqueueParams({
        nodeId: "node-1",
        type: "status.request",
        command: "system.execApprovals.get",
      }),
    ).toBe(false);
  });

  it("bounds drain and pull maxItems", () => {
    expect(validateNodePendingDrainParams({ maxItems: 10 })).toBe(true);
    expect(validateNodePendingPullParams({ maxItems: 1 })).toBe(true);
    expect(validateNodePendingDrainParams({ maxItems: 11 })).toBe(false);
    expect(validateNodePendingPullParams({ maxItems: 0 })).toBe(false);
  });

  it("bounds expiry and requires non-empty ack ids", () => {
    expect(
      validateNodePendingEnqueueParams({
        nodeId: "node-1",
        type: "location.request",
        expiresInMs: 999,
      }),
    ).toBe(false);
    expect(
      validateNodePendingEnqueueParams({
        nodeId: "node-1",
        type: "location.request",
        expiresInMs: 86_400_001,
      }),
    ).toBe(false);
    expect(validateNodePendingAckParams({ ids: ["abc"] })).toBe(true);
    expect(validateNodePendingAckParams({ ids: [] })).toBe(false);
  });
});
