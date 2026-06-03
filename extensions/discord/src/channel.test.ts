import type { FasedAgentConfig, PluginRuntime } from "fased/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { discordPlugin } from "./channel.js";
import { setDiscordRuntime } from "./runtime.js";

describe("discordPlugin outbound", () => {
  it("forwards mediaLocalRoots to sendMessageDiscord", async () => {
    const sendMessageDiscord = vi.fn(async () => ({ messageId: "m1" }));
    setDiscordRuntime({
      channel: {
        discord: {
          sendMessageDiscord,
        },
      },
    } as unknown as PluginRuntime);

    const result = await discordPlugin.outbound!.sendMedia!({
      cfg: {} as FasedAgentConfig,
      to: "channel:123",
      text: "hi",
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp/agent-root"],
      accountId: "work",
    });

    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:123",
      "hi",
      expect.objectContaining({
        mediaUrl: "/tmp/image.png",
        mediaLocalRoots: ["/tmp/agent-root"],
      }),
    );
    expect(result).toMatchObject({ channel: "discord", messageId: "m1" });
  });
});

describe("discordPlugin runtime status", () => {
  it("preserves gateway degraded status fields in account snapshots", async () => {
    const snapshot = await discordPlugin.status!.buildAccountSnapshot!({
      account: {
        accountId: "default",
        name: "Main Discord",
        enabled: true,
        token: "token",
        tokenSource: "config",
        config: {},
      } as any,
      cfg: {} as FasedAgentConfig,
      runtime: {
        accountId: "default",
        running: true,
        connected: false,
        reconnectAttempts: 2,
        lastConnectedAt: 1234,
        lastDisconnect: {
          at: 5678,
          status: 4014,
          error: "missing intents",
        },
        lastError: "discord gateway closed",
      },
    });

    expect(snapshot).toMatchObject({
      accountId: "default",
      running: true,
      connected: false,
      reconnectAttempts: 2,
      lastConnectedAt: 1234,
      lastDisconnect: {
        at: 5678,
        status: 4014,
        error: "missing intents",
      },
      lastError: "discord gateway closed",
    });
  });

  it("passes channel status hooks into the Discord monitor runtime", async () => {
    const probeDiscord = vi.fn(async () => ({
      ok: true,
      bot: { username: "fased-bot" },
      application: { intents: { messageContent: "enabled" } },
    }));
    const monitorDiscordProvider = vi.fn(async () => undefined);
    setDiscordRuntime({
      channel: {
        discord: {
          probeDiscord,
          monitorDiscordProvider,
        },
      },
    } as unknown as PluginRuntime);
    const getStatus = vi.fn(() => ({ accountId: "default" }));
    const setStatus = vi.fn();

    await discordPlugin.gateway!.startAccount!({
      cfg: {} as FasedAgentConfig,
      accountId: "default",
      account: {
        accountId: "default",
        token: "token",
        config: {},
      } as any,
      runtime: {} as any,
      abortSignal: new AbortController().signal,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getStatus,
      setStatus,
    });

    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        bot: { username: "fased-bot" },
        application: { intents: { messageContent: "enabled" } },
      }),
    );
    expect(monitorDiscordProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "token",
        accountId: "default",
        getStatus,
        setStatus,
      }),
    );
  });
});
