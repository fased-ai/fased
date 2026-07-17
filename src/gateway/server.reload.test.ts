import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot, type ConfigFileSnapshot } from "../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { drainSystemEvents } from "../infra/system-events.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  withGatewayServer,
} from "./test-helpers.js";

const hoisted = vi.hoisted(() => {
  const lifecycleEvents: string[] = [];
  const cronInstances: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];

  class CronServiceMock {
    start = vi.fn(async () => {});
    stop = vi.fn();
    constructor() {
      cronInstances.push(this);
    }
  }

  const browserStop = vi.fn(async () => {
    lifecycleEvents.push("browser.stop");
  });
  const startBrowserControlServerIfEnabled = vi.fn(async () => ({
    stop: browserStop,
  }));

  const heartbeatStop = vi.fn();
  const heartbeatUpdateConfig = vi.fn();
  const startHeartbeatRunner = vi.fn(() => ({
    stop: heartbeatStop,
    updateConfig: heartbeatUpdateConfig,
  }));

  const startGmailWatcher = vi.fn(async (_config: unknown) => ({ started: true }));
  const stopGmailWatcher = vi.fn(async () => {});

  const providerManager = {
    getRuntimeSnapshot: vi.fn(() => ({
      providers: {
        whatsapp: {
          running: false,
          connected: false,
          reconnectAttempts: 0,
          lastConnectedAt: null,
          lastDisconnect: null,
          lastMessageAt: null,
          lastEventAt: null,
          lastError: null,
        },
        telegram: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
          mode: null,
        },
        discord: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
        },
        slack: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
        },
        signal: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
          baseUrl: null,
        },
        imessage: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
          cliPath: null,
          dbPath: null,
        },
        msteams: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
        },
      },
      providerAccounts: {
        whatsapp: {},
        telegram: {},
        discord: {},
        slack: {},
        signal: {},
        imessage: {},
        msteams: {},
      },
    })),
    startChannels: vi.fn(async () => {}),
    startChannel: vi.fn(async () => {}),
    stopChannel: vi.fn(async () => {}),
    markChannelLoggedOut: vi.fn(),
  };

  const createChannelManager = vi.fn(() => providerManager);

  let reloaderStopped = false;
  let onStop: (() => void) | null = null;
  const reloaderStop = vi.fn(async () => {
    if (reloaderStopped) {
      return;
    }
    reloaderStopped = true;
    lifecycleEvents.push("configReloader.stop");
    onStop?.();
  });
  let onHotReload:
    | ((plan: unknown, nextConfig: unknown, snapshot: ConfigFileSnapshot) => Promise<void>)
    | null = null;
  let onRestart:
    | ((plan: unknown, nextConfig: unknown, snapshot: ConfigFileSnapshot) => Promise<void>)
    | null = null;

  const startGatewayConfigReloader = vi.fn(
    (opts: {
      onHotReload: typeof onHotReload;
      onRestart: typeof onRestart;
      onStop?: () => void;
    }) => {
      reloaderStopped = false;
      onHotReload = opts.onHotReload;
      onRestart = opts.onRestart;
      onStop = opts.onStop ?? null;
      return { stop: reloaderStop };
    },
  );

  return {
    CronService: CronServiceMock,
    cronInstances,
    lifecycleEvents,
    browserStop,
    startBrowserControlServerIfEnabled,
    heartbeatStop,
    heartbeatUpdateConfig,
    startHeartbeatRunner,
    startGmailWatcher,
    stopGmailWatcher,
    providerManager,
    createChannelManager,
    startGatewayConfigReloader,
    reloaderStop,
    getOnHotReload: () => onHotReload,
    getOnRestart: () => onRestart,
  };
});

vi.mock("../cron/service.js", () => ({
  CronService: hoisted.CronService,
}));

vi.mock("./server-browser.js", () => ({
  startBrowserControlServerIfEnabled: hoisted.startBrowserControlServerIfEnabled,
}));

vi.mock("../infra/heartbeat-runner.js", () => ({
  startHeartbeatRunner: hoisted.startHeartbeatRunner,
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  startGmailWatcher: hoisted.startGmailWatcher,
  stopGmailWatcher: hoisted.stopGmailWatcher,
}));

vi.mock("./server-channels.js", () => ({
  createChannelManager: hoisted.createChannelManager,
}));

vi.mock("./config-reload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config-reload.js")>()),
  startGatewayConfigReloader: hoisted.startGatewayConfigReloader,
}));

installGatewayTestHooks({ scope: "suite" });

describe("gateway hot reload", () => {
  let prevSkipChannels: string | undefined;
  let prevSkipGmail: string | undefined;
  let prevSkipProviders: string | undefined;
  let prevOpenAiApiKey: string | undefined;

  beforeEach(() => {
    hoisted.lifecycleEvents.length = 0;
    prevSkipChannels = process.env.FASED_SKIP_CHANNELS;
    prevSkipGmail = process.env.FASED_SKIP_GMAIL_WATCHER;
    prevSkipProviders = process.env.FASED_SKIP_PROVIDERS;
    prevOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.FASED_SKIP_CHANNELS = "0";
    delete process.env.FASED_SKIP_GMAIL_WATCHER;
    delete process.env.FASED_SKIP_PROVIDERS;
  });

  afterEach(async () => {
    if (prevSkipChannels === undefined) {
      delete process.env.FASED_SKIP_CHANNELS;
    } else {
      process.env.FASED_SKIP_CHANNELS = prevSkipChannels;
    }
    if (prevSkipGmail === undefined) {
      delete process.env.FASED_SKIP_GMAIL_WATCHER;
    } else {
      process.env.FASED_SKIP_GMAIL_WATCHER = prevSkipGmail;
    }
    if (prevSkipProviders === undefined) {
      delete process.env.FASED_SKIP_PROVIDERS;
    } else {
      process.env.FASED_SKIP_PROVIDERS = prevSkipProviders;
    }
    if (prevOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = prevOpenAiApiKey;
    }
    const configPath = process.env.FASED_CONFIG_PATH;
    if (configPath) {
      await fs.writeFile(configPath, "{}\n", "utf8");
    }
  });

  async function writeEnvRefConfig() {
    const configPath = process.env.FASED_CONFIG_PATH;
    if (!configPath) {
      throw new Error("FASED_CONFIG_PATH is not set");
    }
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                models: [],
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  async function writeConfigSnapshot(config: unknown): Promise<ConfigFileSnapshot> {
    const configPath = process.env.FASED_CONFIG_PATH;
    if (!configPath) {
      throw new Error("FASED_CONFIG_PATH is not set");
    }
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return await readConfigFileSnapshot();
  }

  async function writeAuthProfileEnvRefStore() {
    const stateDir = process.env.FASED_STATE_DIR;
    if (!stateDir) {
      throw new Error("FASED_STATE_DIR is not set");
    }
    const authStorePath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
    await fs.mkdir(path.dirname(authStorePath), { recursive: true });
    await fs.writeFile(
      authStorePath,
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            missing: {
              type: "api_key",
              provider: "openai",
              keyRef: { source: "env", provider: "default", id: "MISSING_FASED_AUTH_REF" },
            },
          },
          selectedProfileId: "missing",
          lastUsedProfileByModel: {},
          usageStats: {},
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  async function removeMainAuthProfileStore() {
    const stateDir = process.env.FASED_STATE_DIR;
    if (!stateDir) {
      return;
    }
    const authStorePath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
    await fs.rm(authStorePath, { force: true });
  }

  it("applies hot reload actions and emits restart signal", async () => {
    await withGatewayServer(async () => {
      const onHotReload = hoisted.getOnHotReload();
      expect(onHotReload).toBeTypeOf("function");

      const nextConfig = {
        hooks: {
          enabled: true,
          token: "secret",
          gmail: { account: "me@example.com" },
        },
        cron: { enabled: true, store: "/tmp/cron.json" },
        agents: { defaults: { heartbeat: { every: "1m" }, maxConcurrent: 2 } },
        browser: { enabled: true },
        web: { enabled: true },
        channels: {
          telegram: { botToken: "token" },
          discord: { token: "token" },
          signal: { account: "+15550000000" },
          imessage: { enabled: true },
        },
      };
      const nextSnapshot = await writeConfigSnapshot(nextConfig);

      await onHotReload?.(
        {
          changedPaths: [
            "hooks.gmail.account",
            "cron.enabled",
            "agents.defaults.heartbeat.every",
            "browser.enabled",
            "web.enabled",
            "channels.telegram.botToken",
            "channels.discord.token",
            "channels.signal.account",
            "channels.imessage.enabled",
          ],
          restartGateway: false,
          restartReasons: [],
          hotReasons: ["web.enabled"],
          reloadHooks: true,
          restartGmailWatcher: true,
          restartBrowserControl: true,
          restartCron: true,
          restartHeartbeat: true,
          restartChannels: new Set(["whatsapp", "telegram", "discord", "signal", "imessage"]),
          noopPaths: [],
        },
        nextConfig,
        nextSnapshot,
      );

      expect(hoisted.stopGmailWatcher).toHaveBeenCalled();
      const appliedConfig = hoisted.startGmailWatcher.mock.calls.at(-1)?.[0];
      expect(appliedConfig).toMatchObject(nextConfig);

      expect(hoisted.browserStop).toHaveBeenCalledTimes(1);
      expect(hoisted.startBrowserControlServerIfEnabled).toHaveBeenCalledTimes(2);

      expect(hoisted.startHeartbeatRunner).toHaveBeenCalledTimes(1);
      expect(hoisted.heartbeatUpdateConfig).toHaveBeenCalledTimes(1);
      expect(hoisted.heartbeatUpdateConfig).toHaveBeenCalledWith(appliedConfig);

      expect(hoisted.cronInstances.length).toBe(2);
      expect(hoisted.cronInstances[0].stop).toHaveBeenCalledTimes(1);
      expect(hoisted.cronInstances[1].start).toHaveBeenCalledTimes(1);

      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledTimes(5);
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledTimes(5);
      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledWith("whatsapp");
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledWith("whatsapp");
      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledWith("telegram");
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledWith("telegram");
      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledWith("discord");
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledWith("discord");
      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledWith("signal");
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledWith("signal");
      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledWith("imessage");
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledWith("imessage");

      const onRestart = hoisted.getOnRestart();
      expect(onRestart).toBeTypeOf("function");

      const signalSpy = vi.fn();
      process.once("SIGUSR1", signalSpy);

      const restartConfig = {};
      const restartSnapshot = await writeConfigSnapshot(restartConfig);
      const restartResult = onRestart?.(
        {
          changedPaths: ["gateway.port"],
          restartGateway: true,
          restartReasons: ["gateway.port"],
          hotReasons: [],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartBrowserControl: false,
          restartCron: false,
          restartHeartbeat: false,
          restartChannels: new Set(),
          noopPaths: [],
        },
        restartConfig,
        restartSnapshot,
      );
      await Promise.resolve(restartResult);

      expect(signalSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("fails startup when required secret refs are unresolved", async () => {
    await writeEnvRefConfig();
    delete process.env.OPENAI_API_KEY;
    await expect(withGatewayServer(async () => {})).rejects.toThrow(
      "Startup failed: required secrets are unavailable",
    );
  });

  it("fails startup when auth-profile secret refs are unresolved", async () => {
    await writeAuthProfileEnvRefStore();
    delete process.env.MISSING_FASED_AUTH_REF;
    try {
      await expect(withGatewayServer(async () => {})).rejects.toThrow("SECRETS_RESOLUTION_FAILED");
    } finally {
      await removeMainAuthProfileStore();
    }
  });

  it("emits one-shot degraded and recovered system events during secret reload transitions", async () => {
    await writeEnvRefConfig();
    process.env.OPENAI_API_KEY = "sk-startup";

    await withGatewayServer(async () => {
      const onHotReload = hoisted.getOnHotReload();
      expect(onHotReload).toBeTypeOf("function");
      const sessionKey = resolveMainSessionKeyFromConfig();
      const plan = {
        changedPaths: ["models.providers.openai.apiKey"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["models.providers.openai.apiKey"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartBrowserControl: false,
        restartCron: false,
        restartHeartbeat: false,
        restartChannels: new Set(),
        noopPaths: [],
      };
      const nextConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              models: [],
            },
          },
        },
      };
      const nextSnapshot = await readConfigFileSnapshot();

      delete process.env.OPENAI_API_KEY;
      await expect(onHotReload?.(plan, nextConfig, nextSnapshot)).rejects.toMatchObject({
        code: "SECRETS_RESOLUTION_FAILED",
      });
      const degradedEvents = drainSystemEvents(sessionKey);
      expect(degradedEvents.some((event) => event.includes("[SECRETS_RELOADER_DEGRADED]"))).toBe(
        true,
      );

      await expect(onHotReload?.(plan, nextConfig, nextSnapshot)).rejects.toMatchObject({
        code: "SECRETS_RESOLUTION_FAILED",
      });
      expect(drainSystemEvents(sessionKey)).toEqual([]);

      process.env.OPENAI_API_KEY = "sk-recovered";
      await expect(onHotReload?.(plan, nextConfig, nextSnapshot)).resolves.toBeUndefined();
      const recoveredEvents = drainSystemEvents(sessionKey);
      expect(recoveredEvents.some((event) => event.includes("[SECRETS_RELOADER_RECOVERED]"))).toBe(
        true,
      );
    });
  });

  it("serves secrets.reload immediately after startup without race failures", async () => {
    await writeEnvRefConfig();
    process.env.OPENAI_API_KEY = "sk-startup";
    const { server, ws } = await startServerWithClient();
    try {
      await connectOk(ws);
      const [first, second] = await Promise.all([
        rpcReq<{ warningCount: number }>(ws, "secrets.reload", {}),
        rpcReq<{ warningCount: number }>(ws, "secrets.reload", {}),
      ]);
      const results = [first, second];
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const stale = results.find((result) => !result.ok);
      const staleError = stale?.error as { details?: { code?: string } } | undefined;
      expect(staleError?.details).toEqual({ code: "SECRETS_SOURCE_STALE" });
    } finally {
      ws.close();
      await server.close();
    }
  });

  it("stops the config watcher once before base component teardown", async () => {
    await withGatewayServer(async () => {});

    expect(hoisted.lifecycleEvents.filter((event) => event === "configReloader.stop")).toHaveLength(
      1,
    );
    expect(hoisted.lifecycleEvents.indexOf("configReloader.stop")).toBeLessThan(
      hoisted.lifecycleEvents.indexOf("browser.stop"),
    );
  });
});

describe("gateway agents", () => {
  it("lists configured agents via agents.list RPC", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);
    const res = await rpcReq<{ agents: Array<{ id: string }> }>(ws, "agents.list", {});
    expect(res.ok).toBe(true);
    expect(res.payload?.agents.map((agent) => agent.id)).toContain("main");
    ws.close();
    await server.close();
  });
});
