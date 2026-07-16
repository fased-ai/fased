import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, loadConfig } from "../config/config.js";
import { walletKeystoreExportCommand, walletSetupCommand } from "./wallet.js";

const TEST_SOLANA_PRIVATE_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const signerMocks = vi.hoisted(() => ({
  create: vi.fn(async (params: { walletId: string; role: string }) => ({
    wallet: {
      walletId: params.walletId,
      publicKey: "11111111111111111111111111111111",
      version: 1,
      createdAt: "2026-07-16T12:00:00.000Z",
    },
    policy: {
      walletId: params.walletId,
      role: params.role,
      version: 1,
      operations: [],
      programs: [],
      assets: [],
      hash: `sha256:${"a".repeat(64)}`,
    },
  })),
  install: vi.fn(),
  restart: vi.fn(async () => undefined),
  networkPut: vi.fn(() => ({
    walletId: "solana_1",
    configured: true,
    version: 1,
    hash: `hmac-sha256:${"b".repeat(64)}`,
    ready: true,
  })),
}));

vi.mock("../wallet/local-socket-signer-lifecycle.js", () => ({
  createLockedSignerOwnedWallet: signerMocks.create,
}));

vi.mock("../wallet/signer-network-admin.js", () => ({
  configureSignerOwnedWalletNetwork: signerMocks.networkPut,
}));

vi.mock("../wizard/onboarding.wallet.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wizard/onboarding.wallet.js")>();
  return {
    ...actual,
    installSignerdBinary: signerMocks.install,
    restartLocalSocketSigner: signerMocks.restart,
    resolveSignerdBinaryPath: () => "/tmp/fased-signerd-test",
  };
});

describe("walletSetupCommand local-signer self-hosted modes", () => {
  beforeEach(() => {
    for (const key of [
      "FASED_WALLET_LOCAL_SIGNER_SOCKET",
      "FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET",
      "FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET",
      "FASED_WALLET_LOCAL_SIGNER_STATE_DB",
      "FASED_WALLET_LOCAL_SIGNER_MASTER_KEY",
      "FASED_HOST_PROFILE",
      "FASED_HOST_BOOTSTRAP_CTL",
      "FASED_HOST_BOOTSTRAP_SOCKET",
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    clearConfigCache();
    signerMocks.create.mockClear();
    signerMocks.install.mockClear();
    signerMocks.restart.mockClear();
    signerMocks.networkPut.mockClear();
    vi.unstubAllEnvs();
  });

  it("creates signer-owned wallet state without an embedded keystore", async () => {
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
      expect(cfg.env?.vars?.FASED_WALLET_SOLANA_KEYSTORE_PATH__SOLANA_1).toBeUndefined();
      expect(signerSocket).toBe(path.join(walletDir, "local-signer.sock"));

      const [walletDirStat, signerEnvStat] = await Promise.all([
        fs.stat(walletDir),
        fs.stat(signerEnvPath),
      ]);
      const signerEnv = await fs.readFile(signerEnvPath, "utf8");
      expect(walletDirStat.mode & 0o777).toBe(0o700);
      expect(signerEnvStat.mode & 0o777).toBe(0o600);
      expect(signerEnv).toContain('export FASED_WALLET_CHAINS="solana"');
      expect(signerEnv).not.toMatch(/PASSPHRASE|KEYSTORE|PRIVATE_KEY|SECRET|SEED/i);
      expect(signerEnv).not.toContain("https://rpc.example/solana");
      expect(signerEnv).toContain("FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET");
      expect(signerEnv).toContain("FASED_WALLET_LOCAL_SIGNER_STATE_DB");
      expect(signerEnv).toContain("FASED_WALLET_LOCAL_SIGNER_MASTER_KEY");
      expect(signerEnv).toContain('--control-socket "$FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET"');
      expect(signerEnv).toContain('FASED_WALLET_WEBAUTHN_RP_ID="localhost"');
      expect(signerEnv).toContain('FASED_WALLET_WEBAUTHN_ORIGINS="http://localhost:18789"');
      expect(signerMocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ walletId: "solana-1", role: "agent" }),
      );
      expect(signerMocks.networkPut).toHaveBeenCalledWith(
        expect.objectContaining({
          walletId: "solana-1",
          primaryRpcUrl: "https://rpc.example/solana",
        }),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses only the ephemeral root bootstrap for a fresh hosted signer wallet", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-hosted-signer-create-"));
    const configPath = path.join(root, "fased.json");
    const stateDir = path.join(root, "state");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    vi.stubEnv("FASED_HOST_PROFILE", "hosting");
    vi.stubEnv("FASED_HOST_BOOTSTRAP_CTL", "/usr/local/libexec/fased-host-bootstrapctl.mjs");
    vi.stubEnv("FASED_HOST_BOOTSTRAP_SOCKET", "/run/fased-host-bootstrap/control.sock");
    vi.stubEnv("FASED_WALLET_LOCAL_SIGNER_SOCKET", "/run/fased-signerd/app.sock");
    clearConfigCache();
    try {
      await walletSetupCommand({ log: () => {} } as never, {
        mode: "local-signer-create",
        chain: "solana",
        walletId: "agent",
        walletName: "Agent",
        rpcUrl: "https://hosted-rpc.example/solana?api-key=secret",
        nonInteractive: true,
        noDoctor: true,
        noSignerHints: true,
      });

      const cfg = loadConfig();
      expect(cfg.env?.vars?.FASED_WALLET_LOCAL_SIGNER_SOCKET).toBe("/run/fased-signerd/app.sock");
      for (const key of [
        "FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET",
        "FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET",
        "FASED_WALLET_LOCAL_SIGNER_STATE_DB",
        "FASED_WALLET_LOCAL_SIGNER_MASTER_KEY",
        "FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER",
        "FASED_WALLET_SIGNER_STATE_DIR",
      ]) {
        expect(cfg.env?.vars?.[key]).toBeUndefined();
      }
      await expect(fs.stat(path.join(stateDir, "wallet", "signer.env"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(signerMocks.networkPut).toHaveBeenCalledWith(
        expect.objectContaining({
          walletId: "agent",
          primaryRpcUrl: "https://hosted-rpc.example/solana?api-key=secret",
          env: expect.objectContaining({ FASED_HOST_PROFILE: "hosting" }),
        }),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not create a Node keystore when stale generic keystore config exists", async () => {
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
      expect(cfg.env?.vars?.FASED_WALLET_SOLANA_KEYSTORE_PATH__SOLANA_3).toBeUndefined();
      await expect(fs.stat(genericKeystorePath)).rejects.toMatchObject({ code: "ENOENT" });
      const signerEnv = await fs.readFile(path.join(stateDir, "wallet", "signer.env"), "utf8");
      expect(signerEnv).not.toContain(genericKeystorePath);
      expect(signerEnv).not.toMatch(/KEYSTORE|PASSPHRASE/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not export legacy passphrases for signer-owned wallets", async () => {
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
      expect(signerEnv).not.toContain(passphraseFile);
      expect(signerEnv).not.toMatch(/FASED_WALLET_PASSPHRASE/i);
      expect(signerEnv).not.toContain("stale-env-passphrase");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects signer-owned imports before plaintext key material reaches Node persistence", async () => {
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
      await expect(
        walletSetupCommand({ log: () => {} } as never, {
          mode: "local-signer-import",
          chain: "solana",
          walletId: "trading-main",
          walletName: "Trading Main",
          privateKey: TEST_SOLANA_PRIVATE_KEY,
          rpcUrl: "https://rpc.example/solana",
          nonInteractive: true,
          noDoctor: true,
          force: true,
        }),
      ).rejects.toThrow("cannot pass plaintext key material through Node");

      const cfg = loadConfig();
      expect(cfg.wallet).toBeUndefined();
      expect(cfg.env?.vars).toBeUndefined();
      await expect(fs.readFile(configPath, "utf8")).resolves.not.toContain(TEST_SOLANA_PRIVATE_KEY);
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
        force: true,
      });

      const output = logs.join("\n");
      expect(output).toContain("SOLANA address:");
      expect(output).not.toMatch(/PRIVATE KEY|SECRET|SEED/i);
      expect(output).not.toContain("Self-hosted signer keystore created:");
      expect(output).not.toContain("Signer mode: local native signer");
      expect(output).not.toContain("Wallet signer doctor:");
      expect(output).not.toContain("Recommended environment exports");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to print a signer-owned private key", async () => {
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
      ).rejects.toThrow(/cannot be printed or exported/);
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
