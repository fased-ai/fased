import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSatEpochService } from "./epoch-service.js";
import { createSatMiningRuntimeState, getOrCreateRoundExecutionState } from "./runtime.js";

type GatewayMethodArgs = { method: string; payload: { cycleId?: number; [key: string]: unknown } };
type CycleLookupArgs = { cycleId: number; authority?: string };
type CycleRegistryMeta = { cycleId: number; participantCount: number; pageCount: number };
type CycleRegistryPage = {
  cycleId: number;
  pageIndex: number;
  participantCount: number;
  participants: string[];
};
type CycleSettlementProgress = {
  cycleId: number;
  expectedPageCount: number;
  processedPageCount: number;
  settleChunkIndex: number;
  scoredPageCount: number;
  scoreChunkIndex: number;
  distributedPageCount: number;
  distributeChunkIndex: number;
  finalized: boolean;
  scored: boolean;
};

const ACTIVE_AUTHORITY = "11111111111111111111111111111111";
const PEER_AUTHORITY = "11111111111111111111111111111112";

function derivedMinerCycleAddress(authority: string, cycleId: number) {
  return `derived-${authority}-${cycleId}`;
}

function progressFromSubmittedGatewayCalls(cycleId: number): CycleSettlementProgress | null {
  const methods = runSatGatewayMethod.mock.calls
    .filter((call) => call[0]?.payload?.cycleId === cycleId)
    .map((call) => call[0]?.method);
  const finalized = methods.includes("sat.finalizeCycleSettlement");
  const scored = methods.includes("sat.scoreCyclePage");
  const distributed = methods.includes("sat.distributeCyclePage");
  const settled = methods.includes("sat.settleCyclePage") || finalized || scored || distributed;
  if (!settled) {
    return null;
  }
  return {
    cycleId,
    expectedPageCount: 1,
    processedPageCount: 1,
    settleChunkIndex: 0,
    scoredPageCount: scored ? 1 : 0,
    scoreChunkIndex: 0,
    distributedPageCount: distributed ? 1 : 0,
    distributeChunkIndex: 0,
    finalized: finalized || scored || distributed,
    scored: scored || distributed,
  };
}

const runSatGatewayMethod = vi.fn(
  async (_args: GatewayMethodArgs): Promise<{ ok: boolean }> => ({
    ok: true,
  }),
);
const inspectSatChainSlot = vi.fn(async () => 9_999_999);
const inspectSatChainUnixTime = vi.fn(async () => Math.floor(Date.now() / 1000));
const inspectSatMinerCycleAccountExists = vi.fn(
  async (_config: unknown, _args: CycleLookupArgs): Promise<boolean> => false,
);
const inspectSatMinerCycle = vi.fn(
  async (
    _config: unknown,
    _args: CycleLookupArgs,
  ): Promise<{ address: string; authority: string; cycleId: number } | null> => null,
);
const deriveSatMinerCycleAddress = vi.fn(
  async (_config: unknown, args: CycleLookupArgs): Promise<string> =>
    `derived-${args.authority}-${args.cycleId}`,
);
const listSatMinerCycleAddressesForCycle = vi.fn(
  async (_config: unknown, args: { cycleId: number }): Promise<string[]> => [],
);
const inspectSatCycleRegistryMeta = vi.fn(
  async (_config: unknown, _args: { cycleId: number }): Promise<CycleRegistryMeta | null> => null,
);
const inspectSatCycleRegistryPage = vi.fn(
  async (
    _config: unknown,
    _args: { cycleId: number; pageIndex: number },
  ): Promise<CycleRegistryPage | null> => null,
);
const inspectSatCycleSettlementProgressV2 = vi.fn(
  async (_config: unknown, _args: { cycleId: number }): Promise<CycleSettlementProgress | null> =>
    null,
);
const inspectSatMinerCapital = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);

vi.mock("./gateway-runner.js", () => ({
  runSatGatewayMethod: (args: GatewayMethodArgs) => runSatGatewayMethod(args),
}));

vi.mock("./rpc-read.js", () => ({
  inspectSatChainSlot: (...args: Parameters<typeof inspectSatChainSlot>) =>
    inspectSatChainSlot(...args),
  inspectSatChainUnixTime: () => inspectSatChainUnixTime(),
  inspectSatMinerCycleAccountExists: (
    ...args: Parameters<typeof inspectSatMinerCycleAccountExists>
  ) => inspectSatMinerCycleAccountExists(...args),
  inspectSatMinerCycle: (...args: Parameters<typeof inspectSatMinerCycle>) =>
    inspectSatMinerCycle(...args),
  deriveSatMinerCycleAddress: (...args: Parameters<typeof deriveSatMinerCycleAddress>) =>
    deriveSatMinerCycleAddress(...args),
  listSatMinerCycleAddressesForCycle: (
    ...args: Parameters<typeof listSatMinerCycleAddressesForCycle>
  ) => listSatMinerCycleAddressesForCycle(...args),
  inspectSatCycleRegistryMeta: (...args: Parameters<typeof inspectSatCycleRegistryMeta>) =>
    inspectSatCycleRegistryMeta(...args),
  inspectSatCycleRegistryPage: (...args: Parameters<typeof inspectSatCycleRegistryPage>) =>
    inspectSatCycleRegistryPage(...args),
  inspectSatCycleSettlementProgressV2: (
    ...args: Parameters<typeof inspectSatCycleSettlementProgressV2>
  ) => inspectSatCycleSettlementProgressV2(...args),
  inspectSatMinerCapital: (...args: Parameters<typeof inspectSatMinerCapital>) =>
    inspectSatMinerCapital(...args),
}));

describe("createSatEpochService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T12:09:05.000Z"));
    process.env.FASED_SAT_EPOCH_FAST_TEST_TICK = "1";
    runSatGatewayMethod.mockClear();
    inspectSatChainSlot.mockReset();
    inspectSatChainSlot.mockResolvedValue(9_999_999);
    inspectSatMinerCycleAccountExists.mockReset();
    inspectSatMinerCycle.mockReset();
    deriveSatMinerCycleAddress.mockReset();
    listSatMinerCycleAddressesForCycle.mockReset();
    inspectSatCycleRegistryMeta.mockReset();
    inspectSatCycleRegistryPage.mockReset();
    inspectSatCycleSettlementProgressV2.mockReset();
    inspectSatMinerCapital.mockReset();
    inspectSatCycleRegistryMeta.mockImplementation(async (_config, { cycleId }) => ({
      cycleId,
      participantCount: 1,
      pageCount: 1,
    }));
    inspectSatCycleSettlementProgressV2.mockImplementation(async (_config, { cycleId }) =>
      progressFromSubmittedGatewayCalls(cycleId),
    );
    inspectSatMinerCycle.mockResolvedValue(null);
    deriveSatMinerCycleAddress.mockImplementation(async (_config, args) => {
      return `derived-${args.authority}-${args.cycleId}`;
    });
    listSatMinerCycleAddressesForCycle.mockResolvedValue([]);
    inspectSatMinerCapital.mockResolvedValue(null);
  });

  afterEach(() => {
    delete process.env.FASED_SAT_EPOCH_FAST_TEST_TICK;
    vi.useRealTimers();
  });

  it("drives the four-phase chunked settlement path for the previous cycle", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = ACTIVE_AUTHORITY;
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const previousCycleId = currentCycleId - 1;
    const execution = getOrCreateRoundExecutionState(state, previousCycleId, 0);
    execution.participationSubmitted = true;
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method).slice(0, 4)).toEqual([
      "sat.settleCyclePage",
      "sat.finalizeCycleSettlement",
      "sat.scoreCyclePage",
      "sat.distributeCyclePage",
    ]);

    await service.stop?.();
  });

  it("does not probe historical cycles while drain-only has no pending evidence", async () => {
    const config = {
      enabled: true,
      drainOnly: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = ACTIVE_AUTHORITY;
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(inspectSatMinerCycleAccountExists).not.toHaveBeenCalled();
    expect(inspectSatCycleRegistryMeta).not.toHaveBeenCalled();
    expect(inspectSatCycleSettlementProgressV2).not.toHaveBeenCalled();
    expect(runSatGatewayMethod).not.toHaveBeenCalled();

    await service.stop?.();
  });

  it("keeps epoch worker marked running when a timer overlap lands during an in-flight tick", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = ACTIVE_AUTHORITY;
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const previousCycleId = currentCycleId - 1;
    const execution = getOrCreateRoundExecutionState(state, previousCycleId, 0);
    execution.participationSubmitted = true;
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    runSatGatewayMethod.mockClear();
    execution.participationSubmitted = true;
    execution.crankSubmitted = false;
    execution.epochFinalized = false;
    let releaseFirstCall: (() => void) | null = null;
    runSatGatewayMethod.mockImplementationOnce(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          releaseFirstCall = () => resolve({ ok: true });
        }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.workers.epoch.running).toBe(true);
    expect(state.workers.epoch.lastDetail).toBe(`cycle ${previousCycleId}`);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.workers.epoch.running).toBe(true);
    expect(state.workers.epoch.waitingReason).toBe("previous settlement tick still running");
    expect(state.workers.epoch.lastDetail).toBe(`cycle ${previousCycleId}`);

    (releaseFirstCall as (() => void) | null)?.();
    await vi.advanceTimersByTimeAsync(0);
    await service.stop?.();
  });

  it("retries quickly when a chain read hangs during settlement inspection", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = ACTIVE_AUTHORITY;
    inspectSatMinerCapital.mockImplementation(
      async () => await new Promise<never>(() => undefined),
    );
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    const startPromise = service.start();
    await vi.advanceTimersByTimeAsync(4_000);
    await startPromise;

    expect(state.workers.epoch.waitingReason).toContain("settlement RPC read timed out");
    expect(state.workers.epoch.lastError).toBeNull();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("epoch service timed out on a chain read"),
    );

    await service.stop?.();
  });

  it("hydrates previous-cycle participation from chain state after restart", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = ACTIVE_AUTHORITY;
    const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    inspectSatMinerCycleAccountExists.mockImplementation(async (_config, { cycleId }) => {
      return cycleId === previousCycleId;
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method).slice(0, 4)).toEqual([
      "sat.settleCyclePage",
      "sat.finalizeCycleSettlement",
      "sat.scoreCyclePage",
      "sat.distributeCyclePage",
    ]);

    await service.stop?.();
  });

  it("hydrates previous-cycle participation from a recent successful submit when round execution is missing", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = ACTIVE_AUTHORITY;
    const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    state.recentActions = [
      {
        action: "submitCycle",
        cycleId: previousCycleId,
        txHash: "tx-submit",
        status: "success",
        at: new Date().toISOString(),
      },
    ];
    inspectSatMinerCycleAccountExists.mockResolvedValue(false);
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method).slice(0, 4)).toEqual([
      "sat.settleCyclePage",
      "sat.finalizeCycleSettlement",
      "sat.scoreCyclePage",
      "sat.distributeCyclePage",
    ]);

    await service.stop?.();
  });

  it("keeps an older unresolved cycle recoverable from recent submit history beyond the legacy slot horizon", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const delayedCycleId = currentCycleId - 10;
    state.recentActions = [
      {
        action: "submitCycle",
        cycleId: delayedCycleId,
        txHash: "tx-submit",
        status: "success",
        at: new Date().toISOString(),
      },
    ];
    inspectSatMinerCycleAccountExists.mockResolvedValue(false);
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.payload?.cycleId)).toEqual([
      delayedCycleId,
      delayedCycleId,
      delayedCycleId,
      delayedCycleId,
    ]);

    await service.stop?.();
  });

  it("uses full registry page participants for settlement actions instead of only the local miner", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    inspectSatMinerCycleAccountExists.mockImplementation(async (_config, { cycleId }) => {
      return cycleId === previousCycleId;
    });
    inspectSatCycleRegistryMeta.mockResolvedValueOnce({
      cycleId: previousCycleId,
      participantCount: 2,
      pageCount: 1,
    });
    inspectSatCycleRegistryPage.mockResolvedValue({
      cycleId: previousCycleId,
      pageIndex: 0,
      participantCount: 2,
      participants: [
        derivedMinerCycleAddress(ACTIVE_AUTHORITY, previousCycleId),
        derivedMinerCycleAddress(PEER_AUTHORITY, previousCycleId),
      ],
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls[0]?.[0]?.method).toBe("sat.settleCyclePage");
    expect(runSatGatewayMethod.mock.calls[0]?.[0]?.payload?.minerCycleAccounts).toEqual([
      derivedMinerCycleAddress(ACTIVE_AUTHORITY, previousCycleId),
      derivedMinerCycleAddress(PEER_AUTHORITY, previousCycleId),
    ]);

    await service.stop?.();
  });

  it("resumes from finalized settlement progress without replaying settle/finalize", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    inspectSatMinerCycleAccountExists.mockImplementation(async (_config, { cycleId }) => {
      return cycleId === previousCycleId;
    });
    inspectSatCycleRegistryMeta.mockResolvedValueOnce({
      cycleId: previousCycleId,
      participantCount: 1,
      pageCount: 1,
    });
    inspectSatCycleSettlementProgressV2.mockResolvedValueOnce({
      cycleId: previousCycleId,
      expectedPageCount: 1,
      processedPageCount: 1,
      settleChunkIndex: 0,
      scoredPageCount: 0,
      scoreChunkIndex: 0,
      distributedPageCount: 0,
      distributeChunkIndex: 0,
      finalized: true,
      scored: false,
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.scoreCyclePage",
      "sat.distributeCyclePage",
    ]);
    expect(
      runSatGatewayMethod.mock.calls.some(
        (call) => call[0]?.method === "sat.finalizeCycleSettlement",
      ),
    ).toBe(false);
    expect(
      runSatGatewayMethod.mock.calls.some((call) => call[0]?.method === "sat.settleCyclePage"),
    ).toBe(false);

    await service.stop?.();
  });

  it("restarts mid-recovery and auto-completes multi-participant score/distribute without manual help", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    getOrCreateRoundExecutionState(state, previousCycleId, 0).participationSubmitted = true;
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    inspectSatMinerCycleAccountExists.mockImplementation(async (_config, { cycleId }) => {
      return cycleId === previousCycleId;
    });
    inspectSatCycleRegistryMeta.mockResolvedValueOnce({
      cycleId: previousCycleId,
      participantCount: 2,
      pageCount: 1,
    });
    let progress: CycleSettlementProgress = {
      cycleId: previousCycleId,
      expectedPageCount: 1,
      processedPageCount: 1,
      settleChunkIndex: 0,
      scoredPageCount: 0,
      scoreChunkIndex: 0,
      distributedPageCount: 0,
      distributeChunkIndex: 0,
      finalized: true,
      scored: false,
    };
    inspectSatCycleSettlementProgressV2.mockImplementation(async () => progress);
    inspectSatCycleRegistryPage.mockResolvedValueOnce({
      cycleId: previousCycleId,
      pageIndex: 0,
      participantCount: 2,
      participants: [
        derivedMinerCycleAddress(PEER_AUTHORITY, previousCycleId),
        derivedMinerCycleAddress(ACTIVE_AUTHORITY, previousCycleId),
      ],
    });
    runSatGatewayMethod.mockImplementation(async (args: GatewayMethodArgs) => {
      if (args.method === "sat.scoreCyclePage") {
        progress = { ...progress, scoredPageCount: 1, scored: true };
      } else if (args.method === "sat.distributeCyclePage") {
        progress = { ...progress, distributedPageCount: 1 };
      }
      return { ok: true };
    });

    const restartedService = createSatEpochService({ api: api as never, config, state });
    await restartedService.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.scoreCyclePage",
      "sat.distributeCyclePage",
    ]);
    expect(runSatGatewayMethod.mock.calls[0]?.[0]?.payload?.minerCycleAccounts).toEqual([
      derivedMinerCycleAddress(PEER_AUTHORITY, previousCycleId),
      derivedMinerCycleAddress(ACTIVE_AUTHORITY, previousCycleId),
    ]);
    expect(runSatGatewayMethod.mock.calls[1]?.[0]?.payload?.minerCycleAccounts).toEqual([
      derivedMinerCycleAddress(PEER_AUTHORITY, previousCycleId),
      derivedMinerCycleAddress(ACTIVE_AUTHORITY, previousCycleId),
    ]);

    await restartedService.stop?.();
  });

  it("reuses cached registry page participants for score/distribute when later page reads fail", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    inspectSatMinerCycleAccountExists.mockImplementation(async (_config, { cycleId }) => {
      return cycleId === previousCycleId;
    });
    inspectSatCycleRegistryMeta.mockResolvedValueOnce({
      cycleId: previousCycleId,
      participantCount: 2,
      pageCount: 1,
    });
    let progress: CycleSettlementProgress = {
      cycleId: previousCycleId,
      expectedPageCount: 1,
      processedPageCount: 1,
      settleChunkIndex: 0,
      scoredPageCount: 0,
      scoreChunkIndex: 0,
      distributedPageCount: 0,
      distributeChunkIndex: 0,
      finalized: true,
      scored: false,
    };
    inspectSatCycleSettlementProgressV2.mockImplementation(async () => progress);
    inspectSatCycleRegistryPage
      .mockResolvedValueOnce({
        cycleId: previousCycleId,
        pageIndex: 0,
        participantCount: 2,
        participants: [
          derivedMinerCycleAddress(PEER_AUTHORITY, previousCycleId),
          derivedMinerCycleAddress(ACTIVE_AUTHORITY, previousCycleId),
        ],
      })
      .mockResolvedValue(null);
    runSatGatewayMethod.mockImplementation(async (args: GatewayMethodArgs) => {
      if (args.method === "sat.scoreCyclePage") {
        progress = { ...progress, scoredPageCount: 1, scored: true };
      } else if (args.method === "sat.distributeCyclePage") {
        progress = { ...progress, distributedPageCount: 1 };
      }
      return { ok: true };
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.scoreCyclePage",
      "sat.distributeCyclePage",
    ]);
    expect(runSatGatewayMethod.mock.calls[0]?.[0]?.payload?.minerCycleAccounts).toEqual([
      derivedMinerCycleAddress(PEER_AUTHORITY, previousCycleId),
      derivedMinerCycleAddress(ACTIVE_AUTHORITY, previousCycleId),
    ]);
    expect(runSatGatewayMethod.mock.calls[1]?.[0]?.payload?.minerCycleAccounts).toEqual([
      derivedMinerCycleAddress(PEER_AUTHORITY, previousCycleId),
      derivedMinerCycleAddress(ACTIVE_AUTHORITY, previousCycleId),
    ]);

    await service.stop?.();
  });

  it("ignores stale incomplete cached multi-participant pages and refetches the full page", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    state.settlementPageParticipants.set(`${previousCycleId}:0`, [
      derivedMinerCycleAddress(ACTIVE_AUTHORITY, previousCycleId),
    ]);
    inspectSatMinerCycleAccountExists.mockImplementation(async (_config, { cycleId }) => {
      return cycleId === previousCycleId;
    });
    inspectSatCycleRegistryMeta.mockResolvedValueOnce({
      cycleId: previousCycleId,
      participantCount: 2,
      pageCount: 1,
    });
    inspectSatCycleSettlementProgressV2.mockResolvedValueOnce({
      cycleId: previousCycleId,
      expectedPageCount: 1,
      processedPageCount: 0,
      settleChunkIndex: 0,
      scoredPageCount: 0,
      scoreChunkIndex: 0,
      distributedPageCount: 0,
      distributeChunkIndex: 0,
      finalized: false,
      scored: false,
    });
    inspectSatCycleRegistryPage.mockResolvedValueOnce({
      cycleId: previousCycleId,
      pageIndex: 0,
      participantCount: 2,
      participants: [
        derivedMinerCycleAddress(ACTIVE_AUTHORITY, previousCycleId),
        derivedMinerCycleAddress(PEER_AUTHORITY, previousCycleId),
      ],
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls[0]?.[0]?.method).toBe("sat.settleCyclePage");
    expect(runSatGatewayMethod.mock.calls[0]?.[0]?.payload?.minerCycleAccounts).toEqual([
      derivedMinerCycleAddress(ACTIVE_AUTHORITY, previousCycleId),
      derivedMinerCycleAddress(PEER_AUTHORITY, previousCycleId),
    ]);

    await service.stop?.();
  });

  it("does not cache an incomplete live multi-participant page read and recovers on the next tick", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = ACTIVE_AUTHORITY;
    const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    inspectSatMinerCycleAccountExists.mockImplementation(async (_config, { cycleId }) => {
      return cycleId === previousCycleId;
    });
    inspectSatCycleRegistryMeta.mockImplementation(async () => ({
      cycleId: previousCycleId,
      participantCount: 2,
      pageCount: 1,
    }));
    inspectSatCycleSettlementProgressV2.mockImplementation(async () => ({
      cycleId: previousCycleId,
      expectedPageCount: 1,
      processedPageCount: 0,
      settleChunkIndex: 0,
      scoredPageCount: 0,
      scoreChunkIndex: 0,
      distributedPageCount: 0,
      distributeChunkIndex: 0,
      finalized: false,
      scored: false,
    }));
    inspectSatCycleRegistryPage
      .mockResolvedValueOnce({
        cycleId: previousCycleId,
        pageIndex: 0,
        participantCount: 1,
        participants: [derivedMinerCycleAddress(ACTIVE_AUTHORITY, previousCycleId)],
      })
      .mockResolvedValueOnce({
        cycleId: previousCycleId,
        pageIndex: 0,
        participantCount: 2,
        participants: [
          derivedMinerCycleAddress(ACTIVE_AUTHORITY, previousCycleId),
          derivedMinerCycleAddress(PEER_AUTHORITY, previousCycleId),
        ],
      });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();

    expect(runSatGatewayMethod).not.toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("returned only 1/2 participant accounts"),
    );
    expect(state.settlementPageParticipants.has(`${previousCycleId}:0`)).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method).slice(0, 1)).toEqual([
      "sat.settleCyclePage",
    ]);
    expect(runSatGatewayMethod.mock.calls[0]?.[0]?.payload?.minerCycleAccounts).toEqual([
      derivedMinerCycleAddress(ACTIVE_AUTHORITY, previousCycleId),
      derivedMinerCycleAddress(PEER_AUTHORITY, previousCycleId),
    ]);

    await service.stop?.();
  });

  it("resumes after settle completed but before finalize without replaying settle", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = ACTIVE_AUTHORITY;
    const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    inspectSatMinerCycleAccountExists.mockImplementation(async (_config, { cycleId }) => {
      return cycleId === previousCycleId;
    });
    inspectSatCycleRegistryMeta.mockResolvedValueOnce({
      cycleId: previousCycleId,
      participantCount: 2,
      pageCount: 1,
    });
    let progress: CycleSettlementProgress = {
      cycleId: previousCycleId,
      expectedPageCount: 1,
      processedPageCount: 1,
      settleChunkIndex: 0,
      scoredPageCount: 0,
      scoreChunkIndex: 0,
      distributedPageCount: 0,
      distributeChunkIndex: 0,
      finalized: false,
      scored: false,
    };
    inspectSatCycleSettlementProgressV2.mockImplementation(async () => progress);
    inspectSatCycleRegistryPage.mockResolvedValue({
      cycleId: previousCycleId,
      pageIndex: 0,
      participantCount: 2,
      participants: [
        derivedMinerCycleAddress(PEER_AUTHORITY, previousCycleId),
        derivedMinerCycleAddress(ACTIVE_AUTHORITY, previousCycleId),
      ],
    });
    runSatGatewayMethod.mockImplementation(async (args: GatewayMethodArgs) => {
      if (args.method === "sat.finalizeCycleSettlement") {
        progress = { ...progress, finalized: true };
      } else if (args.method === "sat.scoreCyclePage") {
        progress = { ...progress, scoredPageCount: 1, scored: true };
      } else if (args.method === "sat.distributeCyclePage") {
        progress = { ...progress, distributedPageCount: 1 };
      }
      return { ok: true };
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.finalizeCycleSettlement",
      "sat.scoreCyclePage",
      "sat.distributeCyclePage",
    ]);
    expect(
      runSatGatewayMethod.mock.calls.some((call) => call[0]?.method === "sat.settleCyclePage"),
    ).toBe(false);

    await service.stop?.();
  });

  it("skips a stale closed cycle even when pending range still includes it", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = ACTIVE_AUTHORITY;
    const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    getOrCreateRoundExecutionState(state, previousCycleId, 0).participationSubmitted = true;
    state.recentActions = [
      {
        action: "closeResolvedCycleAccounts",
        cycleId: previousCycleId,
        txHash: "tx-close",
        status: "success",
        at: new Date().toISOString(),
      },
      {
        action: "submitCycle",
        cycleId: previousCycleId,
        txHash: "tx-submit",
        status: "success",
        at: new Date().toISOString(),
      },
    ];
    inspectSatMinerCapital.mockResolvedValue({
      address: "capital",
      authority: state.activeWalletAddress,
      fundedLamports: "1000",
      lockedLamports: "0",
      freeLamports: "1000",
      activeCommitLamports: "300",
      firstPendingCycleId: previousCycleId,
      lastPendingCycleId: previousCycleId,
    });
    inspectSatMinerCycle.mockResolvedValue(null);
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod).not.toHaveBeenCalled();
    expect(state.roundExecution.has(`${previousCycleId}:0`)).toBe(false);

    await service.stop?.();
  });

  it("treats invalid-account-owner after a concurrent close as a resolved stale retry", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    getOrCreateRoundExecutionState(state, previousCycleId, 0).participationSubmitted = true;
    state.recentActions = [
      {
        action: "claimCycleRewardsBatch",
        cycleId: previousCycleId,
        txHash: "tx-claim",
        status: "success",
        at: new Date().toISOString(),
      },
      {
        action: "submitCycle",
        cycleId: previousCycleId,
        txHash: "tx-submit",
        status: "success",
        at: new Date().toISOString(),
      },
    ];
    state.settlementPageParticipants.set(`${previousCycleId}:0`, ["cycle-a", "cycle-b"]);
    inspectSatMinerCycleAccountExists.mockResolvedValue(false);
    inspectSatCycleRegistryMeta.mockResolvedValue({
      cycleId: previousCycleId,
      participantCount: 2,
      pageCount: 1,
    });
    inspectSatCycleSettlementProgressV2.mockResolvedValue({
      cycleId: previousCycleId,
      expectedPageCount: 1,
      processedPageCount: 0,
      settleChunkIndex: 0,
      scoredPageCount: 0,
      scoreChunkIndex: 0,
      distributedPageCount: 0,
      distributeChunkIndex: 0,
      finalized: false,
      scored: false,
    });
    inspectSatCycleRegistryPage.mockResolvedValue({
      cycleId: previousCycleId,
      pageIndex: 0,
      participantCount: 2,
      participants: ["cycle-a", "cycle-b"],
    });
    inspectSatMinerCycle.mockResolvedValue(null);
    runSatGatewayMethod.mockImplementationOnce(async () => {
      state.recentActions.unshift({
        action: "closeResolvedCycleAccounts",
        cycleId: previousCycleId,
        txHash: "tx-close",
        status: "success",
        at: new Date().toISOString(),
      });
      throw new Error("InvalidAccountOwner");
    });
    const persistRuntimeState = vi.fn(async () => {});
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({
      api: api as never,
      config,
      state,
      persistRuntimeState,
    });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(state.roundExecution.has(`${previousCycleId}:0`)).toBe(false);
    expect(state.settlementPageParticipants.has(`${previousCycleId}:0`)).toBe(false);
    expect(persistRuntimeState).toHaveBeenCalled();
    expect(state.workers.epoch.lastError).toBeNull();
    expect(api.logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("cycle settlement service failed"),
    );

    await service.stop?.();
  });

  it.each([
    ["invalid-account-data", "InstructionError: InvalidAccountData"],
    ["invalid-instruction-data", "InstructionError: InvalidInstructionData"],
  ])(
    "treats %s during settlement as a recoverable chain-progress rescan",
    async (_label, errorMessage) => {
      const config = {
        enabled: true,
        network: "devnet" as const,
        riskMode: "balanced" as const,
        walletId: "wallet-a",
      };
      const state = createSatMiningRuntimeState(config);
      state.activeWalletAddress = ACTIVE_AUTHORITY;
      const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
      getOrCreateRoundExecutionState(state, previousCycleId, 0).participationSubmitted = true;
      state.recentActions = [
        {
          action: "submitCycle",
          cycleId: previousCycleId,
          txHash: "tx-submit",
          status: "success",
          at: new Date().toISOString(),
        },
      ];
      state.settlementPageParticipants.set(`${previousCycleId}:0`, ["cycle-a"]);
      inspectSatMinerCapital.mockResolvedValue({
        address: "capital",
        authority: state.activeWalletAddress,
        fundedLamports: "1000",
        lockedLamports: "1000",
        freeLamports: "0",
        activeCommitLamports: "300",
        firstPendingCycleId: previousCycleId,
        lastPendingCycleId: previousCycleId,
      });
      inspectSatCycleRegistryMeta.mockResolvedValue({
        cycleId: previousCycleId,
        participantCount: 1,
        pageCount: 1,
      });
      inspectSatCycleSettlementProgressV2.mockResolvedValue({
        cycleId: previousCycleId,
        expectedPageCount: 1,
        processedPageCount: 0,
        settleChunkIndex: 0,
        scoredPageCount: 0,
        scoreChunkIndex: 0,
        distributedPageCount: 0,
        distributeChunkIndex: 0,
        finalized: false,
        scored: false,
      });
      inspectSatCycleRegistryPage.mockResolvedValue({
        cycleId: previousCycleId,
        pageIndex: 0,
        participantCount: 1,
        participants: ["cycle-a"],
      });
      runSatGatewayMethod.mockRejectedValueOnce(new Error(errorMessage));
      const api = {
        config: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as const;

      const service = createSatEpochService({ api: api as never, config, state });
      await service.start();

      expect(runSatGatewayMethod).toHaveBeenCalledWith(
        expect.objectContaining({ method: "sat.settleCyclePage" }),
      );
      expect(state.settlementPageParticipants.has(`${previousCycleId}:0`)).toBe(false);
      expect(state.workers.epoch.lastError).toBeNull();
      expect(state.workers.epoch.waitingReason).toContain("settlement state changed");
      expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("state changed"));
      expect(api.logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("cycle settlement service failed"),
      );

      await service.stop?.();
    },
  );

  it("skips a stale missing settlement page when another miner already closed the shared cycle", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    getOrCreateRoundExecutionState(state, previousCycleId, 0).participationSubmitted = true;
    state.recentActions = [
      {
        action: "claimCycleRewardsBatch",
        cycleId: previousCycleId,
        txHash: "tx-claim",
        status: "success",
        at: new Date().toISOString(),
      },
      {
        action: "submitCycle",
        cycleId: previousCycleId,
        txHash: "tx-submit",
        status: "success",
        at: new Date().toISOString(),
      },
    ];
    state.settlementPageParticipants.set(`${previousCycleId}:0`, ["cycle-a", "cycle-b"]);
    inspectSatMinerCapital.mockResolvedValue({
      address: "capital",
      authority: state.activeWalletAddress,
      fundedLamports: "1000",
      lockedLamports: "0",
      freeLamports: "1000",
      activeCommitLamports: "300",
      firstPendingCycleId: previousCycleId,
      lastPendingCycleId: previousCycleId,
    });
    inspectSatCycleRegistryMeta.mockResolvedValue({
      cycleId: previousCycleId,
      participantCount: 2,
      pageCount: 1,
    });
    inspectSatCycleSettlementProgressV2.mockResolvedValue({
      cycleId: previousCycleId,
      expectedPageCount: 1,
      processedPageCount: 0,
      settleChunkIndex: 0,
      scoredPageCount: 0,
      scoreChunkIndex: 0,
      distributedPageCount: 0,
      distributeChunkIndex: 0,
      finalized: false,
      scored: false,
    });
    inspectSatCycleRegistryPage.mockResolvedValue(null);
    inspectSatMinerCycle.mockResolvedValue(null);
    const persistRuntimeState = vi.fn(async () => {});
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({
      api: api as never,
      config,
      state,
      persistRuntimeState,
    });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod).not.toHaveBeenCalled();
    expect(state.roundExecution.has(`${previousCycleId}:0`)).toBe(false);
    expect(state.settlementPageParticipants.has(`${previousCycleId}:0`)).toBe(false);
    expect(persistRuntimeState).toHaveBeenCalled();
    expect(state.workers.epoch.lastError).toBeNull();

    await service.stop?.();
  });

  it("clears stale settlement failures once a cycle is proven already closed elsewhere", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    getOrCreateRoundExecutionState(state, previousCycleId, 0).participationSubmitted = true;
    state.lastAction = "settleCyclePage";
    state.lastFailure = "InvalidAccountOwner";
    state.recentActions = [
      {
        action: "settleCyclePage",
        cycleId: previousCycleId,
        txHash: null,
        status: "failure",
        message: "InvalidAccountOwner",
        at: new Date().toISOString(),
      },
      {
        action: "claimCycleRewardsBatch",
        cycleId: previousCycleId,
        txHash: "tx-claim",
        status: "success",
        at: new Date().toISOString(),
      },
      {
        action: "submitCycle",
        cycleId: previousCycleId,
        txHash: "tx-submit",
        status: "success",
        at: new Date().toISOString(),
      },
    ];
    state.settlementPageParticipants.set(`${previousCycleId}:0`, ["cycle-a", "cycle-b"]);
    inspectSatMinerCapital.mockResolvedValue({
      address: "capital",
      authority: state.activeWalletAddress,
      fundedLamports: "1000",
      lockedLamports: "0",
      freeLamports: "1000",
      activeCommitLamports: "300",
      firstPendingCycleId: previousCycleId,
      lastPendingCycleId: previousCycleId,
    });
    inspectSatCycleRegistryMeta.mockResolvedValue({
      cycleId: previousCycleId,
      participantCount: 2,
      pageCount: 1,
    });
    inspectSatCycleSettlementProgressV2.mockResolvedValue({
      cycleId: previousCycleId,
      expectedPageCount: 1,
      processedPageCount: 0,
      settleChunkIndex: 0,
      scoredPageCount: 0,
      scoreChunkIndex: 0,
      distributedPageCount: 0,
      distributeChunkIndex: 0,
      finalized: false,
      scored: false,
    });
    inspectSatCycleRegistryPage.mockResolvedValue(null);
    inspectSatMinerCycle.mockResolvedValue(null);
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(state.lastFailure).toBeNull();
    expect(state.lastAction).toBe("closeResolvedCycleAccounts");
    expect(
      state.recentActions.some(
        (entry) =>
          entry.action === "settleCyclePage" &&
          entry.status === "failure" &&
          entry.cycleId === previousCycleId,
      ),
    ).toBe(false);

    await service.stop?.();
  });

  it("resumes from scored progress and only replays distribute work", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    inspectSatMinerCycleAccountExists.mockImplementation(async (_config, { cycleId }) => {
      return cycleId === previousCycleId;
    });
    inspectSatCycleRegistryMeta.mockResolvedValueOnce({
      cycleId: previousCycleId,
      participantCount: 1,
      pageCount: 1,
    });
    inspectSatCycleSettlementProgressV2.mockResolvedValueOnce({
      cycleId: previousCycleId,
      expectedPageCount: 1,
      processedPageCount: 1,
      settleChunkIndex: 0,
      scoredPageCount: 1,
      scoreChunkIndex: 0,
      distributedPageCount: 0,
      distributeChunkIndex: 0,
      finalized: true,
      scored: true,
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.distributeCyclePage",
    ]);

    await service.stop?.();
  });

  it("does not replay settlement work once distribute is already complete on restart", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    inspectSatMinerCycleAccountExists.mockImplementation(async (_config, { cycleId }) => {
      return cycleId === previousCycleId;
    });
    inspectSatCycleRegistryMeta.mockResolvedValueOnce({
      cycleId: previousCycleId,
      participantCount: 1,
      pageCount: 1,
    });
    inspectSatCycleSettlementProgressV2.mockResolvedValueOnce({
      cycleId: previousCycleId,
      expectedPageCount: 1,
      processedPageCount: 1,
      settleChunkIndex: 0,
      scoredPageCount: 1,
      scoreChunkIndex: 0,
      distributedPageCount: 1,
      distributeChunkIndex: 0,
      finalized: true,
      scored: true,
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls).toHaveLength(0);
    expect(
      runSatGatewayMethod.mock.calls.some((call) => call[0]?.method === "sat.distributeCyclePage"),
    ).toBe(false);
    expect(
      runSatGatewayMethod.mock.calls.some(
        (call) => call[0]?.method === "sat.finalizeCycleSettlement",
      ),
    ).toBe(false);
    const execution = getOrCreateRoundExecutionState(state, previousCycleId, 0);
    expect(execution.crankSubmitted).toBe(true);
    expect(execution.epochFinalized).toBe(true);

    await service.stop?.();
  });

  it("does not replay distribute once settlement progress already shows all pages distributed", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    inspectSatMinerCycleAccountExists.mockImplementation(async (_config, { cycleId }) => {
      return cycleId === previousCycleId;
    });
    inspectSatCycleRegistryMeta.mockResolvedValueOnce({
      cycleId: previousCycleId,
      participantCount: 4,
      pageCount: 2,
    });
    inspectSatCycleSettlementProgressV2.mockResolvedValueOnce({
      cycleId: previousCycleId,
      expectedPageCount: 2,
      processedPageCount: 2,
      settleChunkIndex: 0,
      scoredPageCount: 2,
      scoreChunkIndex: 0,
      distributedPageCount: 2,
      distributeChunkIndex: 0,
      finalized: true,
      scored: true,
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(
      runSatGatewayMethod.mock.calls.filter(
        (call) => call[0]?.method === "sat.distributeCyclePage",
      ),
    ).toHaveLength(0);
    expect(
      runSatGatewayMethod.mock.calls.filter(
        (call) => call[0]?.method === "sat.finalizeCycleSettlement",
      ),
    ).toHaveLength(0);
    expect(
      runSatGatewayMethod.mock.calls.filter((call) => call[0]?.method === "sat.scoreCyclePage"),
    ).toHaveLength(0);

    await service.stop?.();
  });

  it("replays the oldest unresolved backlog cycle after a longer gap instead of only currentCycle-1", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = ACTIVE_AUTHORITY;
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const olderMissedCycleId = currentCycleId - 3;
    const newerMissedCycleId = currentCycleId - 2;
    getOrCreateRoundExecutionState(state, olderMissedCycleId, 0).participationSubmitted = true;
    getOrCreateRoundExecutionState(state, newerMissedCycleId, 0).participationSubmitted = true;
    inspectSatCycleRegistryMeta.mockImplementation(async (_config, { cycleId }) => ({
      cycleId,
      participantCount: 1,
      pageCount: 1,
    }));
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method).slice(0, 4)).toEqual([
      "sat.settleCyclePage",
      "sat.finalizeCycleSettlement",
      "sat.scoreCyclePage",
      "sat.distributeCyclePage",
    ]);
    expect(
      runSatGatewayMethod.mock.calls.map((call) => call[0]?.payload?.cycleId).slice(0, 4),
    ).toEqual([olderMissedCycleId, olderMissedCycleId, olderMissedCycleId, olderMissedCycleId]);
    expect(
      runSatGatewayMethod.mock.calls
        .slice(0, 4)
        .some((call) => call[0]?.payload?.cycleId === newerMissedCycleId),
    ).toBe(false);

    await service.stop?.();
  });

  it("walks a longer-gap settlement backlog across ticks from the oldest unresolved cycle forward", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = ACTIVE_AUTHORITY;
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const olderMissedCycleId = currentCycleId - 3;
    const newerMissedCycleId = currentCycleId - 2;
    getOrCreateRoundExecutionState(state, olderMissedCycleId, 0).participationSubmitted = true;
    getOrCreateRoundExecutionState(state, newerMissedCycleId, 0).participationSubmitted = true;
    inspectSatCycleRegistryMeta.mockImplementation(async (_config, { cycleId }) => ({
      cycleId,
      participantCount: 1,
      pageCount: 1,
    }));
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await service.stop?.();

    inspectSatCycleSettlementProgressV2.mockImplementation(async (_config, { cycleId }) => {
      const submittedProgress = progressFromSubmittedGatewayCalls(cycleId);
      if (submittedProgress) {
        return submittedProgress;
      }
      if (cycleId === olderMissedCycleId) {
        return {
          cycleId,
          expectedPageCount: 1,
          processedPageCount: 1,
          settleChunkIndex: 0,
          scoredPageCount: 1,
          scoreChunkIndex: 0,
          distributedPageCount: 1,
          distributeChunkIndex: 0,
          finalized: true,
          scored: true,
        };
      }
      return null;
    });

    const restartedService = createSatEpochService({ api: api as never, config, state });
    await restartedService.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.settleCyclePage",
      "sat.finalizeCycleSettlement",
      "sat.scoreCyclePage",
      "sat.distributeCyclePage",
      "sat.settleCyclePage",
      "sat.finalizeCycleSettlement",
      "sat.scoreCyclePage",
      "sat.distributeCyclePage",
    ]);
    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.payload?.cycleId)).toEqual([
      olderMissedCycleId,
      olderMissedCycleId,
      olderMissedCycleId,
      olderMissedCycleId,
      newerMissedCycleId,
      newerMissedCycleId,
      newerMissedCycleId,
      newerMissedCycleId,
    ]);
    expect(getOrCreateRoundExecutionState(state, olderMissedCycleId, 0).crankSubmitted).toBe(true);
    expect(getOrCreateRoundExecutionState(state, newerMissedCycleId, 0).crankSubmitted).toBe(true);

    await restartedService.stop?.();
  });

  it("prioritizes real unresolved runtime cycles ahead of a stale pending-range prefix", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const staleFirstPendingCycleId = currentCycleId - 12;
    const realPendingCycleId = currentCycleId - 2;
    inspectSatMinerCapital.mockResolvedValue({
      firstPendingCycleId: staleFirstPendingCycleId,
      lastPendingCycleId: realPendingCycleId,
    });
    getOrCreateRoundExecutionState(state, realPendingCycleId, 0).participationSubmitted = true;
    inspectSatCycleRegistryMeta.mockImplementation(async (_config, { cycleId }) => ({
      cycleId,
      participantCount: 1,
      pageCount: 1,
    }));
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.payload?.cycleId)).toEqual([
      realPendingCycleId,
      realPendingCycleId,
      realPendingCycleId,
      realPendingCycleId,
    ]);

    await service.stop?.();
  });

  it("skips an older already-claimed cycle and settles the newer exact pending cycle", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const olderClaimedCycleId = currentCycleId - 2;
    const exactPendingCycleId = currentCycleId - 1;
    getOrCreateRoundExecutionState(state, exactPendingCycleId, 0).participationSubmitted = true;
    state.recentActions = [
      {
        action: "claimCycleRewardsBatch",
        cycleId: olderClaimedCycleId,
        txHash: "claim-hash",
        status: "success",
        at: new Date().toISOString(),
      },
      {
        action: "submitCycle",
        cycleId: olderClaimedCycleId,
        txHash: "submit-hash",
        status: "success",
        at: new Date().toISOString(),
      },
      {
        action: "openCycle",
        cycleId: olderClaimedCycleId,
        txHash: "open-hash",
        status: "success",
        at: new Date().toISOString(),
      },
    ];
    inspectSatMinerCapital.mockResolvedValue({
      firstPendingCycleId: exactPendingCycleId,
      lastPendingCycleId: exactPendingCycleId,
    });
    inspectSatMinerCycleAccountExists.mockImplementation(async (_config, { cycleId }) => {
      return cycleId === olderClaimedCycleId || cycleId === exactPendingCycleId;
    });
    inspectSatCycleRegistryMeta.mockImplementation(async (_config, { cycleId }) => {
      if (cycleId !== exactPendingCycleId) {
        return null;
      }
      return {
        cycleId,
        participantCount: 1,
        pageCount: 1,
      };
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.payload?.cycleId)).toEqual([
      exactPendingCycleId,
      exactPendingCycleId,
      exactPendingCycleId,
      exactPendingCycleId,
    ]);
    expect(state.roundExecution.has(`${olderClaimedCycleId}:0`)).toBe(false);

    await service.stop?.();
  });

  it("skips an older planner-history cycle and settles the newer exact pending cycle", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const olderClaimedCycleId = currentCycleId - 2;
    const exactPendingCycleId = currentCycleId - 1;
    state.plannerHistory = [
      {
        cycleId: olderClaimedCycleId,
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
    getOrCreateRoundExecutionState(state, exactPendingCycleId, 0).participationSubmitted = true;
    inspectSatMinerCapital.mockResolvedValue({
      firstPendingCycleId: exactPendingCycleId,
      lastPendingCycleId: exactPendingCycleId,
    });
    inspectSatMinerCycleAccountExists.mockImplementation(async (_config, { cycleId }) => {
      return cycleId === olderClaimedCycleId || cycleId === exactPendingCycleId;
    });
    inspectSatCycleRegistryMeta.mockImplementation(async (_config, { cycleId }) => {
      if (cycleId !== exactPendingCycleId) {
        return null;
      }
      return {
        cycleId,
        participantCount: 1,
        pageCount: 1,
      };
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.payload?.cycleId)).toEqual([
      exactPendingCycleId,
      exactPendingCycleId,
      exactPendingCycleId,
      exactPendingCycleId,
    ]);
    expect(state.roundExecution.has(`${olderClaimedCycleId}:0`)).toBe(false);

    await service.stop?.();
  });

  it("drops a restored unresolved cycle at or beyond the seven-cycle slot horizon instead of retrying it", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = ACTIVE_AUTHORITY;
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const restoredDelayedCycleId = currentCycleId - 8;
    state.roundExecution.set(`${restoredDelayedCycleId}:0`, {
      openRoundSubmitted: true,
      participationSubmitted: true,
      epochFinalized: false,
      crankSubmitted: false,
      claimSubmitted: false,
    });
    inspectSatCycleRegistryMeta.mockImplementation(async (_config, { cycleId }) => ({
      cycleId,
      participantCount: 1,
      pageCount: 1,
    }));
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls).toHaveLength(0);
    expect(state.roundExecution.has(`${restoredDelayedCycleId}:0`)).toBe(false);
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("older than the 7-cycle slot horizon"),
    );

    await service.stop?.();
  });

  it("drops a stale restored cycle and resumes the next valid unresolved backlog cycle", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = ACTIVE_AUTHORITY;
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const staleCycleId = currentCycleId - 12;
    const validCycleId = currentCycleId - 2;
    state.roundExecution.set(`${staleCycleId}:0`, {
      openRoundSubmitted: true,
      participationSubmitted: true,
      epochFinalized: false,
      crankSubmitted: false,
      claimSubmitted: false,
    });
    state.roundExecution.set(`${validCycleId}:0`, {
      openRoundSubmitted: true,
      participationSubmitted: true,
      epochFinalized: false,
      crankSubmitted: false,
      claimSubmitted: false,
    });
    inspectSatCycleRegistryMeta.mockImplementation(async (_config, { cycleId }) => ({
      cycleId,
      participantCount: 1,
      pageCount: 1,
    }));
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.payload?.cycleId)).toEqual([
      validCycleId,
      validCycleId,
      validCycleId,
      validCycleId,
    ]);
    expect(state.roundExecution.has(`${staleCycleId}:0`)).toBe(false);

    await service.stop?.();
  });

  it("drops a stale restored cycle at the first slot-colliding boundary and resumes the next valid cycle", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = ACTIVE_AUTHORITY;
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const staleCycleId = currentCycleId - 8;
    const validCycleId = currentCycleId - 7;
    state.roundExecution.set(`${staleCycleId}:0`, {
      openRoundSubmitted: true,
      participationSubmitted: true,
      epochFinalized: false,
      crankSubmitted: false,
      claimSubmitted: false,
    });
    state.roundExecution.set(`${validCycleId}:0`, {
      openRoundSubmitted: true,
      participationSubmitted: true,
      epochFinalized: false,
      crankSubmitted: false,
      claimSubmitted: false,
    });
    inspectSatCycleRegistryMeta.mockImplementation(async (_config, { cycleId }) => ({
      cycleId,
      participantCount: 1,
      pageCount: 1,
    }));
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.payload?.cycleId)).toEqual([
      validCycleId,
      validCycleId,
      validCycleId,
      validCycleId,
    ]);
    expect(state.roundExecution.has(`${staleCycleId}:0`)).toBe(false);
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("older than the 7-cycle slot horizon"),
    );

    await service.stop?.();
  });

  it("skips an already-distributed older backlog cycle and resumes the next unresolved missed cycle", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = ACTIVE_AUTHORITY;
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const olderCompleteCycleId = currentCycleId - 3;
    const nextPendingCycleId = currentCycleId - 2;
    getOrCreateRoundExecutionState(state, olderCompleteCycleId, 0).participationSubmitted = true;
    getOrCreateRoundExecutionState(state, nextPendingCycleId, 0).participationSubmitted = true;
    inspectSatCycleRegistryMeta.mockImplementation(async (_config, { cycleId }) => ({
      cycleId,
      participantCount: 1,
      pageCount: 1,
    }));
    inspectSatCycleSettlementProgressV2.mockImplementation(async (_config, { cycleId }) => {
      const submittedProgress = progressFromSubmittedGatewayCalls(cycleId);
      if (submittedProgress) {
        return submittedProgress;
      }
      if (cycleId === olderCompleteCycleId) {
        return {
          cycleId,
          expectedPageCount: 1,
          processedPageCount: 1,
          settleChunkIndex: 0,
          scoredPageCount: 1,
          scoreChunkIndex: 0,
          distributedPageCount: 1,
          distributeChunkIndex: 0,
          finalized: true,
          scored: true,
        };
      }
      return {
        cycleId,
        expectedPageCount: 1,
        processedPageCount: 1,
        settleChunkIndex: 0,
        scoredPageCount: 0,
        scoreChunkIndex: 0,
        distributedPageCount: 0,
        distributeChunkIndex: 0,
        finalized: true,
        scored: false,
      };
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.scoreCyclePage",
      "sat.distributeCyclePage",
    ]);
    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.payload?.cycleId)).toEqual([
      nextPendingCycleId,
      nextPendingCycleId,
    ]);
    const olderExecution = getOrCreateRoundExecutionState(state, olderCompleteCycleId, 0);
    expect(olderExecution.crankSubmitted).toBe(true);
    expect(olderExecution.epochFinalized).toBe(true);

    await service.stop?.();
  });

  it("skips stale closed roundExecution entries outside the live pending range", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const staleClosedCycleId = currentCycleId - 4;
    const pendingFirstCycleId = currentCycleId - 2;
    const pendingLastCycleId = currentCycleId - 1;
    getOrCreateRoundExecutionState(state, staleClosedCycleId, 0).participationSubmitted = true;
    inspectSatMinerCapital.mockResolvedValue({
      firstPendingCycleId: pendingFirstCycleId,
      lastPendingCycleId: pendingLastCycleId,
    });
    inspectSatMinerCycleAccountExists.mockImplementation(async (_config, { cycleId }) => {
      return cycleId === pendingFirstCycleId || cycleId === pendingLastCycleId;
    });
    inspectSatCycleRegistryMeta.mockImplementation(async (_config, { cycleId }) => {
      if (cycleId === staleClosedCycleId) {
        return null;
      }
      return {
        cycleId,
        participantCount: 1,
        pageCount: 1,
      };
    });
    inspectSatCycleSettlementProgressV2.mockImplementation(async (_config, { cycleId }) => {
      const submittedProgress = progressFromSubmittedGatewayCalls(cycleId);
      if (submittedProgress) {
        return submittedProgress;
      }
      if (cycleId === staleClosedCycleId) {
        return null;
      }
      return {
        cycleId,
        expectedPageCount: 1,
        processedPageCount: 0,
        settleChunkIndex: 0,
        scoredPageCount: 0,
        scoreChunkIndex: 0,
        distributedPageCount: 0,
        distributeChunkIndex: 0,
        finalized: false,
        scored: false,
      };
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method).slice(0, 4)).toEqual([
      "sat.settleCyclePage",
      "sat.finalizeCycleSettlement",
      "sat.scoreCyclePage",
      "sat.distributeCyclePage",
    ]);
    expect(
      runSatGatewayMethod.mock.calls.map((call) => call[0]?.payload?.cycleId).slice(0, 4),
    ).toEqual([pendingFirstCycleId, pendingFirstCycleId, pendingFirstCycleId, pendingFirstCycleId]);
    const staleExecution = getOrCreateRoundExecutionState(state, staleClosedCycleId, 0);
    expect(staleExecution.crankSubmitted).toBe(true);
    expect(staleExecution.epochFinalized).toBe(true);

    await service.stop?.();
  });

  it("caps stale pending capital ranges to the live backlog window", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const staleFirstPendingCycleId = currentCycleId - 20;
    const livePendingCycleId = currentCycleId - 1;
    inspectSatMinerCapital.mockResolvedValue({
      firstPendingCycleId: staleFirstPendingCycleId,
      lastPendingCycleId: livePendingCycleId,
    });
    inspectSatMinerCycleAccountExists.mockImplementation(async (_config, { cycleId }) => {
      return cycleId === livePendingCycleId;
    });
    inspectSatCycleRegistryMeta.mockImplementation(async (_config, { cycleId }) => {
      if (cycleId !== livePendingCycleId) {
        return null;
      }
      return {
        cycleId,
        participantCount: 1,
        pageCount: 1,
      };
    });
    inspectSatCycleSettlementProgressV2.mockImplementation(async (_config, { cycleId }) => {
      const submittedProgress = progressFromSubmittedGatewayCalls(cycleId);
      if (submittedProgress) {
        return submittedProgress;
      }
      if (cycleId !== livePendingCycleId) {
        return null;
      }
      return {
        cycleId,
        expectedPageCount: 1,
        processedPageCount: 0,
        settleChunkIndex: 0,
        scoredPageCount: 0,
        scoreChunkIndex: 0,
        distributedPageCount: 0,
        distributeChunkIndex: 0,
        finalized: false,
        scored: false,
      };
    });
    inspectSatCycleRegistryPage.mockResolvedValue({
      cycleId: livePendingCycleId,
      pageIndex: 0,
      participantCount: 1,
      participants: [derivedMinerCycleAddress(ACTIVE_AUTHORITY, livePendingCycleId)],
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.payload?.cycleId)).toEqual([
      livePendingCycleId,
      livePendingCycleId,
      livePendingCycleId,
      livePendingCycleId,
    ]);
    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.settleCyclePage",
      "sat.finalizeCycleSettlement",
      "sat.scoreCyclePage",
      "sat.distributeCyclePage",
    ]);

    await service.stop?.();
  });

  it("replays the oldest exact pending cycle beyond the legacy slot horizon", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const oldestPendingCycleId = currentCycleId - 20;
    const newestPendingCycleId = currentCycleId - 1;
    inspectSatMinerCapital.mockResolvedValue({
      firstPendingCycleId: oldestPendingCycleId,
      lastPendingCycleId: newestPendingCycleId,
    });
    inspectSatMinerCycleAccountExists.mockImplementation(async (_config, { cycleId }) => {
      return cycleId === oldestPendingCycleId;
    });
    inspectSatCycleRegistryMeta.mockImplementation(async (_config, { cycleId }) => {
      if (cycleId !== oldestPendingCycleId) {
        return null;
      }
      return {
        cycleId,
        participantCount: 1,
        pageCount: 1,
      };
    });
    inspectSatCycleSettlementProgressV2.mockImplementation(async (_config, { cycleId }) => {
      const submittedProgress = progressFromSubmittedGatewayCalls(cycleId);
      if (submittedProgress) {
        return submittedProgress;
      }
      if (cycleId !== oldestPendingCycleId) {
        return null;
      }
      return {
        cycleId,
        expectedPageCount: 1,
        processedPageCount: 0,
        settleChunkIndex: 0,
        scoredPageCount: 0,
        scoreChunkIndex: 0,
        distributedPageCount: 0,
        distributeChunkIndex: 0,
        finalized: false,
        scored: false,
      };
    });
    inspectSatCycleRegistryPage.mockResolvedValue({
      cycleId: oldestPendingCycleId,
      pageIndex: 0,
      participantCount: 1,
      participants: [derivedMinerCycleAddress(ACTIVE_AUTHORITY, oldestPendingCycleId)],
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.payload?.cycleId)).toEqual([
      oldestPendingCycleId,
      oldestPendingCycleId,
      oldestPendingCycleId,
      oldestPendingCycleId,
    ]);
    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.settleCyclePage",
      "sat.finalizeCycleSettlement",
      "sat.scoreCyclePage",
      "sat.distributeCyclePage",
    ]);

    await service.stop?.();
  });

  it("retries finalize after a failure without replaying settle on the next tick", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    getOrCreateRoundExecutionState(state, previousCycleId, 0).participationSubmitted = true;
    inspectSatCycleRegistryMeta.mockResolvedValue({
      cycleId: previousCycleId,
      participantCount: 2,
      pageCount: 1,
    });
    let progress: CycleSettlementProgress = {
      cycleId: previousCycleId,
      expectedPageCount: 1,
      processedPageCount: 1,
      settleChunkIndex: 0,
      scoredPageCount: 0,
      scoreChunkIndex: 0,
      distributedPageCount: 0,
      distributeChunkIndex: 0,
      finalized: false,
      scored: false,
    };
    inspectSatCycleSettlementProgressV2.mockImplementation(async () => progress);
    inspectSatCycleRegistryPage.mockResolvedValue({
      cycleId: previousCycleId,
      pageIndex: 0,
      participantCount: 2,
      participants: [
        derivedMinerCycleAddress(PEER_AUTHORITY, previousCycleId),
        derivedMinerCycleAddress(ACTIVE_AUTHORITY, previousCycleId),
      ],
    });
    runSatGatewayMethod.mockImplementation(async (args: unknown) => {
      const method = (args as { method?: string })?.method;
      if (
        method === "sat.finalizeCycleSettlement" &&
        runSatGatewayMethod.mock.calls.filter((call) => call[0]?.method === method).length === 1
      ) {
        throw new Error("temporary finalize failure");
      }
      if (method === "sat.finalizeCycleSettlement") {
        progress = { ...progress, finalized: true };
      } else if (method === "sat.scoreCyclePage") {
        progress = { ...progress, scoredPageCount: 1, scored: true };
      } else if (method === "sat.distributeCyclePage") {
        progress = { ...progress, distributedPageCount: 1 };
      }
      return { ok: true };
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method)).toEqual([
      "sat.finalizeCycleSettlement",
      "sat.finalizeCycleSettlement",
      "sat.scoreCyclePage",
      "sat.distributeCyclePage",
    ]);
    expect(
      runSatGatewayMethod.mock.calls.filter((call) => call[0]?.method === "sat.settleCyclePage"),
    ).toHaveLength(0);

    await service.stop?.();
  });

  it("retries distribute after a failure without replaying settle, finalize, or score", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    getOrCreateRoundExecutionState(state, previousCycleId, 0).participationSubmitted = true;
    inspectSatCycleRegistryMeta.mockResolvedValue({
      cycleId: previousCycleId,
      participantCount: 2,
      pageCount: 2,
    });
    inspectSatCycleSettlementProgressV2
      .mockResolvedValueOnce({
        cycleId: previousCycleId,
        expectedPageCount: 2,
        processedPageCount: 2,
        settleChunkIndex: 0,
        scoredPageCount: 2,
        scoreChunkIndex: 0,
        distributedPageCount: 0,
        distributeChunkIndex: 0,
        finalized: true,
        scored: true,
      })
      .mockResolvedValueOnce({
        cycleId: previousCycleId,
        expectedPageCount: 2,
        processedPageCount: 2,
        settleChunkIndex: 0,
        scoredPageCount: 2,
        scoreChunkIndex: 0,
        distributedPageCount: 0,
        distributeChunkIndex: 0,
        finalized: true,
        scored: true,
      });
    inspectSatCycleRegistryPage.mockResolvedValue({
      cycleId: previousCycleId,
      pageIndex: 0,
      participantCount: 2,
      participants: ["11111111111111111111111111111111", "11111111111111111111111111111112"],
    });
    runSatGatewayMethod.mockImplementation(async (args: unknown) => {
      const method = (args as { method?: string })?.method;
      if (
        method === "sat.distributeCyclePage" &&
        runSatGatewayMethod.mock.calls.filter((call) => call[0]?.method === method).length === 1
      ) {
        throw new Error("temporary distribute failure");
      }
      return { ok: true };
    });
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(
      runSatGatewayMethod.mock.calls.filter(
        (call) => call[0]?.method === "sat.distributeCyclePage",
      ),
    ).toHaveLength(2);
    expect(
      runSatGatewayMethod.mock.calls.filter((call) => call[0]?.method === "sat.settleCyclePage"),
    ).toHaveLength(0);
    expect(
      runSatGatewayMethod.mock.calls.filter(
        (call) => call[0]?.method === "sat.finalizeCycleSettlement",
      ),
    ).toHaveLength(0);
    expect(
      runSatGatewayMethod.mock.calls.filter((call) => call[0]?.method === "sat.scoreCyclePage"),
    ).toHaveLength(0);

    await service.stop?.();
  });

  it("derives the single-participant miner cycle PDA during restart recovery when page data is unavailable", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    inspectSatMinerCycleAccountExists.mockImplementation(async (_config, { cycleId }) => {
      return cycleId === previousCycleId;
    });
    inspectSatCycleRegistryMeta.mockResolvedValueOnce({
      cycleId: previousCycleId,
      participantCount: 1,
      pageCount: 1,
    });
    inspectSatCycleSettlementProgressV2.mockResolvedValueOnce({
      cycleId: previousCycleId,
      expectedPageCount: 1,
      processedPageCount: 0,
      settleChunkIndex: 0,
      scoredPageCount: 0,
      scoreChunkIndex: 0,
      distributedPageCount: 0,
      distributeChunkIndex: 0,
      finalized: false,
      scored: false,
    });
    inspectSatCycleRegistryPage.mockResolvedValueOnce(null);
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls.map((call) => call[0]?.method).slice(0, 4)).toEqual([
      "sat.settleCyclePage",
      "sat.finalizeCycleSettlement",
      "sat.scoreCyclePage",
      "sat.distributeCyclePage",
    ]);
    expect(runSatGatewayMethod.mock.calls[0]?.[0]?.payload?.minerCycleAccounts).toEqual([
      `derived-${state.activeWalletAddress}-${previousCycleId}`,
    ]);
    expect(deriveSatMinerCycleAddress).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      }),
      {
        authority: state.activeWalletAddress,
        cycleId: previousCycleId,
      },
    );

    await service.stop?.();
  });

  it("falls back to cycle-wide miner-cycle discovery for a single-page multi-participant restart recovery", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    const previousCycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    inspectSatMinerCycleAccountExists.mockImplementation(async (_config, { cycleId }) => {
      return cycleId === previousCycleId;
    });
    inspectSatCycleRegistryMeta.mockResolvedValueOnce({
      cycleId: previousCycleId,
      participantCount: 2,
      pageCount: 1,
    });
    inspectSatCycleSettlementProgressV2.mockResolvedValueOnce({
      cycleId: previousCycleId,
      expectedPageCount: 1,
      processedPageCount: 0,
      settleChunkIndex: 0,
      scoredPageCount: 0,
      scoreChunkIndex: 0,
      distributedPageCount: 0,
      distributeChunkIndex: 0,
      finalized: false,
      scored: false,
    });
    inspectSatCycleRegistryPage.mockResolvedValueOnce(null);
    listSatMinerCycleAddressesForCycle.mockResolvedValueOnce([
      derivedMinerCycleAddress(ACTIVE_AUTHORITY, previousCycleId),
      derivedMinerCycleAddress(PEER_AUTHORITY, previousCycleId),
    ]);
    const api = {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatEpochService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(runSatGatewayMethod.mock.calls[0]?.[0]?.method).toBe("sat.settleCyclePage");
    expect(runSatGatewayMethod.mock.calls[0]?.[0]?.payload?.minerCycleAccounts).toEqual([
      derivedMinerCycleAddress(ACTIVE_AUTHORITY, previousCycleId),
      derivedMinerCycleAddress(PEER_AUTHORITY, previousCycleId),
    ]);
    expect(listSatMinerCycleAddressesForCycle).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-a",
      }),
      {
        cycleId: previousCycleId,
      },
    );

    await service.stop?.();
  });
});
