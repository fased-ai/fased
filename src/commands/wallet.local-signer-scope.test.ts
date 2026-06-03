import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import { clearConfigCache } from "../config/config.js";
import {
  createLegacyLocalSignerEmbeddedAdapter,
  resolveLegacyLocalSignerEmbeddedScope,
  walletKeystoreImportCommand,
} from "./wallet.js";

describe("legacy local signer wallet scope", () => {
  afterEach(() => {
    clearConfigCache();
    vi.unstubAllEnvs();
  });

  it("routes selected wallet probes to the matching scoped keystore", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-local-signer-scope-"));
    const configPath = path.join(root, "fased.json");
    const stateDir = path.join(root, "state");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    vi.stubEnv("FASED_WALLET_PASSPHRASE", "test-passphrase");
    clearConfigCache();
    try {
      await walletKeystoreImportCommand(
        { log: () => {} } as unknown as Parameters<typeof walletKeystoreImportCommand>[0],
        {
          chain: "solana",
          privateKey: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
          passphrase: "test-passphrase",
          rpcUrl: "https://rpc.example/solana-default",
          force: true,
        },
      );
      await walletKeystoreImportCommand(
        { log: () => {} } as unknown as Parameters<typeof walletKeystoreImportCommand>[0],
        {
          chain: "solana",
          walletId: "vps-miner",
          privateKey: "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100",
          passphrase: "test-passphrase",
          rpcUrl: "https://rpc.example/solana-vps",
          force: true,
        },
      );

      const cfg = JSON.parse(await fs.readFile(configPath, "utf8")) as FasedAgentConfig;
      const env = {
        FASED_CONFIG_PATH: configPath,
        FASED_DISABLE_CONFIG_CACHE: "1",
        FASED_STATE_DIR: stateDir,
        FASED_WALLET_PASSPHRASE: "test-passphrase",
      } as NodeJS.ProcessEnv;
      const defaultScope = resolveLegacyLocalSignerEmbeddedScope({
        cfg,
        env,
        chain: "solana",
      });
      const scopedScope = resolveLegacyLocalSignerEmbeddedScope({
        cfg,
        env,
        chain: "solana",
        walletId: "vps-miner",
      });
      const defaultProvider = createLegacyLocalSignerEmbeddedAdapter({
        cfg,
        env,
        chain: "solana",
      });
      const scopedProvider = createLegacyLocalSignerEmbeddedAdapter({
        cfg,
        env,
        chain: "solana",
        walletId: "vps-miner",
      });

      const [defaultRaw, scopedRaw, defaultAddresses, scopedAddresses] = await Promise.all([
        fs.readFile(defaultScope.keystorePath, "utf8"),
        fs.readFile(scopedScope.keystorePath, "utf8"),
        defaultProvider.getAddresses(),
        scopedProvider.getAddresses(),
      ]);
      const defaultParsed = JSON.parse(defaultRaw) as { publicKey?: string };
      const scopedParsed = JSON.parse(scopedRaw) as { publicKey?: string };

      expect(defaultScope.keystorePath).not.toBe(scopedScope.keystorePath);
      expect(defaultAddresses.solana).toBe(defaultParsed.publicKey);
      expect(scopedAddresses.solana).toBe(scopedParsed.publicKey);
      expect(scopedAddresses.solana).not.toBe(defaultAddresses.solana);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
