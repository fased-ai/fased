import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimMarketplaceSettlementOrder,
  getMarketplaceSettlementEntry,
  reserveMarketplaceSettlementAction,
  updateMarketplaceSettlementAction,
} from "./marketplace-settlement-ledger.js";

let stateDir = "";

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-marketplace-ledger-"));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  return { ...process.env, FASED_STATE_DIR: stateDir };
}

describe("marketplace settlement ledger", () => {
  it("returns an exact action retry and rejects changed immutable intent", () => {
    const first = reserveMarketplaceSettlementAction({
      orderId: "order-1",
      action: "direct",
      executionIntentId: "order-1:direct",
      initialPhase: "open",
      intent: { amount: "10", payee: "seller-a" },
      env: env(),
    });
    const retry = reserveMarketplaceSettlementAction({
      orderId: "order-1",
      action: "direct",
      executionIntentId: "order-1:direct",
      initialPhase: "open",
      intent: { payee: "seller-a", amount: "10" },
      env: env(),
    });

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(() =>
      reserveMarketplaceSettlementAction({
        orderId: "order-1",
        action: "direct",
        executionIntentId: "order-1:direct",
        initialPhase: "open",
        intent: { amount: "11", payee: "seller-a" },
        env: env(),
      }),
    ).toThrow("different immutable intent");
  });

  it("persists completed funding and makes release/refund mutually exclusive", () => {
    reserveMarketplaceSettlementAction({
      orderId: "order-escrow-1",
      action: "fund",
      executionIntentId: "order-escrow-1:fund",
      initialPhase: "open",
      intent: { amount: "100", vault: "vault-a" },
      env: env(),
    });
    updateMarketplaceSettlementAction({
      orderId: "order-escrow-1",
      action: "fund",
      expectedStates: ["reserved"],
      state: "complete",
      requestId: "fund-request-1",
      txHash: "fund-tx-1",
      env: env(),
    });
    reserveMarketplaceSettlementAction({
      orderId: "order-escrow-1",
      action: "release",
      executionIntentId: "order-escrow-1:release",
      initialPhase: "held",
      intent: { amount: "100", payee: "seller-a" },
      env: env(),
    });
    updateMarketplaceSettlementAction({
      orderId: "order-escrow-1",
      action: "release",
      expectedStates: ["reserved"],
      state: "complete",
      txHash: "release-tx-1",
      env: env(),
    });

    expect(() =>
      reserveMarketplaceSettlementAction({
        orderId: "order-escrow-1",
        action: "refund",
        executionIntentId: "order-escrow-1:refund",
        initialPhase: "held",
        intent: { amount: "100", payer: "buyer-a" },
        env: env(),
      }),
    ).toThrow("forbidden while settlement phase is released");
    expect(getMarketplaceSettlementEntry({ orderId: "order-escrow-1", env: env() })).toMatchObject({
      phase: "released",
      actions: {
        fund: { state: "complete", txHash: "fund-tx-1" },
        release: { state: "complete", txHash: "release-tx-1" },
      },
    });
  });

  it("does not permit an alternate outcome after an ambiguous release", () => {
    reserveMarketplaceSettlementAction({
      orderId: "order-unknown-1",
      action: "release",
      executionIntentId: "order-unknown-1:release",
      initialPhase: "held",
      intent: { amount: "100", payee: "seller-a" },
      env: env(),
    });
    updateMarketplaceSettlementAction({
      orderId: "order-unknown-1",
      action: "release",
      expectedStates: ["reserved"],
      state: "unknown",
      reason: "broadcast response was ambiguous",
      env: env(),
    });

    expect(() =>
      reserveMarketplaceSettlementAction({
        orderId: "order-unknown-1",
        action: "refund",
        executionIntentId: "order-unknown-1:refund",
        initialPhase: "held",
        intent: { amount: "100", payer: "buyer-a" },
        env: env(),
      }),
    ).toThrow("forbidden while settlement phase is release_unknown");
  });

  it("allows only one order execution claimant", async () => {
    const release = await claimMarketplaceSettlementOrder("order-claim-1", env());
    await expect(claimMarketplaceSettlementOrder("order-claim-1", env())).rejects.toThrow(
      "already in progress",
    );
    await release();
    const releaseAfter = await claimMarketplaceSettlementOrder("order-claim-1", env());
    await releaseAfter();
  });
});
