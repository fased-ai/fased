import { describe, expect, it, vi } from "vitest";

const installChannelPlugin = vi.hoisted(() => vi.fn(async () => undefined));
const logoutChannel = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./controllers/channels.ts", () => ({
  installChannelPlugin,
  loadChannels: vi.fn(async () => undefined),
  logoutChannel,
  logoutWhatsApp: vi.fn(async () => undefined),
  startWhatsAppLogin: vi.fn(async () => undefined),
  waitWhatsAppLogin: vi.fn(async () => undefined),
}));

vi.mock("./controllers/config.ts", () => ({
  loadConfig: vi.fn(async () => undefined),
  saveConfig: vi.fn(async () => undefined),
  updateConfigFormValue: vi.fn(),
}));

describe("app channel actions", () => {
  it("installs channel plugins directly instead of opening a confirm dialog", async () => {
    const { handleChannelInstall } = await import("./app-channels.ts");
    const host = { channelConfirmAction: null } as never;

    await handleChannelInstall(host, "feishu");

    expect(installChannelPlugin).toHaveBeenCalledWith(host, "feishu");
    expect((host as { channelConfirmAction: unknown }).channelConfirmAction).toBeNull();
  });

  it("keeps clear credentials behind the confirm action", async () => {
    const { handleChannelLogout, confirmChannelAction } = await import("./app-channels.ts");
    const host = { channelConfirmAction: null } as never;

    await handleChannelLogout(host, "telegram", "ops");
    expect((host as { channelConfirmAction: unknown }).channelConfirmAction).toEqual({
      kind: "clear",
      channelId: "telegram",
      accountId: "ops",
    });

    await confirmChannelAction(host);
    expect(logoutChannel).toHaveBeenCalledWith(host, "telegram", "ops");
    expect((host as { channelConfirmAction: unknown }).channelConfirmAction).toBeNull();
  });
});
