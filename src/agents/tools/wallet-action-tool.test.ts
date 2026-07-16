import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../../config/config.js";
import { SOLANA_NATIVE_MINT } from "../../wallet/solana-swap.js";
import { resolveWalletRecurringTransferPolicy } from "../../wallet/wallet-policy.js";
import type {
  WalletProviderJupiterIntentV2,
  WalletProviderSignerTransactionEnvelopeV2,
} from "../../wallet/wallet-provider-adapter.js";
import { setDefaultWallet, upsertNamedWallet } from "../../wallet/wallet-provider-registry.js";
import { listWalletSendApprovalRequests } from "../../wallet/wallet-send-approvals.js";
import { createWalletActionTool } from "./wallet-action-tool.js";

const mocks = vi.hoisted(() => ({
  provider: {
    getAddresses: vi.fn(),
    signTx: vi.fn(),
    sendTx: vi.fn(),
    prepareJupiterReview: vi.fn(),
    executeJupiterReview: vi.fn(),
  },
  createWalletProviderAdapter: vi.fn(),
}));

vi.mock("../../wallet/wallet-provider-resolver.js", () => ({
  createWalletProviderAdapter: mocks.createWalletProviderAdapter,
  resolveScopedRpcUrlForWallet: () => process.env.FASED_WALLET_SOLANA_RPC_URL,
}));

const USDC_MINT = "EPjFWdd5AufqSSqeM2qJ3aZ1d1zN7T7Z6viNwY7u1D8";
const TOKEN_A_MINT = Keypair.generate().publicKey.toBase58();
const ROUTE_PROGRAM_ID = Keypair.generate().publicKey.toBase58();
const AGENT_PUBLIC_KEY = Keypair.generate().publicKey;
const AGENT_ADDRESS = AGENT_PUBLIC_KEY.toBase58();
const TRIGGER_VAULT_PUBLIC_KEY = Keypair.generate().publicKey;
const TRIGGER_VAULT_ADDRESS = TRIGGER_VAULT_PUBLIC_KEY.toBase58();
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const preparedSignerReviews = new Map<
  string,
  {
    walletId: string;
    mode: "autonomous" | "reviewed";
    intent: WalletProviderJupiterIntentV2;
    transaction: WalletProviderSignerTransactionEnvelopeV2;
  }
>();

function serializedTestSwapTx(routeProgramId?: string): string {
  const message = new TransactionMessage({
    payerKey: AGENT_PUBLIC_KEY,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [
      SystemProgram.transfer({
        fromPubkey: AGENT_PUBLIC_KEY,
        toPubkey: AGENT_PUBLIC_KEY,
        lamports: 0,
      }),
      ...(routeProgramId
        ? [
            new TransactionInstruction({
              keys: [],
              programId: new PublicKey(routeProgramId),
              data: Buffer.alloc(0),
            }),
          ]
        : []),
    ],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

function serializedTriggerAuthTx(): string {
  const message = new TransactionMessage({
    payerKey: AGENT_PUBLIC_KEY,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [
      new TransactionInstruction({
        keys: [{ pubkey: AGENT_PUBLIC_KEY, isSigner: true, isWritable: false }],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(
          "Sign this message to authenticate with Jupiter Trigger Order API: test",
          "utf8",
        ),
      }),
    ],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

function serializedTriggerDepositTx(amount: string): string {
  const message = new TransactionMessage({
    payerKey: AGENT_PUBLIC_KEY,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [
      SystemProgram.transfer({
        fromPubkey: AGENT_PUBLIC_KEY,
        toPubkey: TRIGGER_VAULT_PUBLIC_KEY,
        lamports: BigInt(amount),
      }),
    ],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

function serializedTriggerCancelTx(amount: string): string {
  const message = new TransactionMessage({
    payerKey: AGENT_PUBLIC_KEY,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [
      SystemProgram.transfer({
        fromPubkey: TRIGGER_VAULT_PUBLIC_KEY,
        toPubkey: AGENT_PUBLIC_KEY,
        lamports: BigInt(amount),
      }),
    ],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

function walletActionConfig(extra?: Partial<FasedAgentConfig>): FasedAgentConfig {
  return {
    agents: {
      list: [{ id: "owner", default: true }],
    },
    wallet: {
      runtime: {
        enabled: true,
        mode: "managed",
        chains: ["solana"],
        policy: {
          directSigning: true,
          skillsEnabled: true,
          solana: {
            allowPrograms: [SystemProgram.programId.toBase58()],
          },
        },
        toolAccess: {
          mode: "owner-only",
        },
      },
    },
    ...extra,
  } as FasedAgentConfig;
}

function setupWallets(params?: { defaultWalletId?: string }) {
  upsertNamedWallet({
    walletId: "agent",
    name: "Agent",
    providerId: "local-socket-signer",
    metadata: { purpose: "agent", role: "agent" },
    env: process.env,
  });
  upsertNamedWallet({
    walletId: "vault",
    name: "Vault",
    providerId: "local-socket-signer",
    metadata: { purpose: "vault", role: "vault" },
    env: process.env,
  });
  upsertNamedWallet({
    walletId: "mining",
    name: "Mining",
    providerId: "local-socket-signer",
    metadata: { purpose: "mining", role: "mining" },
    env: process.env,
  });
  setDefaultWallet({ walletId: params?.defaultWalletId ?? "agent", env: process.env });
}

async function writeClawHubSkillOrigin(params: {
  workspaceDir: string;
  slug: string;
  registry: string;
}) {
  const originDir = path.join(params.workspaceDir, "skills", params.slug, ".clawhub");
  await fs.mkdir(originDir, { recursive: true });
  await fs.writeFile(
    path.join(originDir, "origin.json"),
    `${JSON.stringify(
      {
        version: 1,
        registry: params.registry,
        slug: params.slug,
        installedVersion: "1.0.0",
        installedAt: Date.now(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function stubJupiterOrder(opts?: { routeProgramId?: string }) {
  vi.stubEnv("FASED_WALLET_SOLANA_RPC_URL", "https://rpc.example.test");
  vi.stubEnv("FASED_JUPITER_API_KEY", "test-jupiter-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const url = String(input);
      if (init && String(init.method ?? "GET").toUpperCase() === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as {
          method?: string;
          params?: unknown[];
        };
        if (body.method === "getBalance") {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ result: { value: 1_000_000_000 } }),
          };
        }
        if (body.method === "getAccountInfo") {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              result: {
                value: {
                  owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                  data: { parsed: { info: { decimals: 6, extensions: [] } } },
                },
              },
            }),
          };
        }
        if (body.method === "getTokenAccountsByOwner") {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              result: {
                value: [
                  {
                    pubkey: Keypair.generate().publicKey.toBase58(),
                    account: {
                      data: {
                        parsed: {
                          info: {
                            mint: TOKEN_A_MINT,
                            tokenAmount: { amount: "500000000", decimals: 6 },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            }),
          };
        }
        if (body.method === "getMultipleAccounts") {
          const keys = Array.isArray(body.params?.[0])
            ? body.params[0].filter((value): value is string => typeof value === "string")
            : [];
          const options =
            body.params?.[1] && typeof body.params[1] === "object" && !Array.isArray(body.params[1])
              ? (body.params[1] as Record<string, unknown>)
              : {};
          const jsonParsed = options.encoding === "jsonParsed";
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              result: {
                value: keys.map(() =>
                  jsonParsed
                    ? {
                        owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                        executable: false,
                        data: { parsed: { info: { decimals: 6, extensions: [] } } },
                      }
                    : {
                        owner: SystemProgram.programId.toBase58(),
                        executable: false,
                        data: ["", "base64"],
                      },
                ),
              },
            }),
          };
        }
      }
      if (url.includes("/ultra/v1/search")) {
        const query = new URL(url).searchParams.get("query") ?? "";
        const record =
          query === TOKEN_A_MINT || query.toLowerCase() === "tokena"
            ? {
                address: TOKEN_A_MINT,
                symbol: "TKNA",
                name: "Token A",
                decimals: 6,
                isVerified: true,
              }
            : {
                address: USDC_MINT,
                symbol: "USDC",
                name: "USD Coin",
                decimals: 6,
                isVerified: true,
              };
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [record],
        };
      }
      if (url.includes("/trigger/v2/auth/challenge")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            type: "transaction",
            transaction: serializedTriggerAuthTx(),
          }),
        };
      }
      if (url.includes("/trigger/v2/auth/verify")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ token: "trigger-jwt-1" }),
        };
      }
      if (url.includes("/trigger/v2/vault/register") || url.endsWith("/trigger/v2/vault")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            userPubkey: AGENT_ADDRESS,
            vaultPubkey: TRIGGER_VAULT_ADDRESS,
            privyVaultId: "vault-1",
          }),
        };
      }
      if (url.includes("/trigger/v2/deposit/craft")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { amount?: string };
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            transaction: serializedTriggerDepositTx(body.amount ?? "100000000"),
            requestId: "deposit-req-1",
            receiverAddress: TRIGGER_VAULT_ADDRESS,
            mint: SOLANA_NATIVE_MINT,
            amount: body.amount ?? "100000000",
            tokenDecimals: 9,
            inputTokenAccount: AGENT_ADDRESS,
          }),
        };
      }
      if (url.includes("/trigger/v2/orders/price/confirm-cancel/")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ id: "order-1", txSignature: "cancel-tx-1" }),
        };
      }
      if (url.includes("/trigger/v2/orders/price/cancel/")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            id: "order-1",
            transaction: serializedTriggerCancelTx("100000000"),
            requestId: "cancel-req-1",
          }),
        };
      }
      if (url.includes("/trigger/v2/orders/history")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            orders: [
              {
                id: "order-1",
                orderState: "open",
                userPubkey: AGENT_ADDRESS,
                privyWalletPubkey: TRIGGER_VAULT_ADDRESS,
                inputMint: SOLANA_NATIVE_MINT,
                remainingInputAmount: "100000000",
              },
            ],
            pagination: { total: 1, limit: 20, offset: 0 },
          }),
        };
      }
      if (url.includes("/trigger/v2/orders/price")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ id: "order-1", txSignature: "deposit-tx-1" }),
        };
      }
      const requestedAmount = new URL(url).searchParams.get("amount") ?? "100000000";
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          requestId: "jup-req-1",
          transaction: serializedTestSwapTx(opts?.routeProgramId),
          inAmount: requestedAmount,
          outAmount: "25000000",
          otherAmountThreshold: "24750000",
          slippageBps: 50,
          priceImpactPct: "0.01",
          routePlan: [{ swapInfo: { label: "Jupiter" } }],
        }),
      };
    }),
  );
}

describe("wallet-action-tool", () => {
  beforeEach(() => {
    mocks.provider.getAddresses.mockResolvedValue({
      solana: AGENT_ADDRESS,
    });
    mocks.provider.signTx.mockResolvedValue({
      ok: true,
      chain: "solana",
      signedTxBase64: serializedTestSwapTx(),
      signer: AGENT_ADDRESS,
    });
    mocks.provider.sendTx.mockResolvedValue({
      txHash: "swap-tx-1",
      chain: "solana",
      status: "submitted",
    });
    mocks.provider.prepareJupiterReview.mockImplementation(
      async (request: {
        walletId: string;
        requestId: string;
        mode: "autonomous" | "reviewed";
        intent: WalletProviderJupiterIntentV2;
        transaction: WalletProviderSignerTransactionEnvelopeV2;
      }) => {
        preparedSignerReviews.set(request.requestId, request);
        return {
          requestId: request.requestId,
          walletId: request.walletId,
          intentType: request.intent.type,
          intentDigest: `sha256:${"a".repeat(64)}`,
          policyHash: `sha256:${"b".repeat(64)}`,
          mode: request.mode,
          nonce: "c".repeat(64),
          semanticIntent: request.intent,
          transaction: request.transaction,
          issuedAt: "2026-07-16T00:00:00.000Z",
          state: "prepared" as const,
          preparedAt: "2026-07-16T00:00:00.000Z",
          expiresAt: "2099-07-16T00:05:00.000Z",
          updatedAt: "2026-07-16T00:00:00.000Z",
          transactionDigest: `sha256:${"d".repeat(64)}`,
        };
      },
    );
    mocks.provider.executeJupiterReview.mockImplementation(
      async (request: { walletId: string; requestId: string }) => {
        const prepared = preparedSignerReviews.get(request.requestId);
        if (!prepared || prepared.walletId !== request.walletId) {
          throw new Error("missing exact prepared signer review");
        }
        const signature = prepared.transaction.submission === "rpc" ? "swap-tx-1" : "typed-tx-1";
        return {
          review: {
            requestId: request.requestId,
            walletId: request.walletId,
            intentType: prepared.intent.type,
            intentDigest: `sha256:${"a".repeat(64)}`,
            policyHash: `sha256:${"b".repeat(64)}`,
            mode: prepared.mode,
            nonce: "c".repeat(64),
            semanticIntent: prepared.intent,
            transaction: prepared.transaction,
            issuedAt: "2026-07-16T00:00:00.000Z",
            state: "signed" as const,
            preparedAt: "2026-07-16T00:00:00.000Z",
            expiresAt: "2099-07-16T00:05:00.000Z",
            updatedAt: "2026-07-16T00:00:01.000Z",
            transactionDigest: `sha256:${"d".repeat(64)}`,
            signature,
          },
          operation: {
            requestId: request.requestId,
            walletId: request.walletId,
            intentType: prepared.intent.type,
            intentDigest: `sha256:${"a".repeat(64)}`,
            transactionDigest: `sha256:${"d".repeat(64)}`,
            policyHash: `sha256:${"b".repeat(64)}`,
            asset: prepared.intent.jupiter.inputMint ?? SOLANA_NATIVE_MINT,
            amount: prepared.intent.jupiter.inputAmount ?? "0",
            state: prepared.transaction.submission === "rpc" ? "confirmed" : "broadcast",
            signature,
          },
          ...(prepared.transaction.submission === "returnSigned"
            ? { signedTxBase64: prepared.transaction.serializedTxBase64 }
            : {}),
          signer: AGENT_ADDRESS,
        };
      },
    );
    mocks.createWalletProviderAdapter.mockReturnValue(mocks.provider);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    mocks.provider.getAddresses.mockReset();
    mocks.provider.signTx.mockReset();
    mocks.provider.sendTx.mockReset();
    mocks.provider.prepareJupiterReview.mockReset();
    mocks.provider.executeJupiterReview.mockReset();
    preparedSignerReviews.clear();
    mocks.createWalletProviderAdapter.mockReset();
  });

  it("returns null when wallet runtime is disabled", () => {
    const tool = createWalletActionTool({
      config: {
        wallet: {
          runtime: {
            enabled: false,
          },
        },
      },
      agentSessionKey: "agent:owner:main",
    });
    expect(tool).toBeNull();
  });

  it("rejects Mining and Vault wallets for swap planning", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-action-roles-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupWallets();
      const cfg = walletActionConfig({
        plugins: {
          entries: {
            "sat-mining": {
              config: {
                walletId: "mining",
              },
            },
          },
        },
      });
      const tool = createWalletActionTool({
        config: cfg,
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet_action tool");
      }

      await expect(
        tool.execute("call-mining-plan", {
          action: "plan",
          walletHandle: "@wallet:mining",
          outputMint: USDC_MINT,
          amount: "100000000",
        }),
      ).rejects.toThrow("wallet_role_not_allowed");
      await expect(
        tool.execute("call-vault-plan", {
          action: "plan",
          walletHandle: "@wallet:vault",
          outputMint: USDC_MINT,
          amount: "100000000",
        }),
      ).rejects.toThrow("wallet_role_not_allowed");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("treats decimal quote amounts as human token units when amountFormat is omitted", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-action-decimal-quote-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    stubJupiterOrder();
    try {
      setupWallets();
      const tool = createWalletActionTool({
        config: walletActionConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet_action tool");
      }

      const result = await tool.execute("call-decimal-quote", {
        action: "quote",
        walletHandle: "@wallet:agent",
        outputMint: USDC_MINT,
        amount: "0.01",
      });

      expect(result.details).toEqual(
        expect.objectContaining({
          ok: true,
          plan: expect.objectContaining({
            amount: "10000000",
          }),
        }),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("creates disabled cron templates for scheduled wallet action plans", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-action-schedule-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupWallets();
      const tool = createWalletActionTool({
        config: walletActionConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet_action tool");
      }

      const result = await tool.execute("call-schedule-plan", {
        action: "schedule_plan",
        walletHandle: "@wallet:agent",
        outputMint: USDC_MINT,
        amount: "0.1",
        amountFormat: "human",
        schedule: { type: "daily", time: "09:00" },
        name: "Daily swap plan",
      });
      const details = result.details as Record<string, unknown>;
      const plan = details.plan as Record<string, unknown>;
      const cronJob = details.cronJob as Record<string, unknown>;
      expect(plan.walletHandle).toBe("@wallet:agent");
      expect(plan.amount).toBe("100000000");
      expect(cronJob.enabled).toBe(false);
      expect(cronJob.name).toBe("Daily swap plan");
      expect((cronJob.payload as Record<string, unknown>).kind).toBe("agentTurn");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("creates disabled cron templates for scheduled native SOL sends", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-send-schedule-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupWallets();
      const tool = createWalletActionTool({
        config: walletActionConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet_action tool");
      }

      const result = await tool.execute("call-schedule-send", {
        action: "schedule_send",
        walletHandle: "@wallet:agent",
        chain: "solana",
        to: "@wallet:vault",
        amount: "0.1",
        amountFormat: "human",
        schedule: { type: "daily", time: "10:00" },
        name: "Daily SOL transfer",
      });
      const details = result.details as Record<string, unknown>;
      const plan = details.plan as Record<string, unknown>;
      const cronJob = details.cronJob as Record<string, unknown>;
      const payload = cronJob.payload as Record<string, unknown>;
      expect(plan.kind).toBe("solana_transfer");
      expect(plan.walletHandle).toBe("@wallet:agent");
      expect(plan.to).toBe("@wallet:vault");
      expect(plan.amount).toBe("100000000");
      expect(cronJob.enabled).toBe(false);
      expect(payload.kind).toBe("agentTurn");
      expect(String(payload.message)).toContain("walletTransferSchedule");
      expect(String(payload.message)).toContain("amountFormat=base");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("saves scheduled send policy to the selected Agent wallet when requested", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-send-policy-save-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupWallets();
      const cfg = walletActionConfig();
      cfg.wallet = {
        ...cfg.wallet,
        runtime: {
          ...cfg.wallet?.runtime,
          chains: ["solana"],
          policy: {
            ...cfg.wallet?.runtime?.policy,
            directSigning: true,
          },
        },
      };
      const tool = createWalletActionTool({
        config: cfg,
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet_action tool");
      }

      const firstResult = await tool.execute("call-schedule-send-save-policy", {
        action: "schedule_send",
        walletHandle: "@wallet:agent",
        chain: "solana",
        to: "@wallet:vault",
        amountMode: "percentage",
        percentage: 40,
        minAmount: "1000000",
        keepAmount: "10000000",
        schedule: { kind: "cron", expr: "0 9 * * *" },
        name: "Agent sweep",
        savePolicy: true,
      });
      expect(firstResult.details).toMatchObject({
        savedPolicy: {
          walletId: "agent",
          role: "agent",
          status: "created",
          message: "Saved this recurring transfer policy to the Agent wallet.",
        },
      });

      const secondResult = await tool.execute("call-schedule-send-save-policy-again", {
        action: "schedule_send",
        walletHandle: "@wallet:agent",
        chain: "solana",
        to: "@wallet:vault",
        amountMode: "percentage",
        percentage: 40,
        minAmount: "1000000",
        keepAmount: "10000000",
        schedule: { kind: "cron", expr: "0 9 * * *" },
        name: "Agent sweep",
        savePolicy: true,
      });
      expect(secondResult.details).toMatchObject({
        savedPolicy: {
          walletId: "agent",
          role: "agent",
          status: "unchanged",
          message: "The Agent wallet already had this recurring transfer policy.",
        },
      });

      const policy = resolveWalletRecurringTransferPolicy({
        cfg,
        env: process.env,
        walletId: "agent",
      });
      expect(policy).toMatchObject({
        enabled: true,
        to: "@wallet:vault",
        amountMode: "percentage",
        percentage: 40,
        minAmount: "1000000",
        keepAmount: "10000000",
        name: "Agent sweep",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires a token cap before scheduling SPL token sends", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-send-spl-schedule-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    stubJupiterOrder();
    try {
      setupWallets();
      const tool = createWalletActionTool({
        config: walletActionConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet_action tool");
      }

      await expect(
        tool.execute("call-schedule-send-spl", {
          action: "schedule_send",
          walletHandle: "@wallet:agent",
          chain: "solana",
          to: "@wallet:vault",
          program: TOKEN_A_MINT,
          amount: "10",
          amountFormat: "human",
          schedule: { type: "daily", time: "10:00" },
          name: "Daily SPL transfer",
        }),
      ).rejects.toThrow("SPL token spend requires an explicit per-mint token cap");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("creates a manual approval request for swaps instead of signing immediately", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-action-manual-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    stubJupiterOrder();
    try {
      setupWallets();
      const tool = createWalletActionTool({
        config: walletActionConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet_action tool");
      }

      const result = await tool.execute("call-manual-swap", {
        action: "swap",
        mode: "manual",
        walletHandle: "@wallet:agent",
        outputMint: USDC_MINT,
        outputSymbol: "USDC",
        amount: "0.1",
        amountFormat: "human",
        slippageBps: 50,
      });
      const details = result.details as Record<string, unknown>;
      expect(details.approvalRequired).toBe(true);
      expect(details.code).toBe("wallet_swap_approval_required");
      expect(mocks.provider.sendTx).not.toHaveBeenCalled();
      expect(mocks.provider.prepareJupiterReview).toHaveBeenCalledTimes(1);
      expect(mocks.provider.executeJupiterReview).not.toHaveBeenCalled();

      const requests = listWalletSendApprovalRequests({
        env: process.env,
        status: "all",
        limit: 10,
      });
      expect(requests[0]?.payload.actionKind).toBe("solana_swap");
      expect(requests[0]?.payload.walletHandle).toBe("@wallet:agent");
      expect(requests[0]?.payload.outputMint).toBe(USDC_MINT);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("allows direct owner chat to execute autonomous swaps under Agent caps", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-action-auto-chat-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    stubJupiterOrder();
    try {
      setupWallets();
      const tool = createWalletActionTool({
        config: walletActionConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet_action tool");
      }

      const result = await tool.execute("call-auto-chat", {
        action: "swap",
        walletHandle: "@wallet:agent",
        outputMint: USDC_MINT,
        amount: "100000000",
      });
      const details = result.details as Record<string, unknown>;
      expect(details.ok).toBe(true);
      expect(details.executed).toBe(true);
      expect(mocks.provider.prepareJupiterReview).toHaveBeenCalledWith(
        expect.objectContaining({
          walletId: "agent",
          mode: "autonomous",
          transaction: expect.objectContaining({ submission: "rpc" }),
        }),
      );
      expect(mocks.provider.executeJupiterReview).toHaveBeenCalledWith({
        walletId: "agent",
        requestId: expect.any(String),
      });
      expect(mocks.provider.sendTx).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("creates autonomous Jupiter Trigger limit orders under Agent caps", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-action-limit-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    stubJupiterOrder();
    try {
      setupWallets();
      const tool = createWalletActionTool({
        config: walletActionConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet_action tool");
      }

      const result = await tool.execute("call-limit-order", {
        action: "limit_order",
        walletHandle: "@wallet:agent",
        outputMint: USDC_MINT,
        amount: "0.1",
        amountFormat: "human",
        triggerCondition: "below",
        triggerPriceUsd: 120,
        expirySeconds: 3600,
        slippageBps: 100,
      });
      const details = result.details as Record<string, unknown>;
      const order = details.order as Record<string, unknown>;
      expect(details.live).toBe(true);
      expect(order.id).toBe("order-1");
      expect(order.raw).toBeUndefined();
      expect((details.vault as Record<string, unknown>).privyVaultId).toBeUndefined();
      expect(mocks.provider.executeJupiterReview).toHaveBeenCalledTimes(2);
      expect(mocks.provider.prepareJupiterReview).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "autonomous",
          transaction: expect.objectContaining({ submission: "returnSigned" }),
        }),
      );
      expect(mocks.provider.signTx).not.toHaveBeenCalled();
      expect(mocks.provider.sendTx).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns a review plan for manual limit orders without signing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-action-limit-plan-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    stubJupiterOrder();
    try {
      setupWallets();
      const tool = createWalletActionTool({
        config: walletActionConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet_action tool");
      }

      const result = await tool.execute("call-limit-plan", {
        action: "limit_order",
        mode: "manual",
        walletHandle: "@wallet:agent",
        outputMint: USDC_MINT,
        amount: "0.1",
        amountFormat: "human",
        triggerCondition: "below",
        triggerPriceUsd: 120,
      });
      const details = result.details as Record<string, unknown>;
      const plan = details.plan as Record<string, unknown>;
      expect(details.live).toBe(false);
      expect(plan.kind).toBe("solana_limit_order");
      expect(plan.externalVault).toBe("jupiter-trigger-v2");
      expect(mocks.provider.signTx).not.toHaveBeenCalled();
      expect(mocks.provider.executeJupiterReview).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lists and cancels Jupiter Trigger limit orders through the Agent wallet", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-action-limit-manage-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    stubJupiterOrder();
    try {
      setupWallets();
      const tool = createWalletActionTool({
        config: walletActionConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet_action tool");
      }

      const history = await tool.execute("call-limit-history", {
        action: "limit_history",
        walletHandle: "@wallet:agent",
        state: "active",
      });
      const historyDetails = history.details as Record<string, unknown>;
      expect(((historyDetails.history as Record<string, unknown>).orders as unknown[]).length).toBe(
        1,
      );

      const cancelled = await tool.execute("call-limit-cancel", {
        action: "limit_cancel",
        walletHandle: "@wallet:agent",
        orderId: "order-1",
      });
      const cancelDetails = cancelled.details as Record<string, unknown>;
      expect(cancelDetails.cancelled).toBe(true);
      expect((cancelDetails.tx as Record<string, unknown>).txHash).toBe("cancel-tx-1");
      expect(cancelDetails.raw).toBeUndefined();
      expect(mocks.provider.executeJupiterReview).toHaveBeenCalled();
      expect(mocks.provider.signTx).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects swap routes outside the Solana route allowlist", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-action-route-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    stubJupiterOrder({ routeProgramId: ROUTE_PROGRAM_ID });
    try {
      setupWallets();
      const tool = createWalletActionTool({
        config: walletActionConfig({
          wallet: {
            runtime: {
              enabled: true,
              mode: "managed",
              chains: ["solana"],
              policy: {
                directSigning: true,
                solana: {
                  allowPrograms: [Keypair.generate().publicKey.toBase58()],
                },
              },
              toolAccess: {
                mode: "owner-only",
              },
            },
          },
        }),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet_action tool");
      }

      await expect(
        tool.execute("call-disallowed-route", {
          action: "swap",
          walletHandle: "@wallet:agent",
          outputMint: USDC_MINT,
          amount: "100000000",
        }),
      ).rejects.toThrow("swap route uses a program outside the allowlist");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires per-mint caps before autonomous token-input swaps", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-action-token-cap-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    stubJupiterOrder();
    try {
      setupWallets();
      const tool = createWalletActionTool({
        config: walletActionConfig(),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet_action tool");
      }

      await expect(
        tool.execute("call-token-without-cap", {
          action: "swap",
          walletHandle: "@wallet:agent",
          inputMint: TOKEN_A_MINT,
          outputMint: USDC_MINT,
          amount: "1000000",
        }),
      ).rejects.toThrow("SPL token spend requires an explicit per-mint token cap");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("executes sell and token-to-token swaps when token balance and per-mint cap allow it", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-action-token-swap-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    stubJupiterOrder();
    try {
      setupWallets();
      const tool = createWalletActionTool({
        config: walletActionConfig({
          wallet: {
            runtime: {
              enabled: true,
              mode: "managed",
              chains: ["solana"],
              policy: {
                directSigning: true,
                solana: {
                  allowPrograms: [SystemProgram.programId.toBase58()],
                  tokenCaps: {
                    [TOKEN_A_MINT]: { maxPerTx: "2000000", maxDaily: "5000000" },
                  },
                },
              },
              toolAccess: {
                mode: "owner-only",
              },
            },
          },
        }),
        agentSessionKey: "agent:owner:main",
      });
      if (!tool) {
        throw new Error("missing wallet_action tool");
      }

      const sell = await tool.execute("call-sell-token", {
        action: "swap",
        walletHandle: "@wallet:agent",
        inputMint: TOKEN_A_MINT,
        outputMint: SOLANA_NATIVE_MINT,
        amount: "1000000",
      });
      expect((sell.details as Record<string, unknown>).executed).toBe(true);

      const tokenToToken = await tool.execute("call-token-to-token", {
        action: "swap",
        walletHandle: "@wallet:agent",
        inputMint: TOKEN_A_MINT,
        outputMint: USDC_MINT,
        amount: "1000000",
      });
      expect((tokenToToken.details as Record<string, unknown>).executed).toBe(true);
      expect(mocks.provider.prepareJupiterReview).toHaveBeenCalledWith(
        expect.objectContaining({
          walletId: "agent",
          intent: expect.objectContaining({
            jupiter: expect.objectContaining({ inputAmount: "1000000" }),
          }),
          transaction: expect.objectContaining({ submission: "rpc" }),
        }),
      );
      expect(mocks.provider.sendTx).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires an explicit skill manifest before custom-skill autonomous swaps", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-action-auto-deny-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    try {
      setupWallets();
      const tool = createWalletActionTool({
        config: walletActionConfig(),
        agentSessionKey: "agent:owner:main",
        requesterSkillId: "unsafe-skill",
      });
      if (!tool) {
        throw new Error("missing wallet_action tool");
      }

      await expect(
        tool.execute("call-auto-deny", {
          action: "swap",
          mode: "autonomous",
          walletHandle: "@wallet:agent",
          outputMint: USDC_MINT,
          amount: "100000000",
        }),
      ).rejects.toThrow("wallet_action_skill_manifest_required");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires installed ClawHub skills to come from an allowlisted registry before wallet actions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-action-registry-"));
    const workspaceDir = path.join(tempDir, "workspace");
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    stubJupiterOrder();
    try {
      setupWallets();
      await writeClawHubSkillOrigin({
        workspaceDir,
        slug: "trade-skill",
        registry: "https://untrusted.example.com",
      });
      const tool = createWalletActionTool({
        config: walletActionConfig({
          agents: {
            list: [{ id: "owner", default: true, workspace: workspaceDir }],
          },
          skills: {
            marketplace: {
              allowRegistries: ["https://clawhub.com"],
            },
            entries: {
              "trade-skill": {
                config: {
                  walletActions: {
                    actions: ["quote"],
                    roles: ["agent"],
                    walletIds: ["agent"],
                    chains: ["solana"],
                    inputMints: [SOLANA_NATIVE_MINT],
                    outputMints: [USDC_MINT],
                    maxAmount: "1000000000",
                    maxSlippageBps: 100,
                  },
                },
              },
            },
          },
        }),
        agentSessionKey: "agent:owner:main",
        requesterSkillId: "trade-skill",
      });
      if (!tool) {
        throw new Error("missing wallet_action tool");
      }

      await expect(
        tool.execute("call-registry-deny", {
          action: "quote",
          walletHandle: "@wallet:agent",
          outputMint: USDC_MINT,
          amount: "100000000",
          slippageBps: 50,
        }),
      ).rejects.toThrow("wallet_action_skill_registry_not_allowlisted");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("executes autonomous swaps only when skill permissions and wallet caps allow it", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-action-auto-"));
    vi.stubEnv("FASED_STATE_DIR", tempDir);
    stubJupiterOrder();
    try {
      setupWallets();
      const cfg = walletActionConfig({
        skills: {
          entries: {
            "wallet-actions": {
              config: {
                walletActions: {
                  actions: ["swap", "quote", "schedule_plan"],
                  walletIds: ["agent"],
                  inputMints: [SOLANA_NATIVE_MINT],
                  outputMints: [USDC_MINT],
                  maxAmount: "1000000000",
                  maxSlippageBps: 100,
                  autonomous: true,
                  cron: true,
                },
              },
            },
          },
        },
      });
      const tool = createWalletActionTool({
        config: cfg,
        agentSessionKey: "agent:owner:main",
        requesterSkillId: "wallet-actions",
      });
      if (!tool) {
        throw new Error("missing wallet_action tool");
      }

      const result = await tool.execute("call-auto-swap", {
        action: "swap",
        mode: "autonomous",
        walletHandle: "@wallet:agent",
        outputMint: USDC_MINT,
        amount: "100000000",
        slippageBps: 50,
      });
      const details = result.details as Record<string, unknown>;
      expect(details.ok).toBe(true);
      expect(details.executed).toBe(true);
      expect(mocks.provider.prepareJupiterReview).toHaveBeenCalledWith(
        expect.objectContaining({
          walletId: "agent",
          mode: "autonomous",
          intent: expect.objectContaining({
            jupiter: expect.objectContaining({ inputAmount: "100000000" }),
          }),
          transaction: expect.objectContaining({
            serializedTxBase64: expect.any(String),
            submission: "rpc",
          }),
        }),
      );
      expect(mocks.provider.sendTx).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
