import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./systemd-system.js", () => ({
  resolveHostedSystemdService: vi.fn(() => null),
}));

const { resolveGatewayService } = await import("./service.js");
const originalRuntimeSource = process.env.FASED_RUNTIME_SOURCE;

afterEach(() => {
  if (originalRuntimeSource === undefined) {
    delete process.env.FASED_RUNTIME_SOURCE;
  } else {
    process.env.FASED_RUNTIME_SOURCE = originalRuntimeSource;
  }
});

describe("Go-managed Gateway service boundary", () => {
  it("refuses application-owned service mutation when root metadata is unavailable", async () => {
    process.env.FASED_RUNTIME_SOURCE = "go-lifecycle";
    const service = resolveGatewayService();

    await expect(service.install({} as never)).rejects.toThrow("fased repair");
    await expect(service.restart({} as never)).rejects.toThrow("fased repair");
    await expect(service.uninstall({} as never)).rejects.toThrow("fased repair");
    expect(await service.isLoaded({ env: process.env })).toBe(false);
  });
});
