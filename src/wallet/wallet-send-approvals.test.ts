import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import {
  findTaskRecord,
  listTaskRecords,
  resetTaskRegistryForTests,
} from "../tasks/task-registry.js";
import { readWalletAuditEntries } from "./wallet-audit-log.js";
import type { WalletProviderJupiterReviewV2 } from "./wallet-provider-adapter.js";
import {
  readWalletProviderRegistry,
  writeWalletProviderRegistry,
} from "./wallet-provider-registry.js";
import * as walletProviderResolver from "./wallet-provider-resolver.js";
import { resolveWalletRuntimeConfig, resolveWalletStatePaths } from "./wallet-runtime-config.js";
import {
  approveWalletSendRequest,
  isDevnetCapitalOwnerConfirmation,
  createOrExecuteWalletSend,
  createSignerReviewApprovalRequest,
  createWalletSendApprovalRequest,
  listWalletSendApprovalRequests,
  rejectWalletSendRequest,
  sanitizeWalletSendApprovalRequest,
  signerReviewBindingMatchesWalletApprovalPayload,
  signerReviewMatchesWalletApprovalPayload,
} from "./wallet-send-approvals.js";
import { listWalletSettlementLinks } from "./wallet-settlement-links.js";

vi.mock("./wallet-approval-auth.js", () => ({
  resolveWalletApprovalAuthMode: vi.fn((env?: NodeJS.ProcessEnv) =>
    String(env?.FASED_WALLET_APPROVAL_AUTH ?? "")
      .trim()
      .toLowerCase() === "webauthn"
      ? "webauthn"
      : "none",
  ),
  consumeWalletApprovalGrant: vi.fn((params: { token?: string }) => {
    const token = String(params.token ?? "").trim();
    if (!token) {
      return { ok: false, code: "approval_token_required", message: "missing token" };
    }
    return { ok: true };
  }),
}));

let tempDir = "";

it("limits no-passkey Capital confirmation to exact Devnet preparation roles", () => {
  const review = {
    intentType: "solana.agentCapitalAction" as const,
    requiredRole: "profile" as const,
    semanticIntent: {
      type: "solana.agentCapitalAction" as const,
      cluster: "devnet" as const,
      action: "initialize_capital_offer" as const,
      programId: "FASJ6eaNMEe6K3DdXBT6ZbkfDFSjGBtxbNTVn9htXFKz", // pragma: allowlist secret -- public program ID
      dataBase64: "AA==",
      keys: [],
    },
  };
  expect(isDevnetCapitalOwnerConfirmation(review)).toBe(true);
  for (const action of ["cancel_capital_offer", "succeed_empty_capital_offer"] as const) {
    expect(
      isDevnetCapitalOwnerConfirmation({
        ...review,
        semanticIntent: { ...review.semanticIntent, action },
      }),
    ).toBe(true);
    expect(
      isDevnetCapitalOwnerConfirmation({
        ...review,
        requiredRole: "vault",
        semanticIntent: { ...review.semanticIntent, action },
      }),
    ).toBe(false);
  }
  const deposit = {
    ...review,
    requiredRole: "vault" as const,
    semanticIntent: {
      ...review.semanticIntent,
      action: "deposit_capital_offer_generation" as const,
    },
  };
  expect(isDevnetCapitalOwnerConfirmation(deposit)).toBe(true);
  expect(isDevnetCapitalOwnerConfirmation({ ...deposit, requiredRole: "profile" })).toBe(false);
  expect(
    isDevnetCapitalOwnerConfirmation({
      ...deposit,
      semanticIntent: { ...deposit.semanticIntent, cluster: "mainnet-beta" },
    }),
  ).toBe(false);
  expect(
    isDevnetCapitalOwnerConfirmation({
      ...deposit,
      semanticIntent: { ...deposit.semanticIntent, programId: "11111111111111111111111111111111" },
    }),
  ).toBe(false);
  expect(isDevnetCapitalOwnerConfirmation({ ...review, requiredRole: "vault" })).toBe(false);
  expect(
    isDevnetCapitalOwnerConfirmation({
      ...review,
      semanticIntent: { ...review.semanticIntent, cluster: "mainnet-beta" },
    }),
  ).toBe(false);
  expect(
    isDevnetCapitalOwnerConfirmation({
      ...review,
      semanticIntent: { ...review.semanticIntent, action: "deposit_capital_offer" },
    }),
  ).toBe(false);
});

function testConfig(cfg: unknown): FasedAgentConfig {
  return cfg as FasedAgentConfig;
}

function resolveWalletRuntimeConfigForTest(cfg: unknown) {
  return resolveWalletRuntimeConfig(testConfig(cfg));
}

function registerTestWallet(params: {
  id: string;
  role: "agent" | "mining" | "vault";
  providerId?: "local-socket-signer" | "alchemy";
  address?: string;
}) {
  const registry = readWalletProviderRegistry(process.env);
  const now = new Date().toISOString();
  registry.wallets = [
    {
      id: params.id,
      name: params.role,
      providerId: params.providerId ?? "local-socket-signer",
      addresses: {
        solana: params.address ?? "So11111111111111111111111111111111111111112",
      },
      metadata: { role: params.role },
      createdAt: now,
      updatedAt: now,
    },
  ];
  registry.defaultWalletId = params.id;
  writeWalletProviderRegistry(registry, process.env);
}

describe("wallet-send-approvals", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-approvals-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    resetTaskRegistryForTests({ persist: true });
  });

  afterEach(async () => {
    resetTaskRegistryForTests({ persist: false });
    vi.unstubAllEnvs();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("creates pending requests and lists pending by default", () => {
    createWalletSendApprovalRequest({
      payload: {
        chain: "solana",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      },
      requestedBy: "owner",
    });

    const pending = listWalletSendApprovalRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("pending");
    expect(pending[0]?.payload.chain).toBe("solana");
    expect(pending[0]?.taskLedgerId).toMatch(/^wallet:approval:/);
  });

  it("redacts serialized transactions from public approval request views", () => {
    const request = createWalletSendApprovalRequest({
      payload: {
        chain: "solana",
        actionKind: "solana_swap",
        amount: "1",
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "USDC111111111111111111111111111111111111111",
        serializedTxBase64: "raw-serialized-transaction",
      },
      requestedBy: "owner",
    });

    const stored = listWalletSendApprovalRequests({ status: "all" })[0];
    expect(stored?.payload.serializedTxBase64).toBe("raw-serialized-transaction");

    const publicRequest = sanitizeWalletSendApprovalRequest(request);
    expect(publicRequest.payload.serializedTxBase64).toBeUndefined();
    expect((publicRequest.payload as { hasSerializedTx?: boolean }).hasSerializedTx).toBe(true);
  });

  it("refuses to persist a partial local signer review binding", () => {
    expect(() =>
      createWalletSendApprovalRequest({
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        payload: {
          chain: "solana",
          actionKind: "solana_swap",
          providerId: "local-socket-signer",
          walletId: "agent",
          amount: "1",
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: "USDC111111111111111111111111111111111111111",
          signerReviewId: "partial-review",
          signerPolicyHash: `sha256:${"a".repeat(64)}`,
        },
      }),
    ).toThrow("complete exact signer review binding");
    expect(listWalletSendApprovalRequests({ status: "all" })).toEqual([]);
  });

  it("fails closed when a legacy persisted swap has only a partial signer binding", async () => {
    const request = createWalletSendApprovalRequest({
      payload: {
        chain: "solana",
        actionKind: "solana_swap",
        walletId: "agent",
        amount: "1",
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "USDC111111111111111111111111111111111111111",
      },
    });
    const approvalsPath = resolveWalletStatePaths(process.env).sendApprovalsPath;
    const persisted = JSON.parse(await fs.readFile(approvalsPath, "utf8")) as {
      requests: Array<{ id: string; payload: Record<string, unknown> }>;
    };
    const persistedRequest = persisted.requests.find((entry) => entry.id === request.id);
    if (!persistedRequest) {
      throw new Error("missing persisted approval fixture");
    }
    Object.assign(persistedRequest.payload, {
      providerId: "local-socket-signer",
      signerReviewId: "legacy-partial-review",
      signerPolicyHash: `sha256:${"a".repeat(64)}`,
    });
    await fs.writeFile(approvalsPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

    const approved = await approveWalletSendRequest({
      requestId: request.id,
      actor: "control-ui",
      config: resolveWalletRuntimeConfigForTest({
        wallet: { provider: { id: "local-socket-signer" } },
      }),
      providerIdOverride: "local-socket-signer",
    });
    expect(approved.ok).toBe(false);
    if (!approved.ok) {
      expect(approved.code).toBe("wallet_signer_review_binding_incomplete");
      expect(approved.request?.status).toBe("failed");
    }
  });

  it("preserves the previous approval ledger if an atomic rename is interrupted", async () => {
    const first = createWalletSendApprovalRequest({
      payload: {
        chain: "solana",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      },
    });
    const paths = resolveWalletStatePaths(process.env);
    const original = await fs.readFile(paths.sendApprovalsPath, "utf8");
    const renameSpy = vi.spyOn(fsSync, "renameSync").mockImplementationOnce(() => {
      throw new Error("simulated crash before atomic rename");
    });
    expect(() =>
      createWalletSendApprovalRequest({
        payload: {
          chain: "solana",
          to: "Vote111111111111111111111111111111111111111",
          amount: "2",
        },
      }),
    ).toThrow("simulated crash before atomic rename");
    renameSpy.mockRestore();

    expect(await fs.readFile(paths.sendApprovalsPath, "utf8")).toBe(original);
    expect((await fs.stat(paths.sendApprovalsPath)).mode & 0o777).toBe(0o600);
    expect(listWalletSendApprovalRequests({ status: "all" }).map((entry) => entry.id)).toEqual([
      first.id,
    ]);
    expect((await fs.readdir(paths.rootDir)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("fails closed without overwriting a corrupt existing approval ledger", async () => {
    const paths = resolveWalletStatePaths(process.env);
    createWalletSendApprovalRequest({
      payload: {
        chain: "solana",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      },
    });
    await fs.writeFile(paths.sendApprovalsPath, "{corrupt", "utf8");

    expect(() => listWalletSendApprovalRequests({ status: "all" })).toThrow(
      "wallet approval state is unreadable; refusing to reset persisted requests",
    );
    expect(await fs.readFile(paths.sendApprovalsPath, "utf8")).toBe("{corrupt");
  });

  it("keeps domain-separated federation reviews recoverable without a transaction digest", () => {
    const createdAtMs = Date.now();
    const issuedAt = new Date(createdAtMs).toISOString();
    const expiresAt = new Date(createdAtMs + 60_000).toISOString();
    const review: WalletProviderJupiterReviewV2 = {
      requestId: "federation-review-recovery-123",
      walletId: "vault",
      walletPublicKey: "Vault11111111111111111111111111111111111111",
      intentType: "federation.bondChallenge",
      intentDigest: `sha256:${"a".repeat(64)}`,
      policyHash: `sha256:${"b".repeat(64)}`,
      mode: "reviewed",
      nonce: "c".repeat(64),
      semanticIntent: {
        type: "federation.bondChallenge",
        federation: {
          challengeId: "challenge-123",
          federationOrigin: "https://federation.example.test",
          handle: "@vault@example.test",
          nodeId: "node-123",
          tokenId: "token-123",
          bondId: "bond-123",
          tier: "basic-bond",
          amountRaw: "1",
          expiresAt,
          payloadBase64: Buffer.from("challenge", "utf8").toString("base64"),
        },
      },
      artifactKind: "domain-separated-message",
      artifactDigest: `sha256:${"d".repeat(64)}`,
      messageBase64: Buffer.from("challenge", "utf8").toString("base64"),
      asset: "federation:bond-challenge",
      amount: "1",
      destination: "Vault11111111111111111111111111111111111111",
      policyOperation: "federation.bondChallenge",
      requiredPrograms: ["domain:fased:federation-bond-challenge-v1"],
      requiredRole: "vault",
      issuedAt,
      state: "prepared",
      preparedAt: issuedAt,
      expiresAt,
      updatedAt: issuedAt,
    };
    const request = createSignerReviewApprovalRequest({ review, role: "vault" });
    expect(request.payload.signerTransactionDigest).toBeUndefined();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(createdAtMs + 2 * 60_000);
    expect(listWalletSendApprovalRequests()).toMatchObject([
      { id: review.requestId, status: "pending" },
    ]);
    nowSpy.mockRestore();
  });

  it("recovers an expired signed review once but expires an unsigned review", async () => {
    const createdAtMs = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(createdAtMs);
    const now = new Date(createdAtMs).toISOString();
    const expiresAt = new Date(createdAtMs + 60_000).toISOString();
    const walletId = "vault-reviewed";
    const walletPublicKey = "Vault11111111111111111111111111111111111111";
    const destination = "Dest111111111111111111111111111111111111111";
    const systemProgram = "11111111111111111111111111111111";
    const review: WalletProviderJupiterReviewV2 = {
      requestId: "review-recovery-123",
      walletId,
      walletPublicKey,
      intentType: "solana.nativeTransfer",
      intentDigest: `sha256:${"a".repeat(64)}`,
      policyHash: `sha256:${"b".repeat(64)}`,
      mode: "reviewed",
      nonce: "c".repeat(64),
      semanticIntent: {
        type: "solana.nativeTransfer",
        destination,
        lamports: "42",
      },
      artifactKind: "solana-transaction",
      artifactDigest: `sha256:${"d".repeat(64)}`,
      transaction: {
        serializedTxBase64: "AA==",
        programs: [systemProgram],
        writableAccounts: [walletPublicKey, destination],
        submission: "rpc",
      },
      asset: "solana:native",
      amount: "42",
      destination,
      policyOperation: "solana.nativeTransfer",
      requiredPrograms: [systemProgram],
      requiredRole: "vault",
      issuedAt: now,
      state: "prepared",
      preparedAt: now,
      expiresAt,
      updatedAt: now,
      transactionDigest: `sha256:${"d".repeat(64)}`,
    };
    const pending = createSignerReviewApprovalRequest({ review, role: "vault" });
    const duplicate = createSignerReviewApprovalRequest({ review, role: "vault" });
    expect(duplicate.id).toBe(pending.id);
    expect(listWalletSendApprovalRequests({ status: "all" })).toHaveLength(1);
    expect(pending.expiresAt).toBe(expiresAt);
    expect(pending.payload.signerSemanticIntent).toEqual(review.semanticIntent);
    expect(signerReviewMatchesWalletApprovalPayload(review, pending.payload)).toBe(true);
    expect(
      signerReviewMatchesWalletApprovalPayload(review, {
        ...pending.payload,
        signerArtifactDigest: `sha256:${"e".repeat(64)}`,
      }),
    ).toBe(false);
    expect(
      signerReviewMatchesWalletApprovalPayload(
        {
          ...review,
          semanticIntent: {
            type: "solana.nativeTransfer",
            destination,
            lamports: "43",
          },
        },
        pending.payload,
      ),
    ).toBe(false);
    const binding = {
      requestId: review.requestId,
      walletId: review.walletId,
      role: "vault" as const,
      walletPublicKey: review.walletPublicKey,
      intentType: review.intentType,
      intentDigest: review.intentDigest,
      semanticIntent: structuredClone(review.semanticIntent),
      artifactKind: review.artifactKind,
      artifactDigest: review.artifactDigest,
      transactionDigest: review.transactionDigest,
      stateDigest: review.stateDigest,
      stateSlot: review.stateSlot,
      asset: review.asset,
      amount: review.amount,
      destination: review.destination,
      policyOperation: review.policyOperation,
      requiredPrograms: review.requiredPrograms,
      policyHash: review.policyHash,
      nonce: review.nonce,
      issuedAt: review.issuedAt,
      expiresAt: review.expiresAt,
    };
    expect(signerReviewBindingMatchesWalletApprovalPayload(binding, pending.payload)).toBe(true);
    expect(
      signerReviewBindingMatchesWalletApprovalPayload(
        {
          ...binding,
          semanticIntent: {
            type: "solana.nativeTransfer",
            destination: "ChangedDestination111",
            lamports: "42",
          },
        },
        pending.payload,
      ),
    ).toBe(false);
    expect(() =>
      createSignerReviewApprovalRequest({
        review: {
          ...review,
          semanticIntent: {
            type: "solana.nativeTransfer",
            destination,
            lamports: "43",
          },
        },
        role: "vault",
      }),
    ).toThrow("collides with different persisted metadata");

    const unsignedReview: WalletProviderJupiterReviewV2 = {
      ...review,
      requestId: "review-expired-unsigned-123",
      nonce: "e".repeat(64),
    };
    const unsignedPending = createSignerReviewApprovalRequest({
      review: unsignedReview,
      role: "vault",
    });
    const swapReview: WalletProviderJupiterReviewV2 = {
      ...review,
      requestId: "review-expired-signed-swap-123",
      nonce: "f".repeat(64),
      state: "signed",
      signature: "signed-swap-transaction",
    };
    const unknownSwapReview: WalletProviderJupiterReviewV2 = {
      ...swapReview,
      requestId: "review-expired-unknown-swap-123",
      nonce: "1".repeat(64),
      signature: "unknown-swap-transaction",
    };
    const mismatchedSwapReview: WalletProviderJupiterReviewV2 = {
      ...swapReview,
      requestId: "review-expired-mismatch-swap-123",
      nonce: "2".repeat(64),
      signature: "mismatch-swap-transaction",
    };
    const createSwapApproval = (swap: WalletProviderJupiterReviewV2) =>
      createWalletSendApprovalRequest({
        requestId: swap.requestId,
        expiresAt: swap.expiresAt,
        payload: {
          ...pending.payload,
          actionKind: "solana_swap",
          inputMint: "Input1111111111111111111111111111111111111",
          outputMint: "Output111111111111111111111111111111111111",
          signerReviewId: swap.requestId,
          signerNonce: swap.nonce,
        },
        requestedBy: "control-ui",
      });
    const signedSwapPending = createSwapApproval(swapReview);
    const unknownSwapPending = createSwapApproval(unknownSwapReview);
    const mismatchedSwapPending = createSwapApproval(mismatchedSwapReview);
    nowSpy.mockReturnValue(createdAtMs + 2 * 60_000);
    expect(listWalletSendApprovalRequests()).toHaveLength(5);

    const signedReview: WalletProviderJupiterReviewV2 = {
      ...review,
      state: "signed",
      signature: "signed-transaction",
      updatedAt: new Date().toISOString(),
    };
    const getSignerReview = vi.fn(async (request: { requestId: string }) =>
      request.requestId === unsignedReview.requestId
        ? unsignedReview
        : request.requestId === swapReview.requestId
          ? swapReview
          : request.requestId === unknownSwapReview.requestId
            ? unknownSwapReview
            : request.requestId === mismatchedSwapReview.requestId
              ? {
                  ...mismatchedSwapReview,
                  artifactDigest: `sha256:${"9".repeat(64)}`,
                }
              : signedReview,
    );
    const executeSignerReview = vi.fn(
      async (request: {
        requestId: string;
        authorization?: { type: "webauthn" | "control-ui"; proof: { proofId: string } };
      }) => {
        const executedReview =
          request.requestId === swapReview.requestId
            ? swapReview
            : request.requestId === unknownSwapReview.requestId
              ? unknownSwapReview
              : signedReview;
        return {
          review: executedReview,
          signer: walletPublicKey,
          operation: {
            requestId: executedReview.requestId,
            walletId,
            intentType: executedReview.intentType,
            intentDigest: executedReview.intentDigest,
            transactionDigest: executedReview.transactionDigest,
            policyHash: executedReview.policyHash,
            asset: executedReview.asset,
            amount: executedReview.amount,
            state:
              request.requestId === unknownSwapReview.requestId
                ? ("unknown" as const)
                : ("confirmed" as const),
            reservationActive: false,
            usageBucket: "2026-07-16:solana:native",
            reservedAt: now,
            confirmedAt: now,
            updatedAt: now,
            signature: executedReview.signature,
            authorizationProof: "consumed-proof",
          },
        };
      },
    );
    const providerSpy = vi
      .spyOn(walletProviderResolver, "createWalletProviderAdapter")
      .mockReturnValue({
        id: "local-socket-signer",
        displayName: "Local Socket Signer",
        capabilities: {
          custodyModel: "self-hosted",
          supportsCreateWallet: false,
          supportsPrepare: false,
          supportsSend: true,
          supportsRotateKeys: false,
          supportsResetKeys: false,
          supportsPasskeyGate: false,
          supportedExecutionModes: ["manual", "autonomous"],
          supportedChains: ["solana"],
        },
        supportsChain: () => true,
        health: async () => ({
          ok: true,
          provider: "local-socket-signer",
          configured: true,
          checkedAt: now,
        }),
        getAddresses: async () => ({ solana: walletPublicKey }),
        getBalance: async () => ({
          ok: true,
          chain: "solana",
          address: walletPublicKey,
          balance: "42",
          unit: "lamports",
        }),
        sendTx: vi.fn(),
        getSignerReview,
        executeSignerReview,
      } as ReturnType<typeof walletProviderResolver.createWalletProviderAdapter>);
    const expiredUnsigned = await approveWalletSendRequest({
      requestId: unsignedPending.id,
      actor: "control-ui",
      config: resolveWalletRuntimeConfigForTest({
        wallet: { provider: { id: "local-socket-signer" } },
      }),
      providerIdOverride: "local-socket-signer",
      reviewAuthorization: { type: "webauthn", proof: { proofId: "must-not-be-consumed" } },
    });
    expect(expiredUnsigned.ok).toBe(false);
    if (!expiredUnsigned.ok) {
      expect(expiredUnsigned.code).toBe("expired");
      expect(expiredUnsigned.request?.status).toBe("expired");
    }
    expect(executeSignerReview).not.toHaveBeenCalled();

    const recoveredSwap = await approveWalletSendRequest({
      requestId: signedSwapPending.id,
      actor: "control-ui",
      config: resolveWalletRuntimeConfigForTest({
        wallet: { provider: { id: "local-socket-signer" } },
      }),
      providerIdOverride: "local-socket-signer",
    });
    expect(recoveredSwap.ok).toBe(true);
    if (recoveredSwap.ok) {
      expect(recoveredSwap.tx.txHash).toBe("signed-swap-transaction");
    }

    const ambiguousSwap = await approveWalletSendRequest({
      requestId: unknownSwapPending.id,
      actor: "control-ui",
      config: resolveWalletRuntimeConfigForTest({
        wallet: { provider: { id: "local-socket-signer" } },
      }),
      providerIdOverride: "local-socket-signer",
    });
    expect(ambiguousSwap.ok).toBe(false);
    if (!ambiguousSwap.ok) {
      expect(ambiguousSwap.code).toBe("wallet_provider_ambiguous");
      expect(ambiguousSwap.request?.status).toBe("unknown");
    }
    const ambiguousRetry = await approveWalletSendRequest({
      requestId: unknownSwapPending.id,
      actor: "control-ui",
      config: resolveWalletRuntimeConfigForTest({
        wallet: { provider: { id: "local-socket-signer" } },
      }),
      providerIdOverride: "local-socket-signer",
    });
    expect(ambiguousRetry.ok).toBe(false);
    if (!ambiguousRetry.ok) {
      expect(ambiguousRetry.code).toBe("wallet_provider_ambiguous");
    }

    const mismatchedSwap = await approveWalletSendRequest({
      requestId: mismatchedSwapPending.id,
      actor: "control-ui",
      config: resolveWalletRuntimeConfigForTest({
        wallet: { provider: { id: "local-socket-signer" } },
      }),
      providerIdOverride: "local-socket-signer",
    });
    expect(mismatchedSwap.ok).toBe(false);
    if (!mismatchedSwap.ok) {
      expect(mismatchedSwap.code).toBe("wallet_signer_review_mismatch");
      expect(mismatchedSwap.request?.status).toBe("pending");
    }

    const approved = await approveWalletSendRequest({
      requestId: pending.id,
      actor: "control-ui",
      config: resolveWalletRuntimeConfigForTest({
        wallet: { provider: { id: "local-socket-signer" } },
      }),
      providerIdOverride: "local-socket-signer",
    });
    expect(approved.ok).toBe(true);
    expect(getSignerReview).toHaveBeenCalledTimes(6);
    expect(executeSignerReview).toHaveBeenCalledWith({
      walletId,
      requestId: review.requestId,
      authorization: undefined,
    });
    const duplicateRecovery = await approveWalletSendRequest({
      requestId: pending.id,
      actor: "control-ui",
      config: resolveWalletRuntimeConfigForTest({
        wallet: { provider: { id: "local-socket-signer" } },
      }),
      providerIdOverride: "local-socket-signer",
    });
    expect(duplicateRecovery.ok).toBe(false);
    if (!duplicateRecovery.ok) {
      expect(duplicateRecovery.code).toBe("invalid_state");
    }
    expect(executeSignerReview).toHaveBeenCalledTimes(4);
    providerSpy.mockRestore();
    nowSpy.mockRestore();
  });

  it("mirrors pending wallet approvals into the task ledger", () => {
    const request = createWalletSendApprovalRequest({
      payload: {
        chain: "solana",
        walletId: "agent-wallet",
        walletName: "Agent",
        to: "Dest111111111111111111111111111111111111111",
        amount: "1000000",
        amountDisplay: "0.001",
        assetSymbol: "SOL",
      },
      requestedBy: "main",
    });

    const task = findTaskRecord(request.taskLedgerId ?? "");
    expect(task).toMatchObject({
      taskId: request.taskLedgerId,
      source: "wallet",
      runtime: "wallet",
      taskKind: "wallet_approval",
      sourceId: request.id,
      agentId: "main",
      status: "blocked",
      progressSummary: "Waiting for wallet approval.",
      metadata: expect.objectContaining({
        domain: "wallet",
        approvalId: request.id,
        walletId: "agent-wallet",
        amountDisplay: "0.001",
        token: "SOL",
        to: "Dest111111111111111111111111111111111111111",
      }),
    });
    expect(listTaskRecords({ source: "wallet" }).tasks).toHaveLength(1);
  });

  it("marks rejected requests and excludes them from pending filter", () => {
    const first = createWalletSendApprovalRequest({
      payload: {
        chain: "solana",
        to: "dest",
        amount: "99",
      },
      requestedBy: "owner",
    });

    const second = createWalletSendApprovalRequest({
      payload: {
        chain: "solana",
        to: "So11111111111111111111111111111111111111112",
        amount: "2",
      },
      requestedBy: "owner",
    });

    const rejected = rejectWalletSendRequest({
      requestId: first.id,
      actor: "control-ui",
      reason: "manual deny",
    });
    expect(rejected.ok).toBe(true);

    const pending = listWalletSendApprovalRequests({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(second.id);

    const all = listWalletSendApprovalRequests({ status: "all" });
    const rejectedEntry = all.find((entry) => entry.id === first.id);
    expect(rejectedEntry?.status).toBe("rejected");
    expect(rejectedEntry?.reason).toBe("manual deny");
    const task = findTaskRecord(first.taskLedgerId ?? "");
    expect(task).toMatchObject({
      status: "cancelled",
      terminalSummary: "manual deny",
      metadata: expect.objectContaining({
        approvalStatus: "rejected",
        rejectedBy: "control-ui",
      }),
    });
  });

  it("preserves settlement linkage in audit for rejected manual approvals", () => {
    const request = createWalletSendApprovalRequest({
      payload: {
        chain: "solana",
        to: "So11111111111111111111111111111111111111112",
        amount: "3",
      },
      requestedBy: "owner",
      settlementContext: {
        taskId: "task-abc",
        invoiceId: "inv-abc",
        senderHandle: "@sender@ff1.fased.app",
      },
    });

    const rejected = rejectWalletSendRequest({
      requestId: request.id,
      actor: "control-ui",
      reason: "reject for test",
    });
    expect(rejected.ok).toBe(true);

    const entries = readWalletAuditEntries({ limit: 20 });
    const rejectedAudit = entries.find((entry) => entry.action === "send_rejected");
    expect(rejectedAudit?.details?.requestId).toBe(request.id);
    expect(rejectedAudit?.details?.taskId).toBe("task-abc");
    expect(rejectedAudit?.details?.invoiceId).toBe("inv-abc");
  });

  it("persists canonical token-routing fields in wallet settlement links", () => {
    const request = createWalletSendApprovalRequest({
      payload: {
        chain: "solana",
        to: "ExamplePayeeAddress",
        amount: "5000000",
        amountDisplay: "5",
        assetSymbol: "USDC",
        assetName: "USD Coin",
        assetDecimals: 6,
        program: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // pragma: allowlist secret -- public USDC mint
      },
      requestedBy: "owner",
      settlementContext: {
        taskId: "task-spl",
        invoiceId: "inv-spl",
        senderHandle: "@sender@ff1.fased.app",
      },
    });

    const links = listWalletSettlementLinks({ taskId: "task-spl", limit: 10 });
    expect(links[0]?.requestId).toBe(request.id);
    expect(links[0]?.program).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // pragma: allowlist secret -- public USDC mint
    expect(links[0]?.contract).toBeUndefined();
    const entries = readWalletAuditEntries({ limit: 10 });
    const requestAudit = entries.find((entry) => entry.details?.requestId === request.id);
    expect(requestAudit?.details).toMatchObject({
      amountDisplay: "5",
      assetSymbol: "USDC",
      assetName: "USD Coin",
      assetDecimals: 6,
      program: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // pragma: allowlist secret -- public USDC mint
    });
  });

  it("blocks manual send creation when provider-chain operation is unsupported", async () => {
    registerTestWallet({ id: "wallet-agent", role: "agent", providerId: "alchemy" });
    const cfg = {
      wallet: {
        provider: { id: "alchemy" },
        runtime: {
          enabled: true,
          mode: "external",
          runtime: "external-custom",
          service: { host: "127.0.0.1", port: 19444 },
          policy: { directSigning: true },
        },
      },
    } as const;
    const walletCfg = resolveWalletRuntimeConfigForTest(cfg);

    const result = await createOrExecuteWalletSend({
      payload: {
        chain: "solana",
        walletId: "wallet-agent",
        providerId: "alchemy",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      },
      requestedBy: "owner",
      sendPath: "reviewed",
      config: walletCfg,
      runtimeConfig: cfg as unknown as Record<string, unknown>,
    });

    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("wallet_provider_unsupported_chain");
    expect(result.message).toContain("alchemy");
  });

  it("blocks approval execution when provider-chain operation is unsupported", async () => {
    registerTestWallet({ id: "wallet-agent", role: "agent", providerId: "alchemy" });
    const cfg = {
      wallet: {
        provider: { id: "alchemy" },
        runtime: {
          enabled: true,
          mode: "external",
          runtime: "external-custom",
          service: { host: "127.0.0.1", port: 19444 },
          policy: { directSigning: true },
        },
      },
    } as const;
    const walletCfg = resolveWalletRuntimeConfigForTest(cfg);

    const request = createWalletSendApprovalRequest({
      payload: {
        chain: "solana",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
        walletId: "wallet-agent",
        providerId: "alchemy",
      },
      requestedBy: "owner",
    });

    const approved = await approveWalletSendRequest({
      requestId: request.id,
      actor: "control-ui",
      config: walletCfg,
      providerIdOverride: "alchemy",
    });

    expect(approved.ok).toBe(false);
    if (approved.ok) {
      return;
    }
    expect(approved.code).toBe("wallet_provider_unsupported_chain");
    expect(approved.message).toContain("alchemy");
  });

  it("allows reviewed/operator sends even when automated execution is disabled", async () => {
    const cfg = {
      wallet: {
        provider: { id: "local-socket-signer" },
        execution: { mode: "autonomous" },
        runtime: {
          enabled: true,
          mode: "external",
          runtime: "external-custom",
          chains: ["solana"],
          solana: { enabled: true },
          service: { host: "127.0.0.1", port: 19444 },
          policy: { directSigning: false },
        },
      },
    } as const;
    const walletCfg = resolveWalletRuntimeConfigForTest(cfg);
    const reviewIssuedAt = new Date().toISOString();
    const reviewExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const signerPublicKey = "Signer111111111111111111111111111111111";
    const systemProgram = "11111111111111111111111111111111";
    const prepareTypedTransferReview = vi.fn(
      async (request: {
        walletId: string;
        requestId: string;
        destination: string;
        amount: string;
      }) => ({
        requestId: request.requestId,
        walletId: request.walletId,
        intentType: "solana.nativeTransfer" as const,
        intentDigest: `sha256:${"a".repeat(64)}`,
        policyHash: `sha256:${"b".repeat(64)}`,
        mode: "reviewed" as const,
        nonce: "c".repeat(64),
        semanticIntent: {
          type: "solana.nativeTransfer" as const,
          destination: request.destination,
          lamports: request.amount,
        },
        walletPublicKey: signerPublicKey,
        artifactKind: "solana-transaction" as const,
        artifactDigest: `sha256:${"d".repeat(64)}`,
        transaction: {
          serializedTxBase64: "AA==",
          programs: [systemProgram],
          writableAccounts: [request.destination],
          submission: "rpc" as const,
        },
        asset: "solana:native",
        amount: request.amount,
        destination: request.destination,
        policyOperation: "solana.nativeTransfer",
        requiredPrograms: [systemProgram],
        requiredRole: "vault" as const,
        issuedAt: reviewIssuedAt,
        state: "prepared" as const,
        preparedAt: reviewIssuedAt,
        expiresAt: reviewExpiresAt,
        updatedAt: reviewIssuedAt,
        transactionDigest: `sha256:${"d".repeat(64)}`,
      }),
    );
    const getSignerReview = vi.fn(
      async (request: { walletId: string; requestId: string }) =>
        await prepareTypedTransferReview({
          walletId: request.walletId,
          requestId: request.requestId,
          destination: "So11111111111111111111111111111111111111112",
          amount: "1",
        }),
    );
    const executeSignerReview = vi.fn(
      async (request: {
        requestId: string;
        authorization?: { type: "webauthn" | "control-ui"; proof: { proofId: string } };
      }) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          review: {
            ...(await prepareTypedTransferReview({
              walletId: "wallet-agent",
              requestId: request.requestId,
              destination: "So11111111111111111111111111111111111111112",
              amount: "1",
            })),
            state: "signed" as const,
            signature: "0xmanual",
          },
          signer: signerPublicKey,
          operation: {
            requestId: request.requestId,
            walletId: "wallet-agent",
            intentType: "solana.nativeTransfer",
            intentDigest: `sha256:${"a".repeat(64)}`,
            transactionDigest: `sha256:${"e".repeat(64)}`,
            policyHash: `sha256:${"b".repeat(64)}`,
            asset: "solana:native",
            amount: "1",
            state: "confirmed" as const,
            reservationActive: false,
            usageBucket: "2026-07-16:solana:native",
            reservedAt: "2026-07-16T12:00:00.000Z",
            confirmedAt: "2026-07-16T12:00:01.000Z",
            updatedAt: "2026-07-16T12:00:01.000Z",
            signature: "0xmanual",
            authorizationProof: request.authorization?.proof.proofId,
          },
        };
      },
    );
    const sendTx = vi.fn();
    const providerSpy = vi
      .spyOn(walletProviderResolver, "createWalletProviderAdapter")
      .mockReturnValue({
        id: "local-socket-signer",
        displayName: "Local Socket Signer",
        capabilities: {
          custodyModel: "self-hosted",
          supportsCreateWallet: false,
          supportsPrepare: false,
          supportsSend: true,
          supportsRotateKeys: false,
          supportsResetKeys: false,
          supportsPasskeyGate: false,
          supportedExecutionModes: ["manual", "autonomous"],
          supportedChains: ["solana"],
        },
        supportsChain: () => true,
        health: async () => ({
          ok: true,
          provider: "local-socket-signer",
          configured: true,
          checkedAt: new Date().toISOString(),
        }),
        getAddresses: async () => ({ solana: "So11111111111111111111111111111111111111112" }),
        getBalance: async () => ({
          ok: true,
          chain: "solana",
          address: "So11111111111111111111111111111111111111112",
          balance: "1",
          unit: "lamports",
        }),
        sendTx,
        prepareTypedTransferReview,
        getSignerReview,
        executeSignerReview,
      } as ReturnType<typeof walletProviderResolver.createWalletProviderAdapter>);

    const result = await createOrExecuteWalletSend({
      payload: {
        chain: "solana",
        walletId: "wallet-agent",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      },
      requestedBy: "control-ui",
      executionIntentId: "test:reviewed-native-recovery:1",
      sendPath: "reviewed",
      config: walletCfg,
      runtimeConfig: cfg as unknown as FasedAgentConfig,
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) {
      providerSpy.mockRestore();
      return;
    }
    expect(result.mode).toBe("manual");
    if (result.mode !== "manual") {
      providerSpy.mockRestore();
      throw new Error("Expected reviewed send to create a manual approval request");
    }

    const executionLedgerPath = path.join(
      resolveWalletStatePaths(process.env).rootDir,
      "wallet-send-executions.json",
    );
    const executionLedger = JSON.parse(await fs.readFile(executionLedgerPath, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    executionLedger.entries[0] = {
      ...executionLedger.entries[0],
      state: "reserved",
      approvalRequestId: undefined,
    };
    await fs.writeFile(
      executionLedgerPath,
      `${JSON.stringify(executionLedger, null, 2)}\n`,
      "utf8",
    );
    const recovered = await createOrExecuteWalletSend({
      payload: {
        chain: "solana",
        walletId: "wallet-agent",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      },
      requestedBy: "control-ui",
      executionIntentId: "test:reviewed-native-recovery:1",
      sendPath: "reviewed",
      config: walletCfg,
      runtimeConfig: cfg as unknown as FasedAgentConfig,
    });
    expect(recovered.ok && recovered.mode === "manual" && recovered.request.id).toBe(
      result.request.id,
    );

    const executeApproval = async () =>
      await approveWalletSendRequest({
        requestId: result.request.id,
        actor: "control-ui",
        config: walletCfg,
        providerIdOverride: "local-socket-signer",
      });
    const concurrentResults = await Promise.all([executeApproval(), executeApproval()]);
    const approved = concurrentResults.find((entry) => entry.ok);
    const duplicate = concurrentResults.find((entry) => !entry.ok);
    providerSpy.mockRestore();

    expect(approved?.ok).toBe(true);
    if (approved?.ok) {
      expect(approved.tx.txHash).toBe("0xmanual");
    }
    expect(duplicate?.ok).toBe(false);
    if (duplicate && !duplicate.ok) {
      expect(duplicate.code).toBe("execution_in_progress_or_unknown");
    }
    expect(prepareTypedTransferReview).toHaveBeenCalledWith({
      walletId: "wallet-agent",
      requestId: result.request.id,
      destination: "So11111111111111111111111111111111111111112",
      amount: "1",
    });
    expect(executeSignerReview).toHaveBeenCalledWith({
      walletId: "wallet-agent",
      requestId: result.request.id,
      authorization: { type: "control-ui", proof: { proofId: "c".repeat(64) } },
    });
    expect(executeSignerReview).toHaveBeenCalledTimes(1);
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("allows reviewed operator SOL sends from the mining wallet but blocks generic automation", async () => {
    const cfg = {
      wallet: {
        provider: { id: "local-socket-signer" },
        execution: { mode: "manual" },
        runtime: {
          enabled: true,
          mode: "external",
          runtime: "external-custom",
          service: { host: "127.0.0.1", port: 19444 },
          policy: { directSigning: true },
        },
      },
      plugins: {
        entries: {
          "sat-mining": {
            config: {
              walletId: "wallet-mining",
            },
          },
        },
      },
    } as const;
    const walletCfg = resolveWalletRuntimeConfigForTest(cfg);
    const miningReviewIssuedAt = new Date().toISOString();
    const miningReviewExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const providerSpy = vi
      .spyOn(walletProviderResolver, "createWalletProviderAdapter")
      .mockReturnValue({
        id: "local-socket-signer",
        displayName: "Local Socket Signer",
        capabilities: {
          custodyModel: "self-hosted",
          supportsCreateWallet: false,
          supportsPrepare: false,
          supportsSend: true,
          supportsRotateKeys: false,
          supportsResetKeys: false,
          supportsPasskeyGate: false,
          supportedExecutionModes: ["manual", "autonomous"],
          supportedChains: ["solana"],
        },
        supportsChain: () => true,
        health: async () => ({
          ok: true,
          provider: "local-socket-signer",
          configured: true,
          checkedAt: new Date().toISOString(),
        }),
        getAddresses: async () => ({ solana: "miner-address" }),
        getBalance: async () => ({
          ok: true,
          chain: "solana",
          address: "miner-address",
          balance: "1",
          unit: "lamports",
        }),
        sendTx: vi.fn(),
        prepareTypedTransferReview: async (request) => ({
          requestId: request.requestId,
          walletId: request.walletId,
          intentType: "solana.nativeTransfer",
          intentDigest: `sha256:${"a".repeat(64)}`,
          policyHash: `sha256:${"b".repeat(64)}`,
          mode: "reviewed",
          nonce: "c".repeat(64),
          semanticIntent: {
            type: "solana.nativeTransfer",
            destination: request.destination,
            lamports: request.amount,
          },
          walletPublicKey: "Miner11111111111111111111111111111111111",
          artifactKind: "solana-transaction",
          artifactDigest: `sha256:${"d".repeat(64)}`,
          transaction: {
            serializedTxBase64: "AA==",
            programs: ["11111111111111111111111111111111"],
            writableAccounts: [request.destination],
            submission: "rpc",
          },
          asset: "solana:native",
          amount: request.amount,
          destination: request.destination,
          policyOperation: "solana.nativeTransfer",
          requiredPrograms: ["11111111111111111111111111111111"],
          requiredRole: "mining",
          issuedAt: miningReviewIssuedAt,
          state: "prepared",
          preparedAt: miningReviewIssuedAt,
          expiresAt: miningReviewExpiresAt,
          updatedAt: miningReviewIssuedAt,
          transactionDigest: `sha256:${"d".repeat(64)}`,
        }),
      } as ReturnType<typeof walletProviderResolver.createWalletProviderAdapter>);

    const reviewed = await createOrExecuteWalletSend({
      payload: {
        chain: "solana",
        walletId: "wallet-mining",
        providerId: "local-socket-signer",
        to: "So11111111111111111111111111111111111111112",
        amount: "1000000000",
      },
      requestedBy: "control-ui",
      sendPath: "reviewed",
      config: walletCfg,
      runtimeConfig: cfg as unknown as FasedAgentConfig,
    });

    expect(reviewed.ok).toBe(true);
    expect(reviewed.ok && reviewed.mode).toBe("manual");

    const automation = await createOrExecuteWalletSend({
      payload: {
        chain: "solana",
        walletId: "wallet-mining",
        providerId: "local-socket-signer",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      },
      requestedBy: "agent",
      executionIntentId: "test:mining-generic-native:1",
      sendPath: "automation",
      config: walletCfg,
      runtimeConfig: cfg as unknown as FasedAgentConfig,
    });
    providerSpy.mockRestore();

    expect(automation.ok).toBe(false);
    if (!automation.ok) {
      expect(automation.code).toBe("wallet_role_not_allowed");
    }
  });

  it("allows SAT mining auto-sweep without a generic token cap but rejects generic mining-wallet SPL automation", async () => {
    vi.stubEnv("FASED_SAT_PROGRAM_ID", "SatProgram1111111111111111111111111111111111");
    vi.stubEnv("FASED_SAT_BOND_PROGRAM_ID", "SatBond1111111111111111111111111111111111111");
    vi.stubEnv("FASED_SAT_MINT_ADDRESS", "SatMint1111111111111111111111111111111111111");
    vi.stubEnv("FASED_SAT_MINT_PROGRAM_ID", "SatMintProgram111111111111111111111111111111");
    const cfg = {
      wallet: {
        provider: { id: "local-socket-signer" },
        execution: { mode: "manual" },
        runtime: {
          enabled: true,
          mode: "external",
          runtime: "external-custom",
          service: { host: "127.0.0.1", port: 19444 },
          policy: { directSigning: true },
        },
      },
      plugins: {
        entries: {
          "sat-mining": {
            config: {
              walletId: "wallet-mining",
              automation: {
                satSweep: {
                  enabled: true,
                  destinationAddress: "Vault11111111111111111111111111111111111111",
                  mode: "all",
                  keepRaw: "0",
                  minRaw: "1",
                  percentage: 100,
                },
              },
            },
          },
        },
      },
    } as const;
    const walletCfg = resolveWalletRuntimeConfigForTest(cfg);
    const registry = readWalletProviderRegistry(process.env);
    registry.wallets = [
      {
        id: "wallet-mining",
        name: "Mining",
        providerId: "local-socket-signer",
        addresses: { solana: "Miner11111111111111111111111111111111111111" },
        metadata: { role: "mining" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    registry.defaultWalletId = "wallet-mining";
    writeWalletProviderRegistry(registry, process.env);
    const sendTx = vi.fn(async () => ({
      ok: true,
      chain: "solana" as const,
      txHash: "sat-sweep-tx",
      signer: "miner-address",
    }));
    const providerSpy = vi
      .spyOn(walletProviderResolver, "createWalletProviderAdapter")
      .mockReturnValue({
        id: "local-socket-signer",
        displayName: "Local Socket Signer",
        capabilities: {
          custodyModel: "self-hosted",
          supportsCreateWallet: false,
          supportsPrepare: false,
          supportsSend: true,
          supportsRotateKeys: false,
          supportsResetKeys: false,
          supportsPasskeyGate: false,
          supportedExecutionModes: ["manual", "autonomous"],
          supportedChains: ["solana"],
        },
        supportsChain: () => true,
        health: async () => ({
          ok: true,
          provider: "local-socket-signer",
          configured: true,
          checkedAt: new Date().toISOString(),
        }),
        getAddresses: async () => ({ solana: "miner-address" }),
        getBalance: async () => ({
          ok: true,
          chain: "solana",
          address: "miner-address",
          balance: "1",
          unit: "lamports",
        }),
        sendTx,
      } as ReturnType<typeof walletProviderResolver.createWalletProviderAdapter>);

    const sweep = await createOrExecuteWalletSend({
      payload: {
        chain: "solana",
        walletId: "wallet-mining",
        providerId: "local-socket-signer",
        to: "Vault11111111111111111111111111111111111111",
        amount: "250",
        program: "SatMint1111111111111111111111111111111111111",
      },
      requestedBy: "sat-mining:auto-sweep",
      executionIntentId: "sat-auto-sweep:wallet-mining:claim-cycle-1",
      satSweepAuthorization: {
        kind: "sat-auto-sweep-v1",
        occurrenceId: "claim-cycle-1",
        walletId: "wallet-mining",
        destination: "Vault11111111111111111111111111111111111111",
        mint: "SatMint1111111111111111111111111111111111111",
        sourceBalanceRaw: "250",
        amountRaw: "250",
        keepRaw: "0",
        minRaw: "1",
        mode: "all",
        percentage: 100,
      },
      sendPath: "automation",
      config: walletCfg,
      runtimeConfig: cfg as unknown as FasedAgentConfig,
    });

    expect(sweep.ok).toBe(true);
    expect(sendTx).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: "solana",
        walletId: "wallet-mining",
        program: "SatMint1111111111111111111111111111111111111",
      }),
    );

    const generic = await createOrExecuteWalletSend({
      payload: {
        chain: "solana",
        walletId: "wallet-mining",
        providerId: "local-socket-signer",
        to: "Vault11111111111111111111111111111111111111",
        amount: "250",
        program: "SatMint1111111111111111111111111111111111111",
      },
      requestedBy: "agent",
      executionIntentId: "test:mining-generic-spl:1",
      sendPath: "automation",
      config: walletCfg,
      runtimeConfig: cfg as unknown as FasedAgentConfig,
    });
    providerSpy.mockRestore();

    expect(generic.ok).toBe(false);
    if (!generic.ok) {
      expect(generic.code).toBe("wallet_role_not_allowed");
    }
  });

  it("ignores removed custody flags and sends autonomous transfers only through the typed provider API", async () => {
    vi.stubEnv("FASED_WALLET_CUSTODY_MODE", "split-key");
    registerTestWallet({ id: "wallet-agent", role: "agent" });

    const cfg = {
      wallet: {
        provider: { id: "local-socket-signer" },
        execution: { mode: "autonomous" },
        runtime: {
          enabled: true,
          mode: "external",
          runtime: "external-docker",
          chains: ["solana"],
          solana: { enabled: true },
          service: { host: "127.0.0.1", port: 19444 },
          policy: { directSigning: true },
        },
      },
    } as const;
    const walletCfg = resolveWalletRuntimeConfigForTest(cfg);
    const sendTx = vi.fn(async () => ({
      ok: true as const,
      chain: "solana" as const,
      txHash: "0xsent",
      signer: "So11111111111111111111111111111111111111112",
    }));
    const providerSpy = vi
      .spyOn(walletProviderResolver, "createWalletProviderAdapter")
      .mockReturnValue({
        id: "local-socket-signer",
        displayName: "Local Socket Signer",
        capabilities: {
          custodyModel: "self-hosted",
          supportsCreateWallet: false,
          supportsPrepare: false,
          supportsSend: true,
          supportsRotateKeys: false,
          supportsResetKeys: false,
          supportsPasskeyGate: false,
          supportedExecutionModes: ["manual", "autonomous"],
          supportedChains: ["solana"],
        },
        supportsChain: () => true,
        health: async () => ({
          ok: true,
          provider: "local-socket-signer",
          configured: true,
          checkedAt: new Date().toISOString(),
        }),
        getAddresses: async () => ({ solana: "So11111111111111111111111111111111111111112" }),
        getBalance: async () => ({
          ok: true,
          chain: "solana",
          address: "So11111111111111111111111111111111111111112",
          balance: "1",
          unit: "lamports",
        }),
        sendTx,
      } as ReturnType<typeof walletProviderResolver.createWalletProviderAdapter>);

    const result = await createOrExecuteWalletSend({
      payload: {
        chain: "solana",
        walletId: "wallet-agent",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      },
      requestedBy: "owner",
      executionIntentId: "test:autonomous-native-success:1",
      config: walletCfg,
      runtimeConfig: cfg as unknown as Record<string, unknown>,
    });
    providerSpy.mockRestore();

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(sendTx).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: "solana",
        to: "So11111111111111111111111111111111111111112",
      }),
    );
  });

  it("redacts secret-bearing provider errors from autonomous send results and audit", async () => {
    registerTestWallet({ id: "wallet-agent", role: "agent" });
    const cfg = {
      wallet: {
        provider: { id: "local-socket-signer" },
        execution: { mode: "autonomous" },
        runtime: {
          enabled: true,
          mode: "external",
          runtime: "external-custom",
          chains: ["solana"],
          solana: { enabled: true },
          service: { host: "127.0.0.1", port: 19444 },
          policy: { directSigning: true },
        },
      },
    } as const;
    const walletCfg = resolveWalletRuntimeConfigForTest(cfg);
    const sendTx = vi.fn(async () => {
      throw new Error("rpc failed at https://rpc.example.com/?api_key=super-secret-rpc-key&ok=1");
    });
    const getSignerOperation = vi.fn(async () => {
      throw new Error("signer operation not found");
    });
    const providerSpy = vi
      .spyOn(walletProviderResolver, "createWalletProviderAdapter")
      .mockReturnValue({
        id: "local-socket-signer",
        displayName: "Local Socket Signer",
        capabilities: {
          custodyModel: "self-hosted",
          supportsCreateWallet: false,
          supportsPrepare: false,
          supportsSend: true,
          supportsRotateKeys: false,
          supportsResetKeys: false,
          supportsPasskeyGate: false,
          supportedExecutionModes: ["manual", "autonomous"],
          supportedChains: ["solana"],
        },
        supportsChain: () => true,
        health: async () => ({
          ok: true,
          provider: "local-socket-signer",
          configured: true,
          checkedAt: new Date().toISOString(),
        }),
        getAddresses: async () => ({ solana: "So11111111111111111111111111111111111111112" }),
        getBalance: async () => ({
          ok: true,
          chain: "solana",
          address: "So11111111111111111111111111111111111111112",
          balance: "1",
          unit: "lamports",
        }),
        getSignerOperation,
        sendTx,
      } as ReturnType<typeof walletProviderResolver.createWalletProviderAdapter>);

    const result = await createOrExecuteWalletSend({
      payload: {
        chain: "solana",
        walletId: "wallet-agent",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      },
      requestedBy: "owner",
      executionIntentId: "test:autonomous-native-redaction:1",
      config: walletCfg,
      runtimeConfig: cfg as unknown as FasedAgentConfig,
    });
    providerSpy.mockRestore();

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(sendTx, JSON.stringify(result)).toHaveBeenCalledTimes(1);
    expect(result.requestId).toEqual(expect.any(String));
    expect(sendTx).toHaveBeenCalledWith(expect.objectContaining({ requestId: result.requestId }));
    expect(result.message).toContain("api_key=***");
    expect(result.message).not.toContain("super-secret-rpc-key");
    const failedAudit = readWalletAuditEntries({ limit: 20 }).find(
      (entry) => entry.action === "send_failed",
    );
    expect(String(failedAudit?.details?.reason)).toContain("api_key=***");
    expect(String(failedAudit?.details?.reason)).not.toContain("super-secret-rpc-key");
  });

  it("records failed autonomous settlement link metadata for automation even when legacy execution mode is manual", async () => {
    registerTestWallet({ id: "wallet-agent", role: "agent", providerId: "alchemy" });
    const cfg = {
      wallet: {
        provider: { id: "alchemy" },
        execution: { mode: "manual" },
        runtime: {
          enabled: true,
          mode: "external",
          runtime: "external-custom",
          service: { host: "127.0.0.1", port: 19444 },
          policy: { directSigning: true },
        },
      },
    } as const;
    const walletCfg = resolveWalletRuntimeConfigForTest(cfg);

    const result = await createOrExecuteWalletSend({
      payload: {
        chain: "solana",
        walletId: "wallet-agent",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      },
      requestedBy: "owner",
      executionIntentId: "test:autonomous-unsupported:1",
      sendPath: "automation",
      config: walletCfg,
      runtimeConfig: cfg as unknown as FasedAgentConfig,
      settlementContext: {
        taskId: "task-autonomous-fail",
        invoiceId: "inv-autonomous-fail",
        senderHandle: "@sender@ff1.fased.app",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("wallet_provider_unsupported_chain");
    expect(typeof result.requestId).toBe("string");
    const links = listWalletSettlementLinks({
      env: process.env,
      taskId: "task-autonomous-fail",
      limit: 10,
    });
    expect(links.length).toBeGreaterThan(0);
    const latest = links[0];
    expect(latest?.status).toBe("failed");
    expect(latest?.providerId).toBe("alchemy");
    expect(latest?.chain).toBe("solana");
    expect(latest?.invoiceId).toBe("inv-autonomous-fail");
  });
});
