import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentApp } from "../app.js";
import { resolveWalletSendApprovalOperation } from "./wallet-send.js";
import { loadWallet } from "./wallet.js";

const walletApi = vi.hoisted(() => ({
  getWalletStatus: vi.fn(),
  getWalletSettings: vi.fn(),
  getWalletApprovals: vi.fn(),
  getWalletNamedWallets: vi.fn(),
  getWalletSignerDoctor: vi.fn(),
  getWalletBalances: vi.fn(),
  getWalletAuditFor: vi.fn(),
}));

const miningApi = vi.hoisted(() => ({
  getMiningProfile: vi.fn(),
  getMiningStatus: vi.fn(),
  getMiningReadiness: vi.fn(),
}));

vi.mock("../wallet-api.js", () => walletApi);
vi.mock("../mining-api.js", () => miningApi);

function createHost(): FasedAgentApp {
  return {
    walletApprovalsFilter: "all",
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
    walletProviders: [],
    walletNamedWallets: [],
    walletAssignments: {},
    walletDefaultWalletId: null,
    walletDetailsWalletId: "wallet-payment",
    walletSendCreateForm: {
      walletId: "",
    },
    walletProviderSelection: "",
    walletProviderTab: "embedded-keystore",
    miningProfile: null,
    miningStatus: null,
    miningReadiness: null,
    walletAuditEntries: [],
    walletBalances: null,
  } as unknown as FasedAgentApp;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushWalletLoadMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("loadWallet", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    walletApi.getWalletStatus.mockResolvedValue({
      ok: true,
      status: {
        managedMode: false,
        enabled: true,
        mode: "managed",
        runtime: "external-docker",
        settlement: {
          class: "real-chain",
          realChainReady: true,
          summary: "ready",
        },
        chains: ["solana"],
        service: {
          host: "127.0.0.1",
          port: 18789,
          healthy: true,
        },
        policy: {
          executionMode: "manual",
          directSigning: false,
          toolAccessMode: "owner-only",
          allowAgents: [],
          solana: { allowPrograms: [], maxPerTx: "0", maxDaily: "0" },
        },
        approvalAuth: {
          mode: "none",
          ready: false,
          passkeyCount: 0,
          notes: [],
          passkeys: [],
          statePath: "/tmp/passkeys.json",
        },
        custody: {
          mode: "single-key",
          unlock: { active: false },
          phase2: {
            complete: false,
            splitKeyEnabled: false,
            passkeyCeremonyEnabled: false,
            ephemeralReconstructionEnabled: false,
            notes: [],
          },
        },
        paths: {
          rootDir: "/tmp",
          keysPath: "/tmp/keys",
          pidPath: "/tmp/pid",
        },
        checkedAt: new Date().toISOString(),
        startupState: "healthy",
        authState: "ok",
      },
    });

    walletApi.getWalletSettings.mockResolvedValue({
      ok: true,
      settings: {
        providerId: "embedded-keystore",
      },
    });

    walletApi.getWalletApprovals.mockResolvedValue({
      ok: true,
      requests: [],
    });

    walletApi.getWalletNamedWallets.mockResolvedValue({
      ok: true,
      wallets: [
        {
          id: "wallet-mining",
          name: "Solana 1",
          providerId: "embedded-keystore",
          addresses: {
            solana: "So11111111111111111111111111111111111111113",
          },
          readiness: {
            keystore: true,
            rpc: true,
          },
          createdAt: "2026-04-08T00:00:00.000Z",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
        {
          id: "wallet-payment",
          name: "Solana 2",
          providerId: "embedded-keystore",
          addresses: {
            solana: "So11111111111111111111111111111111111111112",
          },
          balances: {
            solana: "0",
          },
          readiness: {
            keystore: true,
            rpc: true,
          },
          createdAt: "2026-04-08T00:00:00.000Z",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      ],
      assignments: {},
      defaultWalletId: "wallet-payment",
      checkedAt: "2026-04-08T00:00:00.000Z",
    });

    walletApi.getWalletSignerDoctor.mockResolvedValue({
      ok: true,
      report: {
        ok: true,
        running: true,
        socketPath: "/tmp/fased-wallet.sock",
        pidPath: "/tmp/fased-wallet.pid",
        auditPath: "/tmp/fased-wallet-audit.log",
        checks: [],
      },
      chainWallets: {
        solana: [
          {
            walletId: "wallet-mining",
            keystoreReady: true,
            decryptReady: true,
            rpcConfigured: true,
            rpcDetail: "http://127.0.0.1:8899",
          },
          {
            walletId: "wallet-payment",
            keystoreReady: true,
            decryptReady: true,
            rpcConfigured: true,
            rpcDetail: "http://127.0.0.1:8899",
          },
        ],
      },
    });

    walletApi.getWalletBalances.mockImplementation(
      async (_chain: "all", { walletId }: { walletId?: string } = {}) => ({
        ok: true,
        chain: "all",
        provider: "embedded-keystore",
        walletId,
        walletName: walletId === "wallet-mining" ? "Solana 1" : "Solana 2",
        balances: {
          solana: {
            ok: true,
            chain: "solana",
            balance: "0",
            unit: "lamports",
          },
        },
        addresses: {
          solana:
            walletId === "wallet-mining"
              ? "So11111111111111111111111111111111111111113"
              : "So11111111111111111111111111111111111111112",
        },
        checkedAt: "2026-04-08T00:00:00.000Z",
      }),
    );

    walletApi.getWalletAuditFor.mockResolvedValue({
      ok: true,
      entries: [],
    });

    miningApi.getMiningProfile.mockResolvedValue({
      ok: true,
      profile: {
        walletId: "wallet-mining",
      },
    });

    miningApi.getMiningStatus.mockResolvedValue({
      ok: true,
      status: {
        running: false,
        walletId: "wallet-mining",
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    });

    miningApi.getMiningReadiness.mockResolvedValue({
      ok: true,
      readiness: {
        ok: true,
        selectedWalletId: "wallet-mining",
        checks: [],
        warnings: [],
        balances: {},
      },
    });
  });

  it("refreshes balances for every named wallet so singleton mining wallets do not stay blank", async () => {
    const host = createHost();

    await loadWallet(host);
    await Promise.resolve();
    await Promise.resolve();

    expect(host.walletError).toBeNull();
    expect(walletApi.getWalletSettings).toHaveBeenCalledWith("wallet-payment");
    expect(walletApi.getWalletBalances).toHaveBeenCalledTimes(2);
    expect(walletApi.getWalletBalances).toHaveBeenCalledWith("all", { walletId: "wallet-mining" });
    expect(walletApi.getWalletBalances).toHaveBeenCalledWith("all", {
      walletId: "wallet-payment",
      includeAssets: true,
    });

    const miningWallet = host.walletNamedWallets.find(
      (wallet: { id: string }) => wallet.id === "wallet-mining",
    );
    expect(miningWallet?.balances?.solana).toBe("0");
    expect(host.walletBalances?.walletId).toBe("wallet-payment");
    expect(host.walletBalancesError).toBeNull();
  });

  it("clears transient local signer socket errors when signer doctor is healthy", async () => {
    const statusResponse = await walletApi.getWalletStatus();
    walletApi.getWalletStatus.mockClear();
    walletApi.getWalletStatus.mockResolvedValueOnce({
      ...statusResponse,
      status: {
        ...statusResponse.status,
        service: {
          ...statusResponse.status.service,
          healthy: false,
        },
        startupState: "unreachable",
        error: "Error: connect ENOENT /home/app/.fased/wallet/local-signer.sock",
      },
    });

    const host = createHost();

    await loadWallet(host);

    expect(host.walletError).toBeNull();
    expect(host.walletStatus?.service.healthy).toBe(true);
    expect(host.walletStatus?.error).toBeUndefined();
  });

  it("shows wallet activity before slow token balances finish loading", async () => {
    const host = createHost();
    const selectedBalances = {
      ok: true,
      chain: "all",
      provider: "embedded-keystore",
      walletId: "wallet-payment",
      walletName: "Solana 2",
      balances: {
        solana: {
          ok: true,
          chain: "solana",
          balance: "0",
          unit: "lamports",
        },
      },
      addresses: {
        solana: "So11111111111111111111111111111111111111112",
      },
      checkedAt: "2026-04-08T00:00:00.000Z",
    };
    const slowSelectedBalances = createDeferred<typeof selectedBalances>();
    walletApi.getWalletAuditFor.mockResolvedValueOnce({
      ok: true,
      entries: [
        {
          id: "audit-1",
          action: "send_executed",
          at: "2026-04-08T00:00:00.000Z",
          walletId: "wallet-payment",
          details: {
            chain: "solana",
            amountDisplay: "30.740343",
            assetSymbol: "SAT",
          },
        },
      ],
    });
    walletApi.getWalletBalances.mockImplementation(
      async (_chain: "all", options: { walletId?: string; includeAssets?: boolean } = {}) => {
        if (options.includeAssets) {
          return await slowSelectedBalances.promise;
        }
        return {
          ok: true,
          chain: "all",
          provider: "embedded-keystore",
          walletId: options.walletId,
          walletName: options.walletId === "wallet-mining" ? "Solana 1" : "Solana 2",
          balances: {
            solana: {
              ok: true,
              chain: "solana",
              balance: "0",
              unit: "lamports",
            },
          },
          addresses: {
            solana:
              options.walletId === "wallet-mining"
                ? "So11111111111111111111111111111111111111113"
                : "So11111111111111111111111111111111111111112",
          },
          checkedAt: "2026-04-08T00:00:00.000Z",
        };
      },
    );

    const load = loadWallet(host);
    await flushWalletLoadMicrotasks();

    expect(host.walletAuditEntries).toHaveLength(1);
    expect(host.walletAuditLoading).toBe(false);
    expect(host.walletBalances).toBeNull();
    expect(host.walletBalancesLoading).toBe(true);

    slowSelectedBalances.resolve(selectedBalances);
    await load;

    expect(host.walletBalances?.walletId).toBe("wallet-payment");
    expect(host.walletBalancesLoading).toBe(false);
  });

  it("starts wallet activity before slow wallet status finishes loading", async () => {
    const host = createHost();
    const walletStatus = {
      ok: true,
      status: {
        managedMode: false,
        enabled: true,
        mode: "managed",
        runtime: "external-docker",
        settlement: {
          class: "real-chain",
          realChainReady: true,
          summary: "ready",
        },
        chains: ["solana"],
        service: {
          host: "127.0.0.1",
          port: 18789,
          healthy: true,
        },
        policy: {
          executionMode: "manual",
          directSigning: false,
          toolAccessMode: "owner-only",
          allowAgents: [],
          solana: { allowPrograms: [], maxPerTx: "0", maxDaily: "0" },
        },
        approvalAuth: {
          mode: "none",
          ready: false,
          passkeyCount: 0,
          notes: [],
          passkeys: [],
          statePath: "/tmp/passkeys.json",
        },
        custody: {
          mode: "single-key",
          unlock: { active: false },
          phase2: {
            complete: false,
            splitKeyEnabled: false,
            passkeyCeremonyEnabled: false,
            ephemeralReconstructionEnabled: false,
            notes: [],
          },
        },
        paths: {
          rootDir: "/tmp",
          keysPath: "/tmp/keys",
          pidPath: "/tmp/pid",
        },
        checkedAt: "2026-04-08T00:00:00.000Z",
        startupState: "healthy",
        authState: "ok",
      },
    };
    const slowStatus = createDeferred<typeof walletStatus>();
    walletApi.getWalletStatus.mockImplementationOnce(async () => await slowStatus.promise);
    walletApi.getWalletAuditFor.mockResolvedValueOnce({
      ok: true,
      entries: [
        {
          id: "audit-early",
          action: "send_executed",
          at: "2026-04-08T00:00:00.000Z",
          walletId: "wallet-payment",
          details: {
            chain: "solana",
            amountDisplay: "30.740343",
            assetSymbol: "SAT",
          },
        },
      ],
    });

    const load = loadWallet(host);
    await flushWalletLoadMicrotasks();

    expect(walletApi.getWalletAuditFor).toHaveBeenCalledWith(500);
    expect(host.walletAuditEntries).toHaveLength(1);
    expect(host.walletAuditLoading).toBe(false);
    expect(host.walletLoading).toBe(true);

    slowStatus.resolve(walletStatus);
    await load;

    expect(host.walletLoading).toBe(false);
    expect(host.walletAuditEntries).toHaveLength(1);
  });

  it("does not treat a local-socket-signer registry wallet as key-ready without signer doctor proof", async () => {
    walletApi.getWalletNamedWallets.mockResolvedValueOnce({
      ok: true,
      wallets: [
        {
          id: "solana-3",
          name: "Solana 3",
          providerId: "local-socket-signer",
          addresses: {
            solana: "So11111111111111111111111111111111111111114",
          },
          readiness: {
            keystore: true,
            rpc: true,
          },
          createdAt: "2026-04-08T00:00:00.000Z",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      ],
      assignments: {},
      defaultWalletId: "solana-3",
      checkedAt: "2026-04-08T00:00:00.000Z",
    });
    walletApi.getWalletSignerDoctor.mockResolvedValueOnce({
      ok: true,
      report: {
        ok: true,
        running: true,
        socketPath: "/tmp/fased-wallet.sock",
        pidPath: "/tmp/fased-wallet.pid",
        auditPath: "/tmp/fased-wallet-audit.log",
        checks: [],
      },
      chainWallets: {
        solana: [],
      },
    });

    const host = createHost();
    host.walletDetailsWalletId = "solana-3";

    await loadWallet(host);

    const wallet = host.walletNamedWallets.find((entry: { id: string }) => entry.id === "solana-3");
    expect(wallet?.readiness?.keystore).toBe(false);
  });

  it("marks a local-socket-signer registry wallet key-ready from signer doctor proof", async () => {
    walletApi.getWalletNamedWallets.mockResolvedValueOnce({
      ok: true,
      wallets: [
        {
          id: "solana-3",
          name: "Solana 3",
          providerId: "local-socket-signer",
          addresses: {
            solana: "So11111111111111111111111111111111111111114",
          },
          readiness: {
            keystore: false,
            rpc: false,
          },
          createdAt: "2026-04-08T00:00:00.000Z",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      ],
      assignments: {},
      defaultWalletId: "solana-3",
      checkedAt: "2026-04-08T00:00:00.000Z",
    });
    walletApi.getWalletSignerDoctor.mockResolvedValueOnce({
      ok: true,
      report: {
        ok: true,
        running: true,
        socketPath: "/tmp/fased-wallet.sock",
        pidPath: "/tmp/fased-wallet.pid",
        auditPath: "/tmp/fased-wallet-audit.log",
        checks: [],
      },
      chainWallets: {
        solana: [
          {
            walletId: "solana_3",
            keystoreReady: true,
            decryptReady: true,
            rpcConfigured: true,
          },
        ],
      },
    });

    const host = createHost();
    host.walletDetailsWalletId = "solana-3";

    await loadWallet(host);

    const wallet = host.walletNamedWallets.find((entry: { id: string }) => entry.id === "solana-3");
    expect(wallet?.readiness?.keystore).toBe(true);
    expect(wallet?.readiness?.rpc).toBe(true);
  });
});

describe("resolveWalletSendApprovalOperation", () => {
  it("does not require a passkey before creating manual send requests", () => {
    expect(
      resolveWalletSendApprovalOperation({
        passkeyCount: 1,
        executionMode: "manual",
        custodyMode: "single-key",
        unlockActive: false,
      }),
    ).toBeNull();
  });

  it("requires custody unlock before autonomous split-key sends", () => {
    expect(
      resolveWalletSendApprovalOperation({
        passkeyCount: 1,
        executionMode: "autonomous",
        custodyMode: "split-key-active",
        unlockActive: false,
      }),
    ).toBe("wallet.custody-unlock");
  });

  it("requires wallet.send approval for standard autonomous sends when a passkey exists", () => {
    expect(
      resolveWalletSendApprovalOperation({
        passkeyCount: 1,
        executionMode: "autonomous",
        custodyMode: "single-key",
        unlockActive: false,
      }),
    ).toBe("wallet.send");
  });
});
