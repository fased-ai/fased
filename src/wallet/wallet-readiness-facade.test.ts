import { describe, expect, it, vi } from "vitest";
import { createWalletReadinessFacade } from "./wallet-readiness-facade.js";

describe("Wallet readiness facade", () => {
  it("exposes snapshot, summary, and runtime resolution through one typed boundary", async () => {
    const snapshot = { enabled: true, service: { healthy: true } };
    const runtime = { enabled: true, mode: "managed" };
    const read = vi.fn(async () => snapshot);
    const summarize = vi.fn(() => "healthy");
    const resolveRuntimeConfig = vi.fn(() => runtime);
    const facade = createWalletReadinessFacade({
      read: read as never,
      summarize: summarize as never,
      resolveRuntimeConfig: resolveRuntimeConfig as never,
    });
    const config = { wallet: { enabled: true } };
    const env = { FASED_GATEWAY_MODE: "managed" };

    await expect(facade.read({ config: config as never, env })).resolves.toBe(snapshot);
    expect(facade.summarize(snapshot as never)).toBe("healthy");
    expect(facade.resolveRuntimeConfig(config as never, env)).toBe(runtime);
    expect(read).toHaveBeenCalledWith({ config, env });
    expect(summarize).toHaveBeenCalledWith(snapshot);
    expect(resolveRuntimeConfig).toHaveBeenCalledWith(config, env);
  });
});
