import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, loadConfig } from "../config/config.js";
import {
  disableWalletCustodyForWallet,
  initializeWalletCustodyForWallet,
  walletRoleSetCommand,
  walletSetupCommand,
} from "./wallet.js";

vi.mock("../wizard/onboarding.wallet.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wizard/onboarding.wallet.js")>();
  return {
    ...actual,
    restartLocalSocketSigner: vi.fn(async () => ({ performed: true, restarted: true })),
  };
});

function writePasskeyState(walletDir: string) {
  return fs.writeFile(
    path.join(walletDir, "wallet-approval-auth.json"),
    `${JSON.stringify(
      {
        version: 2,
        passkeys: [
          {
            id: "credential-1",
            label: "operator",
            createdAt: "2026-04-15T00:00:00.000Z",
            publicKeySpki: "pub",
            publicKeyAlgorithm: -7,
            signCount: 0,
          },
        ],
        challenges: [],
        grants: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("wallet custody init local signer alignment", () => {
  afterEach(() => {
    clearConfigCache();
    vi.unstubAllEnvs();
  });

  it("does not clear the global signer passphrase while other local signer wallets remain single-key", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-custody-init-"));
    const configPath = path.join(root, "fased.json");
    const stateDir = path.join(root, "state");
    const walletDir = path.join(stateDir, "wallet");
    await fs.mkdir(walletDir, { recursive: true });
    await fs.writeFile(configPath, "{}\n", "utf8");
    await writePasskeyState(walletDir);
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    vi.stubEnv("FASED_WALLET_APPROVAL_AUTH", "webauthn");
    vi.stubEnv("FASED_WALLET_PASSPHRASE", "test-passphrase");
    clearConfigCache();
    try {
      await walletSetupCommand({ log: () => {} } as never, {
        mode: "local-signer-create",
        chain: "solana",
        walletId: "solana-1",
        walletName: "Solana 1",
        rpcUrl: "https://rpc.example/solana-1",
        nonInteractive: true,
        noDoctor: true,
        force: true,
      });
      await walletSetupCommand({ log: () => {} } as never, {
        mode: "local-signer-create",
        chain: "solana",
        walletId: "solana-2",
        walletName: "Solana 2",
        rpcUrl: "https://rpc.example/solana-2",
        nonInteractive: true,
        noDoctor: true,
        force: true,
      });
      await walletRoleSetCommand({ log: () => {} } as never, {
        walletId: "solana-2",
        role: "vault",
      });

      const result = await initializeWalletCustodyForWallet({
        walletId: "solana-2",
        env: process.env,
      });

      const cfg = loadConfig();
      expect(result.ok).toBe(true);
      expect(process.env.FASED_WALLET_PASSPHRASE).toBe("test-passphrase");
      expect(cfg.env?.vars?.FASED_WALLET_CUSTODY_WALLETS).toBe("solana_2");
      expect(cfg.env?.vars?.FASED_WALLET_PASSPHRASE).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("disables custody for a wallet and restores a managed signer passphrase", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-custody-disable-"));
    const configPath = path.join(root, "fased.json");
    const stateDir = path.join(root, "state");
    const walletDir = path.join(stateDir, "wallet");
    await fs.mkdir(walletDir, { recursive: true });
    await fs.writeFile(configPath, "{}\n", "utf8");
    await writePasskeyState(walletDir);
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    vi.stubEnv("FASED_WALLET_APPROVAL_AUTH", "webauthn");
    vi.stubEnv("FASED_WALLET_PASSPHRASE", "test-passphrase");
    clearConfigCache();
    try {
      await walletSetupCommand({ log: () => {} } as never, {
        mode: "local-signer-create",
        chain: "solana",
        walletId: "solana-2",
        walletName: "Solana 2",
        rpcUrl: "https://rpc.example/solana-2",
        nonInteractive: true,
        noDoctor: true,
        force: true,
      });
      await walletRoleSetCommand({ log: () => {} } as never, {
        walletId: "solana-2",
        role: "vault",
      });

      const initialized = await initializeWalletCustodyForWallet({
        walletId: "solana-2",
        env: process.env,
      });
      expect(initialized.removedManagedPassphraseFile).toBe(false);
      delete process.env.FASED_WALLET_PASSPHRASE;
      delete process.env.FASED_WALLET_PASSPHRASE_FILE;

      const disabled = await disableWalletCustodyForWallet({
        walletId: "solana-2",
        deviceShare: initialized.deviceShare,
        env: process.env,
      });

      const cfg = loadConfig();
      expect(disabled.walletId).toBe("solana-2");
      expect(disabled.migratedKeystores).toHaveLength(1);
      expect(disabled.remainingCustodyWallets).toBe("");
      expect(disabled.custodyStateRemoved).toBe(true);
      expect(cfg.env?.vars?.FASED_WALLET_CUSTODY_MODE).toBeUndefined();
      expect(cfg.env?.vars?.FASED_WALLET_CUSTODY_WALLETS).toBeUndefined();
      expect(cfg.env?.vars?.FASED_WALLET_PASSPHRASE_FILE).toBe(disabled.passphraseFile);
      await expect(fs.access(disabled.passphraseFile)).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects split-key custody init for Agent wallets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-custody-agent-"));
    const configPath = path.join(root, "fased.json");
    const stateDir = path.join(root, "state");
    const walletDir = path.join(stateDir, "wallet");
    await fs.mkdir(walletDir, { recursive: true });
    await fs.writeFile(configPath, "{}\n", "utf8");
    await writePasskeyState(walletDir);
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    vi.stubEnv("FASED_WALLET_APPROVAL_AUTH", "webauthn");
    vi.stubEnv("FASED_WALLET_PASSPHRASE", "test-passphrase");
    clearConfigCache();
    try {
      await walletSetupCommand({ log: () => {} } as never, {
        mode: "local-signer-create",
        chain: "solana",
        walletId: "agent-wallet",
        walletName: "Agent Wallet",
        rpcUrl: "https://rpc.example/agent",
        nonInteractive: true,
        noDoctor: true,
        force: true,
      });
      await walletRoleSetCommand({ log: () => {} } as never, {
        walletId: "agent-wallet",
        role: "agent",
        primary: true,
      });

      await expect(
        initializeWalletCustodyForWallet({
          walletId: "agent-wallet",
          env: process.env,
        }),
      ).rejects.toThrow("split-key wallet security can only be enabled for Vault wallets");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
