import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import {
  createWalletProviderAdapter,
  resolveWalletProviderId,
} from "./wallet-provider-resolver.js";
import { resolveWalletRuntimeConfig } from "./wallet-runtime-config.js";

vi.mock("./providers/turnkey-adapter.js", () => ({
  TurnkeyAdapter: class {
    readonly id = "turnkey";
  },
}));

async function writeRegistry(root: string, body: unknown): Promise<void> {
  const walletDir = path.join(root, "wallet");
  await fs.mkdir(walletDir, { recursive: true });
  await fs.writeFile(
    path.join(walletDir, "provider-registry.v1.json"),
    `${JSON.stringify(body, null, 2)}\n`,
    "utf8",
  );
}

describe("wallet provider resolver", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("fails closed to manual capped execution when wallet policy is absent", () => {
    const wallet = resolveWalletRuntimeConfig({} as FasedAgentConfig, {} as NodeJS.ProcessEnv);

    expect(wallet.execution.mode).toBe("manual");
    expect(wallet.policy.directSigning).toBe(false);
    expect(wallet.policy.capsEnabled).toBe(true);
    expect(wallet.policy.solana.allowPrograms).toEqual([]);
  });

  it("rejects explicit embedded config even when a native signer socket is available", () => {
    const cfg = {
      wallet: { provider: { id: "embedded-keystore" } },
    } as FasedAgentConfig;

    expect(() =>
      resolveWalletProviderId(cfg, {
        FASED_WALLET_LOCAL_SIGNER_SOCKET: "/run/fased-signerd/app.sock",
      } as NodeJS.ProcessEnv),
    ).toThrow(/legacy wallet provider selection detected.*import-legacy/i);
  });

  it("rejects legacy material hints instead of inferring a native signer", () => {
    expect(() =>
      resolveWalletProviderId(
        {} as FasedAgentConfig,
        {
          FASED_WALLET_SOLANA_KEYSTORE_PATH: "/legacy/keystore-solana.v1.enc",
        } as NodeJS.ProcessEnv,
      ),
    ).toThrow(/legacy wallet material configuration detected.*import-legacy/i);
  });

  it("rejects a legacy embedded wallet retained in the registry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-provider-legacy-"));
    tempRoots.push(root);
    await writeRegistry(root, {
      version: 1,
      providers: {
        "embedded-keystore": { enabled: true, updatedAt: "2026-04-04T00:00:00.000Z" },
        "local-socket-signer": { enabled: false, updatedAt: "2026-04-04T00:00:00.000Z" },
      },
      wallets: [
        {
          id: "legacy",
          name: "Legacy",
          providerId: "embedded-keystore",
          addresses: { solana: "11111111111111111111111111111111" },
          createdAt: "2026-04-04T00:00:00.000Z",
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
      ],
      assignments: {},
      defaultWalletId: "legacy",
      updatedAt: "2026-04-04T00:00:00.000Z",
    });

    expect(() =>
      resolveWalletProviderId(
        {} as FasedAgentConfig,
        {
          FASED_STATE_DIR: root,
        } as NodeJS.ProcessEnv,
      ),
    ).toThrow(/legacy wallet registry selection detected.*import-legacy/i);
  });

  it("keeps native signer, Turnkey, and Wallet Standard adapter resolution available", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-provider-supported-"));
    tempRoots.push(root);
    const env = {
      FASED_STATE_DIR: root,
      FASED_WALLET_LOCAL_SIGNER_SOCKET: "/run/user/1000/fased-signerd.sock",
    } as NodeJS.ProcessEnv;

    const localConfig = {
      wallet: { provider: { id: "local-socket-signer" } },
    } as FasedAgentConfig;
    const turnkeyConfig = {
      wallet: { provider: { id: "turnkey" } },
    } as FasedAgentConfig;
    const walletStandardConfig = {
      wallet: { provider: { id: "wallet-standard" } },
    } as FasedAgentConfig;

    expect(resolveWalletProviderId(localConfig, env)).toBe("local-socket-signer");
    expect(resolveWalletProviderId(turnkeyConfig, env)).toBe("turnkey");
    expect(resolveWalletProviderId(walletStandardConfig, env)).toBe("wallet-standard");
    expect(
      createWalletProviderAdapter({
        cfg: localConfig,
        wallet: resolveWalletRuntimeConfig(localConfig, env),
        env,
      }).id,
    ).toBe("local-socket-signer");
    expect(
      createWalletProviderAdapter({
        cfg: turnkeyConfig,
        wallet: resolveWalletRuntimeConfig(turnkeyConfig, env),
        env,
      }).id,
    ).toBe("turnkey");
    expect(
      createWalletProviderAdapter({
        cfg: walletStandardConfig,
        wallet: resolveWalletRuntimeConfig(walletStandardConfig, env),
        env,
      }).id,
    ).toBe("wallet-standard");
  });

  it("rejects Privy config and adapter overrides as unavailable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-provider-privy-"));
    tempRoots.push(root);
    const cfg = { wallet: { provider: { id: "privy" } } } as FasedAgentConfig;
    const env = { FASED_STATE_DIR: root } as NodeJS.ProcessEnv;

    expect(() => resolveWalletProviderId(cfg, env)).toThrow(/Privy.*unavailable/i);
    expect(() =>
      createWalletProviderAdapter({
        cfg: {} as FasedAgentConfig,
        wallet: resolveWalletRuntimeConfig({} as FasedAgentConfig, env),
        env,
        providerIdOverride: "privy",
      }),
    ).toThrow(/Privy.*unavailable/i);
  });
});
