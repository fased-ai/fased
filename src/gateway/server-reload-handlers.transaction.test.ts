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
    };
    const candidateCron = {
      start: vi.fn(async () => {}),
      stop: vi.fn(),
    };
    cronMocks.buildGatewayCronService.mockReturnValue({
      cron: candidateCron,
      storePath: "/tmp/candidate-cron.json",
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
    expect(candidateCron.stop).toHaveBeenCalledTimes(1);
    expect(originalCron.start).toHaveBeenCalledTimes(1);
    expect(state.cronState.cron).toBe(originalCron);
    expect(stopChannel).toHaveBeenCalledTimes(2);
    expect(startChannel).toHaveBeenCalledTimes(2);
    expect(logs.join("\n")).not.toContain("SENTINEL_CANDIDATE_CHANNEL_FAILURE");
  });
});
