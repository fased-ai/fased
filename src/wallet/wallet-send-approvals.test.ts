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
import {
  activateWalletCustodyUnlockSession,
  initializeWalletCustodyCeremony,
} from "./wallet-custody.js";
import * as walletProviderResolver from "./wallet-provider-resolver.js";
import { resolveWalletRuntimeConfig } from "./wallet-runtime-config.js";
import {
  approveWalletSendRequest,
  createOrExecuteWalletSend,
  createWalletSendApprovalRequest,
  listWalletSendApprovalRequests,
  rejectWalletSendRequest,
  sanitizeWalletSendApprovalRequest,
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

vi.mock("./local-socket-signer-custody.js", () => ({
  lockLocalSignerCustody: vi.fn(async () => ({ active: false, removed: true })),
  unlockLocalSignerCustody: vi.fn(
    async (params: { sessionId: string; host: string; expiresAt: string }) => ({
      active: true,
      sessionId: params.sessionId,
      host: params.host,
      expiresAt: params.expiresAt,
    }),
  ),
}));

let tempDir = "";

function testConfig(cfg: unknown): FasedAgentConfig {
  return cfg as FasedAgentConfig;
}

function resolveWalletRuntimeConfigForTest(cfg: unknown) {
  return resolveWalletRuntimeConfig(testConfig(cfg));
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
        program: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
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
    expect(links[0]?.program).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(links[0]?.contract).toBeUndefined();
    const entries = readWalletAuditEntries({ limit: 10 });
    const requestAudit = entries.find((entry) => entry.details?.requestId === request.id);
    expect(requestAudit?.details).toMatchObject({
      amountDisplay: "5",
      assetSymbol: "USDC",
      assetName: "USD Coin",
      assetDecimals: 6,
      program: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    });
  });

  it("blocks manual send creation when provider-chain operation is unsupported", async () => {
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
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      },
      requestedBy: "owner",
      config: walletCfg,
      runtimeConfig: cfg as unknown as Record<string, unknown>,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("wallet_provider_unsupported_chain");
    expect(result.message).toContain("alchemy");
  });

  it("blocks approval execution when provider-chain operation is unsupported", async () => {
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

    const result = await createOrExecuteWalletSend({
      payload: {
        chain: "solana",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      },
      requestedBy: "control-ui",
      sendPath: "reviewed",
      config: walletCfg,
      runtimeConfig: cfg as unknown as FasedAgentConfig,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.mode).toBe("manual");
    if (result.mode !== "manual") {
      throw new Error("Expected reviewed send to create a manual approval request");
    }
    const providerSpy = vi
      .spyOn(walletProviderResolver, "createWalletProviderAdapter")
      .mockReturnValue({
        id: "local-socket-signer",
        displayName: "Local Socket Signer",
        capabilities: {
          custodyModel: "self-hosted",
          supportsCreateWallet: false,
          supportsPrepare: true,
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
        prepareTx: async () => ({
          ok: true,
          chain: "solana",
          preparedId: "prepared-1",
          signer: "So11111111111111111111111111111111111111112",
        }),
        sendTx: async () => ({
          ok: true,
          chain: "solana",
          txHash: "0xmanual",
          signer: "So11111111111111111111111111111111111111112",
        }),
      } as ReturnType<typeof walletProviderResolver.createWalletProviderAdapter>);

    const approved = await approveWalletSendRequest({
      requestId: result.request.id,
      actor: "control-ui",
      config: walletCfg,
      providerIdOverride: "local-socket-signer",
    });
    providerSpy.mockRestore();

    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.tx.txHash).toBe("0xmanual");
    }
  });

  it("keeps approval pending when split-key wallet is locked", async () => {
    vi.stubEnv("FASED_WALLET_CUSTODY_MODE", "split-key");
    vi.stubEnv("FASED_WALLET_CUSTODY_PHASE2_COMPLETE", "1");
    vi.stubEnv("FASED_WALLET_CUSTODY_PASSKEY_CEREMONY", "1");
    vi.stubEnv("FASED_WALLET_CUSTODY_EPHEMERAL_RECONSTRUCTION", "1");
    vi.stubEnv("FASED_WALLET_APPROVAL_AUTH", "webauthn");

    const cfg = {
      wallet: {
        provider: { id: "local-socket-signer" },
        execution: { mode: "manual" },
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
    const init = initializeWalletCustodyCeremony({ env: process.env });
    expect(init.ok).toBe(true);

    const request = createWalletSendApprovalRequest({
      payload: {
        chain: "solana",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
        providerId: "local-socket-signer",
      },
      requestedBy: "control-ui",
    });

    const approved = await approveWalletSendRequest({
      requestId: request.id,
      actor: "control-ui",
      config: walletCfg,
      approvalHost: "127.0.0.1",
    });

    expect(approved.ok).toBe(false);
    if (!approved.ok) {
      expect(approved.code).toBe("custody_unlock_required");
      if (!approved.request) {
        throw new Error("Expected locked custody failure to keep the approval request pending");
      }
      expect(approved.request.status).toBe("pending");
    }
    const pending = listWalletSendApprovalRequests({ status: "pending" });
    expect(pending.map((entry) => entry.id)).toContain(request.id);
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
      sendPath: "automation",
      config: walletCfg,
      runtimeConfig: cfg as unknown as FasedAgentConfig,
    });

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
            },
          },
        },
      },
    } as const;
    const walletCfg = resolveWalletRuntimeConfigForTest(cfg);
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
          supportsPrepare: true,
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
        prepareTx: async () => ({
          ok: true,
          chain: "solana",
          preparedId: "prepared-1",
          signer: "miner-address",
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
      requestedBy: "sat-mining",
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

  it("blocks autonomous send when split-key custody is active without unlock session", async () => {
    vi.stubEnv("FASED_WALLET_CUSTODY_MODE", "split-key");
    vi.stubEnv("FASED_WALLET_CUSTODY_PHASE2_COMPLETE", "1");
    vi.stubEnv("FASED_WALLET_CUSTODY_PASSKEY_CEREMONY", "1");
    vi.stubEnv("FASED_WALLET_CUSTODY_EPHEMERAL_RECONSTRUCTION", "1");
    vi.stubEnv("FASED_WALLET_APPROVAL_AUTH", "webauthn");

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
    const init = initializeWalletCustodyCeremony({ env: process.env });
    expect(init.ok).toBe(true);

    const result = await createOrExecuteWalletSend({
      payload: {
        chain: "solana",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      },
      requestedBy: "owner",
      config: walletCfg,
      runtimeConfig: cfg as unknown as Record<string, unknown>,
      approvalHost: "127.0.0.1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("custody_unlock_required");
  });

  it("requires a wallet-send passkey token when Wallet Control Passkey mode is enabled", async () => {
    vi.stubEnv("FASED_WALLET_APPROVAL_AUTH", "webauthn");

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

    const result = await createOrExecuteWalletSend({
      payload: {
        chain: "solana",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      },
      requestedBy: "owner",
      config: walletCfg,
      runtimeConfig: cfg as unknown as FasedAgentConfig,
      approvalHost: "127.0.0.1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("approval_token_required");
    }
  });

  it("allows autonomous send path to proceed when split-key unlock session is active", async () => {
    vi.stubEnv("FASED_WALLET_CUSTODY_MODE", "split-key");
    vi.stubEnv("FASED_WALLET_CUSTODY_PHASE2_COMPLETE", "1");
    vi.stubEnv("FASED_WALLET_CUSTODY_PASSKEY_CEREMONY", "1");
    vi.stubEnv("FASED_WALLET_CUSTODY_EPHEMERAL_RECONSTRUCTION", "1");
    vi.stubEnv("FASED_WALLET_APPROVAL_AUTH", "webauthn");

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
    const init = initializeWalletCustodyCeremony({ env: process.env });
    expect(init.ok).toBe(true);
    if (!init.ok) {
      return;
    }
    const unlocked = await activateWalletCustodyUnlockSession({
      host: "127.0.0.1",
      approvalToken: "approval-token",
      env: process.env,
      cfg: cfg as unknown as FasedAgentConfig,
      wallet: walletCfg,
      deviceShare: init.deviceShare,
    });
    expect(unlocked.ok).toBe(true);

    const providerSpy = vi
      .spyOn(walletProviderResolver, "createWalletProviderAdapter")
      .mockReturnValue({
        id: "local-socket-signer",
        displayName: "Local Socket Signer",
        capabilities: {
          custodyModel: "self-hosted",
          supportsCreateWallet: false,
          supportsPrepare: true,
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
        prepareTx: async () => ({
          ok: true,
          chain: "solana",
          preparedId: "prepared-1",
          signer: "So11111111111111111111111111111111111111112",
        }),
        sendTx: async () => ({
          ok: true,
          chain: "solana",
          txHash: "0xsent",
          signer: "So11111111111111111111111111111111111111112",
        }),
      } as ReturnType<typeof walletProviderResolver.createWalletProviderAdapter>);

    const result = await createOrExecuteWalletSend({
      payload: {
        chain: "solana",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      },
      requestedBy: "owner",
      config: walletCfg,
      runtimeConfig: cfg as unknown as Record<string, unknown>,
      approvalHost: "127.0.0.1",
    });
    providerSpy.mockRestore();

    expect(result.ok).toBe(true);
  });

  it("redacts secret-bearing provider errors from autonomous send results and audit", async () => {
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
    const providerSpy = vi
      .spyOn(walletProviderResolver, "createWalletProviderAdapter")
      .mockReturnValue({
        id: "local-socket-signer",
        displayName: "Local Socket Signer",
        capabilities: {
          custodyModel: "self-hosted",
          supportsCreateWallet: false,
          supportsPrepare: true,
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
        prepareTx: async () => ({
          ok: true,
          chain: "solana",
          preparedId: "prepared-1",
        }),
        sendTx,
      } as ReturnType<typeof walletProviderResolver.createWalletProviderAdapter>);

    const result = await createOrExecuteWalletSend({
      payload: {
        chain: "solana",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      },
      requestedBy: "owner",
      config: walletCfg,
      runtimeConfig: cfg as unknown as FasedAgentConfig,
    });
    providerSpy.mockRestore();

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(sendTx).toHaveBeenCalledTimes(1);
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
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      },
      requestedBy: "owner",
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
