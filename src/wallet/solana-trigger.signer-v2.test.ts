import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SOLANA_NATIVE_MINT } from "./solana-swap.js";
import {
  cancelJupiterTriggerOrder,
  canonicalJupiterTriggerPrice,
  createJupiterTriggerLimitOrder,
  listJupiterTriggerOrders,
} from "./solana-trigger.js";
import type {
  WalletProviderAdapter,
  WalletProviderJupiterIntentV2,
  WalletProviderJupiterReviewV2,
  WalletProviderSignerOperationV2,
} from "./wallet-provider-adapter.js";
import type { ResolvedWalletRuntimeConfig } from "./wallet-runtime-config.js";

const WALLET = "11111111111111111111111111111111";
const OUTPUT_MINT = "So11111111111111111111111111111111111111111";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const roots: string[] = [];

const runtimeConfig: ResolvedWalletRuntimeConfig = {
  enabled: true,
  mode: "managed",
  runtime: "external-custom",
  execution: { mode: "manual" },
  chains: ["solana"],
  service: { host: "127.0.0.1", port: 19444 },
  install: { enabled: false, version: "test" },
  external: { kind: "custom" },
  auth: { mode: "static-token-compat" },
  source: { ref: "test" },
  stack: { rootDir: "", composePath: "", envPath: "", projectName: "test" },
  policy: {
    capsEnabled: true,
    directSigning: true,
    skillsEnabled: true,
    solana: {
      allowPrograms: [SYSTEM_PROGRAM],
      caps: { maxPerTx: 1_000_000_000n, maxDaily: 2_000_000_000n },
      tokenCaps: {},
    },
  },
  toolAccess: {
    mode: "owner-only",
    allowAgents: [],
    allowSkills: [],
    denySkills: [],
    allowSources: [],
  },
};

function testEnv(): NodeJS.ProcessEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-trigger-v2-"));
  roots.push(root);
  return { ...process.env, FASED_STATE_DIR: root };
}

function reviewFor(request: {
  walletId: string;
  requestId: string;
  intent: WalletProviderJupiterIntentV2;
}): WalletProviderJupiterReviewV2 {
  return {
    requestId: request.requestId,
    walletId: request.walletId,
    walletPublicKey: WALLET,
    intentType: request.intent.type,
    intentDigest: `sha256:${"a".repeat(64)}`,
    policyHash: `sha256:${"b".repeat(64)}`,
    mode: "reviewed",
    nonce: "c".repeat(64),
    semanticIntent: request.intent,
    artifactKind: "jupiter-trigger-state",
    artifactDigest: `sha256:${"d".repeat(64)}`,
    stateDigest: `sha256:${"e".repeat(64)}`,
    asset: "solana:native",
    amount:
      request.intent.jupiter.maxInputAmount ?? request.intent.jupiter.minimumOutputAmount ?? "0",
    destination: WALLET,
    policyOperation: request.intent.type,
    requiredPrograms: [...request.intent.jupiter.programs],
    requiredRole: "agent",
    issuedAt: "2026-07-17T12:00:00.000Z",
    state: "prepared",
    preparedAt: "2026-07-17T12:00:00.000Z",
    expiresAt: "2026-07-17T12:15:00.000Z",
    updatedAt: "2026-07-17T12:00:00.000Z",
  };
}

function confirmedOperation(request: {
  walletId: string;
  requestId: string;
  intent: WalletProviderJupiterIntentV2;
}): WalletProviderSignerOperationV2 {
  const action = request.intent.type.endsWith(".cancel") ? "cancel" : "create";
  return {
    requestId: request.requestId,
    walletId: request.walletId,
    intentType: request.intent.type,
    intentDigest: `sha256:${"a".repeat(64)}`,
    policyHash: `sha256:${"b".repeat(64)}`,
    asset: "solana:native",
    amount:
      request.intent.jupiter.maxInputAmount ?? request.intent.jupiter.minimumOutputAmount ?? "0",
    state: "confirmed",
    signature: action === "create" ? "deposit-signature" : "cancel-signature",
    externalResult: {
      provider: "jupiter-trigger-v2",
      action,
      orderId: "order-1",
      orderState: action === "create" ? "open" : "cancelled",
    },
  };
}

function providerFixture() {
  const reviews = new Map<string, WalletProviderJupiterReviewV2>();
  const prepareSignerReview = vi.fn(
    async (request: {
      walletId: string;
      requestId: string;
      mode: "autonomous" | "reviewed";
      intent: WalletProviderJupiterIntentV2;
      transaction?: unknown;
    }) => {
      expect(request.mode).toBe("reviewed");
      expect(request.transaction).toBeUndefined();
      const review = reviewFor(request);
      reviews.set(request.requestId, review);
      return review;
    },
  );
  const getSignerReview = vi.fn(async (request: { requestId: string }) => {
    const review = reviews.get(request.requestId);
    if (!review) {
      throw new Error("review not found");
    }
    return review;
  });
  const executeSignerIntent = vi.fn(
    async (request: {
      walletId: string;
      requestId: string;
      intent: WalletProviderJupiterIntentV2;
    }) => confirmedOperation(request),
  );
  const reconcileSignerOperation = vi.fn(
    async (_request: {
      walletId: string;
      requestId: string;
    }): Promise<WalletProviderSignerOperationV2> => {
      throw new Error("operation not found");
    },
  );
  const listJupiterTriggerOrders = vi.fn(async () => ({
    orders: [
      {
        orderId: "order-1",
        orderState: "open",
        orderType: "single" as const,
        inputMint: SOLANA_NATIVE_MINT,
        initialInputAmount: "10",
        remainingInputAmount: "7",
        outputMint: OUTPUT_MINT,
        triggerMint: SOLANA_NATIVE_MINT,
        condition: "below" as const,
        targetPriceUsd: "120.5",
        slippageBps: 100,
        expiresAt: "2026-07-20T12:00:00.000Z",
        cancel: {
          expectedOrderState: "open" as const,
          refundMint: SOLANA_NATIVE_MINT,
          refundAmount: "7",
          destinationTokenAccount: WALLET,
          program: SYSTEM_PROGRAM,
        },
      },
    ],
  }));
  return {
    provider: {
      prepareSignerReview,
      getSignerReview,
      executeSignerIntent,
      reconcileSignerOperation,
      listJupiterTriggerOrders,
    } as unknown as WalletProviderAdapter,
    prepareSignerReview,
    getSignerReview,
    executeSignerIntent,
    reconcileSignerOperation,
    listJupiterTriggerOrders,
  };
}

function createParams(provider: WalletProviderAdapter, env: NodeJS.ProcessEnv) {
  return {
    provider,
    walletId: "agent",
    walletAddress: WALLET,
    config: runtimeConfig,
    inputMint: SOLANA_NATIVE_MINT,
    outputMint: OUTPUT_MINT,
    amount: "10",
    triggerCondition: "below" as const,
    triggerPriceUsd: "120.5000",
    triggerMint: SOLANA_NATIVE_MINT,
    slippageBps: 100,
    expiresAt: "2026-07-20T12:00:00.000Z",
    intentId: "tool-call-1",
    env,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-17T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("signer-owned Jupiter Trigger flow", () => {
  it("canonicalizes positive prices without exponent notation or redundant zeroes", () => {
    expect(canonicalJupiterTriggerPrice("120.5000")).toBe("120.5");
    expect(canonicalJupiterTriggerPrice(1e-7)).toBe("0.0000001");
    expect(() => canonicalJupiterTriggerPrice("1e-7")).toThrow(/plain decimal/);
    expect(() => canonicalJupiterTriggerPrice("0.000")).toThrow(/positive/);
  });

  it("prepares a reviewed create with exact semantics and no transaction or external side effect", async () => {
    const env = testEnv();
    const fixture = providerFixture();
    const first = await createJupiterTriggerLimitOrder({
      ...createParams(fixture.provider, env),
      autonomous: false,
    });
    expect(first.mode).toBe("reviewed");
    expect(fixture.prepareSignerReview).toHaveBeenCalledOnce();
    const request = fixture.prepareSignerReview.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      mode: "reviewed",
      intent: {
        type: "solana.jupiter.trigger.create",
        jupiter: {
          owner: WALLET,
          inputMint: SOLANA_NATIVE_MINT,
          outputMint: OUTPUT_MINT,
          inputAmount: "10",
          maxInputAmount: "10",
          minimumOutputAmount: "0",
          programs: [SYSTEM_PROGRAM],
          trigger: {
            operation: "create",
            program: SYSTEM_PROGRAM,
            triggerMint: SOLANA_NATIVE_MINT,
            condition: "below",
            targetPriceUsd: "120.5",
            slippageBps: 100,
            expiresAt: "2026-07-20T12:00:00.000Z",
            expectedOrderState: "new",
          },
        },
      },
    });
    expect(request).not.toHaveProperty("transaction");
    expect(request?.intent.jupiter).not.toHaveProperty("sourceTokenAccount");
    expect(request?.intent.jupiter).not.toHaveProperty("destinationTokenAccount");
    expect(request?.intent.jupiter.trigger).not.toHaveProperty("vault");
    expect(request?.intent.jupiter.trigger).not.toHaveProperty("requestId");
    expect(fixture.executeSignerIntent).not.toHaveBeenCalled();

    const repeated = await createJupiterTriggerLimitOrder({
      ...createParams(fixture.provider, env),
      autonomous: false,
    });
    expect(repeated.mode).toBe("reviewed");
    expect(fixture.prepareSignerReview).toHaveBeenCalledOnce();
    expect(fixture.getSignerReview).toHaveBeenCalledOnce();
  });

  it("executes autonomous create once and returns only the sanitized signer result", async () => {
    const env = testEnv();
    const fixture = providerFixture();
    const first = await createJupiterTriggerLimitOrder({
      ...createParams(fixture.provider, env),
      autonomous: true,
    });
    expect(first).toMatchObject({
      mode: "autonomous",
      order: {
        id: "order-1",
        txSignature: "deposit-signature",
        state: "open",
        provider: "jupiter-trigger-v2",
      },
    });
    expect(JSON.stringify(first)).not.toMatch(/signedTxBase64|jwt|apiKey|vault/i);

    const repeated = await createJupiterTriggerLimitOrder({
      ...createParams(fixture.provider, env),
      autonomous: true,
    });
    expect(repeated).toEqual(first);
    expect(fixture.executeSignerIntent).toHaveBeenCalledOnce();
    expect(fixture.prepareSignerReview).not.toHaveBeenCalled();
  });

  it("does not execute again after an ambiguous autonomous response", async () => {
    const env = testEnv();
    const fixture = providerFixture();
    fixture.executeSignerIntent.mockRejectedValueOnce(new Error("response lost"));
    fixture.reconcileSignerOperation.mockImplementationOnce(async (reconcileRequest) => ({
      requestId: reconcileRequest.requestId,
      walletId: reconcileRequest.walletId,
      intentType: "solana.jupiter.trigger.create",
      intentDigest: `sha256:${"a".repeat(64)}`,
      policyHash: `sha256:${"b".repeat(64)}`,
      asset: "solana:native",
      amount: "10",
      state: "unknown",
    }));
    const request = { ...createParams(fixture.provider, env), autonomous: true };
    await expect(createJupiterTriggerLimitOrder(request)).rejects.toThrow(/unknown/);
    await expect(createJupiterTriggerLimitOrder(request)).rejects.toThrow(
      /different immutable|unknown|reconcile/,
    );
    expect(fixture.executeSignerIntent).toHaveBeenCalledOnce();
    expect(fixture.reconcileSignerOperation).toHaveBeenCalledOnce();
  });

  it("uses sanitized signer history for cancel and prepares no cancellation transaction", async () => {
    const env = testEnv();
    const fixture = providerFixture();
    const history = await listJupiterTriggerOrders({
      provider: fixture.provider,
      walletId: "agent",
      state: "active",
      env,
    });
    expect(history.orders).toHaveLength(1);
    expect(JSON.stringify(history)).not.toMatch(/jwt|apiKey|vault|transaction|requestId/i);

    const prepared = await cancelJupiterTriggerOrder({
      provider: fixture.provider,
      walletId: "agent",
      walletAddress: WALLET,
      orderId: "order-1",
      autonomous: false,
      intentId: "cancel-tool-call",
      env,
    });
    expect(prepared.mode).toBe("reviewed");
    const request = fixture.prepareSignerReview.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      mode: "reviewed",
      intent: {
        type: "solana.jupiter.trigger.cancel",
        jupiter: {
          owner: WALLET,
          outputMint: SOLANA_NATIVE_MINT,
          minimumOutputAmount: "7",
          destinationTokenAccount: WALLET,
          programs: [SYSTEM_PROGRAM],
          trigger: {
            operation: "cancel",
            program: SYSTEM_PROGRAM,
            order: "order-1",
            expectedOrderState: "open",
          },
        },
      },
    });
    expect(request).not.toHaveProperty("transaction");
    expect(request?.intent.jupiter).not.toHaveProperty("sourceTokenAccount");
    expect(request?.intent.jupiter.trigger).not.toHaveProperty("vault");
    expect(request?.intent.jupiter.trigger).not.toHaveProperty("requestId");
    expect(fixture.executeSignerIntent).not.toHaveBeenCalled();
  });

  it("returns a durable confirmed cancel without requiring the now-closed order in history", async () => {
    const env = testEnv();
    const fixture = providerFixture();
    const request = {
      provider: fixture.provider,
      walletId: "agent",
      walletAddress: WALLET,
      orderId: "order-1",
      autonomous: true,
      intentId: "cancel-once",
      env,
    } as const;
    const first = await cancelJupiterTriggerOrder(request);
    expect(first).toMatchObject({
      mode: "autonomous",
      order: { id: "order-1", state: "cancelled" },
    });
    fixture.listJupiterTriggerOrders.mockResolvedValueOnce({ orders: [] });
    const repeated = await cancelJupiterTriggerOrder(request);
    expect(repeated).toEqual(first);
    expect(fixture.listJupiterTriggerOrders).toHaveBeenCalledOnce();
    expect(fixture.executeSignerIntent).toHaveBeenCalledOnce();
  });

  it("rejects changed terms under one stable intent id", async () => {
    const env = testEnv();
    const fixture = providerFixture();
    await createJupiterTriggerLimitOrder({
      ...createParams(fixture.provider, env),
      autonomous: true,
    });
    await expect(
      createJupiterTriggerLimitOrder({
        ...createParams(fixture.provider, env),
        amount: "11",
        autonomous: true,
      }),
    ).rejects.toThrow(/different immutable terms/);
    expect(fixture.executeSignerIntent).toHaveBeenCalledOnce();
  });
});
