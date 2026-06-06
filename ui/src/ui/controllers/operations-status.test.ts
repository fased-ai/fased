import { describe, expect, it, vi } from "vitest";
import type { OperationsStatusState } from "./operations-status.ts";

const walletApi = vi.hoisted(() => ({
  getWalletBalances: vi.fn(),
  getWalletNamedWallets: vi.fn(),
  getWalletStatus: vi.fn(),
}));

const miningApi = vi.hoisted(() => ({
  getMiningProfile: vi.fn(),
  getMiningHistory: vi.fn(),
  getMiningReadiness: vi.fn(),
  getMiningStatus: vi.fn(),
  getMiningWalletAttachment: vi.fn(),
}));

const federationApi = vi.hoisted(() => ({
  getStatus: vi.fn(),
}));

vi.mock("../wallet-api.js", () => walletApi);
vi.mock("../mining-api.js", () => miningApi);
vi.mock("../federation-api.js", () => ({
  createFederationApi: () => federationApi,
}));

describe("loadOperationsStatus", () => {
  it("keeps fresh install overview quiet for optional Mining and Fased Network summaries", async () => {
    walletApi.getWalletStatus.mockResolvedValue({
      status: {
        enabled: false,
        managedMode: false,
        mode: "external",
        runtime: "external-custom",
        settlement: { class: "off-chain", realChainReady: false, summary: "Not configured" },
        service: { host: "127.0.0.1", port: 1, healthy: false },
        chains: [],
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
          statePath: "",
        },
        custody: {
          mode: "single-key",
          target: {},
          scope: { chains: [], allowPrograms: [], solana: { maxPerTx: "0", maxDaily: "0" } },
          unlock: { active: false },
          phase2: {
            complete: false,
            splitKeyEnabled: false,
            passkeyCeremonyEnabled: false,
            ephemeralReconstructionEnabled: false,
            notes: [],
          },
        },
        paths: { rootDir: "", keysPath: "", pidPath: "" },
        checkedAt: "2026-05-07T00:00:00Z",
        startupState: "disabled",
        authState: "missing",
      },
    });
    walletApi.getWalletNamedWallets.mockResolvedValue({
      defaultWalletId: null,
      assignments: {},
      wallets: [],
    });

    const { loadOperationsStatus } = await import("./operations-status.ts");
    const state: OperationsStatusState = {
      connected: true,
      walletStatus: null,
      walletNamedWallets: [],
      walletAssignments: {},
      walletDefaultWalletId: null,
      miningAttachedWalletId: null,
      miningProfile: null,
      miningReadiness: null,
      miningStatus: null,
      miningHistory: null,
      federationToken: null,
      federationStatus: null,
    };

    await loadOperationsStatus(state as never);

    expect(walletApi.getWalletStatus).toHaveBeenCalled();
    expect(walletApi.getWalletNamedWallets).toHaveBeenCalled();
    expect(walletApi.getWalletBalances).not.toHaveBeenCalled();
    expect(miningApi.getMiningProfile).not.toHaveBeenCalled();
    expect(miningApi.getMiningWalletAttachment).not.toHaveBeenCalled();
    expect(miningApi.getMiningStatus).not.toHaveBeenCalled();
    expect(miningApi.getMiningHistory).not.toHaveBeenCalled();
    expect(federationApi.getStatus).not.toHaveBeenCalled();
  });

  it("refreshes Wallet, Mining, and Fased Network summaries when optional state already exists", async () => {
    walletApi.getWalletStatus.mockResolvedValue({
      status: {
        enabled: true,
        managedMode: false,
        mode: "external",
        runtime: "external-custom",
        settlement: { class: "real-chain", realChainReady: true, summary: "Solana ready" },
        service: { host: "127.0.0.1", port: 1, healthy: true },
        chains: ["solana"],
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
          statePath: "",
        },
        custody: {
          mode: "single-key",
          target: { walletId: "agent", role: "agent" },
          scope: {
            chains: ["solana"],
            allowPrograms: [],
            solana: { maxPerTx: "0", maxDaily: "0" },
          },
          unlock: { active: false },
          phase2: {
            complete: false,
            splitKeyEnabled: false,
            passkeyCeremonyEnabled: false,
            ephemeralReconstructionEnabled: false,
            notes: [],
          },
        },
        paths: { rootDir: "", keysPath: "", pidPath: "" },
        checkedAt: "2026-05-07T00:00:00Z",
        startupState: "healthy",
        authState: "ok",
      },
    });
    walletApi.getWalletNamedWallets.mockResolvedValue({
      defaultWalletId: "agent",
      assignments: { main: "agent" },
      wallets: [
        {
          id: "agent",
          name: "Agent",
          providerId: "local-socket-signer",
          addresses: { solana: "sol-agent" },
        },
        { id: "auto_status", name: "Hidden", providerId: "local-socket-signer" },
      ],
    });
    walletApi.getWalletBalances.mockResolvedValue({
      balances: {
        solana: { ok: true, chain: "solana", balance: "1500000000" },
      },
    });
    miningApi.getMiningProfile.mockResolvedValue({
      profile: { walletId: "miner", network: "devnet", riskMode: "balanced" },
    });
    miningApi.getMiningWalletAttachment.mockResolvedValue({
      attachment: { walletId: "attached-miner", attached: true },
    });
    miningApi.getMiningStatus.mockResolvedValue({
      status: {
        running: true,
        walletId: "runtime-miner",
        network: "devnet",
        riskMode: "balanced",
      },
    });
    miningApi.getMiningHistory.mockResolvedValue({
      history: {
        window: "7d",
        activityWindow: "7d",
        latestCycleId: 1,
        totalStoredOutcomeCount: 1,
        matchingOutcomeCount: 1,
        sampled: false,
        windowStartAt: null,
        dataStartAt: null,
        dataEndAt: null,
        outcomes: [{ cycleId: 1, totalSatEarnedRaw: "120000000000", netLiveCostLamports: "0" }],
        activityOutcomes: [],
        totalStoredActionCount: 0,
        matchingActionCount: 0,
        actionWindowStartAt: null,
        actionDataStartAt: null,
        actionDataEndAt: null,
        actions: [],
        updatedAt: "2026-05-07T00:00:00Z",
      },
    });
    miningApi.getMiningReadiness.mockResolvedValue({
      readiness: { ok: true, checks: [], warnings: [], balances: {} },
    });
    federationApi.getStatus.mockResolvedValue({
      status: {
        managed: false,
        sourcePath: "/tmp/federation.json",
        joined: true,
        lifecycle: "active",
        checkedAt: "2026-05-07T00:00:00Z",
        token: {
          tokenId: "token-1",
          nodeId: "node-1",
          handle: "node.fased",
          issuedAt: "2026-05-07T00:00:00Z",
          expiresAt: "2026-05-08T00:00:00Z",
          scopes: ["federation.join"],
          signature: "sig",
        },
      },
    });

    const { loadOperationsStatus } = await import("./operations-status.ts");
    const state: OperationsStatusState = {
      connected: true,
      walletStatus: null,
      walletNamedWallets: [],
      walletAssignments: {},
      walletDefaultWalletId: null,
      miningAttachedWalletId: null,
      miningProfile: { walletId: "miner", network: "devnet", riskMode: "balanced" },
      miningReadiness: null,
      miningStatus: null,
      miningHistory: null,
      federationToken: {
        tokenId: "token-old",
        nodeId: "node-1",
        handle: "node.fased",
        issuedAt: "2026-05-07T00:00:00Z",
        expiresAt: "2026-05-08T00:00:00Z",
        scopes: ["federation.join"],
        signature: "sig",
      },
      federationStatus: { joined: true },
    };

    await loadOperationsStatus(state as never);

    expect(walletApi.getWalletStatus).toHaveBeenCalled();
    expect(walletApi.getWalletNamedWallets).toHaveBeenCalled();
    expect(walletApi.getWalletBalances).toHaveBeenCalledWith("solana", { walletId: "agent" });
    expect(miningApi.getMiningReadiness).toHaveBeenCalledWith("attached-miner");
    expect(miningApi.getMiningHistory).toHaveBeenCalledWith("7d", { activityWindow: "7d" });
    expect(federationApi.getStatus).toHaveBeenCalled();
    expect(state.walletNamedWallets.map((wallet) => wallet.id)).toEqual(["agent"]);
    expect(state.walletNamedWallets[0]?.balances?.solana).toBe("1500000000");
    expect(state.walletDefaultWalletId).toBe("agent");
    expect(state.miningAttachedWalletId).toBe("attached-miner");
    expect(state.miningReadiness?.ok).toBe(true);
    expect(state.miningHistory?.window).toBe("7d");
    expect(state.federationToken?.handle).toBe("node.fased");
  });
});
