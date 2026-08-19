import { afterEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import type { GatewayReloadPlan } from "./config-reload.js";

const cronMocks = vi.hoisted(() => ({
  buildGatewayCronService: vi.fn(),
}));

vi.mock("./server-cron.js", () => ({
  buildGatewayCronService: cronMocks.buildGatewayCronService,
}));

const { createGatewayReloadHandlers } = await import("./server-reload-handlers.js");

const previousSkipChannels = process.env.FASED_SKIP_CHANNELS;
const previousSkipProviders = process.env.FASED_SKIP_PROVIDERS;

afterEach(() => {
  if (previousSkipChannels === undefined) {
    delete process.env.FASED_SKIP_CHANNELS;
  } else {
    process.env.FASED_SKIP_CHANNELS = previousSkipChannels;
  }
  if (previousSkipProviders === undefined) {
    delete process.env.FASED_SKIP_PROVIDERS;
  } else {
    process.env.FASED_SKIP_PROVIDERS = previousSkipProviders;
  }
  vi.clearAllMocks();
});

describe("gateway hot reload transaction", () => {
  it("restores a mutated cron and channel after a later component fails", async () => {
    delete process.env.FASED_SKIP_CHANNELS;
    delete process.env.FASED_SKIP_PROVIDERS;

    const originalCron = {
      start: vi.fn(async () => {}),
      stop: vi.fn(),
      stopAndDrainForLifecycle: vi.fn(async () => {}),
    };
    const candidateCron = {
      start: vi.fn(async () => {}),
      stop: vi.fn(),
      stopAndDrainForLifecycle: vi.fn(async () => {}),
    };
    const restoredCron = {
      start: vi.fn(async () => {}),
      stop: vi.fn(),
      stopAndDrainForLifecycle: vi.fn(async () => {}),
    };
    cronMocks.buildGatewayCronService
      .mockReturnValueOnce({
        cron: candidateCron,
        storePath: "/tmp/candidate-cron.json",
        cronEnabled: true,
      })
      .mockReturnValueOnce({
        cron: restoredCron,
        storePath: "/tmp/restored-cron.json",
        cronEnabled: true,
      });

    let state = {
      hooksConfig: null,
      heartbeatRunner: {
        stop: vi.fn(),
        updateConfig: vi.fn(),
      },
      cronState: {
        cron: originalCron,
        storePath: "/tmp/original-cron.json",
        cronEnabled: true,
      },
      browserControl: null,
    };
    const stopChannel = vi.fn(async () => {});
    const startChannel = vi
      .fn<(_name: "telegram") => Promise<void>>()
      .mockRejectedValueOnce(new Error("SENTINEL_CANDIDATE_CHANNEL_FAILURE"))
      .mockResolvedValue(undefined);
    const logs: string[] = [];
    const handlers = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => state as never,
      setState: (nextState) => {
        state = nextState as unknown as typeof state;
      },
      startChannel: startChannel as never,
      stopChannel,
      logHooks: {
        info: (message) => logs.push(message),
        warn: (message) => logs.push(message),
        error: (message) => logs.push(message),
      },
      logBrowser: { error: (message) => logs.push(message) },
      logChannels: {
        info: (message) => logs.push(message),
        error: (message) => logs.push(message),
      },
      logCron: { error: (message) => logs.push(message) },
      logReload: {
        info: (message) => logs.push(message),
        warn: (message) => logs.push(message),
      },
    });
    const plan: GatewayReloadPlan = {
      changedPaths: ["cron.enabled", "channels.telegram.botToken"],
      restartGateway: false,
      restartReasons: [],
      hotReasons: ["cron.enabled", "channels.telegram.botToken"],
      reloadHooks: false,
      restartGmailWatcher: false,
      restartBrowserControl: false,
      restartCron: true,
      restartHeartbeat: false,
      restartChannels: new Set(["telegram"]),
      noopPaths: [],
    };
    const previousConfig = {
      cron: { enabled: true, store: "/tmp/original-cron.json" },
      channels: { telegram: { botToken: "previous-token" } },
    } satisfies FasedAgentConfig;
    const candidateConfig = {
      cron: { enabled: true, store: "/tmp/candidate-cron.json" },
      channels: { telegram: { botToken: "candidate-token" } },
    } satisfies FasedAgentConfig;
    const transaction = handlers.createHotReloadTransaction(plan);

    await expect(transaction.apply(candidateConfig)).rejects.toThrow(
      "SENTINEL_CANDIDATE_CHANNEL_FAILURE",
    );
    expect(state.cronState.cron).toBe(candidateCron);
    expect(candidateCron.start).toHaveBeenCalledTimes(1);

    await expect(transaction.rollback(previousConfig)).resolves.toBeUndefined();
    expect(originalCron.stopAndDrainForLifecycle).toHaveBeenCalledTimes(1);
    expect(candidateCron.stopAndDrainForLifecycle).toHaveBeenCalledTimes(1);
    expect(restoredCron.start).toHaveBeenCalledTimes(1);
    expect(originalCron.start).not.toHaveBeenCalled();
    expect(state.cronState.cron).toBe(restoredCron);
    expect(stopChannel).toHaveBeenCalledTimes(2);
    expect(startChannel).toHaveBeenCalledTimes(2);
    expect(logs.join("\n")).not.toContain("SENTINEL_CANDIDATE_CHANNEL_FAILURE");
  });

  it("waits for old cron drain before building or publishing the replacement", async () => {
    let resolveOldDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      resolveOldDrain = resolve;
    });
    const originalCron = {
      start: vi.fn(async () => {}),
      stop: vi.fn(),
      stopAndDrainForLifecycle: vi.fn(async () => await drain),
    };
    const candidateCron = {
      start: vi.fn(async () => {}),
      stop: vi.fn(),
      stopAndDrainForLifecycle: vi.fn(async () => {}),
    };
    cronMocks.buildGatewayCronService.mockReturnValueOnce({
      cron: candidateCron,
      storePath: "/tmp/candidate-cron.json",
      cronEnabled: true,
    });
    let state = {
      hooksConfig: null,
      heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() },
      cronState: { cron: originalCron, storePath: "/tmp/original-cron.json", cronEnabled: true },
      browserControl: null,
    };
    const handlers = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => state as never,
      setState: (nextState) => {
        state = nextState as unknown as typeof state;
      },
      startChannel: vi.fn(async () => {}) as never,
      stopChannel: vi.fn(async () => {}) as never,
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logBrowser: { error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
    });
    const plan: GatewayReloadPlan = {
      changedPaths: ["cron.enabled"],
      restartGateway: false,
      restartReasons: [],
      hotReasons: ["cron.enabled"],
      reloadHooks: false,
      restartGmailWatcher: false,
      restartBrowserControl: false,
      restartCron: true,
      restartHeartbeat: false,
      restartChannels: new Set(),
      noopPaths: [],
    };
    const transaction = handlers.createHotReloadTransaction(plan);
    const apply = transaction.apply({ cron: { enabled: true } } as FasedAgentConfig);

    await Promise.resolve();
    expect(cronMocks.buildGatewayCronService).not.toHaveBeenCalled();
    expect(state.cronState.cron).toBe(originalCron);

    resolveOldDrain();
    await apply;
    expect(cronMocks.buildGatewayCronService).toHaveBeenCalledTimes(1);
    expect(candidateCron.start).toHaveBeenCalledTimes(1);
    expect(state.cronState.cron).toBe(candidateCron);
  });
});
