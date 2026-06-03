import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../../runtime.js";
import { readWalletProviderRegistry } from "../../../wallet/wallet-provider-registry.js";
import type { OnboardOptions } from "../../onboard-types.js";
import { applyNonInteractiveWalletConfig } from "./wallet-config.js";

function createRuntimeStub() {
  const runtime = {
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
  return runtime;
}

describe("applyNonInteractiveWalletConfig", () => {
  let tempConfigDir = "";

  beforeEach(async () => {
    tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-noninteractive-"));
    vi.stubEnv("FASED_CONFIG_DIR", tempConfigDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    if (tempConfigDir) {
      await fs.rm(tempConfigDir, { recursive: true, force: true });
    }
  });

  it("defaults to local-socket-signer runtime wallet in quickstart local flow", () => {
    const runtime = createRuntimeStub();
    const next = applyNonInteractiveWalletConfig({
      nextConfig: {},
      opts: {} as OnboardOptions,
      runtime,
    });
    expect(next.wallet?.runtime?.enabled).toBe(true);
    expect(next.wallet?.runtime?.mode).toBe("external");
    expect(next.wallet?.runtime?.runtime).toBe("external-custom");
    expect(next.wallet?.provider?.id).toBe("local-socket-signer");
  });

  it("prefers local-socket-signer over legacy embedded-keystore defaults", () => {
    const runtime = createRuntimeStub();
    const next = applyNonInteractiveWalletConfig({
      nextConfig: {
        wallet: {
          provider: { id: "embedded-keystore" },
        },
      },
      opts: {} as OnboardOptions,
      runtime,
    });

    expect(next.wallet?.provider?.id).toBe("local-socket-signer");
  });

  it("keeps self-hosted wallet defaults aligned across local and hosting profiles", () => {
    const runtime = createRuntimeStub();
    const localConfig = applyNonInteractiveWalletConfig({
      nextConfig: {},
      opts: { hostProfile: "local" } as OnboardOptions,
      runtime,
    });
    const hostingConfig = applyNonInteractiveWalletConfig({
      nextConfig: {},
      opts: { hostProfile: "hosting" } as OnboardOptions,
      runtime,
    });

    expect(localConfig.wallet?.provider?.id).toBe("local-socket-signer");
    expect(hostingConfig.wallet?.provider?.id).toBe("local-socket-signer");
    expect(localConfig.wallet?.runtime?.runtime).toBe(hostingConfig.wallet?.runtime?.runtime);
    expect(localConfig.wallet?.runtime?.mode).toBe(hostingConfig.wallet?.runtime?.mode);
    expect(localConfig.wallet?.runtime?.chains).toEqual(hostingConfig.wallet?.runtime?.chains);
  });

  it("enables wallet by default in managed mode", () => {
    vi.stubEnv("FASED_GATEWAY_MODE", "managed");
    const runtime = createRuntimeStub();
    const next = applyNonInteractiveWalletConfig({
      nextConfig: {},
      opts: {} as OnboardOptions,
      runtime,
    });
    expect(next.wallet?.runtime?.enabled).toBe(true);
    expect(next.wallet?.runtime?.mode).toBe("external");
    expect(next.wallet?.runtime?.runtime).toBe("external-custom");
    expect(next.wallet?.runtime?.external?.kind).toBe("custom");
    expect(next.wallet?.runtime?.chains).toEqual(["solana"]);
  });

  it("respects explicit disable flag", () => {
    const runtime = createRuntimeStub();
    const next = applyNonInteractiveWalletConfig({
      nextConfig: {},
      opts: { walletEnabled: false } as OnboardOptions,
      runtime,
    });
    expect(next.wallet?.runtime?.enabled).toBe(false);
  });

  it("rejects invalid chain values", () => {
    const runtime = createRuntimeStub();
    applyNonInteractiveWalletConfig({
      nextConfig: {},
      opts: { walletEnabled: true, walletChains: "solana,btc" } as OnboardOptions,
      runtime,
    });
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("applies enabled providers and default provider from CLI options", () => {
    const runtime = createRuntimeStub();
    const next = applyNonInteractiveWalletConfig({
      nextConfig: {},
      opts: {
        walletEnabled: true,
        walletProviders: "alchemy,privy",
        walletDefaultProvider: "privy",
      } as OnboardOptions,
      runtime,
    });
    const registry = readWalletProviderRegistry(process.env);
    expect(next.wallet?.provider?.id).toBe("privy");
    expect(next.wallet?.runtime?.runtime).toBe("external-custom");
    expect(next.wallet?.runtime?.install?.enabled).toBe(false);
    expect(registry.providers.alchemy?.enabled).toBe(true);
    expect(registry.providers.privy?.enabled).toBe(true);
  });

  it("rejects invalid deprecated provider in --wallet-providers", () => {
    const runtime = createRuntimeStub();
    applyNonInteractiveWalletConfig({
      nextConfig: {},
      opts: {
        walletEnabled: true,
        walletProviders: "removed-provider,alchemy",
        walletDefaultProvider: "alchemy",
      } as OnboardOptions,
      runtime,
    });
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
