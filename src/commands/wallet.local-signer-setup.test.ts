import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, loadConfig } from "../config/config.js";
import { walletKeystoreExportCommand, walletSetupCommand } from "./wallet.js";

const TEST_SOLANA_PRIVATE_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

describe("walletSetupCommand local-signer self-hosted modes", () => {
  afterEach(() => {
    clearConfigCache();
    vi.unstubAllEnvs();
  });

  it("creates self-hosted wallet material without falling back to embedded-keystore config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-local-signer-create-"));
    const configPath = path.join(root, "fased.json");
    const stateDir = path.join(root, "state");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    vi.stubEnv("FASED_WALLET_PASSPHRASE", "test-passphrase");
    delete process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET;
    clearConfigCache();
    try {
      await walletSetupCommand({ log: () => {} } as never, {
        mode: "local-signer-create",
        chain: "solana",
        walletId: "solana-1",
        walletName: "Solana 1",
        rpcUrl: "https://rpc.example/solana",
        nonInteractive: true,
        noDoctor: true,
        force: true,
      });

      const cfg = loadConfig();
      const walletDir = path.join(stateDir, "wallet");
      const keystorePath = String(cfg.env?.vars?.FASED_WALLET_SOLANA_KEYSTORE_PATH__SOLANA_1 ?? "");
      const signerSocket = String(cfg.env?.vars?.FASED_WALLET_LOCAL_SIGNER_SOCKET ?? "");
      const signerEnvPath = path.join(walletDir, "signer.env");

      expect(cfg.wallet?.provider?.id).toBe("local-socket-signer");
      expect(cfg.wallet?.runtime?.enabled).toBe(true);
      expect(cfg.wallet?.runtime?.mode).toBe("external");
      expect(cfg.wallet?.runtime?.runtime).toBe("external-custom");
      expect(cfg.wallet?.keystore?.enabled).not.toBe(true);
      expect(cfg.env?.vars?.FASED_WALLET_SOLANA_RPC_URL__SOLANA_1).toBe(
        "https://rpc.example/solana",
      );
      expect(keystorePath).toMatch(/keystore-solana-solana-1\.v1\.enc$/);
      expect(signerSocket).toBe(path.join(walletDir, "local-signer.sock"));

      const [walletDirStat, keystoreStat, signerEnvStat] = await Promise.all([
        fs.stat(walletDir),
        fs.stat(keystorePath),
        fs.stat(signerEnvPath),
      ]);
      const signerEnv = await fs.readFile(signerEnvPath, "utf8");
      expect(walletDirStat.mode & 0o777).toBe(0o700);
      expect(keystoreStat.mode & 0o777).toBe(0o600);
      expect(signerEnvStat.mode & 0o777).toBe(0o600);
      expect(signerEnv).toContain('export FASED_WALLET_CHAINS="solana"');
      expect(signerEnv).toContain('export FASED_WALLET_PASSPHRASE="test-passphrase"');
      expect(signerEnv).toContain(
        `export FASED_WALLET_SOLANA_KEYSTORE_PATH__SOLANA_1="${keystorePath}"`,
      );
      expect(signerEnv).not.toContain("export FASED_WALLET_SOLANA_KEYSTORE_PATH=");
      expect(signerEnv).toContain(
        'export FASED_WALLET_SOLANA_RPC_URL__SOLANA_1="https://rpc.example/solana"',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("creates named local signer wallets in scoped files even when a generic keystore env exists", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "fased-wallet-local-signer-create-scoped-"),
    );
    const configPath = path.join(root, "fased.json");
    const stateDir = path.join(root, "state");
    const genericKeystorePath = path.join(stateDir, "wallet", "keystore-solana.v1.enc");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    vi.stubEnv("FASED_WALLET_PASSPHRASE", "test-passphrase");
    vi.stubEnv("FASED_WALLET_SOLANA_KEYSTORE_PATH", genericKeystorePath);
    delete process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET;
    clearConfigCache();
    try {
      await walletSetupCommand({ log: () => {} } as never, {
        mode: "local-signer-create",
        chain: "solana",
        walletId: "solana-3",
        walletName: "Solana 3",
        rpcUrl: "https://rpc.example/solana",
        nonInteractive: true,
        noDoctor: true,
        force: true,
      });

      const cfg = loadConfig();
      const scopedPath = String(cfg.env?.vars?.FASED_WALLET_SOLANA_KEYSTORE_PATH__SOLANA_3 ?? "");
      expect(scopedPath).toMatch(/keystore-solana-solana-3\.v1\.enc$/);
      expect(scopedPath).not.toBe(genericKeystorePath);
      await expect(fs.stat(scopedPath)).resolves.toBeTruthy();
      await expect(fs.stat(genericKeystorePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses the managed passphrase file instead of a stale env passphrase", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "fased-wallet-local-signer-passphrase-file-"),
    );
    const configPath = path.join(root, "fased.json");
    const stateDir = path.join(root, "state");
    const walletDir = path.join(stateDir, "wallet");
    const passphraseFile = path.join(walletDir, "passphrase");
    await fs.mkdir(walletDir, { recursive: true });
    await fs.writeFile(configPath, "{}\n", "utf8");
    await fs.writeFile(passphraseFile, "correct-file-passphrase\n", { mode: 0o600 });
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    vi.stubEnv("FASED_WALLET_PASSPHRASE", "stale-env-passphrase");
    delete process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET;
    clearConfigCache();
    try {
      await walletSetupCommand({ log: () => {} } as never, {
        mode: "local-signer-create",
        chain: "solana",
        walletId: "solana-1",
        walletName: "Solana 1",
        rpcUrl: "https://rpc.example/solana",
        nonInteractive: true,
        noDoctor: true,
        force: true,
      });

      const signerEnv = await fs.readFile(path.join(walletDir, "signer.env"), "utf8");
      expect(signerEnv).toContain(`export FASED_WALLET_PASSPHRASE_FILE="${passphraseFile}"`);
      expect(signerEnv).not.toContain("stale-env-passphrase");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("imports self-hosted wallet material without persisting embedded-keystore provider state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-local-signer-import-"));
    const configPath = path.join(root, "fased.json");
    const stateDir = path.join(root, "state");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    vi.stubEnv("FASED_WALLET_PASSPHRASE", "test-passphrase");
    delete process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET;
    clearConfigCache();
    try {
      await walletSetupCommand({ log: () => {} } as never, {
        mode: "local-signer-import",
        chain: "solana",
        walletId: "trading-main",
        walletName: "Trading Main",
        privateKey: TEST_SOLANA_PRIVATE_KEY,
        rpcUrl: "https://rpc.example/solana",
        nonInteractive: true,
        noDoctor: true,
        force: true,
      });

      const cfg = loadConfig();
      expect(cfg.wallet?.provider?.id).toBe("local-socket-signer");
      expect(cfg.wallet?.runtime?.enabled).toBe(true);
      expect(cfg.wallet?.keystore?.enabled).not.toBe(true);
      expect(cfg.env?.vars?.FASED_WALLET_SOLANA_RPC_URL__TRADING_MAIN).toBe(
        "https://rpc.example/solana",
      );
      expect(cfg.env?.vars?.FASED_WALLET_SOLANA_KEYSTORE_PATH__TRADING_MAIN).toMatch(
        /keystore-solana-trading-main\.v1\.enc$/,
      );
      expect(cfg.env?.vars?.FASED_WALLET_LOCAL_SIGNER_SOCKET).toBe(
        path.join(stateDir, "wallet", "local-signer.sock"),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("suppresses signer doctor and env-hint noise during quiet onboarding self-hosted create", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-local-signer-quiet-"));
    const configPath = path.join(root, "fased.json");
    const stateDir = path.join(root, "state");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    vi.stubEnv("FASED_WALLET_PASSPHRASE", "test-passphrase");
    delete process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET;
    clearConfigCache();
    const logs: string[] = [];
    try {
      await walletSetupCommand({ log: (line: string) => logs.push(line) } as never, {
        mode: "local-signer-create",
        chain: "solana",
        walletId: "solana-1",
        walletName: "Solana 1",
        rpcUrl: "https://rpc.example/solana",
        nonInteractive: true,
        noDoctor: true,
        noSignerHints: true,
        showPrivateKeyOnce: true,
        confirmPrivateKeyPrint: "SHOW PRIVATE KEY",
        force: true,
      });

      const output = logs.join("\n");
      expect(output).toContain("SOLANA address:");
      expect(output).toContain("PRIVATE KEY (shown once):");
      expect(output).not.toContain("Self-hosted signer keystore created:");
      expect(output).not.toContain("Signer mode: local native signer");
      expect(output).not.toContain("Wallet signer doctor:");
      expect(output).not.toContain("Recommended environment exports");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("requires explicit confirmation before printing a generated private key", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-private-key-confirm-"));
    const configPath = path.join(root, "fased.json");
    const stateDir = path.join(root, "state");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    vi.stubEnv("FASED_WALLET_PASSPHRASE", "test-passphrase");
    delete process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET;
    clearConfigCache();
    try {
      await expect(
        walletSetupCommand({ log: () => {} } as never, {
          mode: "local-signer-create",
          chain: "solana",
          walletId: "agent",
          walletName: "Agent",
          rpcUrl: "https://rpc.example/solana",
          nonInteractive: true,
          noDoctor: true,
          noSignerHints: true,
          showPrivateKeyOnce: true,
          force: true,
        }),
      ).rejects.toThrow(/requires explicit confirmation/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("requires explicit confirmation and JSON before printing encrypted keystore material", async () => {
    await expect(
      walletKeystoreExportCommand({ log: () => {} } as never, {
        includeSecret: true,
      }),
    ).rejects.toThrow(/requires --json/);

    await expect(
      walletKeystoreExportCommand({ log: () => {} } as never, {
        includeSecret: true,
        json: true,
      }),
    ).rejects.toThrow(/requires explicit confirmation/);
  });

  it("stores Jupiter limit-order config when requested during wallet setup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-limit-orders-"));
    const configPath = path.join(root, "fased.json");
    const stateDir = path.join(root, "state");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    vi.stubEnv("FASED_WALLET_PASSPHRASE", "test-passphrase");
    delete process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET;
    clearConfigCache();
    try {
      await walletSetupCommand({ log: () => {} } as never, {
        mode: "local-signer-create",
        chain: "solana",
        walletId: "agent",
        walletName: "Agent",
        rpcUrl: "https://rpc.example/solana",
        role: "agent",
        nonInteractive: true,
        noDoctor: true,
        noSignerHints: true,
        force: true,
        enableLimitOrders: true,
        jupiterApiKey: "jup-test-key",
      });

      const cfg = loadConfig();
      expect(cfg.env?.vars?.FASED_JUPITER_API_KEY).toBe("jup-test-key");
      expect(process.env.FASED_JUPITER_API_KEY).toBe("jup-test-key");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
