import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listStandingOrders,
  proposeStandingOrder,
  removeStandingOrder,
  resetStandingOrdersForTests,
  saveStandingOrder,
} from "./standing-orders.js";
import { listTaskRecords, resetTaskRegistryForTests } from "./task-registry.js";

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(async () => {
  previousStateDir = process.env.FASED_STATE_DIR;
  stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-standing-orders-"));
  process.env.FASED_STATE_DIR = stateDir;
  resetStandingOrdersForTests({ persist: true });
  resetTaskRegistryForTests({ persist: true });
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.FASED_STATE_DIR;
  } else {
    process.env.FASED_STATE_DIR = previousStateDir;
  }
  resetStandingOrdersForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
  await rm(stateDir, { recursive: true, force: true });
});

describe("standing orders", () => {
  it("saves, filters, and removes Agent-scoped programs", () => {
    const saved = saveStandingOrder({
      agentId: "main",
      name: "Morning market review",
      instructions: "Propose a daily review task after provider health is ready.",
      triggerHint: "weekdays 08:00",
      proposalKind: "workflow",
    });
    saveStandingOrder({
      agentId: "beta",
      name: "Other",
      instructions: "Other Agent program.",
    });

    expect(saved).toMatchObject({
      id: "Morning-market-review",
      agentId: "main",
      proposalKind: "workflow",
      approvalRequired: true,
      status: "enabled",
    });
    expect(listStandingOrders({ agentId: "main" }).orders).toEqual([saved]);
    expect(listStandingOrders().summary.total).toBe(2);

    const remaining = removeStandingOrder({ agentId: "main", id: saved.id });
    expect(remaining.orders).toHaveLength(0);
    expect(listStandingOrders({ agentId: "beta" }).orders).toHaveLength(1);
  });

  it("creates proposal-only ledger records without granting authority", () => {
    const order = saveStandingOrder({
      agentId: "main",
      name: "Mining readiness program",
      instructions: "Propose a mining readiness workflow when conditions change.",
      proposalKind: "workflow",
    });

    const proposal = proposeStandingOrder({ agentId: "main", id: order.id });

    expect(proposal.task).toMatchObject({
      source: "CLI",
      runtime: "cli",
      taskKind: "standing-order-proposal",
      definitionId: order.id,
      definitionKind: "workflow",
      agentId: "main",
      status: "blocked",
      progressSummary: "Program proposal is waiting for operator review.",
      metadata: expect.objectContaining({
        authority: "proposal-only",
        approvalRequired: true,
        forbiddenGrants: ["wallet", "tools", "mining"],
      }),
    });
    expect(listTaskRecords({ agentId: "main" }).tasks).toHaveLength(1);
    expect(listStandingOrders({ agentId: "main" }).orders[0]?.lastProposedAt).toBeTypeOf("number");
  });

  it("rejects disabled or cross-Agent proposal requests", () => {
    const order = saveStandingOrder({
      agentId: "main",
      name: "Disabled program",
      instructions: "Do not propose while disabled.",
      status: "disabled",
    });

    expect(() => proposeStandingOrder({ agentId: "main", id: order.id })).toThrow("disabled");
    expect(() => proposeStandingOrder({ agentId: "other", id: order.id })).toThrow(
      "not found for selected Agent",
    );
  });
});
