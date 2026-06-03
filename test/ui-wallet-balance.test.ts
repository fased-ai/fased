import { describe, expect, it, vi } from "vitest";
import { loadWallet } from "../ui/src/ui/controllers/wallet.ts";
import { hasWalletBalanceValue } from "../ui/src/ui/views/wallet.ts";

vi.mock("../ui/src/ui/wallet-api.js", () => ({
  getWalletStatus: vi.fn(async () => ({
    status: {
      service: { healthy: true },
      chainWallets: {},
    },
  })),
  getWalletSettings: vi.fn(async () => ({ settings: {} })),
  getWalletApprovals: vi.fn(async () => ({ requests: [] })),
  getWalletNamedWallets: vi.fn(async () => ({
    wallets: [
      {
        id: "solana-1",
        name: "Solana 1",
        providerId: "embedded-keystore",
        addresses: { solana: "So11111111111111111111111111111111111111112" },
        readiness: { keystore: true, rpc: true },
      },
    ],
    assignments: {},
    defaultWalletId: "solana-1",
  })),
  getWalletSignerDoctor: vi.fn(async () => ({
    report: { checks: [] },
    chainWallets: {},
  })),
  getWalletBalances: vi.fn(async () => ({
    addresses: { solana: "So11111111111111111111111111111111111111112" },
    balances: {
      solana: { ok: true, balance: "0" },
    },
  })),
  getWalletAuditFor: vi.fn(async () => ({ entries: [] })),
}));

vi.mock("../ui/src/ui/mining-api.js", () => ({
  getMiningProfile: vi.fn(async () => ({ ok: true, profile: null })),
  getMiningStatus: vi.fn(async () => ({ ok: true, status: null })),
  getMiningReadiness: vi.fn(async () => ({ ok: true, readiness: null })),
}));

function createHost() {
  return {
    walletLoading: false,
    walletSettingsLoading: false,
    walletApprovalsLoading: false,
    walletAuditLoading: false,
    walletBalancesLoading: false,
    walletProvidersLoading: false,
    walletError: null,
    walletSettingsError: null,
    walletApprovalsError: null,
    walletAuditError: null,
    walletBalancesError: null,
    walletStatus: null,
    walletSettings: null,
    walletApprovalsFilter: "pending",
    walletApprovals: [],
    walletNamedWallets: [],
    walletAssignments: {},
    walletDefaultWalletId: null,
    walletProviders: [],
    walletDetailsWalletId: "",
    walletSendCreateForm: { walletId: "" },
    walletProviderSelection: "embedded-keystore",
    walletProviderTab: "embedded-keystore",
    walletAuditEntries: [],
    walletBalances: null,
    miningProfile: null,
    miningStatus: null,
    miningReadiness: null,
  };
}

describe("wallet zero-balance handling", () => {
  it("treats zero balances as displayable values", () => {
    expect(hasWalletBalanceValue("0")).toBe(true);
    expect(hasWalletBalanceValue("000")).toBe(true);
    expect(hasWalletBalanceValue(undefined)).toBe(false);
    expect(hasWalletBalanceValue("")).toBe(false);
  });

  it("preserves zero balances instead of treating them as unavailable", async () => {
    const host = createHost();

    await loadWallet(host as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.walletNamedWallets).toHaveLength(1);
    expect(host.walletNamedWallets[0]?.balances?.solana).toBe("0");
  });
});
