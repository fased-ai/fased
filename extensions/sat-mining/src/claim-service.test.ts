import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSatClaimService } from "./claim-service.js";
import { createSatMiningRuntimeState, getOrCreateRoundExecutionState } from "./runtime.js";

type GatewayMethodArgs = { method: string; payload: { cycleId?: number; [key: string]: unknown } };

const runSatGatewayMethod = vi.fn(
  async (
    _args: GatewayMethodArgs,
  ): Promise<{
    ok: boolean;
    payload?: { resolvedCycleIds?: number[]; pendingCycleIds?: number[] };
  }> => ({
    ok: true,
  }),
);
const inspectSatChainUnixTime = vi.fn(async () => Math.floor(Date.now() / 1000));
const inspectSatMinerCycle = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const inspectSatMinerCapital = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const inspectSatPayoutReadiness = vi.fn(
  async (..._args: unknown[]): Promise<unknown> => ({
    recipientBalanceRaw: "0",
  }),
);
const fetchSolanaWalletAssetsViaRpc = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
const createOrExecuteWalletSend = vi.fn(
  async (..._args: unknown[]): Promise<unknown> => ({
    ok: true as const,
    mode: "autonomous" as const,
    tx: { txHash: "sweep-tx" },
    payload: {},
  }),
);
const readWalletProviderRegistry = vi.fn(() => ({
  wallets: [
    {
      id: "wallet-a",
      name: "Miner",
      providerId: "local-socket-signer",
      addresses: { solana: "Source1111111111111111111111111111111111111" },
    },
    {
      id: "vault-wallet",
      name: "Vault",
      providerId: "local-socket-signer",
      addresses: { solana: "Vault11111111111111111111111111111111111111" },
    },
  ],
  defaultWalletId: "vault-wallet",
}));

vi.mock("./gateway-runner.js", () => ({
  runSatGatewayMethod: (args: GatewayMethodArgs) => runSatGatewayMethod(args),
}));

vi.mock("./rpc-read.js", () => ({
  inspectSatChainUnixTime: () => inspectSatChainUnixTime(),
  inspectSatMinerCycle: (...args: unknown[]) => inspectSatMinerCycle(...args),
  inspectSatMinerCapital: (...args: unknown[]) => inspectSatMinerCapital(...args),
  inspectSatPayoutReadiness: (...args: unknown[]) => inspectSatPayoutReadiness(...args),
}));

vi.mock("fased/plugin-sdk/sat-runtime", async () => {
  const actual = await vi.importActual<typeof import("fased/plugin-sdk/sat-runtime")>(
    "fased/plugin-sdk/sat-runtime",
  );
  return {
    ...actual,
    createOrExecuteWalletSend: (...args: unknown[]) => createOrExecuteWalletSend(...args),
    fetchSolanaWalletAssetsViaRpc: (...args: unknown[]) => fetchSolanaWalletAssetsViaRpc(...args),
    loadConfig: vi.fn(() => ({ wallet: {} })),
    readWalletProviderRegistry: () => readWalletProviderRegistry(),
    resolveWalletPolicyConfig: vi.fn(() => ({
      enabled: true,
      mode: "external",
      runtime: "external-custom",
      execution: { mode: "autonomous" },
      chains: ["solana"],
      service: { host: "127.0.0.1", port: 19444 },
      install: { enabled: true, version: "0.1.1" },
      external: { kind: "custom" },
      auth: { mode: "jwt-bootstrap" },
      source: { ref: "" },
      stack: {
        rootDir: "/tmp/wallet-stack",
        composePath: "/tmp/wallet-stack/docker-compose.yml",
        envPath: "/tmp/wallet-stack/.env",
        projectName: "fased-wallet",
      },
      policy: {
        directSigning: true,
        solana: {
          allowPrograms: [],
          caps: { maxPerTx: 0n, maxDaily: 0n },
          tokenCaps: {
            "2AhikHhzJdv6uve1yUBSUmhRKWaSfa7exrsDsfKjVFKa": {
              maxPerTx: 500n,
              maxDaily: 1000n,
            },
          },
        },
      },
      toolAccess: {
        mode: "owner-only",
        allowAgents: [],
        allowSkills: [],
        denySkills: [],
        allowSources: [],
      },
    })),
  };
});

describe("createSatClaimService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T12:30:05.000Z"));
    process.env.FASED_SAT_PROGRAM_ID = "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75";
    process.env.FASED_SAT_BOND_PROGRAM_ID = "Bond111111111111111111111111111111111111111";
    process.env.FASED_SAT_MINT_ADDRESS = "2AhikHhzJdv6uve1yUBSUmhRKWaSfa7exrsDsfKjVFKa";
    process.env.FASED_SAT_MINT_PROGRAM_ID = "8fb3Mpowe4pD6ed89gwm6gLuh8csPSrLi3hypcesqs5C";
    runSatGatewayMethod.mockReset();
    runSatGatewayMethod.mockResolvedValue({ ok: true });
    inspectSatChainUnixTime.mockReset();
    inspectSatChainUnixTime.mockImplementation(async () => Math.floor(Date.now() / 1000));
    inspectSatMinerCycle.mockReset();
    inspectSatMinerCycle.mockResolvedValue(null);
    inspectSatMinerCapital.mockReset();
    inspectSatMinerCapital.mockResolvedValue(null);
    inspectSatPayoutReadiness.mockReset();
    inspectSatPayoutReadiness.mockResolvedValue({ recipientBalanceRaw: "0" });
    fetchSolanaWalletAssetsViaRpc.mockReset();
    fetchSolanaWalletAssetsViaRpc.mockResolvedValue([]);
    createOrExecuteWalletSend.mockReset();
    createOrExecuteWalletSend.mockResolvedValue({
      ok: true,
      mode: "autonomous",
      tx: { txHash: "sweep-tx" },
      payload: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.FASED_SAT_PROGRAM_ID;
    delete process.env.FASED_SAT_BOND_PROGRAM_ID;
    delete process.env.FASED_SAT_MINT_ADDRESS;
    delete process.env.FASED_SAT_MINT_PROGRAM_ID;
    delete process.env.FASED_WALLET_SOLANA_RPC_URL__WALLET_A;
  });

  it("claims batched cycle rewards after settlement", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: { autoClaim: true },
    };
    const state = createSatMiningRuntimeState(config);
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const readyCycleIds = [currentCycleId - 5, currentCycleId - 4];
    for (const cycleId of readyCycleIds) {
      const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
      execution.crankSubmitted = true;
    }
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(runSatGatewayMethod.mock.calls).toHaveLength(1);
    expect(runSatGatewayMethod.mock.calls[0]?.[0]).toMatchObject({
      method: "sat.claimCycleRewardsBatch",
      payload: { cycleIds: readyCycleIds },
    });

    await service.stop?.();
  });

  it("batches only ready cycles and leaves unsettled cycles alone", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: { autoClaim: true },
    };
    const state = createSatMiningRuntimeState(config);
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const readyCycleId = currentCycleId - 5;
    const notReadyCycleId = currentCycleId - 4;
    getOrCreateRoundExecutionState(state, readyCycleId, 0).crankSubmitted = true;
    getOrCreateRoundExecutionState(state, notReadyCycleId, 0).crankSubmitted = false;
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(runSatGatewayMethod.mock.calls).toHaveLength(1);
    expect(runSatGatewayMethod.mock.calls[0]?.[0]).toMatchObject({
      method: "sat.claimCycleRewardsBatch",
      payload: { cycleIds: [readyCycleId] },
    });
    expect(getOrCreateRoundExecutionState(state, readyCycleId, 0).claimSubmitted).toBe(true);
    expect(getOrCreateRoundExecutionState(state, notReadyCycleId, 0).claimSubmitted).toBe(false);

    await service.stop?.();
  });

  it("keeps a bounded partial SAT claim queued until a later chunk drains the cycle", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: { autoClaim: true },
    };
    const state = createSatMiningRuntimeState(config);
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const cycleId = currentCycleId - 5;
    getOrCreateRoundExecutionState(state, cycleId, 0).crankSubmitted = true;
    runSatGatewayMethod
      .mockResolvedValueOnce({
        ok: true,
        payload: { resolvedCycleIds: [], pendingCycleIds: [cycleId] },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: { resolvedCycleIds: [cycleId], pendingCycleIds: [] },
      });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();

    expect(getOrCreateRoundExecutionState(state, cycleId, 0).claimSubmitted).toBe(false);
    expect(state.claimBacklog.get(cycleId)?.stage).toBe("ready");
    expect(state.workers.claim.lastDetail).toContain("still have rewards");

    await vi.advanceTimersByTimeAsync(15_000);

    expect(runSatGatewayMethod).toHaveBeenCalledTimes(2);
    expect(getOrCreateRoundExecutionState(state, cycleId, 0).claimSubmitted).toBe(true);
    expect(state.claimBacklog.get(cycleId)?.stage).toBe("claimed");

    await service.stop?.();
  });

  it("does not replay claims for cycles already marked claimed", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: { autoClaim: true },
    };
    const state = createSatMiningRuntimeState(config);
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const cycleId = currentCycleId - 5;
    const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
    execution.crankSubmitted = true;
    execution.claimSubmitted = true;
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(runSatGatewayMethod.mock.calls).toHaveLength(0);
    expect(state.workers.claim.waitingReason).toContain(
      "waiting for settled batched cycle rewards",
    );

    await service.stop?.();
  });

  it("does not retry claim batches for cycles that already have a successful claim or close record", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: { autoClaim: true },
    };
    const state = createSatMiningRuntimeState(config);
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const cycleId = currentCycleId - 5;
    getOrCreateRoundExecutionState(state, cycleId, 0).crankSubmitted = true;
    state.recentActions.unshift({
      action: "claimCycleRewardsBatch",
      cycleId,
      txHash: "tx-claimed",
      status: "success",
      at: new Date().toISOString(),
    });
    state.recentActions.unshift({
      action: "closeResolvedCycleAccounts",
      cycleId,
      txHash: "tx-close",
      status: "success",
      at: new Date().toISOString(),
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(runSatGatewayMethod).not.toHaveBeenCalled();
    expect(state.workers.claim.waitingReason).toContain(
      "waiting for settled batched cycle rewards",
    );

    await service.stop?.();
  });

  it("retries a failed claim batch and only marks claimed cycles after success", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: { autoClaim: true },
    };
    const state = createSatMiningRuntimeState(config);
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const cycleId = currentCycleId - 5;
    getOrCreateRoundExecutionState(state, cycleId, 0).crankSubmitted = true;
    runSatGatewayMethod
      .mockRejectedValueOnce(new Error("temporary claim failure"))
      .mockResolvedValueOnce({ ok: true });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();

    expect(getOrCreateRoundExecutionState(state, cycleId, 0).claimSubmitted).toBe(false);
    expect(state.workers.claim.retryCount).toBe(1);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(getOrCreateRoundExecutionState(state, cycleId, 0).claimSubmitted).toBe(true);
    expect(
      runSatGatewayMethod.mock.calls.filter(
        (call) => call[0]?.method === "sat.claimCycleRewardsBatch",
      ),
    ).toHaveLength(2);

    await service.stop?.();
  });

  it("backs off claim retries when RPC is rate limited", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: { autoClaim: true },
    };
    const state = createSatMiningRuntimeState(config);
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const cycleId = currentCycleId - 5;
    getOrCreateRoundExecutionState(state, cycleId, 0).crankSubmitted = true;
    runSatGatewayMethod.mockRejectedValueOnce(new Error("rate limited"));
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();

    expect(state.workers.claim.retryCount).toBe(1);
    expect(state.workers.claim.waitingReason).toContain("rate limited; backing off 60s");
    expect(state.workers.claim.nextScheduledAt).toBe(new Date(Date.now() + 60_000).toISOString());
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("cycle claim service rate limited; backing off 60s"),
    );
    expect(getOrCreateRoundExecutionState(state, cycleId, 0).claimSubmitted).toBe(false);

    await service.stop?.();
  });

  it("auto-sweeps claimed SAT to the configured destination wallet", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: {
        autoClaim: true,
        satSweep: {
          enabled: true,
          destinationWalletId: "vault-wallet",
          minRaw: "1",
          keepRaw: "0",
        },
      },
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "Source1111111111111111111111111111111111111";
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const cycleId = currentCycleId - 5;
    getOrCreateRoundExecutionState(state, cycleId, 0).crankSubmitted = true;
    inspectSatPayoutReadiness.mockResolvedValue({ recipientBalanceRaw: "250" });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runtime: {
        config: {
          loadConfig: () => ({ wallet: {} }),
        },
      },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(readWalletProviderRegistry).toHaveBeenCalled();
    expect(createOrExecuteWalletSend).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          chain: "solana",
          to: "Vault11111111111111111111111111111111111111",
          amount: "250",
          program: "2AhikHhzJdv6uve1yUBSUmhRKWaSfa7exrsDsfKjVFKa",
          walletId: "wallet-a",
        }),
        config: expect.objectContaining({
          policy: expect.objectContaining({
            solana: expect.objectContaining({
              tokenCaps: expect.objectContaining({
                "2AhikHhzJdv6uve1yUBSUmhRKWaSfa7exrsDsfKjVFKa": {
                  maxPerTx: 500n,
                  maxDaily: 1000n,
                },
              }),
            }),
          }),
        }),
        sendPath: "automation",
      }),
    );

    await service.stop?.();
  });

  it("falls back to wallet asset inventory when payout readiness returns zero", async () => {
    process.env.FASED_WALLET_SOLANA_RPC_URL__WALLET_A = "https://rpc.example/solana";
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: {
        autoClaim: true,
        satSweep: {
          enabled: true,
          destinationWalletId: "vault-wallet",
          mode: "percentage" as const,
          percentage: 10,
          minRaw: "1",
          keepRaw: "0",
        },
      },
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "Source1111111111111111111111111111111111111";
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const cycleId = currentCycleId - 5;
    getOrCreateRoundExecutionState(state, cycleId, 0).crankSubmitted = true;
    inspectSatPayoutReadiness.mockResolvedValue({
      recipientAtaExists: false,
      recipientBalanceRaw: "0",
    });
    fetchSolanaWalletAssetsViaRpc.mockResolvedValue([
      {
        id: "solana:spl-token:2AhikHhzJdv6uve1yUBSUmhRKWaSfa7exrsDsfKjVFKa",
        chain: "solana",
        kind: "spl-token",
        symbol: "SAT",
        name: "SAT",
        amountRaw: "250",
        amountDisplay: "2.5",
        decimals: 2,
        unit: "raw",
        isNative: false,
        program: "2AhikHhzJdv6uve1yUBSUmhRKWaSfa7exrsDsfKjVFKa",
      },
    ]);
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runtime: {
        config: {
          loadConfig: () => ({ wallet: {} }),
        },
      },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(fetchSolanaWalletAssetsViaRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcUrl: "https://rpc.example/solana",
        ownerAddress: "Source1111111111111111111111111111111111111",
      }),
    );
    expect(createOrExecuteWalletSend).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          amount: "25",
          amountDisplay: "0.00000000025",
          assetSymbol: "SAT",
          assetName: "SAT",
          assetDecimals: 11,
          to: "Vault11111111111111111111111111111111111111",
        }),
      }),
    );

    await service.stop?.();
  });

  it("does not auto-sweep SAT back to the miner wallet address", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: {
        autoClaim: true,
        satSweep: {
          enabled: true,
          destinationAddress: "Source1111111111111111111111111111111111111",
          minRaw: "1",
          keepRaw: "0",
        },
      },
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "Source1111111111111111111111111111111111111";
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const cycleId = currentCycleId - 5;
    getOrCreateRoundExecutionState(state, cycleId, 0).crankSubmitted = true;
    inspectSatPayoutReadiness.mockResolvedValue({ recipientBalanceRaw: "250" });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runtime: {
        config: {
          loadConfig: () => ({ wallet: {} }),
        },
      },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(createOrExecuteWalletSend).not.toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalledWith(
      "[sat-mining] SAT auto-sweep is enabled but no valid destination wallet/address is configured",
    );

    await service.stop?.();
  });

  it("retries quickly when a chain read hangs during claim readiness inspection", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: { autoClaim: true },
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    inspectSatMinerCapital.mockImplementation(
      async () => await new Promise<never>(() => undefined),
    );
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    const startPromise = service.start();
    await vi.advanceTimersByTimeAsync(4_000);
    await startPromise;

    expect(state.workers.claim.waitingReason).toContain("claim RPC read timed out");
    expect(state.workers.claim.lastError).toBeNull();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("claim service timed out on a chain read"),
    );

    await service.stop?.();
  });

  it("treats invalid-owner claim races as already claimed when the miner cycle is gone", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: { autoClaim: true },
    };
    const state = createSatMiningRuntimeState(config);
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const cycleId = currentCycleId - 5;
    state.activeWalletAddress = "11111111111111111111111111111111";
    getOrCreateRoundExecutionState(state, cycleId, 0).crankSubmitted = true;
    runSatGatewayMethod.mockRejectedValueOnce(new Error("InvalidAccountOwner"));
    inspectSatMinerCycle.mockResolvedValue(null);
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(getOrCreateRoundExecutionState(state, cycleId, 0).claimSubmitted).toBe(true);
    expect(state.workers.claim.lastError).toBeNull();
    expect(state.workers.claim.lastDetail).toContain("already claimed or closed");

    await vi.advanceTimersByTimeAsync(15_000);

    expect(
      runSatGatewayMethod.mock.calls.filter(
        (call) => call[0]?.method === "sat.claimCycleRewardsBatch",
      ),
    ).toHaveLength(1);

    await service.stop?.();
  });

  it("claims older settled cycles outside the recent five-cycle window but within slot reuse horizon", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: { autoClaim: true },
    };
    const state = createSatMiningRuntimeState(config);
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const delayedCycleId = currentCycleId - 7;
    const recentCycleId = currentCycleId - 4;
    getOrCreateRoundExecutionState(state, delayedCycleId, 0).crankSubmitted = true;
    getOrCreateRoundExecutionState(state, recentCycleId, 0).crankSubmitted = true;
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(runSatGatewayMethod.mock.calls).toHaveLength(1);
    expect(runSatGatewayMethod.mock.calls[0]?.[0]).toMatchObject({
      method: "sat.claimCycleRewardsBatch",
      payload: { cycleIds: [delayedCycleId, recentCycleId] },
    });
    expect(getOrCreateRoundExecutionState(state, delayedCycleId, 0).claimSubmitted).toBe(true);
    expect(getOrCreateRoundExecutionState(state, recentCycleId, 0).claimSubmitted).toBe(true);

    await service.stop?.();
  });

  it("claims a restored delayed cycle outside the recent five-cycle claim window but within slot reuse horizon", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: { autoClaim: true },
    };
    const state = createSatMiningRuntimeState(config);
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const restoredDelayedCycleId = currentCycleId - 7;
    state.roundExecution.set(`${restoredDelayedCycleId}:0`, {
      openRoundSubmitted: true,
      participationSubmitted: true,
      epochFinalized: true,
      crankSubmitted: true,
      claimSubmitted: false,
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(runSatGatewayMethod.mock.calls).toHaveLength(1);
    expect(runSatGatewayMethod.mock.calls[0]?.[0]).toMatchObject({
      method: "sat.claimCycleRewardsBatch",
      payload: { cycleIds: [restoredDelayedCycleId] },
    });
    expect(state.roundExecution.get(`${restoredDelayedCycleId}:0`)?.claimSubmitted).toBe(true);

    await service.stop?.();
  });

  it("keeps an older distributed cycle claimable from recent action history beyond the legacy slot horizon", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: { autoClaim: true },
    };
    const state = createSatMiningRuntimeState(config);
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const delayedCycleId = currentCycleId - 10;
    state.roundExecution.set(`${delayedCycleId}:0`, {
      openRoundSubmitted: true,
      participationSubmitted: true,
      epochFinalized: true,
      crankSubmitted: true,
      claimSubmitted: false,
    });
    state.recentActions = [
      {
        action: "distributeCyclePage",
        cycleId: delayedCycleId,
        txHash: "tx-distribute",
        status: "success",
        at: new Date().toISOString(),
      },
    ];
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(runSatGatewayMethod.mock.calls).toHaveLength(1);
    expect(runSatGatewayMethod.mock.calls[0]?.[0]).toMatchObject({
      method: "sat.claimCycleRewardsBatch",
      payload: { cycleIds: [delayedCycleId] },
    });
    expect(state.roundExecution.get(`${delayedCycleId}:0`)?.claimSubmitted).toBe(true);

    await service.stop?.();
  });

  it("claims the oldest ready delayed cycles first when backlog exceeds one batch", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: { autoClaim: true },
    };
    const state = createSatMiningRuntimeState(config);
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const delayedCycleIds = [
      currentCycleId - 7,
      currentCycleId - 6,
      currentCycleId - 5,
      currentCycleId - 4,
      currentCycleId - 3,
      currentCycleId - 2,
    ];
    for (const cycleId of delayedCycleIds) {
      getOrCreateRoundExecutionState(state, cycleId, 0).crankSubmitted = true;
    }
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(15_000);

    const claimCalls = runSatGatewayMethod.mock.calls.filter(
      (call) => call[0]?.method === "sat.claimCycleRewardsBatch",
    );
    expect(claimCalls).toHaveLength(2);
    expect(claimCalls[0]?.[0]).toMatchObject({
      method: "sat.claimCycleRewardsBatch",
      payload: { cycleIds: delayedCycleIds.slice(0, 5) },
    });
    expect(claimCalls[1]?.[0]).toMatchObject({
      method: "sat.claimCycleRewardsBatch",
      payload: { cycleIds: [delayedCycleIds[5]] },
    });
    expect(getOrCreateRoundExecutionState(state, delayedCycleIds[5]!, 0).claimSubmitted).toBe(true);

    await service.stop?.();
  });

  it("uses the configured claim batch cycle cap and records durable backlog retries", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: { autoClaim: true, claimBatchCycles: 3 },
    };
    const state = createSatMiningRuntimeState(config);
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const delayedCycleIds = [
      currentCycleId - 6,
      currentCycleId - 5,
      currentCycleId - 4,
      currentCycleId - 3,
    ];
    for (const cycleId of delayedCycleIds) {
      getOrCreateRoundExecutionState(state, cycleId, 0).crankSubmitted = true;
    }
    runSatGatewayMethod
      .mockRejectedValueOnce(new Error("temporary configured batch failure"))
      .mockResolvedValue({ ok: true });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();

    let claimCalls = runSatGatewayMethod.mock.calls.filter(
      (call) => call[0]?.method === "sat.claimCycleRewardsBatch",
    );
    expect(claimCalls).toHaveLength(1);
    expect(claimCalls[0]?.[0]).toMatchObject({
      method: "sat.claimCycleRewardsBatch",
      payload: { cycleIds: delayedCycleIds.slice(0, 3) },
    });
    expect(state.claimBacklog.get(delayedCycleIds[0]!)?.stage).toBe("failed");
    expect(state.claimBacklog.get(delayedCycleIds[0]!)?.retryCount).toBe(1);
    expect(state.claimBacklog.get(delayedCycleIds[0]!)?.lastError).toContain(
      "temporary configured batch failure",
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);

    claimCalls = runSatGatewayMethod.mock.calls.filter(
      (call) => call[0]?.method === "sat.claimCycleRewardsBatch",
    );
    expect(claimCalls).toHaveLength(3);
    expect(claimCalls[1]?.[0]).toMatchObject({
      method: "sat.claimCycleRewardsBatch",
      payload: { cycleIds: delayedCycleIds.slice(0, 3) },
    });
    expect(claimCalls[2]?.[0]).toMatchObject({
      method: "sat.claimCycleRewardsBatch",
      payload: { cycleIds: [delayedCycleIds[3]] },
    });
    expect(state.claimBacklog.get(delayedCycleIds[0]!)?.stage).toBe("claimed");

    await service.stop?.();
  });

  it("walks a long-gap delayed backlog across multiple ticks while skipping already-claimed cycles", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: { autoClaim: true },
    };
    const state = createSatMiningRuntimeState(config);
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const delayedCycleIds = [
      currentCycleId - 7,
      currentCycleId - 6,
      currentCycleId - 5,
      currentCycleId - 4,
      currentCycleId - 3,
      currentCycleId - 2,
      currentCycleId - 1,
    ];
    for (const cycleId of delayedCycleIds) {
      getOrCreateRoundExecutionState(state, cycleId, 0).crankSubmitted = true;
    }
    getOrCreateRoundExecutionState(state, delayedCycleIds[1]!, 0).claimSubmitted = true;
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(30_000);

    const claimCalls = runSatGatewayMethod.mock.calls.filter(
      (call) => call[0]?.method === "sat.claimCycleRewardsBatch",
    );
    expect(claimCalls).toHaveLength(2);
    expect(claimCalls[0]?.[0]).toMatchObject({
      method: "sat.claimCycleRewardsBatch",
      payload: {
        cycleIds: [
          delayedCycleIds[0],
          delayedCycleIds[2],
          delayedCycleIds[3],
          delayedCycleIds[4],
          delayedCycleIds[5],
        ],
      },
    });
    expect(claimCalls[1]?.[0]).toMatchObject({
      method: "sat.claimCycleRewardsBatch",
      payload: {
        cycleIds: [delayedCycleIds[6]],
      },
    });
    for (const cycleId of delayedCycleIds) {
      expect(getOrCreateRoundExecutionState(state, cycleId, 0).claimSubmitted).toBe(true);
    }
    expect(state.workers.claim.waitingReason).toContain(
      "waiting for settled batched cycle rewards",
    );

    await service.stop?.();
  });

  it("does not re-claim a delayed cycle that is only preserved in planner history", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: { autoClaim: true },
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const claimedCycleId = currentCycleId - 2;
    const exactPendingCycleId = currentCycleId - 1;
    state.plannerHistory = [
      {
        cycleId: claimedCycleId,
        committedLamports: "6025000000",
        totalSatEarnedRaw: "5118457515719",
        totalRebateLamports: "400061",
        txFeeLamports: "30000",
        netLiveCostLamports: "-68811",
        validParticipation: true,
        committedMinerCount: 1,
        recordedAt: new Date().toISOString(),
      },
    ];
    getOrCreateRoundExecutionState(state, claimedCycleId, 0).crankSubmitted = true;
    getOrCreateRoundExecutionState(state, exactPendingCycleId, 0).participationSubmitted = true;
    inspectSatMinerCapital.mockResolvedValue({
      firstPendingCycleId: claimedCycleId,
      lastPendingCycleId: exactPendingCycleId,
      lockedLamports: "6025000000",
    });
    inspectSatMinerCycle.mockImplementation(async (...args: unknown[]) => {
      const cycleId = (args[1] as { cycleId?: number } | undefined)?.cycleId;
      return {
        validParticipation: true,
        capitalLockReleased: true,
        claimableSatRaw: cycleId === exactPendingCycleId ? "100" : "0",
        claimableDetRebateLamports: "0",
        claimablePerfRebateLamports: "0",
        claimedSatRaw: cycleId === claimedCycleId ? "100" : "0",
        claimedDetRebateLamports: "0",
        claimedPerfRebateLamports: "0",
      };
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(runSatGatewayMethod).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sat.claimCycleRewardsBatch",
        payload: { cycleIds: [exactPendingCycleId] },
      }),
    );

    await service.stop?.();
  });

  it("prioritizes real claimable runtime cycles ahead of a stale pending-range prefix", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: { autoClaim: true },
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const staleFirstPendingCycleId = currentCycleId - 12;
    const realClaimableCycleId = currentCycleId - 2;
    getOrCreateRoundExecutionState(state, realClaimableCycleId, 0).crankSubmitted = true;
    inspectSatMinerCycle.mockImplementation(async (_config, args) => {
      if (
        typeof args === "object" &&
        args &&
        "cycleId" in args &&
        (args as { cycleId?: number }).cycleId === realClaimableCycleId
      ) {
        return {
          cycleId: realClaimableCycleId,
          validParticipation: true,
          capitalLockReleased: true,
          claimableSatRaw: "1",
          claimableDetRebateLamports: "0",
          claimablePerfRebateLamports: "0",
        };
      }
      return null;
    });
    inspectSatMinerCapital.mockResolvedValue({
      firstPendingCycleId: staleFirstPendingCycleId,
      lastPendingCycleId: realClaimableCycleId,
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(runSatGatewayMethod.mock.calls).toHaveLength(1);
    expect(runSatGatewayMethod.mock.calls[0]?.[0]).toMatchObject({
      method: "sat.claimCycleRewardsBatch",
      payload: { cycleIds: [realClaimableCycleId] },
    });

    await service.stop?.();
  });

  it("retries the oldest delayed claim batch before advancing deeper into backlog", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: { autoClaim: true },
    };
    const state = createSatMiningRuntimeState(config);
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const delayedCycleIds = [
      currentCycleId - 7,
      currentCycleId - 6,
      currentCycleId - 5,
      currentCycleId - 4,
      currentCycleId - 3,
      currentCycleId - 2,
    ];
    for (const cycleId of delayedCycleIds) {
      getOrCreateRoundExecutionState(state, cycleId, 0).crankSubmitted = true;
    }
    runSatGatewayMethod
      .mockRejectedValueOnce(new Error("temporary delayed claim failure"))
      .mockResolvedValue({ ok: true });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();

    let claimCalls = runSatGatewayMethod.mock.calls.filter(
      (call) => call[0]?.method === "sat.claimCycleRewardsBatch",
    );
    expect(claimCalls).toHaveLength(1);
    expect(claimCalls[0]?.[0]).toMatchObject({
      method: "sat.claimCycleRewardsBatch",
      payload: { cycleIds: delayedCycleIds.slice(0, 5) },
    });
    expect(getOrCreateRoundExecutionState(state, delayedCycleIds[0]!, 0).claimSubmitted).toBe(
      false,
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);

    claimCalls = runSatGatewayMethod.mock.calls.filter(
      (call) => call[0]?.method === "sat.claimCycleRewardsBatch",
    );
    expect(claimCalls).toHaveLength(3);
    expect(claimCalls[1]?.[0]).toMatchObject({
      method: "sat.claimCycleRewardsBatch",
      payload: { cycleIds: delayedCycleIds.slice(0, 5) },
    });
    expect(claimCalls[2]?.[0]).toMatchObject({
      method: "sat.claimCycleRewardsBatch",
      payload: { cycleIds: [delayedCycleIds[5]] },
    });
    for (const cycleId of delayedCycleIds) {
      expect(getOrCreateRoundExecutionState(state, cycleId, 0).claimSubmitted).toBe(true);
    }

    await service.stop?.();
  });

  it("drops stale restored delayed-claim entries at or beyond the seven-cycle slot horizon", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: { autoClaim: true },
    };
    const state = createSatMiningRuntimeState(config);
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const staleCycleId = currentCycleId - 8;
    state.roundExecution.set(`${staleCycleId}:0`, {
      openRoundSubmitted: true,
      participationSubmitted: true,
      epochFinalized: true,
      crankSubmitted: true,
      claimSubmitted: false,
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(runSatGatewayMethod).not.toHaveBeenCalled();
    expect(state.roundExecution.has(`${staleCycleId}:0`)).toBe(false);
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("older than the 7-cycle slot horizon"),
    );

    await service.stop?.();
  });

  it("drops stale delayed-claim entries and still claims the next valid restored cycle", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      automation: { autoClaim: true },
    };
    const state = createSatMiningRuntimeState(config);
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const staleCycleId = currentCycleId - 12;
    const validDelayedCycleId = currentCycleId - 7;
    state.roundExecution.set(`${staleCycleId}:0`, {
      openRoundSubmitted: true,
      participationSubmitted: true,
      epochFinalized: true,
      crankSubmitted: true,
      claimSubmitted: false,
    });
    state.roundExecution.set(`${validDelayedCycleId}:0`, {
      openRoundSubmitted: true,
      participationSubmitted: true,
      epochFinalized: true,
      crankSubmitted: true,
      claimSubmitted: false,
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatClaimService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(runSatGatewayMethod.mock.calls).toHaveLength(1);
    expect(runSatGatewayMethod.mock.calls[0]?.[0]).toMatchObject({
      method: "sat.claimCycleRewardsBatch",
      payload: { cycleIds: [validDelayedCycleId] },
    });
    expect(state.roundExecution.has(`${staleCycleId}:0`)).toBe(false);
    expect(state.roundExecution.get(`${validDelayedCycleId}:0`)?.claimSubmitted).toBe(true);

    await service.stop?.();
  });
});
