import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import { listTaskRecords, resetTaskRegistryForTests } from "../tasks/task-registry.js";
import { upsertMarketplaceOrderConfig, upsertMarketplaceRequestConfig } from "./offers.js";

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(async () => {
  previousStateDir = process.env.FASED_STATE_DIR;
  stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-marketplace-ledger-"));
  process.env.FASED_STATE_DIR = stateDir;
  resetTaskRegistryForTests({ persist: true });
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.FASED_STATE_DIR;
  } else {
    process.env.FASED_STATE_DIR = previousStateDir;
  }
  resetTaskRegistryForTests({ persist: false });
  await rm(stateDir, { recursive: true, force: true });
});

describe("marketplace task ledger mirror", () => {
  it("mirrors Marketplace requests into the task ledger", () => {
    upsertMarketplaceRequestConfig({
      config: {} as FasedAgentConfig,
      now: "2026-05-22T10:00:00.000Z",
      input: {
        id: "request-1",
        enabled: true,
        status: "open",
        title: "Need a summary",
        serviceKind: "content.summarize",
      },
    });

    const task = listTaskRecords({ source: "marketplace" }).tasks[0];
    expect(task).toMatchObject({
      taskId: "marketplace:request:request-1",
      source: "marketplace",
      runtime: "marketplace",
      taskKind: "marketplace_request",
      status: "running",
      agentId: "main",
      task: "Marketplace request: Need a summary",
      metadata: {
        domain: "marketplace",
        requestId: "request-1",
        requestStatus: "open",
        serviceKind: "content.summarize",
      },
    });
  });

  it("mirrors payment, delivery, and dispute state from Marketplace orders", () => {
    upsertMarketplaceOrderConfig({
      config: {} as FasedAgentConfig,
      now: "2026-05-22T10:05:00.000Z",
      input: {
        id: "order-1",
        source: "federation",
        status: "disputed",
        offerId: "offer-1",
        requestId: "request-1",
        buyerHandle: "@buyer",
        sellerHandle: "@seller",
        title: "Summarize report",
        serviceKind: "content.summarize",
        pricing: {
          amount: 0.1,
          currency: "SOL",
          model: "fixed",
          unit: "per-job",
        },
        paymentIntent: {
          status: "verified",
          amount: 0.1,
          currency: "SOL",
          chain: "solana",
          assetKind: "native",
          txRef: "tx-1",
        },
        settlement: {
          mode: "escrow",
          status: "disputed",
          amount: 0.1,
          currency: "SOL",
          chain: "solana",
          assetKind: "native",
          txRef: "tx-1",
          escrow: {
            status: "held",
            holdPolicy: "release_on_delivery",
            releaseRequired: true,
          },
        },
        delivery: {
          status: "blocked",
          resultRef: "result-1",
          artifactRef: "artifact-1",
        },
        receipt: {
          status: "issued",
          invoiceId: "invoice-1",
          receiptId: "receipt-1",
          txRef: "tx-1",
          resultRef: "result-1",
          disputeCaseId: "case-1",
        },
        disputeCaseId: "case-1",
      },
    });

    const task = listTaskRecords({ source: "marketplace" }).tasks[0];
    expect(task).toMatchObject({
      taskId: "marketplace:order:order-1",
      source: "marketplace",
      runtime: "marketplace",
      taskKind: "marketplace_order",
      status: "blocked",
      deliveryStatus: "not_delivered",
      task: "Marketplace order: Summarize report",
      metadata: {
        domain: "marketplace",
        orderId: "order-1",
        offerId: "offer-1",
        requestId: "request-1",
        paymentStatus: "verified",
        settlementStatus: "disputed",
        deliveryStatus: "blocked",
        disputeCaseId: "case-1",
      },
    });
    expect(task?.steps?.map((step) => [step.id, step.status])).toEqual([
      ["accepted", "succeeded"],
      ["payment", "succeeded"],
      ["settlement", "blocked"],
      ["delivery", "blocked"],
      ["receipt", "succeeded"],
      ["dispute", "blocked"],
    ]);
  });
});
