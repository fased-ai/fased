import { afterEach, describe, expect, it, vi } from "vitest";
import { uninstallCommand } from "./uninstall.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("managed uninstall boundary", () => {
  it("refuses before application-owned service or state mutation", async () => {
    vi.stubEnv("FASED_RUNTIME_SOURCE", "go-lifecycle");
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await uninstallCommand(runtime, { all: true, yes: true, nonInteractive: true });

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("verified Go lifecycle"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).not.toHaveBeenCalled();
  });
});
