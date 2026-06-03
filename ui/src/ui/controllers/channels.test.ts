import { describe, expect, it, vi } from "vitest";
import {
  installChannelPlugin,
  logoutChannel,
  startChannelQrLogin,
  startChannelRuntime,
  startWhatsAppLogin,
  stopChannelRuntime,
  waitChannelQrLogin,
  waitWhatsAppLogin,
  type ChannelsState,
} from "./channels.ts";

function createState(request: ReturnType<typeof vi.fn>): ChannelsState {
  return {
    client: { request } as unknown as ChannelsState["client"],
    connected: true,
    channelsLoading: false,
    channelsSnapshot: null,
    channelsError: null,
    channelsNotice: null,
    channelsLastSuccess: null,
    channelRuntimeBusy: {},
    channelQrLogin: {},
    whatsappLoginMessage: null,
    whatsappLoginQrDataUrl: null,
    whatsappLoginConnected: null,
    whatsappBusy: false,
  };
}

describe("channel runtime controls", () => {
  it("starts a channel account and refreshes channel status", async () => {
    const request = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce(null);
    const state = createState(request);

    await startChannelRuntime(state, "telegram", "main");

    expect(request).toHaveBeenNthCalledWith(1, "channels.start", {
      channel: "telegram",
      accountId: "main",
    });
    expect(request).toHaveBeenNthCalledWith(2, "channels.status", {
      probe: false,
      timeoutMs: 8000,
    });
    expect(state.channelRuntimeBusy).toEqual({});
    expect(state.channelsError).toBeNull();
  });

  it("stops a channel and refreshes channel status", async () => {
    const request = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce(null);
    const state = createState(request);

    await stopChannelRuntime(state, "discord");

    expect(request).toHaveBeenNthCalledWith(1, "channels.stop", {
      channel: "discord",
    });
    expect(request).toHaveBeenNthCalledWith(2, "channels.status", {
      probe: false,
      timeoutMs: 8000,
    });
  });

  it("clears a channel account through the logout RPC and reports the result", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ channel: "telegram", accountId: "ops", cleared: true })
      .mockResolvedValueOnce(null);
    const state = createState(request);

    await logoutChannel(state, "telegram", "ops");

    expect(request).toHaveBeenNthCalledWith(1, "channels.logout", {
      channel: "telegram",
      accountId: "ops",
    });
    expect(request).toHaveBeenNthCalledWith(2, "channels.status", {
      probe: true,
      timeoutMs: 8000,
    });
    expect(state.channelsNotice).toBe("Cleared telegram/ops.");
    expect(state.channelsError).toBeNull();
    expect(state.channelRuntimeBusy).toEqual({});
  });

  it("surfaces runtime control errors without leaving the control busy", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("start failed"));
    const state = createState(request);

    await startChannelRuntime(state, "signal");

    expect(request).toHaveBeenCalledTimes(1);
    expect(state.channelsError).toBe("Error: start failed");
    expect(state.channelRuntimeBusy).toEqual({});
  });

  it("installs a channel plugin through the marketplace RPC", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        pluginId: "feishu",
        action: "install",
        requiresRestart: true,
        message: "Linked plugin path: /tmp/feishu",
        warnings: [],
      })
      .mockResolvedValueOnce(null);
    const state = createState(request);

    await installChannelPlugin(state, "feishu");

    expect(request).toHaveBeenNthCalledWith(1, "plugins.marketplace.install", { id: "feishu" });
    expect(request).toHaveBeenNthCalledWith(2, "channels.status", {
      probe: false,
      timeoutMs: 8000,
    });
    expect(state.channelsNotice).toContain("Restart the gateway");
    expect(state.channelsNotice).toContain("restart-required state");
    expect(state.channelsError).toBeNull();
    expect(state.channelRuntimeBusy).toEqual({});
  });

  it("shows manual install command when channel plugin install fails", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("npm unavailable"));
    const state = createState(request);
    state.channelsSnapshot = {
      ts: 1,
      channelOrder: ["demo-channel"],
      channelLabels: { "demo-channel": "Demo Channel" },
      channels: {
        "demo-channel": {
          catalogOnly: true,
          install: { npmSpec: "@fased/demo-channel@1.0.0" },
        },
      },
      channelAccounts: { "demo-channel": [] },
      channelDefaultAccountId: { "demo-channel": "default" },
    };

    await installChannelPlugin(state, "demo-channel");

    expect(request).toHaveBeenCalledWith("plugins.marketplace.install", {
      id: "demo-channel",
    });
    expect(state.channelsError).toContain("npm unavailable");
    expect(state.channelsError).toContain("fased plugins install @fased/demo-channel@1.0.0");
  });

  it("prefers bundled local channel install commands when available", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("install unavailable"));
    const state = createState(request);
    state.channelsSnapshot = {
      ts: 1,
      channelOrder: ["feishu"],
      channelLabels: { feishu: "Feishu" },
      channels: {
        feishu: {
          catalogOnly: true,
          install: { localPath: "extensions/feishu", defaultChoice: "local" },
        },
      },
      channelAccounts: { feishu: [] },
      channelDefaultAccountId: { feishu: "default" },
    };

    await installChannelPlugin(state, "feishu");

    expect(state.channelsError).toContain("install unavailable");
    expect(state.channelsError).toContain("fased plugins install extensions/feishu");
    expect(state.channelsError).not.toContain("@fased/feishu");
  });

  it("explains missing WhatsApp web-login provider instead of leaking gateway internals", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("GatewayRequestError: web login provider is not available"));
    const state = createState(request);

    await startWhatsAppLogin(state, false);

    expect(state.whatsappLoginMessage).toContain("WhatsApp channel plugin is not loaded");
    expect(state.whatsappLoginQrDataUrl).toBeNull();
    expect(state.whatsappBusy).toBe(false);
  });

  it("starts QR login for a specific channel", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        message: "Scan QR code with Zalo app",
        qrDataUrl: "data:image/png;base64,zalo",
      })
      .mockResolvedValueOnce(null);
    const state = createState(request);
    state.channelsSnapshot = {
      ts: 1,
      channelOrder: ["zalouser"],
      channelLabels: { zalouser: "Zalo Personal" },
      channels: {},
      channelAccounts: { zalouser: [] },
      channelDefaultAccountId: { zalouser: "default" },
    };

    await startChannelQrLogin(state, "zalouser", false);

    expect(request).toHaveBeenCalledWith("web.login.start", {
      channel: "zalouser",
      force: false,
      timeoutMs: 30000,
    });
    expect(state.channelQrLogin.zalouser).toEqual({
      message: "Scan QR code with Zalo app",
      qrDataUrl: "data:image/png;base64,zalo",
      connected: null,
    });
    expect(state.channelRuntimeBusy).toEqual({});
  });

  it("waits for QR login for a specific channel and refreshes on connect", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ message: "Login successful", connected: true })
      .mockResolvedValueOnce({ channels: { zalouser: { configured: true } } });
    const state = createState(request);
    state.channelQrLogin = {
      zalouser: {
        message: "Scan QR code with Zalo app",
        qrDataUrl: "data:image/png;base64,zalo",
        connected: null,
      },
    };

    await waitChannelQrLogin(state, "zalouser");

    expect(request).toHaveBeenNthCalledWith(1, "web.login.wait", {
      channel: "zalouser",
      timeoutMs: 120000,
    });
    expect(request).toHaveBeenNthCalledWith(2, "channels.status", {
      probe: true,
      timeoutMs: 8000,
    });
    expect(state.channelQrLogin.zalouser).toEqual({
      message: "Login successful",
      qrDataUrl: null,
      connected: true,
    });
  });

  it("refreshes channel status after WhatsApp QR scan connects", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ message: "Connected", connected: true })
      .mockResolvedValueOnce({ channels: { whatsapp: { configured: true, linked: true } } });
    const state = createState(request);
    state.whatsappLoginQrDataUrl = "data:image/png;base64,qr";

    await waitWhatsAppLogin(state);

    expect(request).toHaveBeenNthCalledWith(1, "web.login.wait", {
      channel: "whatsapp",
      timeoutMs: 120000,
    });
    expect(request).toHaveBeenNthCalledWith(2, "channels.status", {
      probe: true,
      timeoutMs: 8000,
    });
    expect(state.whatsappLoginQrDataUrl).toBeNull();
    expect(state.channelsSnapshot).toEqual({
      channels: { whatsapp: { configured: true, linked: true } },
    });
  });
});
