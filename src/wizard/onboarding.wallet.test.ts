import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import {
  configureWalletForOnboarding,
  renderLocalSignerEnvFile,
  shouldSyncLocalSocketSignerFromConfig,
  writeLocalSignerEnvFile,
} from "./onboarding.wallet.js";
import type { WizardPrompter } from "./prompts.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createPrompterStub(): WizardPrompter {
  return {
    confirm: vi.fn(),
    multiselect: vi.fn(),
    note: vi.fn(),
    progress: vi.fn(() => ({
      update: vi.fn(),
      stop: vi.fn(),
    })),
    select: vi.fn(),
    text: vi.fn(),
  } as unknown as WizardPrompter;
}

describe("local signer env file helpers", () => {
  it("keeps fresh quickstart wallet disabled so installer does not require signerd assets", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-onboarding-wallet-fresh-"));
    tempDirs.push(root);
    vi.stubEnv("HOME", root);
    vi.stubEnv("FASED_STATE_DIR", root);
    vi.stubEnv("FASED_CONFIG_DIR", root);

    const next = await configureWalletForOnboarding({
      flow: "quickstart",
      nextConfig: {},
      prompter: createPrompterStub(),
    });

    expect(next.wallet?.runtime?.enabled).toBe(false);
    expect(next.wallet?.provider?.id).toBeUndefined();
    expect(next.env?.vars?.FASED_WALLET_LOCAL_SIGNER_SOCKET).toBeUndefined();
  });

  it("cleans stale local signer socket config when quickstart has no wallet material", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-onboarding-wallet-stale-"));
    tempDirs.push(root);
    vi.stubEnv("HOME", root);
    vi.stubEnv("FASED_STATE_DIR", root);
    vi.stubEnv("FASED_CONFIG_DIR", root);
    vi.stubEnv("FASED_WALLET_LOCAL_SIGNER_SOCKET", path.join(root, "wallet", "local-signer.sock"));

    const next = await configureWalletForOnboarding({
      flow: "quickstart",
      nextConfig: {
        env: {
          vars: {
            FASED_WALLET_LOCAL_SIGNER_SOCKET: path.join(root, "wallet", "local-signer.sock"),
          },
        },
        wallet: {
          provider: { id: "local-socket-signer" },
          runtime: { enabled: true },
        },
      },
      prompter: createPrompterStub(),
    });

    expect(next.wallet?.runtime?.enabled).toBe(false);
    expect(next.env?.vars?.FASED_WALLET_LOCAL_SIGNER_SOCKET).toBeUndefined();
    expect(process.env.FASED_WALLET_LOCAL_SIGNER_SOCKET).toBeUndefined();
  });

  it("renders named-wallet signer env from config state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-onboarding-wallet-env-"));
    tempDirs.push(root);
    const cfg: FasedAgentConfig = {
      env: {
        vars: {
          FASED_WALLET_LOCAL_SIGNER_SOCKET: path.join(root, "wallet", "local-signer.sock"),
          FASED_WALLET_SOLANA_KEYSTORE_PATH__WALLET_1: path.join(
            root,
            "wallet",
            "keystore-solana-wallet-1.v1.enc",
          ),
          FASED_WALLET_SOLANA_RPC_URL__WALLET_1: "https://rpc.example/solana",
          FASED_WALLET_CUSTODY_MODE: "split-key",
          FASED_WALLET_CUSTODY_WALLETS: "wallet_1",
          FASED_WALLET_CUSTODY_PASSKEY_CEREMONY: "1",
          FASED_WALLET_CUSTODY_EPHEMERAL_RECONSTRUCTION: "1",
          FASED_WALLET_CUSTODY_PHASE2_COMPLETE: "1",
        },
      },
      wallet: {
        provider: { id: "local-socket-signer" },
        execution: { mode: "manual" },
        runtime: {
          enabled: true,
          mode: "external",
          runtime: "external-custom",
          external: { kind: "custom" },
          chains: ["solana"],
          service: { host: "127.0.0.1", port: 19444 },
          policy: {
            directSigning: true,
            solana: { allowPrograms: [], maxPerTx: "1", maxDaily: "2" },
          },
          toolAccess: { mode: "owner-only", allowAgents: [] },
        },
      },
    };

    const content = renderLocalSignerEnvFile({
      config: cfg,
      env: {
        HOME: root,
        FASED_STATE_DIR: root,
        FASED_WALLET_PASSPHRASE: "test-passphrase",
      } as NodeJS.ProcessEnv,
    });

    expect(content).toContain(
      `export FASED_WALLET_LOCAL_SIGNER_SOCKET="${path.join(root, "wallet", "local-signer.sock")}"`,
    );
    expect(content).toContain('export FASED_WALLET_CHAINS="solana"');
    expect(content).toContain('export FASED_WALLET_PASSPHRASE="test-passphrase"');
    expect(content).toContain(
      `export FASED_WALLET_SOLANA_KEYSTORE_PATH__WALLET_1="${path.join(root, "wallet", "keystore-solana-wallet-1.v1.enc")}"`,
    );
    expect(content).not.toContain("export FASED_WALLET_SOLANA_KEYSTORE_PATH=");
    expect(content).toContain(
      'export FASED_WALLET_SOLANA_RPC_URL__WALLET_1="https://rpc.example/solana"',
    );
    expect(content).toContain('export FASED_WALLET_CUSTODY_MODE="split-key"');
    expect(content).toContain('export FASED_WALLET_CUSTODY_WALLETS="wallet_1"');
    expect(content).toContain('export FASED_WALLET_CUSTODY_PASSKEY_CEREMONY="1"');
  });

  it("writes signer.env with restrictive permissions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-onboarding-wallet-write-"));
    tempDirs.push(root);
    const cfg: FasedAgentConfig = {
      env: {
        vars: {
          FASED_WALLET_LOCAL_SIGNER_SOCKET: path.join(root, "wallet", "local-signer.sock"),
        },
      },
      wallet: {
        provider: { id: "local-socket-signer" },
        execution: { mode: "manual" },
        runtime: {
          enabled: true,
          mode: "external",
          runtime: "external-custom",
          external: { kind: "custom" },
          chains: ["solana"],
          service: { host: "127.0.0.1", port: 19444 },
          policy: {
            directSigning: true,
            solana: { allowPrograms: [], maxPerTx: "1", maxDaily: "2" },
          },
          toolAccess: { mode: "owner-only", allowAgents: [] },
        },
      },
    };

    const signerEnvPath = writeLocalSignerEnvFile({
      config: cfg,
      env: {
        HOME: root,
        FASED_STATE_DIR: root,
        FASED_WALLET_PASSPHRASE: "test-passphrase",
      } as NodeJS.ProcessEnv,
    });
    const stat = fs.statSync(signerEnvPath);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(signerEnvPath, "utf8")).toContain('export FASED_WALLET_CHAINS="solana"');
    expect(fs.readFileSync(signerEnvPath, "utf8")).toContain(
      'export FASED_WALLET_PASSPHRASE="test-passphrase"',
    );
  });

  it("writes signer.env with the managed passphrase file when one exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-onboarding-wallet-passphrase-file-"));
    tempDirs.push(root);
    const walletDir = path.join(root, "wallet");
    const passphraseFile = path.join(walletDir, "passphrase");
    fs.mkdirSync(walletDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(passphraseFile, "correct-file-passphrase\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    const cfg: FasedAgentConfig = {
      env: {
        vars: {
          FASED_WALLET_LOCAL_SIGNER_SOCKET: path.join(walletDir, "local-signer.sock"),
        },
      },
      wallet: {
        provider: { id: "local-socket-signer" },
        runtime: {
          enabled: true,
          mode: "external",
          runtime: "external-custom",
          external: { kind: "custom" },
          chains: ["solana"],
        },
      },
    };

    const signerEnvPath = writeLocalSignerEnvFile({
      config: cfg,
      env: {
        HOME: root,
        FASED_STATE_DIR: root,
        FASED_WALLET_PASSPHRASE: "stale-env-passphrase",
      } as NodeJS.ProcessEnv,
    });
    const signerEnv = fs.readFileSync(signerEnvPath, "utf8");
    expect(signerEnv).toContain(`export FASED_WALLET_PASSPHRASE_FILE="${passphraseFile}"`);
    expect(signerEnv).not.toContain("stale-env-passphrase");
  });

  it("still syncs signer env when provider config is stale but self-hosted signer env exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-onboarding-wallet-sync-"));
    tempDirs.push(root);
    const cfg: FasedAgentConfig = {
      env: {
        vars: {
          FASED_WALLET_LOCAL_SIGNER_SOCKET: path.join(root, "wallet", "local-signer.sock"),
          FASED_WALLET_SOLANA_KEYSTORE_PATH__WALLET_1: path.join(
            root,
            "wallet",
            "keystore-solana-wallet-1.v1.enc",
          ),
        },
      },
      wallet: {
        provider: { id: "embedded-keystore" },
      },
    };

    expect(
      shouldSyncLocalSocketSignerFromConfig({
        config: cfg,
        env: { HOME: root, FASED_STATE_DIR: root } as NodeJS.ProcessEnv,
      }),
    ).toBe(true);
  });

  it("ignores stale generic keystore env when named-wallet scoped signer material exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-onboarding-wallet-scoped-"));
    tempDirs.push(root);
    const cfg: FasedAgentConfig = {
      env: {
        vars: {
          FASED_WALLET_LOCAL_SIGNER_SOCKET: path.join(root, "wallet", "local-signer.sock"),
          FASED_WALLET_SOLANA_KEYSTORE_PATH: path.join(root, "wallet", "keystore-solana.v1.enc"),
          FASED_WALLET_SOLANA_KEYSTORE_PATH__WALLET_1: path.join(
            root,
            "wallet",
            "keystore-solana-wallet-1.v1.enc",
          ),
        },
      },
      wallet: {
        provider: { id: "embedded-keystore" },
      },
    };

    const content = renderLocalSignerEnvFile({
      config: cfg,
      env: { HOME: root, FASED_STATE_DIR: root } as NodeJS.ProcessEnv,
    });

    expect(content).toContain(
      `export FASED_WALLET_SOLANA_KEYSTORE_PATH__WALLET_1="${path.join(root, "wallet", "keystore-solana-wallet-1.v1.enc")}"`,
    );
    expect(content).not.toContain(
      `export FASED_WALLET_SOLANA_KEYSTORE_PATH="${path.join(root, "wallet", "keystore-solana.v1.enc")}"`,
    );
    expect(content).not.toContain("export FASED_WALLET_SOLANA_KEYSTORE_PATH=");
  });

  it("reconstructs scoped signer env from registry and named keystore files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-onboarding-wallet-registry-"));
    tempDirs.push(root);
    const walletDir = path.join(root, "wallet");
    fs.mkdirSync(walletDir, { recursive: true });
    fs.writeFileSync(
      path.join(walletDir, "provider-registry.v1.json"),
      JSON.stringify(
        {
          version: 1,
          providers: {
            "embedded-keystore": { enabled: true, updatedAt: "2026-04-05T00:00:00.000Z" },
            "local-socket-signer": { enabled: true, updatedAt: "2026-04-05T00:00:00.000Z" },
            alchemy: { enabled: false, updatedAt: "2026-04-05T00:00:00.000Z" },
            turnkey: { enabled: false, updatedAt: "2026-04-05T00:00:00.000Z" },
            privy: { enabled: false, updatedAt: "2026-04-05T00:00:00.000Z" },
          },
          wallets: [
            {
              id: "wallet-1",
              name: "Wallet 1",
              providerId: "local-socket-signer",
              addresses: { solana: "3P2TQ3EDdummy" },
              createdAt: "2026-04-05T00:00:00.000Z",
              updatedAt: "2026-04-05T00:00:00.000Z",
            },
          ],
          assignments: {},
          defaultWalletId: "wallet-1",
          updatedAt: "2026-04-05T00:00:00.000Z",
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(path.join(walletDir, "keystore-solana-wallet-1.v1.enc"), "{}", "utf8");
    const cfg: FasedAgentConfig = {
      env: {
        vars: {
          FASED_WALLET_LOCAL_SIGNER_SOCKET: path.join(walletDir, "local-signer.sock"),
        },
      },
      wallet: {
        provider: { id: "local-socket-signer" },
      },
    };

    const content = renderLocalSignerEnvFile({
      config: cfg,
      env: { HOME: root, FASED_STATE_DIR: root } as NodeJS.ProcessEnv,
    });

    expect(content).toContain(
      `export FASED_WALLET_SOLANA_KEYSTORE_PATH__WALLET_1="${path.join(walletDir, "keystore-solana-wallet-1.v1.enc")}"`,
    );
    expect(content).not.toContain(
      `export FASED_WALLET_SOLANA_KEYSTORE_PATH="${path.join(walletDir, "keystore-solana.v1.enc")}"`,
    );
  });
});
