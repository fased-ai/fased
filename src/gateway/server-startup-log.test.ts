import { describe, expect, it, vi } from "vitest";
import { logGatewayStartup } from "./server-startup-log.js";

describe("gateway startup log", () => {
  it("does not log the fallback model as configured when provider setup was skipped", () => {
    const info = vi.fn();
    const warn = vi.fn();

    logGatewayStartup({
      cfg: {},
      bindHost: "127.0.0.1",
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(info).toHaveBeenCalledWith("agent model: not configured (provider setup skipped)", {
      consoleMessage: expect.stringContaining("not configured"),
    });
    expect(info).not.toHaveBeenCalledWith(
      expect.stringContaining("agent model: openai/gpt-5.5"),
      expect.anything(),
    );
  });

  it("logs an explicitly configured primary model", () => {
    const info = vi.fn();
    const warn = vi.fn();

    logGatewayStartup({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
          },
        },
      },
      bindHost: "127.0.0.1",
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(info).toHaveBeenCalledWith("agent model: openai/gpt-5.5", {
      consoleMessage: expect.stringContaining("openai/gpt-5.5"),
    });
  });

  it("warns when dangerous config flags are enabled", () => {
    const info = vi.fn();
    const warn = vi.fn();

    logGatewayStartup({
      cfg: {
        gateway: {
          controlUi: {
            dangerouslyDisableDeviceAuth: true,
          },
        },
      },
      bindHost: "127.0.0.1",
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dangerous config flags enabled"));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("gateway.controlUi.dangerouslyDisableDeviceAuth=true"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fased security audit"));
  });

  it("does not warn when dangerous config flags are disabled", () => {
    const info = vi.fn();
    const warn = vi.fn();

    logGatewayStartup({
      cfg: {},
      bindHost: "127.0.0.1",
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("logs all listen endpoints on a single line", () => {
    const info = vi.fn();
    const warn = vi.fn();

    logGatewayStartup({
      cfg: {},
      bindHost: "127.0.0.1",
      bindHosts: ["127.0.0.1", "::1"],
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    const listenMessages = info.mock.calls
      .map((call) => call[0])
      .filter((message) => message.startsWith("listening on "));
    expect(listenMessages).toEqual([
      `listening on ws://127.0.0.1:18789, ws://[::1]:18789 (PID ${process.pid})`,
    ]);
  });
});
