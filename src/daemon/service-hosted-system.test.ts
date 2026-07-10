import { describe, expect, it, vi } from "vitest";

const hostedService = {
  label: "systemd system service",
  loadedText: "enabled",
  notLoadedText: "disabled",
};

vi.mock("./systemd-system.js", () => ({
  resolveHostedSystemdService: vi.fn(() => hostedService),
}));

const { resolveGatewayService } = await import("./service.js");

describe.runIf(process.platform === "linux")("hosted gateway service resolution", () => {
  it("prefers the root-managed service over a user service", () => {
    expect(resolveGatewayService()).toBe(hostedService);
  });
});
