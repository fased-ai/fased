import { describe, expect, it, vi } from "vitest";
import { loadWallet } from "../ui/src/ui/controllers/wallet.ts";

vi.mock("../ui/src/ui/wallet-api.js", () => ({
  getWalletStatus: vi.fn(),
  getWalletSettings: vi.fn(),
  getWalletApprovals: vi.fn(),
  getWalletNamedWallets: vi.fn(),
  getWalletSignerDoctor: vi.fn(),
  getWalletAuditFor: vi.fn(),
  getWalletBalances: vi.fn(),
}));

vi.mock("../ui/src/ui/mining-api.js", () => ({
  getMiningProfile: vi.fn(async () => ({ ok: true, profile: null })),
  getMiningStatus: vi.fn(async () => ({
    ok: true,
    status: {
      running: false,
      network: "devnet",
      riskMode: "balanced",
      blocked: false,
      updatedAt: new Date().toISOString(),
    },
  })),
  getMiningReadiness: vi.fn(async () => ({
    ok: true,
    readiness: { ok: true, checks: [], warnings: [], balances: {} },
  })),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildWalletStatus() {
  return {
    service: { healthy: true },
    capabilities: {},
    policyDisplay: {
      solana: { maxPerTx: { human: "1 SOL" }, maxDaily: { human: "2 SOL" } },
    },
    chainWallets: { solana: [] },
  };
}

function buildWalletSettings(walletId: string) {
  return {
    selectedWalletId: walletId,
    policy: {
      solana: { maxPerTx: "1000000000", maxDaily: "2000000000" },
    },
  };
}

function buildNamedWallet(id: string, name: string) {
  return {
    id,
    name,
    providerId: "embedded-keystore",
    readiness: { keystore: true, rpc: true },
    addresses: { solana: `${id}-addr` },
  };
}

function buildHost() {
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
    walletApprovals: [],
    walletNamedWallets: [],
    walletAssignments: {},
    walletDefaultWalletId: null,
    walletDetailsWalletId: "",
    walletProviderSelection: "embedded-keystore",
    walletProviderTab: "embedded-keystore",
    walletSendCreateForm: { walletId: "" },
    walletAuditEntries: [],
    walletBalances: null,
    walletProviders: [],
    miningProfile: null,
    miningStatus: null,
    miningReadiness: null,
  };
}

describe("loadWallet", () => {
  it("ignores stale wallet loads so reconnect data wins over an older offline response", async () => {
    const walletApi = await import("../ui/src/ui/wallet-api.js");
    const firstStatus = deferred<{ status: ReturnType<typeof buildWalletStatus> }>();

    vi.mocked(walletApi.getWalletStatus)
      .mockImplementationOnce(() => firstStatus.promise)
      .mockResolvedValueOnce({ status: buildWalletStatus() } as never);
    vi.mocked(walletApi.getWalletSettings)
      .mockResolvedValueOnce({ settings: buildWalletSettings("wallet-a") as never })
      .mockResolvedValueOnce({ settings: buildWalletSettings("wallet-b") as never });
    vi.mocked(walletApi.getWalletApprovals).mockResolvedValue({ requests: [] } as never);
    vi.mocked(walletApi.getWalletNamedWallets)
      .mockResolvedValueOnce({
        wallets: [buildNamedWallet("wallet-a", "Wallet A")],
        assignments: {},
        defaultWalletId: "wallet-a",
      } as never)
      .mockResolvedValueOnce({
        wallets: [buildNamedWallet("wallet-b", "Wallet B")],
        assignments: {},
        defaultWalletId: "wallet-b",
      } as never);
    vi.mocked(walletApi.getWalletSignerDoctor).mockResolvedValue({
      report: { checks: [] },
      chainWallets: { solana: [] },
    } as never);
    vi.mocked(walletApi.getWalletAuditFor).mockResolvedValue({
      entries: [{ id: "fresh-audit" }],
    } as never);
    vi.mocked(walletApi.getWalletBalances).mockResolvedValue({
      addresses: { solana: "addr" },
      balances: {
        solana: { ok: true, balance: "1000000000" },
      },
    } as never);

    const host = buildHost() as never;
    const staleLoad = loadWallet(host);
    const freshLoad = loadWallet(host);
    await freshLoad;
    firstStatus.resolve({ status: buildWalletStatus() });
    await staleLoad;

    expect(host.walletDefaultWalletId).toBe("wallet-b");
    expect(host.walletDetailsWalletId).toBe("wallet-b");
    expect(host.walletNamedWallets[0]?.id).toBe("wallet-b");
  });

  it("only probes live balances for the selected wallet instead of every wallet row", async () => {
    const walletApi = await import("../ui/src/ui/wallet-api.js");
    vi.clearAllMocks();

    vi.mocked(walletApi.getWalletStatus).mockResolvedValue({
      status: buildWalletStatus(),
    } as never);
    vi.mocked(walletApi.getWalletSettings).mockResolvedValue({
      settings: buildWalletSettings("wallet-a") as never,
    });
    vi.mocked(walletApi.getWalletApprovals).mockResolvedValue({ requests: [] } as never);
    vi.mocked(walletApi.getWalletNamedWallets).mockResolvedValue({
      wallets: [buildNamedWallet("wallet-a", "Wallet A"), buildNamedWallet("wallet-b", "Wallet B")],
      assignments: {},
      defaultWalletId: "wallet-a",
    } as never);
    vi.mocked(walletApi.getWalletSignerDoctor).mockResolvedValue({
      report: { checks: [] },
      chainWallets: { solana: [] },
    } as never);
    vi.mocked(walletApi.getWalletAuditFor).mockResolvedValue({ entries: [] } as never);
    vi.mocked(walletApi.getWalletBalances).mockResolvedValue({
      addresses: { solana: "wallet-a-addr" },
      balances: {
        solana: { ok: true, balance: "1000000000" },
      },
    } as never);

    const host = buildHost() as never;
    await loadWallet(host);

    expect(walletApi.getWalletBalances).toHaveBeenCalledTimes(1);
    expect(walletApi.getWalletBalances).toHaveBeenCalledWith("all", { walletId: "wallet-a" });
    expect(host.walletNamedWallets[0]?.balances?.solana).toBe("1000000000");
    expect(host.walletNamedWallets[1]?.balances?.solana).toBeUndefined();
  });

  it("keeps zero balances visible for the selected wallet row", async () => {
    const walletApi = await import("../ui/src/ui/wallet-api.js");
    vi.clearAllMocks();

    vi.mocked(walletApi.getWalletStatus).mockResolvedValue({
      status: buildWalletStatus(),
    } as never);
    vi.mocked(walletApi.getWalletSettings).mockResolvedValue({
      settings: buildWalletSettings("solana-1") as never,
    });
    vi.mocked(walletApi.getWalletApprovals).mockResolvedValue({ requests: [] } as never);
    vi.mocked(walletApi.getWalletNamedWallets).mockResolvedValue({
      wallets: [buildNamedWallet("solana-1", "Solana 1")],
      assignments: {},
      defaultWalletId: "solana-1",
    } as never);
    vi.mocked(walletApi.getWalletSignerDoctor).mockResolvedValue({
      report: { checks: [] },
      chainWallets: { solana: [] },
    } as never);
    vi.mocked(walletApi.getWalletAuditFor).mockResolvedValue({ entries: [] } as never);
    vi.mocked(walletApi.getWalletBalances).mockResolvedValue({
      addresses: { solana: "solana-1-addr" },
      balances: {
        solana: { ok: true, balance: "0" },
      },
    } as never);

    const host = buildHost() as never;
    host.walletDetailsWalletId = "solana-1";
    await loadWallet(host);

    expect(host.walletNamedWallets[0]?.balances?.solana).toBe("0");
  });
});
