import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChannelId, type ChannelPlugin } from "../channels/plugins/types.js";
import {
  createSubsystemLogger,
  type SubsystemLogger,
  runtimeForLogger,
} from "../logging/subsystem.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { createChannelManager } from "./server-channels.js";

const hoisted = vi.hoisted(() => {
  const computeBackoff = vi.fn(() => 10);
  const sleepWithAbort = vi.fn((ms: number, abortSignal?: AbortSignal) => {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), ms);
      abortSignal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  });
  return { computeBackoff, sleepWithAbort };
});

vi.mock("../infra/backoff.js", () => ({
  computeBackoff: hoisted.computeBackoff,
  sleepWithAbort: hoisted.sleepWithAbort,
}));

type TestAccount = {
  enabled?: boolean;
  configured?: boolean;
};

function createTestPlugin(params?: {
  id?: ChannelPlugin<TestAccount>["id"];
  label?: string;
  account?: TestAccount;
  listAccountIds?: ChannelPlugin<TestAccount>["config"]["listAccountIds"];
  resolveAccount?: ChannelPlugin<TestAccount>["config"]["resolveAccount"];
  isConfigured?: ChannelPlugin<TestAccount>["config"]["isConfigured"];
  startAccount?: NonNullable<ChannelPlugin<TestAccount>["gateway"]>["startAccount"];
  includeDescribeAccount?: boolean;
}): ChannelPlugin<TestAccount> {
  const id = params?.id ?? "discord";
  const label = params?.label ?? "Discord";
  const account = params?.account ?? { enabled: true, configured: true };
  const includeDescribeAccount = params?.includeDescribeAccount !== false;
  const config: ChannelPlugin<TestAccount>["config"] = {
    listAccountIds: params?.listAccountIds ?? (() => [DEFAULT_ACCOUNT_ID]),
    resolveAccount: params?.resolveAccount ?? (() => account),
    isEnabled: (resolved) => resolved.enabled !== false,
  };
  if (params?.isConfigured) {
    config.isConfigured = params.isConfigured;
  }
  if (includeDescribeAccount) {
    config.describeAccount = (resolved) => ({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: resolved.enabled !== false,
      configured: resolved.configured !== false,
    });
  }
  const gateway: NonNullable<ChannelPlugin<TestAccount>["gateway"]> = {};
  if (params?.startAccount) {
    gateway.startAccount = params.startAccount;
  }
  return {
    id,
    meta: {
      id,
      label,
      selectionLabel: label,
      docsPath: "/channels/discord",
      blurb: "test stub",
    },
    capabilities: { chatTypes: ["direct"] },
    config,
    gateway,
  };
}

function installTestRegistry(...plugins: Array<ChannelPlugin<TestAccount>>) {
  const registry = createEmptyPluginRegistry();
  for (const plugin of plugins) {
    registry.channels.push({
      pluginId: plugin.id,
      source: "test",
      plugin,
    });
  }
  setActivePluginRegistry(registry);
}

function createManager() {
  const log = createSubsystemLogger("gateway/server-channels-test");
  const channelLogs = {
    discord: log,
    telegram: log,
  } as Record<ChannelId, SubsystemLogger>;
  const runtime = runtimeForLogger(log);
  const channelRuntimeEnvs = {
    discord: runtime,
    telegram: runtime,
  } as Record<ChannelId, RuntimeEnv>;
  return createChannelManager({
    loadConfig: () => ({}),
    channelLogs,
    channelRuntimeEnvs,
  });
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function waitForMicrotaskCondition(
  check: () => boolean,
  message: string,
  attempts = 100,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (check()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(message);
}

describe("server-channels auto restart", () => {
  let previousRegistry: PluginRegistry | null = null;

  beforeEach(() => {
    previousRegistry = getActivePluginRegistry();
    vi.useFakeTimers();
    hoisted.computeBackoff.mockClear();
    hoisted.sleepWithAbort.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
  });

  it("caps crash-loop restarts after max attempts", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    await vi.advanceTimersByTimeAsync(200);

    expect(startAccount).toHaveBeenCalledTimes(11);
    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.running).toBe(false);
    expect(account?.reconnectAttempts).toBe(10);

    await vi.advanceTimersByTimeAsync(200);
    expect(startAccount).toHaveBeenCalledTimes(11);
  });

  it("does not auto-restart after manual stop during backoff", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    vi.runAllTicks();
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);

    await vi.advanceTimersByTimeAsync(200);
    expect(startAccount).toHaveBeenCalledTimes(1);
  });

  it("marks enabled/configured when account descriptors omit them", () => {
    installTestRegistry(
      createTestPlugin({
        includeDescribeAccount: false,
      }),
    );
    const manager = createManager();
    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.enabled).toBe(true);
    expect(account?.configured).toBe(true);
  });

  it("does not block channel startup behind a long-running Discord task", async () => {
    const discordStart = vi.fn(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    const telegramStart = vi.fn(async () => {});
    installTestRegistry(
      createTestPlugin({ id: "discord", label: "Discord", startAccount: discordStart }),
      createTestPlugin({ id: "telegram", label: "Telegram", startAccount: telegramStart }),
    );
    const manager = createManager();

    await manager.startChannels();

    expect(discordStart).toHaveBeenCalledTimes(1);
    expect(telegramStart).toHaveBeenCalledTimes(1);
    expect(
      manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID]?.running,
    ).toBe(true);

    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
  });

  it("limits whole-channel account startup fanout to four", async () => {
    const accountIds = ["one", "two", "three", "four", "five", "six"];
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const isConfigured = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      active -= 1;
      return true;
    });
    const startAccount = vi.fn(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    installTestRegistry(
      createTestPlugin({
        listAccountIds: () => accountIds,
        isConfigured,
        startAccount,
      }),
    );
    const manager = createManager();

    const start = manager.startChannel("discord");
    await flushMicrotasks();

    expect(isConfigured).toHaveBeenCalledTimes(4);
    expect(maxActive).toBe(4);
    expect(startAccount).not.toHaveBeenCalled();

    releases.splice(0, 4).forEach((release) => release());
    await waitForMicrotaskCondition(
      () => isConfigured.mock.calls.length === 6,
      "expected second account startup wave",
    );

    expect(isConfigured).toHaveBeenCalledTimes(6);
    expect(maxActive).toBe(4);

    releases.splice(0).forEach((release) => release());
    await start;

    expect(startAccount).toHaveBeenCalledTimes(6);

    await manager.stopChannel("discord");
  });

  it("deduplicates concurrent start requests for the same account", async () => {
    const startupGate = createDeferred();
    const isConfigured = vi.fn(async () => {
      await startupGate.promise;
      return true;
    });
    const startAccount = vi.fn(async () => {});
    installTestRegistry(createTestPlugin({ isConfigured, startAccount }));
    const manager = createManager();

    const firstStart = manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    const secondStart = manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    await flushMicrotasks();

    expect(isConfigured).toHaveBeenCalledTimes(1);
    expect(startAccount).not.toHaveBeenCalled();

    startupGate.resolve();
    await Promise.all([firstStart, secondStart]);

    expect(startAccount).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending startup when the account is stopped mid-boot", async () => {
    const startupGate = createDeferred();
    const isConfigured = vi.fn(async () => {
      await startupGate.promise;
      return true;
    });
    const startAccount = vi.fn(async () => {});
    installTestRegistry(createTestPlugin({ isConfigured, startAccount }));
    const manager = createManager();

    const startTask = manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    await flushMicrotasks();
    const stopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    startupGate.resolve();
    await Promise.all([startTask, stopTask]);

    expect(isConfigured).toHaveBeenCalledTimes(1);
    expect(startAccount).not.toHaveBeenCalled();
    expect(
      manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID]?.running,
    ).toBe(false);
  });
});
