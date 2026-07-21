import chokidar from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { ConfigFileSnapshot, FasedAgentConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  buildGatewayReloadPlan,
  diffConfigPaths,
  resolveGatewayReloadSettings,
  startGatewayConfigReloader,
  type GatewayReloadPlan,
} from "./config-reload.js";

describe("diffConfigPaths", () => {
  it("captures nested config changes", () => {
    const prev = { hooks: { gmail: { account: "a" } } };
    const next = { hooks: { gmail: { account: "b" } } };
    const paths = diffConfigPaths(prev, next);
    expect(paths).toContain("hooks.gmail.account");
  });

  it("captures array changes", () => {
    const prev = { messages: { groupChat: { mentionPatterns: ["a"] } } };
    const next = { messages: { groupChat: { mentionPatterns: ["b"] } } };
    const paths = diffConfigPaths(prev, next);
    expect(paths).toContain("messages.groupChat.mentionPatterns");
  });

  it("does not report unchanged arrays of objects as changed", () => {
    const prev = {
      memory: {
        qmd: {
          paths: [{ path: "~/docs", pattern: "**/*.md", name: "docs" }],
          scope: {
            rules: [{ when: { channel: "slack" }, include: ["docs"] }],
          },
        },
      },
    };
    const next = {
      memory: {
        qmd: {
          paths: [{ path: "~/docs", pattern: "**/*.md", name: "docs" }],
          scope: {
            rules: [{ when: { channel: "slack" }, include: ["docs"] }],
          },
        },
      },
    };
    expect(diffConfigPaths(prev, next)).toEqual([]);
  });

  it("reports changed arrays of objects", () => {
    const prev = {
      memory: {
        qmd: {
          paths: [{ path: "~/docs", pattern: "**/*.md", name: "docs" }],
        },
      },
    };
    const next = {
      memory: {
        qmd: {
          paths: [{ path: "~/docs", pattern: "**/*.txt", name: "docs" }],
        },
      },
    };
    expect(diffConfigPaths(prev, next)).toContain("memory.qmd.paths");
  });
});

describe("buildGatewayReloadPlan", () => {
  const emptyRegistry = createTestRegistry([]);
  const telegramPlugin: ChannelPlugin = {
    id: "telegram",
    meta: {
      id: "telegram",
      label: "Telegram",
      selectionLabel: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
    },
    reload: { configPrefixes: ["channels.telegram"] },
  };
  const whatsappPlugin: ChannelPlugin = {
    id: "whatsapp",
    meta: {
      id: "whatsapp",
      label: "WhatsApp",
      selectionLabel: "WhatsApp",
      docsPath: "/channels/whatsapp",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
    },
    reload: { configPrefixes: ["web"], noopPrefixes: ["channels.whatsapp"] },
  };
  const registry = createTestRegistry([
    { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
  ]);

  beforeEach(() => {
    setActivePluginRegistry(registry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("does not restart the gateway for a per-wallet RPC update", () => {
    const plan = buildGatewayReloadPlan(["env.vars.FASED_WALLET_SOLANA_RPC_URL__AGENT_2"]);

    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toEqual(["env.vars.FASED_WALLET_SOLANA_RPC_URL__AGENT_2"]);
  });

  it("does not restart the gateway when wallet creation materializes signer paths", () => {
    const changedPaths = [
      "env.vars.FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET",
      "env.vars.FASED_WALLET_LOCAL_SIGNER_STATE_DB",
      "env.vars.FASED_WALLET_LOCAL_SIGNER_MASTER_KEY",
      "env.vars.FASED_WALLET_SOLANA_RPC_URL__AGENT_4",
    ];
    const plan = buildGatewayReloadPlan(changedPaths);

    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toEqual(changedPaths);
  });

  it("marks gateway changes as restart required", () => {
    const plan = buildGatewayReloadPlan(["gateway.port"]);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toContain("gateway.port");
  });

  it("restarts the Gmail watcher for hooks.gmail changes", () => {
    const plan = buildGatewayReloadPlan(["hooks.gmail.account"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartGmailWatcher).toBe(true);
    expect(plan.reloadHooks).toBe(true);
  });

  it("restarts providers when provider config prefixes change", () => {
    const changedPaths = ["web.enabled", "channels.telegram.botToken"];
    const plan = buildGatewayReloadPlan(changedPaths);
    expect(plan.restartGateway).toBe(false);
    const expected = new Set(
      listChannelPlugins()
        .filter((plugin) =>
          (plugin.reload?.configPrefixes ?? []).some((prefix) =>
            changedPaths.some((path) => path === prefix || path.startsWith(`${prefix}.`)),
          ),
        )
        .map((plugin) => plugin.id),
    );
    expect(expected.size).toBeGreaterThan(0);
    expect(plan.restartChannels).toEqual(expected);
  });

  it("treats gateway.remote as no-op", () => {
    const plan = buildGatewayReloadPlan(["gateway.remote.url"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toContain("gateway.remote.url");
  });

  it("treats secrets config changes as no-op for gateway restart planning", () => {
    const plan = buildGatewayReloadPlan(["secrets.providers.default.path"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toContain("secrets.providers.default.path");
  });

  it("treats federation config changes as no-op for gateway restart planning", () => {
    const plan = buildGatewayReloadPlan(["federation"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toContain("federation");
  });

  it("defaults unknown paths to restart", () => {
    const plan = buildGatewayReloadPlan(["unknownField"]);
    expect(plan.restartGateway).toBe(true);
  });
});

describe("resolveGatewayReloadSettings", () => {
  it("uses defaults when unset", () => {
    const settings = resolveGatewayReloadSettings({});
    expect(settings.mode).toBe("hybrid");
    expect(settings.debounceMs).toBe(300);
  });
});

type WatcherHandler = () => void;
type WatcherEvent = "add" | "change" | "unlink" | "error";

function createWatcherMock() {
  const handlers = new Map<WatcherEvent, WatcherHandler[]>();
  return {
    on(event: WatcherEvent, handler: WatcherHandler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
      return this;
    },
    emit(event: WatcherEvent) {
      for (const handler of handlers.get(event) ?? []) {
        handler();
      }
    },
    close: vi.fn(async () => {}),
  };
}

function makeSnapshot(partial: Partial<ConfigFileSnapshot> = {}): ConfigFileSnapshot {
  return {
    path: "/tmp/fased.json",
    exists: true,
    raw: "{}",
    parsed: {},
    resolved: {},
    valid: true,
    config: {},
    issues: [],
    warnings: [],
    legacyIssues: [],
    ...partial,
  };
}

function createReloaderHarness(readSnapshot: () => Promise<ConfigFileSnapshot>) {
  const watcher = createWatcherMock();
  vi.spyOn(chokidar, "watch").mockReturnValue(watcher as unknown as never);
  const onHotReload = vi.fn<
    (
      plan: GatewayReloadPlan,
      nextConfig: FasedAgentConfig,
      snapshot: ConfigFileSnapshot,
    ) => Promise<void>
  >(async () => {});
  const onRestart = vi.fn();
  const onSourceRevision = vi.fn();
  const onStop = vi.fn();
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const reloader = startGatewayConfigReloader({
    initialConfig: { gateway: { reload: { debounceMs: 0 } } },
    readSnapshot,
    onHotReload,
    onRestart,
    onSourceRevision,
    onStop,
    log,
    watchPath: "/tmp/fased.json",
  });
  return { watcher, onHotReload, onRestart, onSourceRevision, onStop, log, reloader };
}

describe("startGatewayConfigReloader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries missing snapshots and reloads once config file reappears", async () => {
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(makeSnapshot({ exists: false, raw: null, hash: "missing-1" }))
      .mockResolvedValueOnce(
        makeSnapshot({
          config: {
            gateway: { reload: { debounceMs: 0 } },
            hooks: { enabled: true },
          },
          hash: "next-1",
        }),
      );
    const { watcher, onHotReload, onRestart, log, reloader } = createReloaderHarness(readSnapshot);

    watcher.emit("unlink");
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(150);

    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(onHotReload).toHaveBeenCalledTimes(1);
    expect(onRestart).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("config reload retry (1/2): config file not found");
    expect(log.warn).not.toHaveBeenCalledWith("config reload skipped (config file not found)");

    await reloader.stop();
  });

  it("caps missing-file retries and skips reload after retry budget is exhausted", async () => {
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValue(makeSnapshot({ exists: false, raw: null, hash: "missing" }));
    const { watcher, onHotReload, onRestart, log, reloader } = createReloaderHarness(readSnapshot);

    watcher.emit("unlink");
    await vi.runAllTimersAsync();

    expect(readSnapshot).toHaveBeenCalledTimes(3);
    expect(onHotReload).not.toHaveBeenCalled();
    expect(onRestart).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("config reload skipped (config file not found)");

    await reloader.stop();
  });

  it.each([
    {
      name: "missing",
      snapshot: makeSnapshot({ exists: false, raw: null, hash: "missing-revision" }),
    },
    {
      name: "invalid",
      snapshot: makeSnapshot({
        valid: false,
        issues: [{ path: "gateway.port", message: "invalid" }],
        hash: "invalid-revision",
      }),
    },
    {
      name: "no-diff revert",
      snapshot: makeSnapshot({
        config: { gateway: { reload: { debounceMs: 0 } } },
        hash: "active-revision",
      }),
    },
    {
      name: "reload mode off",
      snapshot: makeSnapshot({
        config: {
          gateway: { reload: { debounceMs: 0, mode: "off" } },
          hooks: { enabled: true },
        },
        hash: "off-revision",
      }),
    },
    {
      name: "hot mode ignoring restart",
      snapshot: makeSnapshot({
        config: {
          gateway: { reload: { debounceMs: 0, mode: "hot" }, port: 18790 },
        },
        hash: "ignored-restart-revision",
      }),
    },
  ])("announces a $name source before reload routing", async ({ snapshot }) => {
    const readSnapshot = vi.fn<() => Promise<ConfigFileSnapshot>>().mockResolvedValue(snapshot);
    const { watcher, onHotReload, onRestart, onSourceRevision, reloader } =
      createReloaderHarness(readSnapshot);

    watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();

    expect(onSourceRevision).toHaveBeenCalledTimes(1);
    expect(onSourceRevision).toHaveBeenCalledWith(snapshot);
    expect(onHotReload).not.toHaveBeenCalled();
    expect(onRestart).not.toHaveBeenCalled();

    await reloader.stop();
  });

  it("contains restart validation failures and retries the unchanged source revision", async () => {
    const restartCandidate = makeSnapshot({
      config: {
        gateway: { reload: { debounceMs: 0 }, port: 18790 },
      },
      hash: "restart-candidate",
    });
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValue(restartCandidate);
    const { watcher, onHotReload, onRestart, log, reloader } = createReloaderHarness(readSnapshot);
    onRestart.mockRejectedValueOnce(new Error("restart-check failed"));
    onRestart.mockResolvedValueOnce(undefined);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      watcher.emit("change");
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      expect(onHotReload).not.toHaveBeenCalled();
      expect(onRestart).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalledWith(
        "config restart validation failed; restart was not scheduled",
      );
      expect(log.error.mock.calls.flat().join("\n")).not.toContain("restart-check failed");
      expect(unhandled).toEqual([]);

      watcher.emit("change");
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      expect(onRestart).toHaveBeenCalledTimes(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await reloader.stop();
    }
  });

  it("keeps the previous diff baseline when hot activation fails and retries unchanged source", async () => {
    const candidate = makeSnapshot({
      config: {
        gateway: { reload: { debounceMs: 0 } },
        hooks: { enabled: true },
      },
      hash: "hot-candidate",
    });
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(candidate)
      .mockResolvedValueOnce(candidate);
    const { watcher, onHotReload, log, reloader } = createReloaderHarness(readSnapshot);
    onHotReload
      .mockRejectedValueOnce(new Error("SENTINEL_HOT_RELOAD_FAILURE"))
      .mockResolvedValueOnce(undefined);

    watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();
    expect(onHotReload).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      "config reload failed; keeping last-known-good configuration",
    );
    expect(log.error.mock.calls.flat().join("\n")).not.toContain("SENTINEL_HOT_RELOAD_FAILURE");

    watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();
    expect(onHotReload).toHaveBeenCalledTimes(2);
    expect(onHotReload.mock.calls[1]?.[0].changedPaths).toContain("hooks");

    await reloader.stop();
  });

  it("revalidates every config revision while a Gateway restart is pending", async () => {
    const first = makeSnapshot({
      config: {
        gateway: { reload: { debounceMs: 0 }, port: 18790 },
      },
      hash: "restart-first",
    });
    const second = makeSnapshot({
      config: {
        gateway: { reload: { debounceMs: 0 }, port: 18791 },
      },
      hash: "restart-second",
    });
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const { watcher, onRestart, onSourceRevision, log, reloader } =
      createReloaderHarness(readSnapshot);
    onRestart.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("invalid secret"));

    watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();
    watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();

    expect(onRestart).toHaveBeenCalledTimes(2);
    expect(onSourceRevision).toHaveBeenCalledTimes(2);
    expect(onSourceRevision.mock.invocationCallOrder[1]).toBeLessThan(
      onRestart.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    );
    expect(onRestart.mock.calls[1]?.[0].changedPaths).toContain("gateway.port");
    expect(log.error).toHaveBeenCalledWith(
      "config restart validation failed; restart was not scheduled",
    );

    await reloader.stop();
  });

  it("does not hot-activate restart-only changes that hot mode ignored", async () => {
    const ignored = makeSnapshot({
      config: {
        gateway: { reload: { debounceMs: 0, mode: "hot" }, port: 18790 },
      },
      hash: "hot-ignored-restart",
    });
    const laterHotChange = makeSnapshot({
      config: {
        gateway: { reload: { debounceMs: 0, mode: "hot" }, port: 18790 },
        hooks: { enabled: true },
      },
      hash: "hot-after-ignored-restart",
    });
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(ignored)
      .mockResolvedValueOnce(laterHotChange);
    const { watcher, onHotReload, onRestart, log, reloader } = createReloaderHarness(readSnapshot);

    watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();
    watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();

    expect(onHotReload).not.toHaveBeenCalled();
    expect(onRestart).not.toHaveBeenCalled();
    expect(
      log.warn.mock.calls.filter(([message]) =>
        String(message).includes("config reload requires gateway restart"),
      ),
    ).toHaveLength(2);

    await reloader.stop();
  });

  it("applies changes accumulated while reload mode was off when it is re-enabled", async () => {
    const disabled = makeSnapshot({
      config: {
        gateway: { reload: { debounceMs: 0, mode: "off" } },
        hooks: { enabled: true },
      },
      hash: "reload-disabled",
    });
    const enabled = makeSnapshot({
      config: {
        gateway: { reload: { debounceMs: 0, mode: "hybrid" } },
        hooks: { enabled: true },
      },
      hash: "reload-enabled",
    });
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(disabled)
      .mockResolvedValueOnce(enabled);
    const { watcher, onHotReload, reloader } = createReloaderHarness(readSnapshot);

    watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();
    expect(onHotReload).not.toHaveBeenCalled();

    watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();
    expect(onHotReload).toHaveBeenCalledTimes(1);
    expect(onHotReload.mock.calls[0]?.[0].changedPaths).toContain("hooks");

    await reloader.stop();
  });

  it("runs restart cancellation cleanup when the reloader stops", async () => {
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValue(makeSnapshot());
    const { watcher, onStop, reloader } = createReloaderHarness(readSnapshot);

    const first = reloader.stop();
    const second = reloader.stop();
    await Promise.all([first, second]);

    expect(first).toBe(second);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });
});
