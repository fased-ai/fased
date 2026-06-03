import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, loadConfig } from "../config/config.js";
import { walletKeystoreImportCommand } from "./wallet.js";

const TEST_SOLANA_PRIVATE_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

describe("wallet keystore env mappings", () => {
  afterEach(() => {
    clearConfigCache();
    vi.unstubAllEnvs();
  });

  it("persists walletId-scoped keystore and rpc env vars into config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-map-"));
    const configPath = path.join(root, "fased.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", path.join(root, "state"));
    try {
      await walletKeystoreImportCommand(
        { log: () => {} } as unknown as Parameters<typeof walletKeystoreImportCommand>[0],
        {
          chain: "solana",
          walletId: "trading-main",
          privateKey: TEST_SOLANA_PRIVATE_KEY,
          passphrase: "test-passphrase",
          rpcUrl: "https://rpc.example/solana",
          force: true,
        },
      );
      const cfg = loadConfig();
      expect(cfg.env?.vars?.["FASED_WALLET_SOLANA_KEYSTORE_PATH__TRADING_MAIN"]).toMatch(
        /keystore-solana-trading-main\.v1\.enc$/,
      );
      expect(cfg.env?.vars?.["FASED_WALLET_SOLANA_RPC_URL__TRADING_MAIN"]).toBe(
        "https://rpc.example/solana",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("persists default-chain keystore and rpc env vars when walletId is omitted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-map-default-"));
    const configPath = path.join(root, "fased.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", path.join(root, "state"));
    try {
      await walletKeystoreImportCommand(
        { log: () => {} } as unknown as Parameters<typeof walletKeystoreImportCommand>[0],
        {
          chain: "solana",
          privateKey: TEST_SOLANA_PRIVATE_KEY,
          passphrase: "test-passphrase",
          rpcUrl: "https://rpc.example/default",
          force: true,
        },
      );
      const cfg = loadConfig();
      expect(cfg.env?.vars?.FASED_WALLET_SOLANA_KEYSTORE_PATH).toMatch(/keystore-solana\.v1\.enc$/);
      expect(cfg.env?.vars?.FASED_WALLET_SOLANA_RPC_URL).toBe("https://rpc.example/default");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("imports solana from 32-byte seed and persists env mappings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-map-solana-seed-"));
    const configPath = path.join(root, "fased.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", path.join(root, "state"));
    try {
      const solanaSeedHex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
      await walletKeystoreImportCommand(
        { log: () => {} } as unknown as Parameters<typeof walletKeystoreImportCommand>[0],
        {
          chain: "solana",
          privateKey: solanaSeedHex,
          passphrase: "test-passphrase",
          rpcUrl: "https://rpc.example/solana",
          force: true,
        },
      );
      const cfg = loadConfig();
      expect(cfg.env?.vars?.FASED_WALLET_SOLANA_KEYSTORE_PATH).toMatch(/keystore-solana\.v1\.enc$/);
      expect(cfg.env?.vars?.FASED_WALLET_SOLANA_RPC_URL).toBe("https://rpc.example/solana");
      const keystorePath = String(cfg.env?.vars?.FASED_WALLET_SOLANA_KEYSTORE_PATH ?? "");
      const raw = await fs.readFile(keystorePath, "utf8");
      const parsed = JSON.parse(raw) as { kind?: string; publicKey?: string };
      expect(parsed.kind).toBe("fased-solana-keypair");
      expect(typeof parsed.publicKey).toBe("string");
      expect(String(parsed.publicKey ?? "").length).toBeGreaterThan(30);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
