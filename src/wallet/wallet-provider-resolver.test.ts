import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import {
  createWalletProviderAdapter,
  resolveWalletProviderId,
} from "./wallet-provider-resolver.js";
import {
  resolveWalletRuntimeConfig,
  resolveWalletRuntimeProviderId,
} from "./wallet-runtime-config.js";

async function writeRegistry(root: string, body: unknown): Promise<void> {
  const walletDir = path.join(root, "wallet");
  await fs.mkdir(walletDir, { recursive: true });
  await fs.writeFile(
    path.join(walletDir, "provider-registry.v1.json"),
    JSON.stringify(body, null, 2),
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

  it("prefers the SAT attached local signer wallet over legacy embedded-keystore config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-provider-resolver-"));
    tempRoots.push(root);
    await writeRegistry(root, {
      version: 1,
      providers: {
        "embedded-keystore": { enabled: true, updatedAt: "2026-04-04T00:00:00.000Z" },
        "local-socket-signer": { enabled: true, updatedAt: "2026-04-04T00:00:00.000Z" },
        alchemy: { enabled: false, updatedAt: "2026-04-04T00:00:00.000Z" },
        turnkey: { enabled: false, updatedAt: "2026-04-04T00:00:00.000Z" },
        privy: { enabled: false, updatedAt: "2026-04-04T00:00:00.000Z" },
      },
      wallets: [
        {
          id: "solana-1",
          name: "Solana 1",
          providerId: "local-socket-signer",
          addresses: { solana: "3P2TQ3ED1111111111111111111111111111116TNai5" },
          createdAt: "2026-04-04T00:00:00.000Z",
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
      ],
      assignments: {},
      defaultWalletId: "solana-1",
      updatedAt: "2026-04-04T00:00:00.000Z",
    });
    const cfg: FasedAgentConfig = {
      wallet: {
        provider: { id: "embedded-keystore" },
      },
      plugins: {
        entries: {
          "sat-mining": {
            config: {
              walletId: "solana-1",
            },
          },
        },
      },
    } as FasedAgentConfig;

    expect(
      resolveWalletProviderId(cfg, {
        FASED_STATE_DIR: root,
      } as NodeJS.ProcessEnv),
    ).toBe("local-socket-signer");
  });

  it("infers local-socket-signer from self-hosted signer env when config provider is unset", () => {
    const cfg = {} as FasedAgentConfig;
    const env = {
      FASED_WALLET_LOCAL_SIGNER_SOCKET: "/tmp/fased-local-signer.sock",
      FASED_WALLET_SOLANA_KEYSTORE_PATH__SOLANA_1: "/tmp/keystore-solana-solana-1.v1.enc",
    } as NodeJS.ProcessEnv;

    expect(resolveWalletRuntimeProviderId(cfg, env)).toBe("local-socket-signer");
    expect(resolveWalletRuntimeConfig(cfg, env).mode).toBe("external");
  });

  it("creates a local-socket-signer adapter from config-scoped env without raw process env", () => {
    const cfg = {
      env: {
        vars: {
          FASED_WALLET_LOCAL_SIGNER_SOCKET: "/tmp/from-config.sock",
        },
      },
      wallet: {
        provider: { id: "local-socket-signer" },
      },
    } as FasedAgentConfig;
    const wallet = resolveWalletRuntimeConfig(cfg, {} as NodeJS.ProcessEnv);

    const adapter = createWalletProviderAdapter({
      cfg,
      wallet,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(adapter.id).toBe("local-socket-signer");
    expect((adapter as { socketPath?: string }).socketPath).toBe("/tmp/from-config.sock");
  });

  it("prefers local-socket-signer when self-hosted signer env exists even if config still says embedded-keystore", () => {
    const cfg = {
      wallet: {
        provider: { id: "embedded-keystore" },
      },
    } as FasedAgentConfig;
    const env = {
      FASED_WALLET_LOCAL_SIGNER_SOCKET: "/tmp/fased-local-signer.sock",
      FASED_WALLET_SOLANA_KEYSTORE_PATH__SOLANA_1: "/tmp/keystore-solana-solana-1.v1.enc",
    } as NodeJS.ProcessEnv;

    expect(resolveWalletProviderId(cfg, env)).toBe("local-socket-signer");
  });

  it("uses wallet-scoped RPC for embedded-keystore wallet selection", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-provider-resolver-"));
    tempRoots.push(root);
    await writeRegistry(root, {
      version: 1,
      providers: {
        "embedded-keystore": { enabled: true, updatedAt: "2026-04-04T00:00:00.000Z" },
        "local-socket-signer": { enabled: false, updatedAt: "2026-04-04T00:00:00.000Z" },
        alchemy: { enabled: false, updatedAt: "2026-04-04T00:00:00.000Z" },
        turnkey: { enabled: false, updatedAt: "2026-04-04T00:00:00.000Z" },
        privy: { enabled: false, updatedAt: "2026-04-04T00:00:00.000Z" },
      },
      wallets: [
        {
          id: "solana-1",
          name: "Solana 1",
          providerId: "embedded-keystore",
          addresses: { solana: "3P2TQ3ED1111111111111111111111111111116TNai5" },
          createdAt: "2026-04-04T00:00:00.000Z",
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
      ],
      assignments: {},
      defaultWalletId: "solana-1",
      updatedAt: "2026-04-04T00:00:00.000Z",
    });
    const cfg = {
      wallet: {
        provider: { id: "embedded-keystore" },
      },
      env: {
        vars: {
          FASED_STATE_DIR: root,
          FASED_WALLET_KEYSTORE_PATH: "/tmp/keystore.enc",
          FASED_WALLET_PASSPHRASE: "secret",
          FASED_WALLET_SOLANA_RPC_URL: "https://wrong-global-rpc.example",
          FASED_WALLET_SOLANA_RPC_URL__SOLANA_1: "https://wallet-specific-rpc.example",
        },
      },
    } as FasedAgentConfig;
    const wallet = resolveWalletRuntimeConfig(cfg, {} as NodeJS.ProcessEnv);

    const adapter = createWalletProviderAdapter({
      cfg,
      wallet,
      env: {} as NodeJS.ProcessEnv,
      walletId: "solana-1",
      providerIdOverride: "embedded-keystore",
    });

    expect((adapter as { rpcUrl?: string }).rpcUrl).toBe("https://wallet-specific-rpc.example");
  });
});
