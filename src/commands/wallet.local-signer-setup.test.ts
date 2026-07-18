import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, loadConfig } from "../config/config.js";
import type { SignerNetworkSummary } from "../wallet/signer-network-admin.js";
import {
  readWalletProviderRegistry,
  upsertNamedWallet,
} from "../wallet/wallet-provider-registry.js";
import {
  walletLegacyMigrationFinalizeCommand,
  walletRotateKeysCommand,
  walletSetupCommand,
} from "./wallet.js";

vi.mock("../wallet/providers/turnkey-adapter.js", () => ({
  TurnkeyAdapter: class {
    readonly id = "turnkey";
  },
}));

const signerMocks = vi.hoisted(() => ({
  create: vi.fn(async (params: { walletId: string; role: string }) => {
    const signerWalletId =
      params.walletId
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "default";
    return {
      wallet: {
        walletId: signerWalletId,
        publicKey: "11111111111111111111111111111111",
        version: 1,
        createdAt: "2026-07-16T12:00:00.000Z",
      },
      policy: {
        walletId: signerWalletId,
        role: params.role,
        version: 1,
        operations: [],
        programs: [],
        assets: [],
        hash: `sha256:${"a".repeat(64)}`,
      },
    };
  }),
  install: vi.fn(),
  restart: vi.fn(async () => undefined),
  networkPut: vi.fn(
    (): SignerNetworkSummary => ({
      walletId: "agent",
      configured: true,
      version: 1,
      hash: `hmac-sha256:${"b".repeat(64)}`,
      ready: true,
    }),
  ),
  socketCall: vi.fn(),
}));

vi.mock("../wallet/local-socket-signer-lifecycle.js", () => ({
  createLockedSignerOwnedWallet: signerMocks.create,
}));

vi.mock("../wallet/signer-network-admin.js", () => ({
  configureSignerOwnedWalletNetwork: signerMocks.networkPut,
}));

vi.mock("../wallet/providers/local-socket-signer-adapter.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../wallet/providers/local-socket-signer-adapter.js")>();
  return {
    ...actual,
    callLocalSocketSigner: signerMocks.socketCall,
    requireLocalSocketSignerPath: () => "/tmp/fased-signerd-app-test.sock",
  };
});

vi.mock("../wizard/onboarding.wallet.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wizard/onboarding.wallet.js")>();
  return {
    ...actual,
    installSignerdBinary: signerMocks.install,
    restartLocalSocketSigner: signerMocks.restart,
    resolveSignerdBinaryPath: () => "/tmp/fased-signerd-test",
  };
});

const WALLET_ENV_KEYS = [
  "FASED_WALLET_PROVIDER",
  "FASED_WALLET_KEYSTORE_PATH",
  "FASED_WALLET_PASSPHRASE",
  "FASED_WALLET_PASSPHRASE_FILE",
  "FASED_WALLET_PRIVATE_KEY",
  "FASED_WALLET_SOLANA_KEYSTORE_PATH",
  "FASED_WALLET_LOCAL_SIGNER_SOCKET",
  "FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET",
  "FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET",
  "FASED_WALLET_LOCAL_SIGNER_STATE_DB",
  "FASED_WALLET_LOCAL_SIGNER_MASTER_KEY",
  "FASED_HOST_PROFILE",
  "FASED_HOST_ROOT_PREPARED",
] as const;

describe("walletSetupCommand native signer boundary", () => {
  beforeEach(() => {
    for (const key of WALLET_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    clearConfigCache();
    signerMocks.create.mockClear();
    signerMocks.install.mockClear();
    signerMocks.restart.mockClear();
    signerMocks.networkPut.mockClear();
    signerMocks.socketCall.mockReset();
    vi.unstubAllEnvs();
  });

  it("creates fresh local wallets inside Go without creating a Node keystore", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-native-create-"));
    const configPath = path.join(root, "fased.json");
    const stateDir = path.join(root, "state");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    clearConfigCache();

    try {
      const logs: string[] = [];
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
      expect(signerEnv).toContain(
        'FASED_WALLET_WEBAUTHN_ORIGINS="http://localhost:18789,http://localhost:18791"',
      );
      expect(signerMocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ walletId: "solana-1", role: "agent" }),
      );
      expect(signerMocks.networkPut).toHaveBeenCalledWith(
        expect.objectContaining({
          walletId: "solana_1",
          primaryRpcUrl: "https://rpc.example/solana",
        }),
      );
      expect(
        readWalletProviderRegistry(process.env).wallets.find((wallet) => wallet.id === "solana-1")
          ?.metadata?.signerWalletId,
      ).toBe("solana_1");
      expect(logs.join("\n")).toContain("SOLANA address:");
      expect(logs.join("\n")).toContain("Signer wallet ID: solana_1");
      expect(logs.join("\n")).not.toMatch(/PRIVATE KEY|PASSPHRASE|SEED/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("creates a fail-closed hosted wallet without any app-visible root channel", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-hosted-signer-create-"));
    const configPath = path.join(root, "fased.json");
    const stateDir = path.join(root, "state");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    vi.stubEnv("FASED_HOST_PROFILE", "hosting");
    vi.stubEnv("FASED_HOST_ROOT_PREPARED", "1");
    vi.stubEnv("FASED_WALLET_LOCAL_SIGNER_SOCKET", "/run/fased-signerd/app.sock");
    signerMocks.networkPut.mockReturnValueOnce({
      walletId: "agent",
      configured: false,
      version: 0,
      ready: false,
      rootAdminRequired: true,
      rootCommand:
        "/usr/local/sbin/fased-signer-network --wallet-id agent --network-file /root/fased-network.json",
    });
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
      const hostedWallet = readWalletProviderRegistry(process.env).wallets.find(
        (wallet) => wallet.id === "agent",
      );
      expect(hostedWallet?.metadata?.networkReady).toBe(false);
      expect(hostedWallet?.metadata?.policyState).toBe("locked");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("persists and reports the canonical signer wallet ID separately from the friendly ID", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-native-id-"));
    const configPath = path.join(root, "fased.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", path.join(root, "state"));
    clearConfigCache();

    try {
      const logs: string[] = [];
      await walletSetupCommand({ log: (line: string) => logs.push(line) } as never, {
        mode: "local-signer-create",
        chain: "solana",
        walletId: "Agent-Primary",
        walletName: "Primary Agent",
        role: "agent",
        rpcUrl: "https://rpc.example/solana",
        nonInteractive: true,
        noDoctor: true,
        noSignerHints: true,
        json: true,
      });

      const payload = JSON.parse(logs.find((line) => line.trim().startsWith("{")) ?? "{}") as {
        walletId?: string;
        signerWalletId?: string;
      };
      expect(payload.walletId).toBe("Agent-Primary");
      expect(payload.signerWalletId).toBe("agent_primary");
      expect(
        readWalletProviderRegistry(process.env).wallets.find(
          (wallet) => wallet.id === "Agent-Primary",
        )?.metadata?.signerWalletId,
      ).toBe("agent_primary");
      expect(signerMocks.networkPut).toHaveBeenCalledWith(
        expect.objectContaining({ walletId: "agent_primary" }),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects friendly IDs that collide with an existing canonical signer wallet ID before creation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-native-id-collision-"));
    const configPath = path.join(root, "fased.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", path.join(root, "state"));
    clearConfigCache();

    try {
      upsertNamedWallet({
        walletId: "existing-agent",
        name: "Existing Agent",
        providerId: "local-socket-signer",
        addresses: { solana: "11111111111111111111111111111111" },
        metadata: { signerWalletId: "agent_primary" },
        env: process.env,
      });

      await expect(
        walletSetupCommand({ log: vi.fn() } as never, {
          mode: "local-signer-create",
          chain: "solana",
          walletId: "Agent-Primary",
          role: "agent",
          rpcUrl: "https://rpc.example/solana",
          nonInteractive: true,
          noDoctor: true,
          noSignerHints: true,
        }),
      ).rejects.toThrow(/agent_primary is already registered as existing-agent/i);
      expect(signerMocks.create).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("routes imports exclusively to the native signer CLI without mutating config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-native-import-"));
    const configPath = path.join(root, "fased.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", path.join(root, "state"));
    clearConfigCache();

    try {
      const log = vi.fn();
      await walletSetupCommand({ log } as never, {
        mode: "local-signer-import",
        chain: "solana",
        walletId: "mining",
        nonInteractive: true,
        noDoctor: true,
      });
      expect(log.mock.calls.flat().join("\n")).toMatch(/admin wallet import --control-socket/i);
      expect(log.mock.calls.flat().join("\n")).toMatch(/import-legacy/iu);
      expect(log.mock.calls.flat().join("\n")).toMatch(/--wallet-id mining --locked-role mining/iu);
      expect(log.mock.calls.flat().join("\n")).toMatch(/finalize-legacy-migration/iu);
      await expect(fs.readFile(configPath, "utf8")).resolves.toBe("{}\n");
      expect(signerMocks.create).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps retired embedded setup modes fail closed with one-way migration guidance", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-legacy-setup-"));
    const configPath = path.join(root, "fased.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", path.join(root, "state"));
    clearConfigCache();

    try {
      await expect(
        walletSetupCommand({ log: vi.fn() } as never, {
          mode: "embedded-import",
          chain: "solana",
          nonInteractive: true,
        }),
      ).rejects.toThrow(/fased-signerd admin wallet import-legacy/i);
      expect(signerMocks.create).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes Gateway key rotation and points to signer-owned re-encryption", async () => {
    await expect(walletRotateKeysCommand({ log: vi.fn() } as never)).rejects.toThrow(
      /fased-signerd admin wallet reencrypt --control-socket/i,
    );
  });

  it("finalizes a native legacy import only after verifying the protocol-v2 public key", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-native-finalize-"));
    const configPath = path.join(root, "fased.json");
    const stateDir = path.join(root, "state");
    const walletStateDir = path.join(stateDir, "wallet");
    const legacyPath = path.join(root, "legacy-wallet.enc");
    const publicKey = "11111111111111111111111111111111";
    await fs.mkdir(walletStateDir, { recursive: true });
    await fs.writeFile(legacyPath, "legacy-ciphertext", { mode: 0o600 });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          env: {
            vars: {
              FASED_WALLET_LOCAL_SIGNER_SOCKET: "/tmp/fased-signerd-app-test.sock",
              FASED_WALLET_SOLANA_KEYSTORE_PATH__AGENT: legacyPath,
              FASED_UNRELATED_SETTING: "keep-me",
            },
          },
          wallet: {
            provider: { id: "embedded-keystore" },
            keystore: { enabled: true, path: legacyPath },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(walletStateDir, "provider-registry.v1.json"),
      `${JSON.stringify(
        {
          version: 1,
          providers: {
            "embedded-keystore": { enabled: true, updatedAt: "2026-07-16T12:00:00.000Z" },
          },
          wallets: [
            {
              id: "agent",
              name: "Agent",
              providerId: "embedded-keystore",
              addresses: { solana: publicKey },
              metadata: { purpose: "agent" },
              createdAt: "2026-07-16T12:00:00.000Z",
              updatedAt: "2026-07-16T12:00:00.000Z",
            },
          ],
          assignments: {},
          defaultWalletId: "agent",
          updatedAt: "2026-07-16T12:00:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    clearConfigCache();
    signerMocks.socketCall.mockImplementation(async (_socket: string, request: { op?: string }) => {
      if (request.op === "v2.capabilities") {
        return {
          ready: true,
          capabilities: { protocol: { current: 2 }, features: ["signerOwnedKeys"] },
        };
      }
      if (request.op === "v2.wallet.get") {
        return { walletId: "agent", publicKey };
      }
      throw new Error(`unexpected signer op ${request.op}`);
    });

    try {
      await walletLegacyMigrationFinalizeCommand({ log: vi.fn() } as never, {
        walletId: "agent",
      });

      const registry = readWalletProviderRegistry(process.env);
      expect(registry.wallets).toContainEqual(
        expect.objectContaining({
          id: "agent",
          providerId: "local-socket-signer",
          addresses: { solana: publicKey },
          metadata: expect.objectContaining({ signerWalletId: "agent" }),
        }),
      );
      expect(registry.providers["embedded-keystore"]?.enabled).toBe(false);
      expect(registry.providers["local-socket-signer"]?.enabled).toBe(true);
      const cfg = loadConfig();
      expect(cfg.wallet?.provider?.id).toBe("local-socket-signer");
      expect(cfg.wallet?.keystore).toBeUndefined();
      expect(cfg.env?.vars?.FASED_WALLET_SOLANA_KEYSTORE_PATH__AGENT).toBeUndefined();
      expect(cfg.env?.vars?.FASED_UNRELATED_SETTING).toBe("keep-me");
      await expect(fs.readFile(legacyPath, "utf8")).resolves.toBe("legacy-ciphertext");
      expect(signerMocks.socketCall.mock.calls.map((call) => call[1]?.op)).toEqual([
        "v2.capabilities",
        "v2.wallet.get",
      ]);

      upsertNamedWallet({
        walletId: "conflicting-friendly-id",
        name: "Collision",
        providerId: "local-socket-signer",
        addresses: { solana: publicKey },
        metadata: { signerWalletId: "agent" },
        env: process.env,
      });
      await expect(
        walletLegacyMigrationFinalizeCommand({ log: vi.fn() } as never, {
          walletId: "agent",
        }),
      ).rejects.toThrow(/already registered as conflicting-friendly-id/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
