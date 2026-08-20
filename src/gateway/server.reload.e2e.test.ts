import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot, type ConfigFileSnapshot } from "../config/config.js";
import {
  connectOk,
  getFreePort,
  installGatewayTestHooks,
  rpcReq,
  startGatewayServer,
  startServerWithClient,
} from "./test-helpers.js";

const hoisted = vi.hoisted(() => {
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

  const heartbeatStop = vi.fn();
  const heartbeatUpdateConfig = vi.fn();
  const startHeartbeatRunner = vi.fn(() => ({
    stop: heartbeatStop,
    updateConfig: heartbeatUpdateConfig,
  }));

  const startGmailWatcher = vi.fn(async () => ({ started: true }));
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

  const reloaderStop = vi.fn(async () => {});
  let onHotReload:
    | ((plan: unknown, nextConfig: unknown, snapshot: ConfigFileSnapshot) => Promise<void>)
    | null = null;
  let onRestart:
    | ((plan: unknown, nextConfig: unknown, snapshot: ConfigFileSnapshot) => Promise<void>)
    | null = null;

  const startGatewayConfigReloader = vi.fn(
    (opts: { onHotReload: typeof onHotReload; onRestart: typeof onRestart }) => {
      onHotReload = opts.onHotReload;
      onRestart = opts.onRestart;
      return { stop: reloaderStop };
    },
  );

  return {
    CronService: CronServiceMock,
    cronInstances,
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

  beforeEach(() => {
    prevSkipChannels = process.env.FASED_SKIP_CHANNELS;
    prevSkipGmail = process.env.FASED_SKIP_GMAIL_WATCHER;
    prevSkipProviders = process.env.FASED_SKIP_PROVIDERS;
    process.env.FASED_SKIP_CHANNELS = "0";
    delete process.env.FASED_SKIP_GMAIL_WATCHER;
    delete process.env.FASED_SKIP_PROVIDERS;
  });

  afterEach(() => {
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
  });

  async function writeConfigSnapshot(config: unknown): Promise<ConfigFileSnapshot> {
    const configPath = process.env.FASED_CONFIG_PATH;
    if (!configPath) {
      throw new Error("FASED_CONFIG_PATH is not set");
    }
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return await readConfigFileSnapshot();
  }

  it("applies hot reload actions and emits restart signal", async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port);

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
        restartCron: true,
        restartHeartbeat: true,
        restartChannels: new Set(["whatsapp", "telegram", "discord", "signal", "imessage"]),
        noopPaths: [],
      },
      nextConfig,
      nextSnapshot,
    );

    expect(hoisted.stopGmailWatcher).toHaveBeenCalled();
    expect(hoisted.startGmailWatcher).toHaveBeenCalledWith(nextConfig);

    expect(hoisted.startHeartbeatRunner).toHaveBeenCalledTimes(1);
    expect(hoisted.heartbeatUpdateConfig).toHaveBeenCalledTimes(1);
    expect(hoisted.heartbeatUpdateConfig).toHaveBeenCalledWith(nextConfig);

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
    await onRestart?.(
      {
        changedPaths: ["gateway.port"],
        restartGateway: true,
        restartReasons: ["gateway.port"],
        hotReasons: [],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartCron: false,
        restartHeartbeat: false,
        restartChannels: new Set(),
        noopPaths: [],
      },
      restartConfig,
      restartSnapshot,
    );

    expect(signalSpy).toHaveBeenCalledTimes(1);

    await server.close();
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
