import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSatRecoveryService } from "./recovery-service.js";
import { createSatMiningRuntimeState, getOrCreateRoundExecutionState } from "./runtime.js";

const runSatGatewayMethod = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true }));
const inspectSatChainUnixTime = vi.fn(async () => Math.floor(Date.now() / 1000));
const inspectSatMinerCapital = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const inspectSatCycle = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const inspectSatMinerCycle = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const inspectSatCycleSettlementProgressV2 = vi.fn(
  async (..._args: unknown[]): Promise<unknown> => null,
);

vi.mock("./gateway-runner.js", () => ({
  runSatGatewayMethod: (args: unknown) => runSatGatewayMethod(args),
}));

vi.mock("./rpc-read.js", () => ({
  inspectSatChainUnixTime: () => inspectSatChainUnixTime(),
  inspectSatMinerCapital: (...args: unknown[]) => inspectSatMinerCapital(...args),
  inspectSatCycle: (...args: unknown[]) => inspectSatCycle(...args),
  inspectSatMinerCycle: (...args: unknown[]) => inspectSatMinerCycle(...args),
  inspectSatCycleSettlementProgressV2: (...args: unknown[]) =>
    inspectSatCycleSettlementProgressV2(...args),
}));

describe("createSatRecoveryService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T12:20:00.000Z"));
    runSatGatewayMethod.mockReset();
    runSatGatewayMethod.mockResolvedValue({ ok: true });
    inspectSatChainUnixTime.mockReset();
    inspectSatChainUnixTime.mockImplementation(async () => Math.floor(Date.now() / 1000));
    inspectSatMinerCapital.mockReset();
    inspectSatMinerCapital.mockResolvedValue(null);
    inspectSatCycle.mockReset();
    inspectSatCycle.mockResolvedValue(null);
    inspectSatMinerCycle.mockReset();
    inspectSatMinerCycle.mockResolvedValue(null);
    inspectSatCycleSettlementProgressV2.mockReset();
    inspectSatCycleSettlementProgressV2.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays idle when there is no active round context to recover", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    const api = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRecoveryService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(state.workers.recovery.running).toBe(false);
    expect(state.workers.recovery.waitingReason).toBeNull();
    expect(api.logger.debug).not.toHaveBeenCalled();

    await service.stop?.();
  });

  it("marks recovery success when round context exists after restart", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.cycleContext = {
      epochId: 123,
      microRoundId: 0,
      bucketVersion: 1,
      roundOpenTs: 0,
      roundCloseTs: 300,
      roundSeed: "seed",
      bucketHash: "hash",
    };
    const api = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRecoveryService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(state.workers.recovery.lastSuccessAt).toBeTruthy();
    expect(state.workers.recovery.lastDetail).toContain("123:0");
    expect(api.logger.debug).toHaveBeenCalled();

    await service.stop?.();
  });

  it("surfaces the oldest unresolved backlog cycle in recovery detail after a gap", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.cycleContext = {
      epochId: 123,
      microRoundId: 0,
      bucketVersion: 1,
      roundOpenTs: 0,
      roundCloseTs: 300,
      roundSeed: "seed",
      bucketHash: "hash",
    };
    getOrCreateRoundExecutionState(state, 120, 0).participationSubmitted = true;
    getOrCreateRoundExecutionState(state, 121, 0).participationSubmitted = true;
    const api = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRecoveryService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(state.workers.recovery.lastDetail).toContain("123:0");
    expect(state.workers.recovery.lastDetail).toContain("backlog 120 (2)");
    expect(api.logger.debug).toHaveBeenCalledWith(expect.stringContaining("backlog 120 (2)"));

    await service.stop?.();
  });

  it("moves recovery backlog detail forward once the oldest unresolved cycle is already cranked", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.cycleContext = {
      epochId: 123,
      microRoundId: 0,
      bucketVersion: 1,
      roundOpenTs: 0,
      roundCloseTs: 300,
      roundSeed: "seed",
      bucketHash: "hash",
    };
    getOrCreateRoundExecutionState(state, 120, 0).participationSubmitted = true;
    getOrCreateRoundExecutionState(state, 120, 0).crankSubmitted = true;
    getOrCreateRoundExecutionState(state, 121, 0).participationSubmitted = true;
    const api = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRecoveryService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(state.workers.recovery.lastDetail).toContain("123:0");
    expect(state.workers.recovery.lastDetail).toContain("backlog 121 (1)");
    expect(state.workers.recovery.lastDetail).not.toContain("backlog 120");

    await service.stop?.();
  });

  it("prefers the effective runtime backlog detail over a stale raw pending range", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    state.cycleContext = {
      epochId: 123,
      microRoundId: 0,
      bucketVersion: 1,
      roundOpenTs: 0,
      roundCloseTs: 300,
      roundSeed: "seed",
      bucketHash: "hash",
    };
    getOrCreateRoundExecutionState(state, 121, 0).participationSubmitted = true;
    inspectSatMinerCapital.mockResolvedValue({
      firstPendingCycleId: 100,
      lastPendingCycleId: 130,
    });
    const api = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRecoveryService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(state.workers.recovery.lastDetail).toContain("backlog 121 (1)");
    expect(state.workers.recovery.lastDetail).not.toContain("backlog 100-130");

    await service.stop?.();
  });

  it("runs pending-range compaction before other recovery work when the raw range exists", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    state.cycleContext = {
      epochId: 123,
      microRoundId: 0,
      bucketVersion: 1,
      roundOpenTs: 0,
      roundCloseTs: 300,
      roundSeed: "seed",
      bucketHash: "hash",
    };
    inspectSatMinerCapital.mockResolvedValue({
      firstPendingCycleId: 100,
      lastPendingCycleId: 130,
    });
    runSatGatewayMethod.mockImplementation(async (...args: unknown[]) => {
      const payload = args[0] as { method?: string } | undefined;
      if (payload?.method === "sat.compactPendingCycleRange") {
        return {
          compacted: true,
          frontCycleIds: [100, 101],
          backCycleIds: [],
          after: {
            firstPendingCycleId: 102,
            lastPendingCycleId: 130,
          },
        };
      }
      return { ok: true };
    });
    const api = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRecoveryService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(runSatGatewayMethod).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sat.compactPendingCycleRange",
        payload: { maxFrontCycles: 4, maxBackCycles: 4 },
      }),
    );
    expect(state.workers.recovery.lastDetail).toContain("compacted pending range");
    expect(state.workers.recovery.lastDetail).toContain("backlog 102-130 (29)");

    await service.stop?.();
  });

  it("retries after a recovery tick failure and succeeds on the next interval", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.cycleContext = {
      epochId: 123,
      microRoundId: 0,
      bucketVersion: 1,
      roundOpenTs: 0,
      roundCloseTs: 300,
      roundSeed: "seed",
      bucketHash: "hash",
    };
    const api = {
      logger: {
        debug: vi
          .fn()
          .mockImplementationOnce(() => {
            throw new Error("temporary recovery failure");
          })
          .mockImplementation(() => undefined),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as const;

    const service = createSatRecoveryService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(state.workers.recovery.retryCount).toBe(1);
    expect(state.workers.recovery.lastError).toContain("temporary recovery failure");
    expect(state.workers.recovery.waitingReason).toContain("retrying after failure");
    expect(api.logger.warn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);

    expect(state.workers.recovery.retryCount).toBe(0);
    expect(state.workers.recovery.lastSuccessAt).toBeTruthy();
    expect(state.workers.recovery.lastDetail).toContain("123:0");

    await service.stop?.();
  });

  it("retries quickly when a chain read hangs during recovery inspection", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "11111111111111111111111111111111";
    state.cycleContext = {
      epochId: 123,
      microRoundId: 0,
      bucketVersion: 1,
      roundOpenTs: 0,
      roundCloseTs: 300,
      roundSeed: "seed",
      bucketHash: "hash",
    };
    inspectSatMinerCapital.mockImplementation(
      async () => await new Promise<never>(() => undefined),
    );
    const api = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRecoveryService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(24_000);

    expect(state.workers.recovery.waitingReason).toContain("recovery RPC read timed out");
    expect(state.workers.recovery.lastError).toBeNull();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("recovery service timed out on a chain read"),
    );

    await service.stop?.();
  });

  it("backs off recovery retries when RPC is rate limited", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.cycleContext = {
      epochId: 123,
      microRoundId: 0,
      bucketVersion: 1,
      roundOpenTs: 0,
      roundCloseTs: 300,
      roundSeed: "seed",
      bucketHash: "hash",
    };
    const api = {
      logger: {
        debug: vi
          .fn()
          .mockImplementationOnce(() => {
            throw new Error("rate limited");
          })
          .mockImplementation(() => undefined),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as const;

    const service = createSatRecoveryService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(state.workers.recovery.retryCount).toBe(1);
    expect(state.workers.recovery.waitingReason).toContain("rate limited; backing off 60s");
    expect(state.workers.recovery.nextScheduledAt).toBe(
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("recovery service rate limited; backing off 60s"),
    );

    await service.stop?.();
  });

  it("recovers prior-cycle entropy before considering an expired reveal deadline", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "authority-1";
    const nowSec = Math.floor(Date.now() / 1000);
    const cycleId = Math.floor(nowSec / 300) - 1;
    getOrCreateRoundExecutionState(state, cycleId, 0).commitSubmitted = true;
    inspectSatMinerCapital.mockResolvedValue({
      lockedLamports: "300000000",
      firstPendingCycleId: cycleId,
      lastPendingCycleId: cycleId,
    });
    inspectSatCycle.mockResolvedValue({
      cycleId,
      status: 1,
      cycleSeed: "0".repeat(64),
      commitDeadlineTs: nowSec - 180,
      revealDeadlineTs: nowSec - 60,
      entropyTargetSlot: 123,
      committedMinerCount: "1",
      resolvedCommitCount: "0",
      validMinerCount: "0",
    });
    inspectSatMinerCycle.mockResolvedValue({
      authority: "authority-1",
      cycleId,
      validParticipation: false,
      capitalLockReleased: false,
    });
    const api = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRecoveryService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(runSatGatewayMethod).toHaveBeenCalledTimes(1);
    expect(runSatGatewayMethod).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sat.sealCycleEntropy",
        payload: { cycleId },
      }),
    );
    expect(state.workers.recovery.waitingReason).toContain("sealing post-reveal entropy");

    await service.stop?.();
  });

  it("releases a missed prior reveal and aborts a fully resolved empty cycle", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "authority-1";
    const nowSec = Math.floor(Date.now() / 1000);
    const cycleId = Math.floor(nowSec / 300) - 1;
    getOrCreateRoundExecutionState(state, cycleId, 0).commitSubmitted = true;
    inspectSatMinerCapital.mockResolvedValue({
      lockedLamports: "300000000",
      firstPendingCycleId: cycleId,
      lastPendingCycleId: cycleId,
    });
    inspectSatCycle
      .mockResolvedValueOnce({
        cycleId,
        status: 1,
        cycleSeed: "7".repeat(64),
        commitDeadlineTs: nowSec - 180,
        revealDeadlineTs: nowSec - 60,
        entropyTargetSlot: 123,
        committedMinerCount: "1",
        resolvedCommitCount: "0",
        validMinerCount: "0",
      })
      .mockResolvedValueOnce({
        cycleId,
        status: 1,
        cycleSeed: "7".repeat(64),
        committedMinerCount: "1",
        resolvedCommitCount: "1",
        validMinerCount: "0",
      });
    inspectSatMinerCycle.mockResolvedValue({
      authority: "authority-1",
      cycleId,
      validParticipation: false,
      capitalLockReleased: false,
    });
    const api = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRecoveryService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(
      runSatGatewayMethod.mock.calls.map(
        (call) => (call[0] as { method?: string } | undefined)?.method,
      ),
    ).toEqual([
      "sat.releaseUnrevealedCommit",
      "sat.abortEmptyCycle",
      "sat.closeResolvedCycleAccounts",
    ]);
    expect(state.roundExecution.has(`${cycleId}:0`)).toBe(false);
    expect(state.workers.recovery.lastDetail).toContain(
      `released missed reveal and aborted empty cycle ${cycleId}`,
    );

    await service.stop?.();
  });

  it("unwinds an unprovable prior-cycle commitment without a missed-reveal penalty", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "authority-1";
    const nowSec = Math.floor(Date.now() / 1000);
    const cycleId = Math.floor(nowSec / 300) - 1;
    getOrCreateRoundExecutionState(state, cycleId, 0).commitSubmitted = true;
    inspectSatMinerCapital.mockResolvedValue({
      lockedLamports: "300000000",
      firstPendingCycleId: cycleId,
      lastPendingCycleId: cycleId,
    });
    inspectSatCycle
      .mockResolvedValueOnce({
        cycleId,
        status: 1,
        cycleSeed: "ff".repeat(32),
        entropyUnavailable: true,
        commitDeadlineTs: nowSec - 180,
        revealDeadlineTs: nowSec + 60,
        entropyTargetSlot: 123,
        committedMinerCount: "1",
        resolvedCommitCount: "0",
        validMinerCount: "0",
      })
      .mockResolvedValueOnce({
        cycleId,
        status: 1,
        cycleSeed: "ff".repeat(32),
        entropyUnavailable: true,
        committedMinerCount: "1",
        resolvedCommitCount: "1",
        validMinerCount: "0",
      });
    inspectSatMinerCycle.mockResolvedValue({
      authority: "authority-1",
      cycleId,
      validParticipation: false,
      capitalLockReleased: false,
    });
    const api = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRecoveryService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(
      runSatGatewayMethod.mock.calls.map(
        (call) => (call[0] as { method?: string } | undefined)?.method,
      ),
    ).toEqual([
      "sat.releaseUnrevealedCommit",
      "sat.abortEmptyCycle",
      "sat.closeResolvedCycleAccounts",
    ]);
    expect(state.roundExecution.has(`${cycleId}:0`)).toBe(false);
    expect(state.workers.recovery.lastDetail).toContain("without penalty");

    await service.stop?.();
  });

  it("closes its own resolved commitment after another keeper aborts the empty cycle", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "authority-1";
    const cycleId = Math.floor(Date.now() / 1000 / 300) - 1;
    getOrCreateRoundExecutionState(state, cycleId, 0).commitSubmitted = true;
    inspectSatMinerCapital.mockResolvedValue({
      lockedLamports: "0",
      firstPendingCycleId: cycleId,
      lastPendingCycleId: cycleId,
    });
    inspectSatCycle.mockResolvedValue({
      cycleId,
      status: 2,
      committedMinerCount: "2",
      resolvedCommitCount: "2",
      validMinerCount: "0",
    });
    inspectSatMinerCycle.mockResolvedValue({
      authority: "authority-1",
      cycleId,
      validParticipation: false,
      capitalLockReleased: true,
      claimableSatRaw: "0",
      claimableDetRebateLamports: "0",
      claimablePerfRebateLamports: "0",
    });
    const api = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRecoveryService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(runSatGatewayMethod).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sat.closeResolvedCycleAccounts",
        payload: { cycleId },
      }),
    );
    expect(state.roundExecution.has(`${cycleId}:0`)).toBe(false);
    expect(state.workers.recovery.lastDetail).toContain(
      `closed resolved commitment cycle ${cycleId}`,
    );

    await service.stop?.();
  });

  it("automatically closes resolved exact cycles after claim completion", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "authority-1";
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const cycleId = currentCycleId - 1;
    getOrCreateRoundExecutionState(state, cycleId, 0).claimSubmitted = true;
    inspectSatMinerCapital.mockResolvedValue({
      address: "capital-1",
      authority: "authority-1",
      fundedLamports: "1000000000",
      lockedLamports: "0",
      freeLamports: "1000000000",
      activeCommitLamports: "300000000",
      firstPendingCycleId: 0,
      lastPendingCycleId: 0,
    });
    inspectSatMinerCycle.mockResolvedValue({
      address: `miner-cycle-${cycleId}`,
      authority: "authority-1",
      cycleId,
      validParticipation: true,
      capitalLockReleased: true,
      claimableSatRaw: "0",
      claimableDetRebateLamports: "0",
      claimablePerfRebateLamports: "0",
    });
    inspectSatCycleSettlementProgressV2.mockResolvedValue({
      address: `progress-${cycleId}`,
      cycleId,
      expectedPageCount: 1,
      processedPageCount: 1,
      scoredPageCount: 1,
      distributedPageCount: 1,
      finalized: true,
    });
    const api = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRecoveryService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(
      runSatGatewayMethod.mock.calls.map(
        (call) => (call[0] as { method?: string } | undefined)?.method,
      ),
    ).toEqual(["sat.closeResolvedCycleAccounts"]);
    expect(runSatGatewayMethod.mock.calls[0]?.[0]).toMatchObject({
      method: "sat.closeResolvedCycleAccounts",
      payload: { cycleId },
    });
    expect(state.roundExecution.has(`${cycleId}:0`)).toBe(false);
    expect(state.workers.recovery.lastDetail).toContain(`closed resolved cycle ${cycleId}`);

    await service.stop?.();
  });

  it("limits cleanup probes to recent close candidates", async () => {
    const config = {
      enabled: true,
      network: "devnet" as const,
      riskMode: "balanced" as const,
      walletId: "wallet-a",
    };
    const state = createSatMiningRuntimeState(config);
    state.activeWalletAddress = "authority-1";
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    getOrCreateRoundExecutionState(state, currentCycleId - 20, 0).claimSubmitted = true;
    for (let offset = 6; offset >= 1; offset -= 1) {
      getOrCreateRoundExecutionState(state, currentCycleId - offset, 0).claimSubmitted = true;
    }
    inspectSatMinerCapital.mockResolvedValue({
      address: "capital-1",
      authority: "authority-1",
      fundedLamports: "1000000000",
      lockedLamports: "0",
      freeLamports: "1000000000",
      activeCommitLamports: "300000000",
      firstPendingCycleId: 0,
      lastPendingCycleId: 0,
    });
    const api = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as const;

    const service = createSatRecoveryService({ api: api as never, config, state });
    await service.start();
    await vi.advanceTimersByTimeAsync(20_000);

    const probedCycleIds = inspectSatMinerCycle.mock.calls.map(
      (call) => (call[1] as { cycleId?: number } | undefined)?.cycleId,
    );
    expect(probedCycleIds).toEqual([
      currentCycleId - 6,
      currentCycleId - 5,
      currentCycleId - 4,
      currentCycleId - 3,
    ]);
    expect(probedCycleIds).not.toContain(currentCycleId - 20);
    expect(inspectSatCycleSettlementProgressV2).toHaveBeenCalledTimes(4);
    expect(runSatGatewayMethod).not.toHaveBeenCalled();

    await service.stop?.();
  });
});
