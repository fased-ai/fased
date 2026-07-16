import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import {
  configureWalletForOnboarding,
  installSignerdBinary,
  renderLocalSignerEnvFile,
  resolveLocalSignerWebAuthnConfig,
  shouldSyncLocalSocketSignerFromConfig,
  syncLocalSocketSignerFromConfig,
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

function createSignerReleaseFixture(root: string): {
  assetBody: string;
  assetName: string;
  releaseDir: string;
} {
  const releaseDir = path.join(root, "release");
  fs.mkdirSync(releaseDir, { recursive: true });
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const assetName = `fased-signerd-${platform}-${arch}`;
  const assetBody = "fixture signer binary\n";
  fs.writeFileSync(path.join(releaseDir, assetName), assetBody, { mode: 0o755 });
  const checksum = createHash("sha256").update(assetBody).digest("hex");
  fs.writeFileSync(
    path.join(releaseDir, "fased-signerd-checksums.txt"),
    `${checksum}  ${assetName}\n`,
  );
  return { assetBody, assetName, releaseDir };
}

describe("local signer env file helpers", () => {
  it("uses the same localhost WebAuthn identity on Linux, WSL2, and native macOS", () => {
    const cfg = { gateway: { port: 19876 } } as FasedAgentConfig;
    for (const env of [
      { HOME: "/home/linux" },
      { HOME: "/home/wsl", WSL_DISTRO_NAME: "Ubuntu" },
      { HOME: "/Users/macos" },
    ]) {
      expect(resolveLocalSignerWebAuthnConfig(cfg, env)).toEqual({
        rpId: "localhost",
        origins: "http://localhost:19876",
      });
    }
  });

  it("rejects partial, cross-origin, and shell-active local WebAuthn configuration", () => {
    expect(() =>
      resolveLocalSignerWebAuthnConfig(
        {},
        {
          FASED_WALLET_WEBAUTHN_RP_ID: "localhost",
        },
      ),
    ).toThrow(/requires both/);
    expect(() =>
      resolveLocalSignerWebAuthnConfig(
        {},
        {
          FASED_WALLET_WEBAUTHN_RP_ID: "localhost",
          FASED_WALLET_WEBAUTHN_ORIGINS: "https://attacker.example",
        },
      ),
    ).toThrow(/exactly match/);
    expect(() =>
      resolveLocalSignerWebAuthnConfig(
        {},
        {
          FASED_WALLET_WEBAUTHN_RP_ID: "localhost$(touch /tmp/unsafe)",
          FASED_WALLET_WEBAUTHN_ORIGINS: "http://localhost:18789",
        },
      ),
    ).toThrow(/valid exact hostname/);
  });

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

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "installs a checksum-verified signer asset without Go from an arbitrary cwd",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-onboarding-wallet-signer-"));
      tempDirs.push(root);
      const binPath = path.join(root, "bin", "fased-signerd");
      const { assetBody, releaseDir } = createSignerReleaseFixture(root);
      vi.stubEnv("HOME", root);
      vi.stubEnv("FASED_WALLET_LOCAL_SIGNER_BIN", binPath);
      vi.stubEnv("FASED_SKIP_NATIVE_SIGNER_BUILD", "1");
      vi.stubEnv("FASED_LOCAL_SIGNER_BASE_URL", `file://${releaseDir}`);
      vi.stubEnv("FASED_LOCAL_SIGNER_VERSION", "");
      vi.stubEnv("FASED_LOCAL_SIGNER_LATEST_TAG", "");

      const originalCwd = process.cwd();
      process.chdir(root);
      try {
        installSignerdBinary(binPath);
      } finally {
        process.chdir(originalCwd);
      }

      expect(fs.readFileSync(binPath, "utf8")).toBe(assetBody);
      expect(fs.statSync(binPath).mode & 0o111).not.toBe(0);
    },
  );

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "rejects a signer asset when its published checksum does not match",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-onboarding-wallet-checksum-"));
      tempDirs.push(root);
      const binPath = path.join(root, "bin", "fased-signerd");
      const { assetName, releaseDir } = createSignerReleaseFixture(root);
      fs.writeFileSync(
        path.join(releaseDir, "fased-signerd-checksums.txt"),
        `${"0".repeat(64)}  ${assetName}\n`,
      );
      vi.stubEnv("HOME", root);
      vi.stubEnv("FASED_WALLET_LOCAL_SIGNER_BIN", binPath);
      vi.stubEnv("FASED_SKIP_NATIVE_SIGNER_BUILD", "1");
      vi.stubEnv("FASED_LOCAL_SIGNER_BASE_URL", `file://${releaseDir}`);
      vi.stubEnv("FASED_LOCAL_SIGNER_VERSION", "");
      vi.stubEnv("FASED_LOCAL_SIGNER_LATEST_TAG", "");

      expect(() => installSignerdBinary(binPath)).toThrow(/Checksum mismatch/);
      expect(fs.existsSync(binPath)).toBe(false);
    },
  );

  it("reports an automatic asset failure without claiming Go is required", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-onboarding-wallet-signer-"));
    tempDirs.push(root);
    const binPath = path.join(root, "bin", "fased-signerd");
    const socketPath = path.join(root, "wallet", "local-signer.sock");
    vi.stubEnv("HOME", root);
    vi.stubEnv("FASED_STATE_DIR", root);
    vi.stubEnv("FASED_CONFIG_DIR", root);
    vi.stubEnv("FASED_WALLET_LOCAL_SIGNER_BIN", binPath);
    vi.stubEnv("FASED_WALLET_LOCAL_SIGNER_SOCKET", socketPath);
    vi.stubEnv("FASED_SKIP_NATIVE_SIGNER_BUILD", "1");
    vi.stubEnv("FASED_LOCAL_SIGNER_BASE_URL", `file://${path.join(root, "missing-release")}`);
    vi.stubEnv("FASED_LOCAL_SIGNER_VERSION", "");
    vi.stubEnv("FASED_LOCAL_SIGNER_LATEST_TAG", "");

    const cfg: FasedAgentConfig = {
      env: {
        vars: {
          FASED_WALLET_LOCAL_SIGNER_SOCKET: socketPath,
          FASED_WALLET_PASSPHRASE: "test-passphrase",
        },
      },
      wallet: {
        provider: { id: "local-socket-signer" },
        runtime: { enabled: true },
      },
    };

    await expect(
      syncLocalSocketSignerFromConfig({
        config: cfg,
        env: process.env,
        restart: false,
      }),
    ).rejects.toThrow(/Go is not required/);
    expect(fs.existsSync(binPath)).toBe(false);
  });

  it("never installs or brokers a signer from Hosting QuickStart", async () => {
    vi.stubEnv("FASED_WALLET_LOCAL_SIGNER_SOCKET", "/run/fased-signerd/app.sock");
    vi.stubEnv("FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET", "/run/fased-signerd/app.sock");
    const prepareLocalSigner = vi.fn();
    const signerProgressStop = vi.fn();
    const prompter = createPrompterStub();
    vi.mocked(prompter.progress).mockReturnValue({
      stop: signerProgressStop,
      update: vi.fn(),
    });

    await expect(
      configureWalletForOnboarding({
        flow: "quickstart",
        forceEnable: true,
        hostProfile: "hosting",
        nextConfig: {},
        prepareLocalSigner,
        prompter,
      }),
    ).rejects.toThrow(
      /root-managed hosted wallet signer is unavailable|root-managed hosted signer/i,
    );

    expect(prepareLocalSigner).not.toHaveBeenCalled();
    expect(prompter.multiselect).not.toHaveBeenCalled();
    expect(prompter.note).not.toHaveBeenCalled();
    expect(prompter.progress).not.toHaveBeenCalled();
    expect(signerProgressStop).not.toHaveBeenCalled();
  });

  it("renders signer-v2 runtime env without legacy key or custody state", () => {
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
          FASED_WALLET_SOLANA_WRITE_RPC_FALLBACK_URL__WALLET_1: "https://rpc-backup.example/solana",
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
    expect(content).not.toMatch(/FASED_WALLET_PASSPHRASE/);
    expect(content).not.toMatch(/FASED_WALLET_SOLANA_KEYSTORE_PATH/);
    expect(content).not.toContain("https://rpc.example/solana");
    expect(content).not.toContain("https://rpc-backup.example/solana");
    expect(content).toContain('export FASED_WALLET_WEBAUTHN_RP_ID="localhost"');
    expect(content).toContain('export FASED_WALLET_WEBAUTHN_ORIGINS="http://localhost:18789"');
    expect(content).not.toMatch(/FASED_WALLET_CUSTODY_/);
    expect(content).not.toMatch(/FASED_WALLET_LOCAL_SIGNER_DIRECT_SIGNING/);
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
    const signerEnv = fs.readFileSync(signerEnvPath, "utf8");
    expect(signerEnv).toContain('export FASED_WALLET_CHAINS="solana"');
    expect(signerEnv).toContain("FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET");
    expect(signerEnv).toContain("FASED_WALLET_LOCAL_SIGNER_STATE_DB");
    expect(signerEnv).toContain("FASED_WALLET_LOCAL_SIGNER_MASTER_KEY");
    expect(signerEnv).toContain('FASED_WALLET_WEBAUTHN_RP_ID="localhost"');
    expect(signerEnv).toContain('FASED_WALLET_WEBAUTHN_ORIGINS="http://localhost:18789"');
    expect(signerEnv).not.toMatch(/FASED_WALLET_PASSPHRASE|KEYSTORE/);
  });

  it("does not leak an existing managed passphrase into signer-v2 env", () => {
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
    expect(signerEnv).not.toContain(passphraseFile);
    expect(signerEnv).not.toMatch(/FASED_WALLET_PASSPHRASE/);
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

  it("ignores all stale Node keystore env for signer-v2", () => {
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

    expect(content).not.toMatch(/FASED_WALLET_SOLANA_KEYSTORE_PATH/);
  });

  it("does not reconstruct legacy keys or policies from registry files", () => {
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

    expect(content).not.toMatch(/FASED_WALLET_SOLANA_KEYSTORE_PATH/);
    expect(content).not.toMatch(/FASED_WALLET_LOCAL_SIGNER_(ROLE|DIRECT_SIGNING|CAPS_ENABLED)/);
  });
});
