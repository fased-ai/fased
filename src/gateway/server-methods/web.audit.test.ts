import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loginWithQrStart: vi.fn(),
  loginWithQrWait: vi.fn(),
  builtInLoginStart: vi.fn(),
  builtInLoginWait: vi.fn(),
  channelPlugins: [] as unknown[],
  provider: {
    id: "whatsapp",
    meta: { label: "WhatsApp", order: 1 },
    gatewayMethods: ["web.login.start", "web.login.wait"],
    gateway: {
      loginWithQrStart: undefined as unknown,
      loginWithQrWait: undefined as unknown,
    },
  },
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn(() => mocks.channelPlugins),
}));

vi.mock("../../web/login-qr.js", () => ({
  startWebLoginWithQr: (...args: unknown[]) => mocks.builtInLoginStart(...args),
  waitForWebLogin: (...args: unknown[]) => mocks.builtInLoginWait(...args),
}));

const { webHandlers } = await import("./web.js");

function createContext() {
  return {
    startChannel: vi.fn(),
    stopChannel: vi.fn(),
    logGateway: {
      info: vi.fn(),
    },
  };
}

describe("web login mutating admin RPC audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.channelPlugins = [
      {
        ...mocks.provider,
        gateway: {
          loginWithQrStart: mocks.loginWithQrStart,
          loginWithQrWait: mocks.loginWithQrWait,
        },
      },
    ];
    mocks.loginWithQrStart.mockResolvedValue({
      started: true,
      qr: "secret-qr-payload",
      token: "secret-login-token",
    });
    mocks.loginWithQrWait.mockResolvedValue({
      connected: true,
      token: "secret-session-token",
    });
  });

  it("audits web.login.start without QR or token payloads", async () => {
    const context = createContext();
    const respond = vi.fn();

    await webHandlers["web.login.start"]({
      params: { accountId: "main", force: true },
      respond,
      context: context as never,
      client: {
        connId: "conn-1",
        clientIp: "127.0.0.1",
        connect: {
          client: { id: "dashboard" },
          device: { id: "operator-laptop" },
        },
      } as never,
      req: { type: "req", id: "req-1", method: "web.login.start" },
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ started: true }),
      undefined,
    );
    expect(context.stopChannel).toHaveBeenCalledWith("whatsapp", "main");
    const auditLine = String(context.logGateway.info.mock.calls.at(-1)?.[0] ?? "");
    expect(auditLine).toContain("method=web.login.start");
    expect(auditLine).toContain("outcome=succeeded");
    expect(auditLine).toContain("provider=whatsapp");
    expect(auditLine).toContain("accountId=main");
    expect(auditLine).not.toContain("secret-qr-payload");
    expect(auditLine).not.toContain("secret-login-token");
  });

  it("audits web.login.wait without returned session tokens", async () => {
    const context = createContext();
    const respond = vi.fn();

    await webHandlers["web.login.wait"]({
      params: { accountId: "main" },
      respond,
      context: context as never,
      client: null,
      req: { type: "req", id: "req-2", method: "web.login.wait" },
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ connected: true }),
      undefined,
    );
    expect(context.startChannel).toHaveBeenCalledWith("whatsapp", "main");
    const auditLine = String(context.logGateway.info.mock.calls.at(-1)?.[0] ?? "");
    expect(auditLine).toContain("method=web.login.wait");
    expect(auditLine).toContain("outcome=succeeded");
    expect(auditLine).toContain("connected=true");
    expect(auditLine).not.toContain("secret-session-token");
  });

  it("uses the requested QR channel provider when channel is supplied", async () => {
    const zalouserStart = vi.fn().mockResolvedValue({
      qrDataUrl: "data:image/png;base64,secret-zalo-qr",
      message: "Scan QR code with Zalo app",
    });
    mocks.channelPlugins = [
      {
        ...mocks.provider,
        id: "whatsapp",
        gateway: {
          loginWithQrStart: vi.fn(),
          loginWithQrWait: vi.fn(),
        },
      },
      {
        ...mocks.provider,
        id: "zalouser",
        meta: { label: "Zalo Personal", order: 2 },
        gateway: {
          loginWithQrStart: zalouserStart,
          loginWithQrWait: vi.fn(),
        },
      },
    ];
    const context = createContext();
    const respond = vi.fn();

    await webHandlers["web.login.start"]({
      params: { channel: "zalouser", accountId: "work", force: false },
      respond,
      context: context as never,
      client: null,
      req: { type: "req", id: "req-zalo", method: "web.login.start" },
      isWebchatConnect: () => false,
    });

    expect(zalouserStart).toHaveBeenCalledWith({
      force: false,
      timeoutMs: undefined,
      verbose: false,
      accountId: "work",
    });
    expect(context.stopChannel).toHaveBeenCalledWith("zalouser", "work");
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ message: "Scan QR code with Zalo app" }),
      undefined,
    );
    const auditLine = String(context.logGateway.info.mock.calls.at(-1)?.[0] ?? "");
    expect(auditLine).toContain("provider=zalouser");
    expect(auditLine).not.toContain("secret-zalo-qr");
  });

  it("uses the built-in WhatsApp QR adapter when the channel plugin is not loaded", async () => {
    mocks.channelPlugins = [];
    mocks.builtInLoginStart.mockResolvedValue({
      qrDataUrl: "data:image/png;base64,secret-qr",
      message: "Scan this QR in WhatsApp → Linked Devices.",
    });
    const context = createContext();
    const respond = vi.fn();

    await webHandlers["web.login.start"]({
      params: { accountId: "main", force: false, timeoutMs: 1234 },
      respond,
      context: context as never,
      client: null,
      req: { type: "req", id: "req-3", method: "web.login.start" },
      isWebchatConnect: () => false,
    });

    expect(mocks.builtInLoginStart).toHaveBeenCalledWith({
      force: false,
      timeoutMs: 1234,
      verbose: false,
      accountId: "main",
    });
    expect(context.stopChannel).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ message: expect.stringContaining("Scan this QR") }),
      undefined,
    );
    const auditLine = String(context.logGateway.info.mock.calls.at(-1)?.[0] ?? "");
    expect(auditLine).toContain("method=web.login.start");
    expect(auditLine).toContain("provider=whatsapp");
    expect(auditLine).toContain("source=built_in_qr");
    expect(auditLine).not.toContain("secret-qr");
  });

  it("does not try to start an unloaded WhatsApp channel after direct QR wait", async () => {
    mocks.channelPlugins = [];
    mocks.builtInLoginWait.mockResolvedValue({
      connected: true,
      message: "Linked.",
    });
    const context = createContext();
    const respond = vi.fn();

    await webHandlers["web.login.wait"]({
      params: { accountId: "main", timeoutMs: 1234 },
      respond,
      context: context as never,
      client: null,
      req: { type: "req", id: "req-4", method: "web.login.wait" },
      isWebchatConnect: () => false,
    });

    expect(mocks.builtInLoginWait).toHaveBeenCalledWith({
      timeoutMs: 1234,
      accountId: "main",
    });
    expect(context.startChannel).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        connected: true,
        message: expect.stringContaining("Restart the gateway"),
      }),
      undefined,
    );
  });
});
