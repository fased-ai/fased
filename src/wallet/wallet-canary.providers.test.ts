import { beforeEach, describe, expect, test, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import { runWalletProviderCanaryReport } from "./wallet-canary.js";
import { createWalletProviderAdapter } from "./wallet-provider-resolver.js";
import type { ResolvedWalletRuntimeConfig } from "./wallet-runtime-config.js";

let auditEntries: Array<{
  action: string;
  details?: Record<string, unknown>;
}> = [];
let requestCounter = 0;
const settlementByRequest = new Map<
  string,
  { status: "pending" | "executed" | "failed" | "rejected"; txHash?: string }
>();

vi.mock("./wallet-provider-registry.js", () => ({
  readWalletProviderRegistry: vi.fn(() => ({
    defaultProviderId: "turnkey",
    providers: {
      turnkey: {
        enabled: true,
        isDefault: true,
      },
    },
    wallets: [],
  })),
}));

vi.mock("./wallet-provider-resolver.js", () => ({
  createWalletProviderAdapter: vi.fn(() => ({
    id: "turnkey",
    displayName: "Turnkey",
    capabilities: {
      custodyModel: "provider-managed",
      supportsCreateWallet: true,
      supportsPrepare: true,
      supportsSend: true,
      supportsRotateKeys: false,
      supportsResetKeys: false,
      supportsPasskeyGate: true,
      supportedExecutionModes: ["manual", "autonomous"],
      supportedChains: ["solana"],
    },
    supportsChain: (chain: "solana") => chain === "solana",
    health: async () => ({
      ok: true,
      provider: "turnkey",
      configured: true,
      checkedAt: new Date().toISOString(),
      details: "ok",
    }),
    createWallet: async () => ({
      ok: true,
      walletId: "turnkey-wallet-1",
      addresses: { solana: "So11111111111111111111111111111111111111112" },
    }),
    getAddresses: async () => ({
      solana: "So11111111111111111111111111111111111111112",
    }),
    getBalance: async () => ({
      ok: true,
      chain: "solana",
      address: "So11111111111111111111111111111111111111112",
      balance: "42",
      unit: "SOL",
    }),
    prepareTx: async () => ({
      ok: true,
      chain: "solana",
      preparedId: "prepared-1",
    }),
    sendTx: async () => ({
      ok: true,
      chain: "solana",
      txHash: "0xhash1234",
    }),
  })),
}));

vi.mock("./wallet-send-approvals.js", () => ({
  createWalletSendApprovalRequest: vi.fn((params: { payload: { providerId?: string } }) => {
    requestCounter += 1;
    const requestId = `req-${requestCounter}`;
    auditEntries.push({
      action: "send_requested",
      details: {
        requestId,
        providerId: params.payload.providerId ?? "turnkey",
      },
    });
    return {
      id: requestId,
      status: "pending",
      payload: params.payload,
    };
  }),
  rejectWalletSendRequest: vi.fn((params: { requestId: string }) => {
    settlementByRequest.set(params.requestId, { status: "rejected" });
    auditEntries.push({
      action: "send_rejected",
      details: {
        requestId: params.requestId,
        providerId: "turnkey",
      },
    });
    return { ok: true };
  }),
  approveWalletSendRequest: vi.fn(async (params: { requestId: string }) => {
    settlementByRequest.set(params.requestId, {
      status: "executed",
      txHash: "So11111111111111111111111111111111111111112pproved1234",
    });
    auditEntries.push({
      action: "send_executed",
      details: {
        requestId: params.requestId,
        providerId: "turnkey",
      },
    });
    return {
      ok: true as const,
      tx: {
        ok: true,
        chain: "solana" as const,
        txHash: "So11111111111111111111111111111111111111112pproved1234",
      },
      request: {
        id: params.requestId,
        status: "executed",
      },
    };
  }),
}));

vi.mock("./wallet-settlement-links.js", () => ({
  getWalletSettlementLinkByRequestId: vi.fn((params: { requestId: string }) => {
    const found = settlementByRequest.get(params.requestId);
    if (!found) {
      return null;
    }
    return {
      requestId: params.requestId,
      taskId: `task-${params.requestId}`,
      mode: "manual",
      status: found.status,
      txHash: found.txHash,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }),
}));

vi.mock("./wallet-audit-log.js", () => ({
  readWalletAuditEntries: vi.fn(() => auditEntries),
}));

const baseCfg = {
  wallet: {
    provider: { id: "turnkey" },
    runtime: {
      enabled: true,
      mode: "external",
      runtime: "external-custom",
      service: { host: "127.0.0.1", port: 19444 },
    },
  },
} as unknown as FasedAgentConfig;

const baseWallet = {
  enabled: true,
  mode: "external",
  runtime: "external-custom",
  execution: { mode: "manual" },
  chains: ["solana"],
  service: { host: "127.0.0.1", port: 19444 },
  install: { enabled: true, version: "0.1.0" },
  external: { kind: "custom" },
  policy: {
    directSigning: false,
    solana: { allowPrograms: [], caps: { maxPerTx: 1n, maxDaily: 10n } },
  },
  toolAccess: { mode: "owner-only", allowAgents: [] },
} as unknown as ResolvedWalletRuntimeConfig;

describe("runWalletProviderCanaryReport", () => {
  beforeEach(() => {
    auditEntries = [];
    requestCounter = 0;
    settlementByRequest.clear();
  });

  test("passes provider E2E report in non-live mode", async () => {
    const report = await runWalletProviderCanaryReport({
      cfg: baseCfg,
      wallet: baseWallet,
      executeLiveSend: false,
    });

    expect(report.ok).toBe(true);
    expect(report.providers).toHaveLength(1);
    const provider = report.providers[0];
    expect(provider?.providerId).toBe("turnkey");
    expect(provider?.steps.some((step) => step.id === "provider.create_wallet" && step.ok)).toBe(
      true,
    );
    expect(provider?.steps.some((step) => step.id === "approval.reject_flow" && step.ok)).toBe(
      true,
    );
    expect(
      provider?.steps.some(
        (step) =>
          step.id === "send.solana" && !step.required && step.message.includes("live send skipped"),
      ),
    ).toBe(true);
  });

  test("redacts secret-bearing provider health diagnostics", async () => {
    vi.mocked(createWalletProviderAdapter).mockReturnValueOnce({
      id: "turnkey",
      displayName: "Turnkey",
      capabilities: {
        custodyModel: "provider-managed",
        supportsCreateWallet: false,
        supportsPrepare: true,
        supportsSend: true,
        supportsRotateKeys: false,
        supportsResetKeys: false,
        supportsPasskeyGate: true,
        supportedExecutionModes: ["manual", "autonomous"],
        supportedChains: ["solana"],
      },
      supportsChain: (chain: "solana") => chain === "solana",
      health: async () => ({
        ok: false,
        provider: "turnkey",
        configured: true,
        checkedAt: new Date().toISOString(),
        details: "rpc failed at https://rpc.example.com/?api_key=super-secret-rpc-key&ok=1",
      }),
      createWallet: async () => ({ ok: true, walletId: "unused", addresses: {} }),
      getAddresses: async () => ({
        solana: "So11111111111111111111111111111111111111112",
      }),
      getBalance: async () => ({
        ok: true,
        chain: "solana",
        address: "So11111111111111111111111111111111111111112",
        balance: "42",
        unit: "SOL",
      }),
      prepareTx: async () => ({
        ok: true,
        chain: "solana",
        preparedId: "prepared-1",
      }),
      sendTx: async () => ({
        ok: true,
        chain: "solana",
        txHash: "0xhash1234",
      }),
    } as ReturnType<typeof createWalletProviderAdapter>);

    const report = await runWalletProviderCanaryReport({
      cfg: baseCfg,
      wallet: baseWallet,
      executeLiveSend: false,
    });

    const health = report.providers[0]?.steps.find((step) => step.id === "provider.health");
    expect(health?.message).toContain("api_key=***");
    expect(health?.message).not.toContain("super-secret-rpc-key");
  });

  test("fails required send step when live mode is enabled without canary target", async () => {
    const report = await runWalletProviderCanaryReport({
      cfg: baseCfg,
      wallet: baseWallet,
      executeLiveSend: true,
      env: {},
    });

    expect(report.ok).toBe(false);
    const provider = report.providers[0];
    const sendStep = provider?.steps.find((step) => step.id === "send.solana");
    expect(sendStep?.required).toBe(true);
    expect(sendStep?.ok).toBe(false);
    expect(sendStep?.message).toContain("missing canary target env");
  });
});
