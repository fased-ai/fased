import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSatRoundWatcherService, shouldParticipateInSatCycle } from "./round-watcher.js";
import { createSatMiningRuntimeState, getOrCreateRoundExecutionState } from "./runtime.js";

type GatewayMethodArgs = { method: string; payload: { cycleId?: number; [key: string]: unknown } };
type CycleArgs = { cycleId: number; authority?: string };
type RegistryMeta = {
  address?: string;
  cycleId: number;
  participantCount: number;
  pageCount: number;
};
type CycleView = {
  [key: string]: unknown;
  address: string;
  cycleId: number;
  openTs: number;
  closeTs: number;
  status: number;
  unlockTargetLamports: string;
  totalCommittedLamports: string;
  validMinerCount: string;
  unlockRatioFp: string;
  minimumEntryLamports?: string;
  currentUnlockSolLamports?: string;
  currentUnlockSatRaw?: string;
  pendingTreasurySatRaw?: string;
  pendingDistributorSatRaw?: string;
  pendingTreasurySolLamports?: string;
  issuedCycleMinerSatRaw?: string;
  issuedCycleTreasurySatRaw?: string;
  unissuedCycleMinerSatRaw?: string;
  unissuedCycleTreasurySatRaw?: string;
  solErosionPoolLamports?: string;
  cycleSeed?: string;
  entropyUnavailable?: boolean;
  commitDeadlineTs?: number;
  revealDeadlineTs?: number;
  entropyTargetSlot?: number;
  committedMinerCount?: string;
  revealedMinerCount?: string;
  resolvedCommitCount?: string;
  entropySealedSlot?: number;
};
type MinerCycleView = {
  address: string;
  cycleId: number;
  commitment?: string;
  validParticipation?: boolean;
};

function createOpenCycleView(cycleId: number): CycleView {
  const openTs = cycleId * 300;
  return {
    address: `cycle-${cycleId}`,
    cycleId,
    openTs,
    closeTs: openTs + 300,
    status: 0,
    unlockTargetLamports: "0",
    totalCommittedLamports: "0",
    validMinerCount: "0",
    unlockRatioFp: "0",
    cycleSeed: "0".repeat(64),
    commitDeadlineTs: openTs + 120,
    revealDeadlineTs: openTs + 270,
    entropyTargetSlot: 0,
    committedMinerCount: "0",
    revealedMinerCount: "0",
    resolvedCommitCount: "0",
    entropySealedSlot: 0,
  };
}

const runSatGatewayMethod = vi.fn(
  async (_args: GatewayMethodArgs): Promise<{ ok: boolean }> => ({
    ok: true,
  }),
);
const inspectCurrentSatRoundBucket = vi.fn<() => Promise<unknown | null>>(async () => null);
const inspectSatChainUnixTime = vi.fn(async () => Math.floor(Date.now() / 1000));
const inspectSatCycleAccountExists = vi.fn(
  async (_config: unknown, _args: { cycleId: number }): Promise<boolean> => false,
);
const inspectSatMinerCycleAccountExists = vi.fn(
  async (_config: unknown, _args: CycleArgs): Promise<boolean> => false,
);
const inspectSatLamportBalance = vi.fn(async () => "3000000000");
const inspectSatRegistryReserveLamports = vi.fn(async () => ({
  address: "reserve",
  lamports: "200000000",
}));
const inspectSatTreasuryVaultLamports = vi.fn(async () => ({
  address: "treasury-vault",
  lamports: "0",
}));
const inspectSatRentExemptionLamports = vi.fn(async () => ({
  registryReserveTargetLamports: "200000000",
  protocolVaultLamports: "1",
  cycleStateLamports: "1614720",
  cycleRegistryMetaLamports: "1614720",
  cycleRegistryPageLamports: "15312000",
  cycleSettlementProgressLamports: "8184960",
  minerCycleLamports: "15312000",
  openCycleLamports: "3229440",
  submitCycleSharedLamports: "23496960",
  submitCycleSignerLamports: "15312000",
}));
const inspectSatGlobalState = vi.fn(async () => ({
  address: "global",
  cycleSeconds: 180,
  currentUnlockSolLamports: "5000000000",
  minimumEntryLamports: "250000000",
  cycleErosionPpm: 50,
}));
const inspectSatCycle = vi.fn(
  async (_config: unknown, _args: { cycleId: number }): Promise<CycleView | null> => null,
);
const inspectSatCycleRegistryMeta = vi.fn(
  async (_config: unknown, _args: { cycleId: number }): Promise<RegistryMeta | null> => null,
);
const inspectSatMinerCapital = vi.fn(
  async (..._args: unknown[]): Promise<unknown> => ({
    address: "capital",
    authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
    fundedLamports: "3000000000",
    lockedLamports: "0",
    freeLamports: "3000000000",
    activeCommitLamports: "250000000",
    firstPendingCycleId: 0,
    lastPendingCycleId: 0,
  }),
);
const inspectSatMinerCycle = vi.fn(
  async (_config: unknown, _args: CycleArgs): Promise<MinerCycleView | null> => null,
);
const computeMiningStrategy = vi.fn(
  async ({ config }: { config: { riskMode: string; strategyMode?: string } }) => ({
    source: config.strategyMode === "skill" ? "skill" : "base",
    allocationFp: new Array(25).fill(40_000),
    decidedAt: new Date().toISOString(),
    rationale: `risk=${config.riskMode}`,
  }),
);

vi.mock("./gateway-runner.js", () => ({
  runSatGatewayMethod: (args: GatewayMethodArgs) => runSatGatewayMethod(args),
}));

vi.mock("./rpc-read.js", () => ({
  inspectCurrentSatRoundBucket: () => inspectCurrentSatRoundBucket(),
  inspectSatChainUnixTime: () => inspectSatChainUnixTime(),
  inspectSatCycleAccountExists: (...args: Parameters<typeof inspectSatCycleAccountExists>) =>
    inspectSatCycleAccountExists(...args),
  inspectSatMinerCycleAccountExists: (
    ...args: Parameters<typeof inspectSatMinerCycleAccountExists>
  ) => inspectSatMinerCycleAccountExists(...args),
  inspectSatLamportBalance: (...args: Parameters<typeof inspectSatLamportBalance>) =>
    inspectSatLamportBalance(...args),
  inspectSatRegistryReserveLamports: (
    ...args: Parameters<typeof inspectSatRegistryReserveLamports>
  ) => inspectSatRegistryReserveLamports(...args),
  inspectSatTreasuryVaultLamports: (...args: Parameters<typeof inspectSatTreasuryVaultLamports>) =>
    inspectSatTreasuryVaultLamports(...args),
  inspectSatRentExemptionLamports: (...args: Parameters<typeof inspectSatRentExemptionLamports>) =>
    inspectSatRentExemptionLamports(...args),
  inspectSatGlobalState: (...args: Parameters<typeof inspectSatGlobalState>) =>
    inspectSatGlobalState(...args),
  inspectSatCycle: (...args: Parameters<typeof inspectSatCycle>) => inspectSatCycle(...args),
  inspectSatCycleRegistryMeta: (...args: Parameters<typeof inspectSatCycleRegistryMeta>) =>
    inspectSatCycleRegistryMeta(...args),
  inspectSatMinerCapital: (...args: Parameters<typeof inspectSatMinerCapital>) =>
    inspectSatMinerCapital(...args),
  inspectSatMinerCycle: (...args: Parameters<typeof inspectSatMinerCycle>) =>
    inspectSatMinerCycle(...args),
}));

vi.mock("./strategy-engine.js", () => ({
  computeMiningStrategy: (args: unknown) => computeMiningStrategy(args as never),
}));

describe("SAT economy cadence", () => {
  it("selects cycles relative to the immutable launch cycle", () => {
    expect(shouldParticipateInSatCycle({ cycleId: 100, launchCycleId: 100, cadence: 12 })).toBe(
      true,
    );
    expect(shouldParticipateInSatCycle({ cycleId: 111, launchCycleId: 100, cadence: 12 })).toBe(
      false,
    );
    expect(shouldParticipateInSatCycle({ cycleId: 112, launchCycleId: 100, cadence: 12 })).toBe(
      true,
    );
    expect(shouldParticipateInSatCycle({ cycleId: 99, launchCycleId: 100, cadence: 1 })).toBe(
      false,
    );
  });
});

describe("createSatRoundWatcherService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T12:00:00.000Z"));
    runSatGatewayMethod.mockReset();
    runSatGatewayMethod.mockResolvedValue({ ok: true });
    inspectCurrentSatRoundBucket.mockReset();
    inspectSatChainUnixTime.mockReset();
    inspectSatChainUnixTime.mockImplementation(async () => Math.floor(Date.now() / 1000));
    inspectSatCycleAccountExists.mockReset();
    inspectSatCycleAccountExists.mockResolvedValue(true);
    inspectSatMinerCycleAccountExists.mockReset();
    inspectSatMinerCycleAccountExists.mockResolvedValue(false);
    inspectSatLamportBalance.mockReset();
    inspectSatLamportBalance.mockResolvedValue("3000000000");
    inspectSatRegistryReserveLamports.mockReset();
    inspectSatRegistryReserveLamports.mockResolvedValue({
      address: "reserve",
      lamports: "200000000",
    });
    inspectSatTreasuryVaultLamports.mockReset();
    inspectSatTreasuryVaultLamports.mockResolvedValue({
      address: "treasury-vault",
      lamports: "0",
    });
    inspectSatRentExemptionLamports.mockReset();
    inspectSatRentExemptionLamports.mockResolvedValue({
      registryReserveTargetLamports: "200000000",
      protocolVaultLamports: "1",
      cycleStateLamports: "1614720",
      cycleRegistryMetaLamports: "1614720",
      cycleRegistryPageLamports: "15312000",
      cycleSettlementProgressLamports: "8184960",
      minerCycleLamports: "15312000",
      openCycleLamports: "3229440",
      submitCycleSharedLamports: "23496960",
      submitCycleSignerLamports: "15312000",
    });
    inspectSatGlobalState.mockReset();
    inspectSatGlobalState.mockResolvedValue({
      address: "global",
      cycleSeconds: 180,
      currentUnlockSolLamports: "5000000000",
      minimumEntryLamports: "250000000",
      cycleErosionPpm: 50,
    });
    process.env.FASED_SAT_PROGRAM_ID = "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75";
    process.env.FASED_SAT_BOND_PROGRAM_ID = "D1ySMMiJmvJRhJJKwYnc171w3g2JDPQnkgD8kGhaG4Vq";
    process.env.FASED_SAT_MINT_ADDRESS = "2AhikHhzJdv6uve1yUBSUmhRKWaSfa7exrsDsfKjVFKa";
    process.env.FASED_SAT_MINT_PROGRAM_ID = "8fb3Mpowe4pD6ed89gwm6gLuh8csPSrLi3hypcesqs5C";
    inspectSatCycle.mockReset();
    inspectSatCycle.mockImplementation(async (config, args) =>
      (await inspectSatCycleAccountExists(config, args)) ? createOpenCycleView(args.cycleId) : null,
    );
    inspectSatCycleRegistryMeta.mockReset();
    inspectSatCycleRegistryMeta.mockResolvedValue(null);
    inspectSatMinerCapital.mockReset();
    inspectSatMinerCapital.mockResolvedValue({
      address: "capital",
      authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
      fundedLamports: "3000000000",
      lockedLamports: "0",
      freeLamports: "3000000000",
      activeCommitLamports: "250000000",
    });
    inspectSatMinerCycle.mockReset();
    inspectSatMinerCycle.mockImplementation(async (config, args) =>
      (await inspectSatMinerCycleAccountExists(config, args))
        ? {
            address: `miner-cycle-${args.cycleId}`,
            cycleId: args.cycleId,
            commitment: "11".repeat(32),
            validParticipation: true,
          }
        : null,
    );
    computeMiningStrategy.mockClear();
  });

  afterEach(() => {
    delete process.env.FASED_SAT_PROGRAM_ID;
    delete process.env.FASED_SAT_BOND_PROGRAM_ID;
    delete process.env.FASED_SAT_MINT_ADDRESS;
    delete process.env.FASED_SAT_MINT_PROGRAM_ID;
    vi.useRealTimers();
  });

  it("submits exactly one cycle participation per tick", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.setActiveCommit",
      "sat.commitCycle",
    ]);

    await service.stop?.();
  });

  it("keeps round watcher marked running when a timer overlap lands during an in-flight tick", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    const cycleId = Math.floor(Date.now() / 1000 / 300);
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();
    runSatGatewayMethod.mockClear();
    const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
    execution.openRoundSubmitted = false;
    execution.commitSubmitted = false;
    execution.participationSubmitted = false;
    state.recentActions = [];
    state.workers.roundWatcher.nextScheduledAt = new Date().toISOString();
    let releaseFirstCall: (() => void) | null = null;
    runSatGatewayMethod.mockImplementationOnce(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          releaseFirstCall = () => resolve({ ok: true });
        }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.workers.roundWatcher.running).toBe(true);
    expect(state.workers.roundWatcher.lastDetail).toBe(`cycle ${cycleId}`);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.workers.roundWatcher.running).toBe(true);
    expect(state.workers.roundWatcher.waitingReason).toBe("previous cycle tick still running");
    expect(state.workers.roundWatcher.lastDetail).toBe(`cycle ${cycleId}`);

    let stopped = false;
    const stopPromise = service.stop?.().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    (releaseFirstCall as (() => void) | null)?.();
    await vi.advanceTimersByTimeAsync(0);
    await stopPromise;
    expect(stopped).toBe(true);
  });

  it("recovers when a chain read hangs instead of wedging the watcher forever", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    let firstRead = true;
    inspectSatChainUnixTime.mockImplementation(async () => {
      if (firstRead) {
        firstRead = false;
        return await new Promise<number>(() => {});
      }
      return Math.floor(Date.now() / 1000);
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    const startPromise = service.start();
    await vi.advanceTimersByTimeAsync(4_000);
    await startPromise;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.setActiveCommit",
      "sat.commitCycle",
    ]);
    expect(state.workers.roundWatcher.retryCount).toBe(0);
    expect(state.workers.roundWatcher.lastSuccessAt).not.toBeNull();

    await service.stop?.();
  });

  it("passes exact cycle payload into submitCycle", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(5_000);

    const participationCall = runSatGatewayMethod.mock.calls.find(
      (call) => call[0]?.method === "sat.commitCycle",
    );

    const setCommitCall = runSatGatewayMethod.mock.calls.find(
      (call) => call[0]?.method === "sat.setActiveCommit",
    );
    expect(setCommitCall?.[0]?.payload).toMatchObject({
      lamports: 250000000,
    });
    expect(participationCall?.[0]?.payload).toMatchObject({
      cycleId: expect.any(Number),
      commitmentHex: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const cycleId = (participationCall?.[0]?.payload as { cycleId?: number } | undefined)?.cycleId;
    expect(cycleId).toEqual(expect.any(Number));
    expect(getOrCreateRoundExecutionState(state, cycleId!, 0).allocationFp).toHaveLength(25);

    await service.stop?.();
  });

  it("does not rewrite active commit while a strategy-only freeze is active", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "aggressive" as const,
      strategyExecution: "deterministic" as const,
      commitLamports: 1_000_000_000,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    state.commitFreezeUntilMs = Date.now() + 600_000;
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.commitCycle",
    ]);
    expect(runSatGatewayMethod.mock.calls[0]?.[0]?.payload).toMatchObject({
      cycleId: expect.any(Number),
    });

    await service.stop?.();
  });

  it("skips instead of reducing submit size while a strategy-only freeze is active", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "aggressive" as const,
      strategyExecution: "deterministic" as const,
      commitLamports: 1_000_000_000,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    state.commitFreezeUntilMs = Date.now() + 600_000;
    inspectSatMinerCapital.mockResolvedValue({
      address: "capital",
      authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
      fundedLamports: "1200000000",
      lockedLamports: "0",
      freeLamports: "900000000",
      activeCommitLamports: "1000000000",
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([]);
    expect(state.workers.roundWatcher.waitingReason).toContain(
      "strategy-only commit freeze kept active commit",
    );

    await service.stop?.();
  });

  it("does not submit duplicate cycle participation for the same cycle", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    const cycleId = Math.floor(Date.now() / 1000 / 300);
    getOrCreateRoundExecutionState(state, cycleId, 0).participationSubmitted = true;
    getOrCreateRoundExecutionState(state, cycleId, 0).openRoundSubmitted = true;
    inspectSatMinerCycleAccountExists.mockResolvedValue(true);
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(
      runSatGatewayMethod.mock.calls.filter((call) => call[0]?.method === "sat.commitCycle"),
    ).toHaveLength(0);

    await service.stop?.();
  });

  it("seals entropy before applying the missed-reveal penalty after an expired deadline", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    const authority = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    state.activeWalletAddress = authority;
    const cycleId = Math.floor(Date.now() / 1000 / 300);
    const nowSec = cycleId * 300 + 280;
    inspectSatChainUnixTime.mockResolvedValue(nowSec);
    const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
    execution.openRoundSubmitted = true;
    execution.commitSubmitted = true;
    execution.commitmentHex = "11".repeat(32);
    execution.revealNonceBase64 = Buffer.alloc(32, 7).toString("base64");
    execution.allocationFp = new Array(25).fill(40_000);
    execution.commitLamports = 250_000_000;
    state.recentActions.push({
      action: "commitCycle",
      status: "success",
      at: new Date().toISOString(),
      cycleId,
      txHash: "tx-commit",
    });
    inspectSatMinerCycle.mockResolvedValue({
      address: `miner-cycle-${cycleId}`,
      cycleId,
      commitment: execution.commitmentHex,
      validParticipation: false,
    });
    inspectSatCycle
      .mockResolvedValueOnce({
        ...createOpenCycleView(cycleId),
        status: 1,
        cycleSeed: "0".repeat(64),
        entropyTargetSlot: 123,
        revealDeadlineTs: nowSec - 10,
        committedMinerCount: "1",
      })
      .mockResolvedValueOnce({
        ...createOpenCycleView(cycleId),
        status: 1,
        cycleSeed: "7".repeat(64),
        entropyTargetSlot: 125,
        revealDeadlineTs: nowSec - 10,
        committedMinerCount: "1",
      });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.sealCycleEntropy",
    ]);
    expect(execution.entropySealed).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.sealCycleEntropy",
      "sat.releaseUnrevealedCommit",
    ]);
    expect(execution.entropySealed).toBe(true);
    expect(execution.participationSubmitted).toBe(false);

    await service.stop?.();
  });

  it("unwinds an unprovable entropy cycle without attempting a reveal", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    const authority = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    state.activeWalletAddress = authority;
    const cycleId = Math.floor(Date.now() / 1000 / 300);
    const nowSec = cycleId * 300 + 180;
    inspectSatChainUnixTime.mockResolvedValue(nowSec);
    const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
    execution.openRoundSubmitted = true;
    execution.commitSubmitted = true;
    execution.commitmentHex = "11".repeat(32);
    execution.revealNonceBase64 = Buffer.alloc(32, 7).toString("base64");
    execution.allocationFp = new Array(25).fill(40_000);
    execution.commitLamports = 250_000_000;
    state.recentActions.push({
      action: "commitCycle",
      status: "success",
      at: new Date().toISOString(),
      cycleId,
      txHash: "tx-commit",
    });
    inspectSatMinerCycle.mockResolvedValue({
      address: `miner-cycle-${cycleId}`,
      cycleId,
      commitment: execution.commitmentHex,
      validParticipation: false,
    });
    inspectSatCycle.mockResolvedValue({
      ...createOpenCycleView(cycleId),
      status: 1,
      cycleSeed: "ff".repeat(32),
      entropyUnavailable: true,
      entropyTargetSlot: 123,
      commitDeadlineTs: nowSec - 10,
      revealDeadlineTs: nowSec + 100,
      committedMinerCount: "1",
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.releaseUnrevealedCommit",
    ]);
    expect(execution.entropySealed).toBe(false);
    expect(execution.participationSubmitted).toBe(false);
    expect(state.workers.roundWatcher.lastDetail).toContain("released without penalty");

    await service.stop?.();
  });

  it("keeps the cycle window retryable when a chain read times out", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    let firstRead = true;
    inspectSatChainUnixTime.mockImplementation(async () => {
      if (firstRead) {
        firstRead = false;
        return await new Promise<number>(() => {});
      }
      return Math.floor(Date.now() / 1000);
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    const startPromise = service.start();
    await vi.advanceTimersByTimeAsync(4_000);
    await startPromise;

    expect(runSatGatewayMethod).not.toHaveBeenCalled();
    expect(state.workers.roundWatcher.retryCount).toBe(0);
    expect(state.workers.roundWatcher.rpcTimeoutCount).toBe(1);
    expect(state.workers.roundWatcher.lastError).toBeNull();
    expect(state.workers.roundWatcher.waitingReason).toContain("authoritative chain clock");

    await vi.advanceTimersByTimeAsync(5_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.setActiveCommit",
      "sat.commitCycle",
    ]);
    expect(state.workers.roundWatcher.lastSuccessAt).not.toBeNull();

    await service.stop?.();
  });

  it("does not re-bootstrap reserve for a cycle that local runtime already marked as submitted", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    const cycleId = Math.floor(Date.now() / 1000 / 300);
    const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
    execution.openRoundSubmitted = true;
    execution.participationSubmitted = true;
    state.recentActions = [
      {
        action: "commitCycle",
        cycleId,
        txHash: "tx-submit",
        status: "success",
        at: new Date().toISOString(),
      },
    ];
    inspectSatCycleAccountExists.mockResolvedValue(false);
    inspectSatMinerCycleAccountExists.mockResolvedValue(false);
    inspectSatRegistryReserveLamports.mockResolvedValue({
      address: "reserve",
      lamports: "1000000",
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(
      runSatGatewayMethod.mock.calls.filter(
        (call) =>
          call[0]?.method === "sat.topUpRegistryReserve" ||
          call[0]?.method === "sat.openCycle" ||
          call[0]?.method === "sat.commitCycle",
      ),
    ).toHaveLength(0);

    await service.stop?.();
  });

  it("reconciles stale local participation flags from chain truth before submitting the current cycle", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    const cycleId = Math.floor(Date.now() / 1000 / 300);
    const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
    execution.openRoundSubmitted = true;
    execution.participationSubmitted = true;
    inspectSatMinerCycleAccountExists.mockResolvedValue(false);
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.setActiveCommit",
      "sat.commitCycle",
    ]);
    expect(getOrCreateRoundExecutionState(state, cycleId, 0).commitSubmitted).toBe(true);
    expect(getOrCreateRoundExecutionState(state, cycleId, 0).participationSubmitted).toBe(false);
    expect(state.workers.roundWatcher.retryCount).toBe(0);

    await service.stop?.();
  });

  it("skips submitCycle when miner cycle account already exists on-chain", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatMinerCycleAccountExists.mockResolvedValueOnce(true);
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([]);

    await service.stop?.();
  });

  it("uses chain unix time instead of local wall clock when selecting the current cycle", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    const localNowSec = Math.floor(Date.now() / 1000);
    inspectSatChainUnixTime.mockResolvedValue(localNowSec - 300);
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(5_000);

    const participationCall = runSatGatewayMethod.mock.calls.find(
      (call) => call[0]?.method === "sat.commitCycle",
    );
    expect(participationCall?.[0]?.payload).toMatchObject({
      cycleId: Math.floor((localNowSec - 300) / 300),
    });

    await service.stop?.();
  });

  it("reconstructs submitted participation from chain state after restart without resubmitting", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatMinerCycleAccountExists.mockResolvedValueOnce(true);
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    const cycleId = Math.floor(Date.now() / 1000 / 300);
    const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
    expect(execution.openRoundSubmitted).toBe(true);
    expect(execution.commitSubmitted).toBe(true);
    expect(execution.participationSubmitted).toBe(true);
    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([]);

    await service.stop?.();
  });

  it("keeps cycle submission moving without relying on round-bucket inspection", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.setActiveCommit",
      "sat.commitCycle",
    ]);

    await service.stop?.();
  });

  it("reconciles local participation state when submitCycle reports the cycle is already initialized", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatMinerCycleAccountExists.mockResolvedValueOnce(false).mockResolvedValue(true);
    runSatGatewayMethod.mockImplementation(async (args: unknown) => {
      const method = (args as { method?: string })?.method;
      if (method === "sat.commitCycle") {
        throw new Error("AccountAlreadyInitialized: instruction requires an uninitialized account");
      }
      return { ok: true };
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(5_000);

    const cycleId = Math.floor(Date.now() / 1000 / 300);
    const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
    expect(execution.openRoundSubmitted).toBe(true);
    expect(execution.commitSubmitted).toBe(true);
    expect(execution.participationSubmitted).toBe(true);
    expect(state.workers.roundWatcher.retryCount).toBe(0);
    expect(runSatGatewayMethod).toHaveBeenCalledTimes(2);

    await service.stop?.();
  });

  it("does not falsely reconcile local state when submitCycle fails with invalid account data", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    runSatGatewayMethod.mockImplementation(async (args: unknown) => {
      const method = (args as { method?: string })?.method;
      if (method === "sat.commitCycle") {
        throw new Error("InvalidAccountData: miner slot still has unclaimed rewards");
      }
      return { ok: true };
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    const cycleId = Math.floor(Date.now() / 1000 / 300);
    const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
    expect(execution.openRoundSubmitted).toBe(true);
    expect(execution.participationSubmitted).toBe(false);
    expect(state.workers.roundWatcher.retryCount).toBe(1);
    expect(state.workers.roundWatcher.lastError).toContain("InvalidAccountData");

    await service.stop?.();
  });

  it("backs off cycle reads when the RPC provider quota is exhausted", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    runSatGatewayMethod.mockImplementation(async (args: unknown) => {
      const method = (args as { method?: string })?.method;
      if (method === "sat.commitCycle") {
        throw new Error("RPC error -32429: max usage reached");
      }
      return { ok: true };
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(state.workers.roundWatcher.retryCount).toBe(1);
    expect(state.workers.roundWatcher.waitingReason).toContain("backing off 60s");
    expect(Date.parse(state.workers.roundWatcher.nextScheduledAt ?? "") - Date.now()).toBe(60_000);
    expect(
      runSatGatewayMethod.mock.calls.filter((call) => call[0]?.method === "sat.commitCycle"),
    ).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(55_000);
    expect(
      runSatGatewayMethod.mock.calls.filter((call) => call[0]?.method === "sat.commitCycle"),
    ).toHaveLength(1);

    await service.stop?.();
  });

  it("reconciles a timed-out submit that later appears on-chain without sending a duplicate", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    const cycleId = Math.floor(Date.now() / 1000 / 300);
    let landedAfterTimeout = false;
    inspectSatMinerCycleAccountExists.mockImplementation(async () => landedAfterTimeout);
    runSatGatewayMethod.mockImplementation(async (args: unknown) => {
      const method = (args as { method?: string })?.method;
      if (method === "sat.commitCycle") {
        landedAfterTimeout = true;
        throw new Error("gateway timeout waiting for submit confirmation");
      }
      return { ok: true };
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(
      runSatGatewayMethod.mock.calls.filter((call) => call[0]?.method === "sat.commitCycle"),
    ).toHaveLength(1);
    expect(getOrCreateRoundExecutionState(state, cycleId, 0).participationSubmitted).toBe(false);
    expect(state.workers.roundWatcher.retryCount).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(
      runSatGatewayMethod.mock.calls.filter((call) => call[0]?.method === "sat.commitCycle"),
    ).toHaveLength(1);
    expect(getOrCreateRoundExecutionState(state, cycleId, 0).commitSubmitted).toBe(true);
    expect(getOrCreateRoundExecutionState(state, cycleId, 0).participationSubmitted).toBe(true);
    expect(state.workers.roundWatcher.retryCount).toBe(0);
    expect(state.workers.roundWatcher.lastError).toBeNull();

    await service.stop?.();
  });

  it("keeps a blockhash-expired submit retryable until chain truth confirms participation", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    const cycleId = Math.floor(Date.now() / 1000 / 300);
    inspectSatMinerCycleAccountExists.mockResolvedValue(false);
    runSatGatewayMethod.mockImplementation(async (args: unknown) => {
      const method = (args as { method?: string })?.method;
      if (
        method === "sat.commitCycle" &&
        runSatGatewayMethod.mock.calls.filter((call) => call[0]?.method === "sat.commitCycle")
          .length === 1
      ) {
        throw new Error("TransactionExpiredBlockheightExceededError: blockhash expired");
      }
      return { ok: true };
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(getOrCreateRoundExecutionState(state, cycleId, 0).participationSubmitted).toBe(false);
    expect(state.workers.roundWatcher.retryCount).toBe(1);
    expect(state.workers.roundWatcher.lastError).toContain("blockhash expired");

    await vi.advanceTimersByTimeAsync(5_000);

    expect(
      runSatGatewayMethod.mock.calls.filter((call) => call[0]?.method === "sat.commitCycle"),
    ).toHaveLength(2);
    expect(getOrCreateRoundExecutionState(state, cycleId, 0).commitSubmitted).toBe(true);
    expect(getOrCreateRoundExecutionState(state, cycleId, 0).participationSubmitted).toBe(false);
    expect(state.workers.roundWatcher.retryCount).toBe(0);

    await service.stop?.();
  });

  it("opens the current cycle on-chain before submitting when the cycle state is missing", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatCycleAccountExists.mockResolvedValue(false);
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    const cycleId = Math.floor(Date.now() / 1000 / 300);
    const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.openCycle",
      "sat.setActiveCommit",
      "sat.commitCycle",
    ]);
    expect(execution.openRoundSubmitted).toBe(true);
    expect(execution.commitSubmitted).toBe(true);
    expect(execution.participationSubmitted).toBe(false);

    await service.stop?.();
  });

  it("uses the local 83 ppm fallback when global metadata still reports stale 180/50 values", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      commitLamports: 250_000_000,
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatCycleAccountExists.mockResolvedValue(false);
    inspectSatGlobalState.mockResolvedValue({
      address: "global",
      cycleSeconds: 180,
      currentUnlockSolLamports: "5000000000",
      minimumEntryLamports: "250000000",
      cycleErosionPpm: 50,
    });
    inspectSatMinerCapital.mockResolvedValue({
      address: "capital",
      authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
      fundedLamports: "3000000000",
      lockedLamports: "0",
      freeLamports: "250015000",
      activeCommitLamports: "250000000",
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(runSatGatewayMethod).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "sat.commitCycle" }),
    );
    expect(state.workers.roundWatcher.waitingReason).toContain(
      "cannot cover commit plus worst-case reveal collateral",
    );

    await service.stop?.();
  });

  it("reduces a high configured commit to the safe minimum instead of missing the cycle", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      commitLamports: 9_275_000_000,
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatMinerCapital.mockResolvedValue({
      address: "capital",
      authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
      fundedLamports: "10493000000",
      lockedLamports: "0",
      freeLamports: "252600000",
      activeCommitLamports: "6075000000",
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.setActiveCommit",
      "sat.commitCycle",
    ]);
    const setCommitCall = runSatGatewayMethod.mock.calls.find(
      (call) => call[0]?.method === "sat.setActiveCommit",
    );
    expect(setCommitCall?.[0]?.payload).toMatchObject({
      lamports: 250000000,
      persistConfig: false,
    });

    await service.stop?.();
  });

  it("keeps a minimum-entry continuity reserve when target commit would lock almost all capital", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      commitLamports: 9_970_000_000,
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatGlobalState.mockResolvedValue({
      address: "global",
      cycleSeconds: 180,
      currentUnlockSolLamports: "5000000000",
      minimumEntryLamports: "0",
      cycleErosionPpm: 50,
    });
    inspectSatMinerCapital.mockResolvedValue({
      address: "capital",
      authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
      fundedLamports: "9969867331",
      lockedLamports: "0",
      freeLamports: "9969867331",
      activeCommitLamports: "9945000000",
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.setActiveCommit",
      "sat.commitCycle",
    ]);
    const setCommitCall = runSatGatewayMethod.mock.calls.find(
      (call) => call[0]?.method === "sat.setActiveCommit",
    );
    expect(setCommitCall?.[0]?.payload).toMatchObject({
      lamports: 9620000000,
      persistConfig: false,
    });

    await service.stop?.();
  });

  it("does not let a max-capital target consume the whole funded balance", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      commitLamports: 10_000_000_000,
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatGlobalState.mockResolvedValue({
      address: "global",
      cycleSeconds: 300,
      currentUnlockSolLamports: "5000000000",
      minimumEntryLamports: "250000000",
      cycleErosionPpm: 83,
    });
    inspectSatMinerCapital.mockResolvedValue({
      address: "capital",
      authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
      fundedLamports: "10000000000",
      lockedLamports: "0",
      freeLamports: "10000000000",
      activeCommitLamports: "10000000000",
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.setActiveCommit",
      "sat.commitCycle",
    ]);
    const setCommitCall = runSatGatewayMethod.mock.calls.find(
      (call) => call[0]?.method === "sat.setActiveCommit",
    );
    expect(setCommitCall?.[0]?.payload).toMatchObject({
      lamports: 9650000000,
      persistConfig: false,
    });

    await service.stop?.();
  });

  it("does not start duplicate round watcher timers when start is called twice", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatCycleAccountExists.mockResolvedValue(false);
    inspectSatMinerCycleAccountExists.mockResolvedValue(false);
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();
    await service.start();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(
      runSatGatewayMethod.mock.calls.filter((call) => call[0]?.method === "sat.commitCycle"),
    ).toHaveLength(1);

    await service.stop?.();
  });

  it("tops up the protocol reserve before opening and submitting a new cycle when reserve is low", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatCycleAccountExists.mockResolvedValue(false);
    inspectSatRegistryReserveLamports.mockResolvedValue({
      address: "reserve",
      lamports: "1000000",
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.topUpRegistryReserve",
      "sat.openCycle",
      "sat.setActiveCommit",
      "sat.commitCycle",
    ]);

    await service.stop?.();
  });

  it("does not bootstrap reserve from the wallet when treasury vault can cover the shortfall", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatCycleAccountExists.mockResolvedValue(false);
    inspectSatRegistryReserveLamports.mockResolvedValue({
      address: "reserve",
      lamports: "1000000",
    });
    inspectSatTreasuryVaultLamports.mockResolvedValue({
      address: "treasury-vault",
      lamports: "500000000",
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.refillRegistryReserveFromTreasury",
      "sat.openCycle",
      "sat.setActiveCommit",
      "sat.commitCycle",
    ]);

    await service.stop?.();
  });

  it("auto-withdraws free miner capital back into the wallet before topping up reserve and submitting", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatCycleAccountExists.mockResolvedValue(false);
    inspectSatLamportBalance.mockResolvedValue("160000000");
    inspectSatRegistryReserveLamports.mockResolvedValue({
      address: "reserve",
      lamports: "1000000",
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.withdrawMinerCapital",
      "sat.topUpRegistryReserve",
      "sat.openCycle",
      "sat.setActiveCommit",
      "sat.commitCycle",
    ]);

    await service.stop?.();
  });

  it("waits without spamming submit when free miner capital cannot cover cycle operating rent", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatCycleAccountExists.mockResolvedValue(false);
    inspectSatLamportBalance.mockResolvedValue("160000000");
    inspectSatRegistryReserveLamports.mockResolvedValue({
      address: "reserve",
      lamports: "1000000",
    });
    inspectSatRentExemptionLamports.mockResolvedValue({
      registryReserveTargetLamports: "200000000",
      protocolVaultLamports: "1",
      cycleStateLamports: "1614720",
      cycleRegistryMetaLamports: "1614720",
      cycleRegistryPageLamports: "15312000",
      cycleSettlementProgressLamports: "8184960",
      minerCycleLamports: "15312000",
      openCycleLamports: "3229440",
      submitCycleSharedLamports: "23496960",
      submitCycleSignerLamports: "400000000",
    });
    inspectSatMinerCapital.mockResolvedValue({
      address: "capital",
      authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
      fundedLamports: "3000000000",
      lockedLamports: "2700000000",
      freeLamports: "300000000",
      activeCommitLamports: "250000000",
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(runSatGatewayMethod).not.toHaveBeenCalled();
    expect(state.workers.roundWatcher.retryCount).toBe(0);
    expect(state.workers.roundWatcher.waitingReason).toContain("free miner capital must cover");

    await service.stop?.();
  });

  it("does not attempt submit when setActiveCommit fails at the on-chain boundary", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      commitLamports: 300_000_000,
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    runSatGatewayMethod.mockImplementation(async (args: unknown) => {
      const method = (args as { method?: string })?.method;
      if (method === "sat.setActiveCommit") {
        throw new Error("InsufficientFunds: active commit exceeds funded capital");
      }
      return { ok: true };
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    const cycleId = Math.floor(Date.now() / 1000 / 300);
    const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
    expect(
      runSatGatewayMethod.mock.calls.filter((call) => call[0]?.method === "sat.setActiveCommit"),
    ).toHaveLength(1);
    expect(
      runSatGatewayMethod.mock.calls.filter((call) => call[0]?.method === "sat.commitCycle"),
    ).toHaveLength(0);
    expect(execution.openRoundSubmitted).toBe(true);
    expect(execution.participationSubmitted).toBe(false);
    expect(state.workers.roundWatcher.retryCount).toBe(1);
    expect(state.workers.roundWatcher.lastError).toContain("InsufficientFunds");

    await service.stop?.();
  });

  it("uses current cycle id in submitCycle payload", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(5_000);

    const participationCall = runSatGatewayMethod.mock.calls.find(
      (call) => call[0]?.method === "sat.commitCycle",
    );
    const expectedCycleId = Math.floor(Date.now() / 1000 / 300);
    expect(participationCall?.[0]?.payload).toMatchObject({
      cycleId: expectedCycleId,
    });

    await service.stop?.();
  });

  it("skips stale submissions when the cycle advances before submit", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;
    const baseNowSec = Math.floor(Date.now() / 1000);
    const advancedNowSec = baseNowSec + 301;
    inspectSatChainUnixTime.mockResolvedValueOnce(baseNowSec).mockResolvedValueOnce(advancedNowSec);

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(runSatGatewayMethod).not.toHaveBeenCalled();
    expect(state.workers.roundWatcher.retryCount).toBe(0);
    expect(state.workers.roundWatcher.waitingReason).toContain("cycle advanced");

    await service.stop?.();
  });

  it("treats submitCycle cycle mismatch as a retryable rollover", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    runSatGatewayMethod.mockImplementation(async (args: unknown) => {
      const method = (args as { method?: string })?.method;
      if (method === "sat.commitCycle") {
        throw new Error(
          "Transaction simulation failed: Program log: submit_cycle cycle mismatch: requested=1, current=2",
        );
      }
      return { ok: true };
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(state.workers.roundWatcher.retryCount).toBe(0);
    expect(state.workers.roundWatcher.lastError).toBeNull();
    expect(state.workers.roundWatcher.waitingReason).toContain("rolled");

    await service.stop?.();
  });

  it("does not crash the worker when round context resolution fails", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    inspectCurrentSatRoundBucket.mockImplementation(async () => {
      throw new Error("round-bucket lookup failed");
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(state.workers.roundWatcher.lastError ?? "").not.toContain("context is not defined");
    expect(state.workers.roundWatcher.running).toBe(false);

    await service.stop?.();
  });

  it("submits participation when mining is active", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.setActiveCommit",
      "sat.commitCycle",
    ]);
    expect(state.workers.roundWatcher.lastDetail ?? "").toContain("cycle");

    await service.stop?.();
  });

  it("uses auto planner sizing and preset selection before submit", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      strategyExecution: "auto" as const,
      strategyMode: "skill" as const,
      strategyPreset: "balanced" as const,
      commitLamports: 250_000_000,
      minSolBalanceLamports: 1_000_000_000,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatCycle.mockResolvedValueOnce({
      address: "cycle",
      cycleId: 0,
      openTs: 0,
      closeTs: 0,
      status: 1,
      unlockTargetLamports: "5000000000",
      totalCommittedLamports: "1200000000",
      validMinerCount: "6",
      unlockRatioFp: "240000",
      issuedCycleMinerSatRaw: "0",
      unissuedCycleMinerSatRaw: "0",
      solErosionPoolLamports: "0",
      deterministicRebatePoolLamports: "0",
      performanceRebatePoolLamports: "0",
      treasurySolLamports: "0",
    });
    inspectSatCycleRegistryMeta.mockResolvedValueOnce({
      address: "meta",
      cycleId: 0,
      participantCount: 6,
      pageCount: 1,
    });
    inspectSatMinerCapital.mockResolvedValueOnce({
      address: "capital",
      authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
      fundedLamports: "1000000000",
      lockedLamports: "0",
      freeLamports: "1000000000",
      activeCommitLamports: "250000000",
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(5_000);

    const setCommitCall = runSatGatewayMethod.mock.calls.find(
      (call) => call[0]?.method === "sat.setActiveCommit",
    );
    const submitCall = runSatGatewayMethod.mock.calls.find(
      (call) => call[0]?.method === "sat.commitCycle",
    );
    expect(setCommitCall?.[0]?.payload).toMatchObject({
      lamports: 250000000,
    });
    expect(submitCall?.[0]?.payload).toMatchObject({
      cycleId: expect.any(Number),
    });
    expect(state.lastPlannerDecision?.strategyPreset).toBe("top_k");
    expect(computeMiningStrategy.mock.calls[0]?.[0]?.config?.riskMode).toBe("aggressive");
    expect(
      (computeMiningStrategy.mock.calls[0]?.[0] as { liveContext?: unknown } | undefined)
        ?.liveContext,
    ).toEqual(
      expect.objectContaining({
        currentCycleId: expect.any(Number),
        participantCount: expect.any(Number),
        recentOutcomes: expect.any(Array),
      }),
    );

    await service.stop?.();
  });

  it("reduces auto commit when live free capital drops before submit", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      strategyExecution: "auto" as const,
      strategyMode: "skill" as const,
      strategyPreset: "balanced" as const,
      commitLamports: 250_000_000,
      minSolBalanceLamports: 1_000_000_000,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatCycle.mockResolvedValueOnce({
      address: "cycle",
      cycleId: 0,
      openTs: 0,
      closeTs: 0,
      status: 1,
      unlockTargetLamports: "5000000000",
      totalCommittedLamports: "1200000000",
      validMinerCount: "6",
      unlockRatioFp: "240000",
      issuedCycleMinerSatRaw: "0",
      unissuedCycleMinerSatRaw: "0",
      solErosionPoolLamports: "0",
      deterministicRebatePoolLamports: "0",
      performanceRebatePoolLamports: "0",
      treasurySolLamports: "0",
    });
    inspectSatCycleRegistryMeta.mockResolvedValueOnce({
      address: "meta",
      cycleId: 0,
      participantCount: 6,
      pageCount: 1,
    });
    inspectSatMinerCapital
      .mockResolvedValueOnce({
        address: "capital",
        authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
        fundedLamports: "1000000000",
        lockedLamports: "0",
        freeLamports: "1000000000",
        activeCommitLamports: "250000000",
      })
      .mockResolvedValueOnce({
        address: "capital",
        authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
        fundedLamports: "340000000",
        lockedLamports: "0",
        freeLamports: "340000000",
        activeCommitLamports: "250000000",
      });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(5_000);

    const setCommitCall = runSatGatewayMethod.mock.calls.find(
      (call) => call[0]?.method === "sat.setActiveCommit",
    );
    expect(setCommitCall?.[0]?.payload).toMatchObject({
      lamports: 250000000,
    });
    expect(state.lastPlannerDecision?.commitLamports).toBe(250000000);

    await service.stop?.();
  });

  it("auto-withdraws from free miner capital instead of skipping when auto planner hits wallet reserve", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      strategyExecution: "auto" as const,
      strategyMode: "skill" as const,
      strategyPreset: "balanced" as const,
      commitLamports: 250_000_000,
      minSolBalanceLamports: 1_000_000_000,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatLamportBalance.mockResolvedValue("1000000000");
    inspectSatMinerCapital.mockResolvedValueOnce({
      address: "capital",
      authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
      fundedLamports: "1000000000",
      lockedLamports: "0",
      freeLamports: "1000000000",
      activeCommitLamports: "250000000",
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toContain(
      "sat.withdrawMinerCapital",
    );
    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toContain(
      "sat.commitCycle",
    );
    expect(state.lastPlannerDecision).toMatchObject({
      shouldSubmit: true,
    });

    await service.stop?.();
  });

  it("skips deterministic submit when free miner capital is below minimum entry", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatMinerCapital.mockResolvedValue({
      address: "capital",
      authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
      fundedLamports: "200000000",
      lockedLamports: "0",
      freeLamports: "200000000",
      activeCommitLamports: "250000000",
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(
      runSatGatewayMethod.mock.calls.filter((call) => call[0]?.method === "sat.commitCycle"),
    ).toHaveLength(0);
    expect(state.workers.roundWatcher.waitingReason).toContain("below minimum entry");

    await service.stop?.();
  });

  it("reduces deterministic submit when free miner capital is below active commit", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      commitLamports: 300_000_000,
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatMinerCapital.mockResolvedValue({
      address: "capital",
      authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
      fundedLamports: "510000000",
      lockedLamports: "250000000",
      freeLamports: "260000000",
      activeCommitLamports: "300000000",
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.setActiveCommit",
      "sat.commitCycle",
    ]);
    const setCommitCall = runSatGatewayMethod.mock.calls.find(
      (call) => call[0]?.method === "sat.setActiveCommit",
    );
    expect(setCommitCall?.[0]?.payload).toMatchObject({
      lamports: 250000000,
      persistConfig: false,
    });

    await service.stop?.();
  });

  it("waits for recovery when two pending cycles already hold locked capital", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      commitLamports: 300_000_000,
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatMinerCapital.mockResolvedValue({
      address: "capital",
      authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
      fundedLamports: "13887000000",
      lockedLamports: "13850000000",
      freeLamports: "37000000",
      activeCommitLamports: "5650000000",
      firstPendingCycleId: 9862636,
      lastPendingCycleId: 9862637,
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(
      runSatGatewayMethod.mock.calls.filter((call) => call[0]?.method === "sat.commitCycle"),
    ).toHaveLength(0);
    expect(state.workers.roundWatcher.waitingReason).toContain(
      "pending cycle range 9862636-9862637 still leaves 13.850 SOL locked",
    );

    await service.stop?.();
  });

  it("does not block new submits on a stale pending range once locked capital is already zero", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      commitLamports: 4_090_000_000,
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatMinerCapital.mockResolvedValue({
      address: "capital",
      authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
      fundedLamports: "5600000000",
      lockedLamports: "0",
      freeLamports: "5600000000",
      activeCommitLamports: "4090000000",
      firstPendingCycleId: 5918111,
      lastPendingCycleId: 5918142,
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(
      runSatGatewayMethod.mock.calls.some((call) => call[0]?.method === "sat.commitCycle"),
    ).toBe(true);
    expect(state.workers.roundWatcher.waitingReason ?? "").not.toContain(
      "recovery is draining the backlog before new submits",
    );

    await service.stop?.();
  });

  it("does not block new submits on a stale pending-range prefix when local runtime only has one unresolved cycle", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      commitLamports: 4_090_000_000,
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const submittedCycleId = currentCycleId - 1;
    state.recentActions.unshift({
      action: "commitCycle",
      cycleId: submittedCycleId,
      txHash: "tx-submit",
      status: "success",
      at: new Date().toISOString(),
    });
    inspectSatMinerCapital.mockResolvedValue({
      address: "capital",
      authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
      fundedLamports: "8200000000",
      lockedLamports: "3050000000",
      freeLamports: "5150000000",
      activeCommitLamports: "4090000000",
      firstPendingCycleId: submittedCycleId - 100,
      lastPendingCycleId: submittedCycleId,
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(
      runSatGatewayMethod.mock.calls.some((call) => call[0]?.method === "sat.commitCycle"),
    ).toBe(true);
    expect(state.workers.roundWatcher.waitingReason ?? "").not.toContain(
      "recovery is draining the backlog before new submits",
    );

    await service.stop?.();
  });

  it("uses a lowered configured commit even when the old active commit is still higher on-chain", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      commitLamports: 250_000_000,
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatMinerCapital.mockResolvedValue({
      address: "capital",
      authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
      fundedLamports: "550000000",
      lockedLamports: "250000000",
      freeLamports: "260000000",
      activeCommitLamports: "300000000",
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.setActiveCommit",
      "sat.commitCycle",
    ]);
    const setCommitCall = runSatGatewayMethod.mock.calls.find(
      (call) => call[0]?.method === "sat.setActiveCommit",
    );
    expect(setCommitCall?.[0]?.payload).toMatchObject({
      lamports: 250000000,
    });

    await service.stop?.();
  });

  it("reduces deterministic commit when live free capital drops before submit", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      commitLamports: 400_000_000,
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatMinerCapital
      .mockResolvedValueOnce({
        address: "capital",
        authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
        fundedLamports: "1000000000",
        lockedLamports: "0",
        freeLamports: "1000000000",
        activeCommitLamports: "400000000",
      })
      .mockResolvedValueOnce({
        address: "capital",
        authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
        fundedLamports: "1000000000",
        lockedLamports: "0",
        freeLamports: "1000000000",
        activeCommitLamports: "400000000",
      })
      .mockResolvedValueOnce({
        address: "capital",
        authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
        fundedLamports: "340000000",
        lockedLamports: "0",
        freeLamports: "340000000",
        activeCommitLamports: "400000000",
      })
      .mockResolvedValueOnce({
        address: "capital",
        authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
        fundedLamports: "340000000",
        lockedLamports: "0",
        freeLamports: "340000000",
        activeCommitLamports: "400000000",
      });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.setActiveCommit",
      "sat.commitCycle",
    ]);
    const setCommitCall = runSatGatewayMethod.mock.calls.find(
      (call) => call[0]?.method === "sat.setActiveCommit",
    );
    expect(setCommitCall?.[0]?.payload).toMatchObject({
      lamports: 325000000,
    });

    await service.stop?.();
  });

  it("skips submit when live free capital cannot cover commit plus reveal collateral", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      commitLamports: 250_000_000,
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatMinerCapital
      .mockResolvedValueOnce({
        address: "capital",
        authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
        fundedLamports: "300000000",
        lockedLamports: "0",
        freeLamports: "300000000",
        activeCommitLamports: "250000000",
      })
      .mockResolvedValueOnce({
        address: "capital",
        authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
        fundedLamports: "300000000",
        lockedLamports: "0",
        freeLamports: "300000000",
        activeCommitLamports: "250000000",
      })
      .mockResolvedValueOnce({
        address: "capital",
        authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
        fundedLamports: "250000000",
        lockedLamports: "0",
        freeLamports: "250000000",
        activeCommitLamports: "250000000",
      })
      .mockResolvedValueOnce({
        address: "capital",
        authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
        fundedLamports: "250000000",
        lockedLamports: "0",
        freeLamports: "250000000",
        activeCommitLamports: "250000000",
      });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(
      runSatGatewayMethod.mock.calls.filter((call) => call[0]?.method === "sat.commitCycle"),
    ).toHaveLength(0);
    expect(state.workers.roundWatcher.waitingReason).toContain(
      "cover commit plus worst-case reveal collateral",
    );

    await service.stop?.();
  });

  it("keeps only a minimum continuity reserve while one pending cycle can still accept another submit", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      commitLamports: 5_650_000_000,
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatMinerCapital
      .mockResolvedValueOnce({
        address: "capital",
        authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
        fundedLamports: "13887000000",
        lockedLamports: "8225000000",
        freeLamports: "5662000000",
        activeCommitLamports: "5650000000",
        firstPendingCycleId: 9862636,
        lastPendingCycleId: 9862636,
      })
      .mockResolvedValueOnce({
        address: "capital",
        authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
        fundedLamports: "13887000000",
        lockedLamports: "8225000000",
        freeLamports: "5662000000",
        activeCommitLamports: "5650000000",
        firstPendingCycleId: 9862636,
        lastPendingCycleId: 9862636,
      })
      .mockResolvedValueOnce({
        address: "capital",
        authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
        fundedLamports: "13887000000",
        lockedLamports: "8225000000",
        freeLamports: "5662000000",
        activeCommitLamports: "5650000000",
        firstPendingCycleId: 9862636,
        lastPendingCycleId: 9862636,
      })
      .mockResolvedValueOnce({
        address: "capital",
        authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
        fundedLamports: "13887000000",
        lockedLamports: "8225000000",
        freeLamports: "5662000000",
        activeCommitLamports: "5650000000",
        firstPendingCycleId: 9862636,
        lastPendingCycleId: 9862636,
      });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.setActiveCommit",
      "sat.commitCycle",
    ]);
    const setCommitCall = runSatGatewayMethod.mock.calls.find(
      (call) => call[0]?.method === "sat.setActiveCommit",
    );
    expect(setCommitCall?.[0]?.payload).toMatchObject({
      lamports: 5350000000,
      persistConfig: false,
    });

    await service.stop?.();
  });

  it("keeps a minimum-entry continuity reserve when one pending cycle already exists", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      commitLamports: 9_970_000_000,
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatMinerCapital.mockResolvedValue({
      address: "capital",
      authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
      fundedLamports: "9968550788",
      lockedLamports: "250000000",
      freeLamports: "9718550788",
      activeCommitLamports: "250000000",
      firstPendingCycleId: 5933668,
      lastPendingCycleId: 5933668,
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.setActiveCommit",
      "sat.commitCycle",
    ]);
    const setCommitCall = runSatGatewayMethod.mock.calls.find(
      (call) => call[0]?.method === "sat.setActiveCommit",
    );
    expect(setCommitCall?.[0]?.payload).toMatchObject({
      lamports: 9370000000,
      persistConfig: false,
    });

    await service.stop?.();
  });

  it("uses the remaining minimum entry for a second pending cycle instead of idling", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
      commitLamports: 9_695_000_000,
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW";
    inspectSatMinerCapital.mockResolvedValue({
      address: "capital",
      authority: "8ZxJ61qmvh3j9rDao8XDgcJMWx5SPr2zX4tEdK2rgCvW",
      fundedLamports: "9968897560",
      lockedLamports: "9695000000",
      freeLamports: "273897560",
      activeCommitLamports: "9695000000",
      firstPendingCycleId: 5933666,
      lastPendingCycleId: 5933666,
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRoundWatcherService({ api: api as never, config, state });
    await service.start();

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.setActiveCommit",
      "sat.commitCycle",
    ]);
    const setCommitCall = runSatGatewayMethod.mock.calls.find(
      (call) => call[0]?.method === "sat.setActiveCommit",
    );
    expect(setCommitCall?.[0]?.payload).toMatchObject({
      lamports: 270000000,
      persistConfig: false,
    });

    await service.stop?.();
  });
});
