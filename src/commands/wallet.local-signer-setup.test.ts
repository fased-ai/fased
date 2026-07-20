import fsSync from "node:fs";
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
  walletPolicyActivateRoleBaselineCommand,
  walletRecoveryExportCommand,
  walletRecoveryImportCommand,
  walletRawExportCommand,
  walletRotateKeysCommand,
  walletSetupCommand,
} from "./wallet.js";

vi.mock("../wallet/providers/turnkey-adapter.js", () => ({
  TurnkeyAdapter: class {
    readonly id = "turnkey";
  },
}));

const signerMocks = vi.hoisted(() => ({
  roles: new Map<string, string>(),
  policyHashes: new Map<string, string>(),
  create: vi.fn(async (params: { walletId: string; role: string }) => {
    const signerWalletId =
      params.walletId
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "default";
    signerMocks.roles.set(signerWalletId, params.role);
    signerMocks.policyHashes.set(signerWalletId, `sha256:${"a".repeat(64)}`);
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
        baselineVersion: 1,
        operations: ["solana.nativeTransfer"],
        programs: ["11111111111111111111111111111111"],
        assets: [
          {
            asset: "solana:native",
            destinations: ["11111111111111111111111111111111"],
            maxPerTx: "1000000000",
            maxDaily: "5000000000",
            reviewedDestinations: true,
          },
        ],
        hash: `sha256:${"a".repeat(64)}`,
      },
    };
  }),
  install: vi.fn(),
  restart: vi.fn(async () => undefined),
  readiness: vi.fn(async (params: { walletId: string }) => ({
    walletId: params.walletId,
    publicKey: "11111111111111111111111111111111",
    role: signerMocks.roles.get(params.walletId) ?? "agent",
    baselineVersion: 1,
    policyVersion: 1,
    policyHash: signerMocks.policyHashes.get(params.walletId) ?? `sha256:${"d".repeat(64)}`,
    networkVersion: 1,
    networkHash: `hmac-sha256:${"b".repeat(64)}`,
    keyReady: true,
    policyReady: true,
    networkReady: true,
    operationLane: "agent-reviewed-and-autonomous",
    ready: true,
  })),
  read: vi.fn(async (params: { walletId: string }) => ({
    wallet: {
      walletId: params.walletId,
      publicKey: "11111111111111111111111111111111",
      version: 1,
      createdAt: "2026-07-16T12:00:00.000Z",
    },
    policy: {
      walletId: params.walletId,
      role: signerMocks.roles.get(params.walletId) ?? "agent",
      version: 1,
      baselineVersion: 0,
      operations: [],
      programs: [],
      assets: [],
      hash: `sha256:${"e".repeat(64)}`,
    },
  })),
  activate: vi.fn(async (params: { walletId: string; role: string }) => {
    signerMocks.policyHashes.set(params.walletId, `sha256:${"f".repeat(64)}`);
    return {
      walletId: params.walletId,
      role: params.role,
      version: 2,
      baselineVersion: 1,
      operations: ["solana.nativeTransfer"],
      programs: ["11111111111111111111111111111111"],
      assets: [
        {
          asset: "solana:native",
          destinations: ["11111111111111111111111111111111"],
          maxPerTx: "1000000000",
          maxDaily: "5000000000",
          reviewedDestinations: true,
        },
      ],
      hash: `sha256:${"f".repeat(64)}`,
    };
  }),
  networkPut: vi.fn(
    (params?: Record<string, unknown>): SignerNetworkSummary => ({
      walletId: typeof params?.walletId === "string" ? params.walletId : "agent",
      configured: true,
      version: 1,
      hash: `hmac-sha256:${"b".repeat(64)}`,
      ready: true,
    }),
  ),
  importProcess: vi.fn((_command: string, args: string[]) => {
    const walletId = args[args.indexOf("--wallet-id") + 1] || "mining";
    if (args.includes("network") && args.includes("set-primary")) {
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({
          walletId,
          configured: true,
          version: 1,
          hash: `hmac-sha256:${"b".repeat(64)}`,
          ready: true,
        }),
        stderr: "",
        pid: 1,
        output: [],
      };
    }
    if (args.includes("wallet") && args.includes("readiness")) {
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({
          walletId,
          publicKey: "11111111111111111111111111111111",
          role: signerMocks.roles.get(walletId) ?? "agent",
          baselineVersion: 1,
          policyVersion: 1,
          policyHash: signerMocks.policyHashes.get(walletId) ?? `sha256:${"d".repeat(64)}`,
          networkVersion: 1,
          networkHash: `hmac-sha256:${"b".repeat(64)}`,
          keyReady: true,
          policyReady: true,
          networkReady: true,
          operationLane: "agent-reviewed-and-autonomous",
          ready: true,
        }),
        stderr: "",
        pid: 1,
        output: [],
      };
    }
    const role = args[args.indexOf("--baseline-role") + 1] || "mining";
    signerMocks.roles.set(walletId, role);
    signerMocks.policyHashes.set(walletId, `sha256:${"d".repeat(64)}`);
    return {
      status: 0,
      signal: null,
      stdout: JSON.stringify({
        wallet: {
          walletId,
          publicKey: "11111111111111111111111111111111",
          version: 1,
          createdAt: "2026-07-19T00:00:00.000Z",
        },
        policy: {
          walletId,
          role,
          version: 1,
          baselineVersion: 1,
          operations: ["solana.nativeTransfer"],
          programs: ["11111111111111111111111111111111"],
          assets: [
            {
              asset: "solana:native",
              destinations: ["11111111111111111111111111111111"],
              maxPerTx: "1000000000",
              maxDaily: "5000000000",
              reviewedDestinations: true,
            },
          ],
          hash: `sha256:${"d".repeat(64)}`,
        },
      }),
      stderr: "",
      pid: 1,
      output: [],
    };
  }),
  socketCall: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: signerMocks.importProcess };
});

vi.mock("../wallet/local-socket-signer-lifecycle.js", () => ({
  activateSignerOwnedRoleBaseline: signerMocks.activate,
  createRoleReadySignerOwnedWallet: signerMocks.create,
  readSignerOwnedWallet: signerMocks.read,
  readSignerOwnedWalletReadiness: signerMocks.readiness,
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
    signerMocks.readiness.mockClear();
    signerMocks.read.mockClear();
    signerMocks.activate.mockClear();
    signerMocks.roles.clear();
    signerMocks.policyHashes.clear();
    signerMocks.networkPut.mockClear();
    signerMocks.importProcess.mockClear();
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
        role: "agent",
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

  it("activates an existing deny-all role baseline only after explicit confirmation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-baseline-migration-"));
    const configPath = path.join(root, "fased.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", path.join(root, "state"));
    signerMocks.roles.set("legacy_agent", "agent");
    clearConfigCache();

    try {
      upsertNamedWallet({
        walletId: "legacy-agent",
        name: "Legacy Agent",
        providerId: "local-socket-signer",
        addresses: { solana: "11111111111111111111111111111111" },
        metadata: { role: "agent", purpose: "agent", signerWalletId: "legacy_agent" },
        env: process.env,
      });
      await expect(
        walletPolicyActivateRoleBaselineCommand({ log: vi.fn() } as never, {
          walletId: "legacy-agent",
          role: "agent",
          confirm: false,
        }),
      ).rejects.toThrow(/requires --confirm/i);

      signerMocks.readiness.mockResolvedValueOnce({
        walletId: "legacy_agent",
        publicKey: "11111111111111111111111111111111",
        role: "agent",
        baselineVersion: 1,
        policyVersion: 2,
        policyHash: `sha256:${"f".repeat(64)}`,
        networkVersion: 1,
        networkHash: `hmac-sha256:${"b".repeat(64)}`,
        keyReady: true,
        policyReady: true,
        networkReady: true,
        operationLane: "agent-reviewed-and-autonomous",
        ready: true,
      });
      await walletPolicyActivateRoleBaselineCommand({ log: vi.fn() } as never, {
        walletId: "legacy-agent",
        role: "agent",
        confirm: true,
      });

      expect(signerMocks.activate).toHaveBeenCalledWith({
        socketPath: "/tmp/fased-signerd-app-test.sock",
        walletId: "legacy_agent",
        role: "agent",
        expectedPolicyVersion: 1,
      });
      expect(
        readWalletProviderRegistry(process.env).wallets.find(
          (wallet) => wallet.id === "legacy-agent",
        )?.metadata,
      ).toMatchObject({
        baselineVersion: 1,
        policyVersion: 2,
        roleReady: true,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not persist an RPC that signer validation rejects", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-rpc-reject-"));
    const configPath = path.join(root, "fased.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", path.join(root, "state"));
    clearConfigCache();
    signerMocks.networkPut.mockRejectedValueOnce(new Error("RPC genesis verification failed"));

    try {
      await expect(
        walletSetupCommand({ log: vi.fn() } as never, {
          mode: "local-signer-create",
          chain: "solana",
          walletId: "rejected-rpc",
          walletName: "Rejected RPC",
          role: "agent",
          rpcUrl: "https://wrong-network.example/solana",
          nonInteractive: true,
          noDoctor: true,
          noSignerHints: true,
        }),
      ).rejects.toThrow(/genesis verification failed/i);

      clearConfigCache();
      const cfg = loadConfig();
      expect(cfg.env?.vars?.FASED_WALLET_SOLANA_RPC_URL__REJECTED_RPC).toBeUndefined();
      expect(
        readWalletProviderRegistry(process.env).wallets.find(
          (wallet) => wallet.id === "rejected-rpc",
        ),
      ).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("never promotes the generic read fallback into the signer execution plane", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-rpc-role-"));
    const configPath = path.join(root, "fased.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("FASED_WALLET_SOLANA_RPC_FALLBACK_URL", "https://public-read.example/solana");
    clearConfigCache();

    try {
      await walletSetupCommand({ log: vi.fn() } as never, {
        mode: "local-signer-create",
        chain: "solana",
        walletId: "agent",
        role: "agent",
        rpcUrl: "https://primary.example/solana",
        nonInteractive: true,
        noDoctor: true,
        noSignerHints: true,
      });

      expect(signerMocks.networkPut).toHaveBeenCalledWith(
        expect.objectContaining({ primaryRpcUrl: "https://primary.example/solana" }),
      );
      expect(signerMocks.networkPut.mock.calls[0]?.[0]).not.toHaveProperty(
        "executionFallbackRpcUrl",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps advanced execution fallback settings out of normal one-RPC onboarding", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-rpc-advanced-"));
    const configPath = path.join(root, "fased.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("FASED_WALLET_SOLANA_EXECUTION_FALLBACK_RPC_URL__AGENT", "");
    vi.stubEnv(
      "FASED_WALLET_SOLANA_WRITE_RPC_FALLBACK_URL__AGENT",
      "https://advanced-execution.example/solana",
    );
    clearConfigCache();

    try {
      await walletSetupCommand({ log: vi.fn() } as never, {
        mode: "local-signer-create",
        chain: "solana",
        walletId: "agent",
        role: "agent",
        rpcUrl: "https://primary.example/solana",
        nonInteractive: true,
        noDoctor: true,
        noSignerHints: true,
      });

      expect(signerMocks.networkPut).toHaveBeenCalledWith(
        expect.objectContaining({ primaryRpcUrl: "https://primary.example/solana" }),
      );
      expect(signerMocks.networkPut.mock.calls[0]?.[0]).not.toHaveProperty(
        "executionFallbackRpcUrl",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("creates a hosted wallet through the restricted native operator lifecycle", async () => {
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
      configured: true,
      version: 1,
      hash: `hmac-sha256:${"b".repeat(64)}`,
      ready: true,
    });
    clearConfigCache();
    try {
      await walletSetupCommand({ log: () => {} } as never, {
        mode: "local-signer-create",
        chain: "solana",
        walletId: "agent",
        walletName: "Agent",
        role: "agent",
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
      expect(signerMocks.networkPut).not.toHaveBeenCalled();
      expect(signerMocks.importProcess).toHaveBeenCalledWith(
        "/opt/fased/signer/fased-signerd",
        expect.arrayContaining([
          "admin",
          "wallet",
          "create",
          "--operator-socket",
          "/run/fased-signerd/operator.sock",
          "--wallet-id",
          "agent",
          "--baseline-role",
          "agent",
        ]),
        expect.anything(),
      );
      expect(
        JSON.stringify(signerMocks.importProcess.mock.calls.map((call) => call[1])),
      ).not.toContain("api-key=secret");
      const hostedWallet = readWalletProviderRegistry(process.env).wallets.find(
        (wallet) => wallet.id === "agent",
      );
      expect(hostedWallet?.metadata?.networkReady).toBe(true);
      expect(hostedWallet?.metadata?.policyState).toBe("ready");
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
      expect(readWalletProviderRegistry(process.env).defaultWalletId).toBeUndefined();
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

  it("imports through the native signer with the keypair passed only by file descriptor", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-native-import-"));
    const configPath = path.join(root, "fased.json");
    const importPath = path.join(root, "mining-keypair.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    await fs.writeFile(
      importPath,
      `[${Array.from({ length: 64 }, (_, index) => index).join(",")}]\n`,
      {
        mode: 0o600,
      },
    );
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
        role: "mining",
        walletName: "Mining",
        importFile: importPath,
        rpcUrl: "https://rpc.example/solana",
        nonInteractive: true,
        noDoctor: true,
      });
      expect(signerMocks.importProcess).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([
          "admin",
          "wallet",
          "import",
          "--wallet-id",
          "mining",
          "--baseline-role",
          "mining",
        ]),
        expect.objectContaining({
          stdio: [expect.any(Number), "pipe", "pipe"],
        }),
      );
      expect(JSON.stringify(signerMocks.importProcess.mock.calls)).not.toContain(
        await fs.readFile(importPath, "utf8"),
      );
      expect(log.mock.calls.flat().join("\n")).toContain("Imported mining wallet mining");
      expect(readWalletProviderRegistry(process.env).wallets).toContainEqual(
        expect.objectContaining({
          id: "mining",
          metadata: expect.objectContaining({ role: "mining" }),
        }),
      );
      expect(signerMocks.create).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an import file swapped after validation instead of reading the replacement", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-native-import-race-"));
    const configPath = path.join(root, "fased.json");
    const importPath = path.join(root, "agent-keypair.json");
    const originalPath = path.join(root, "original.json");
    const replacementPath = path.join(root, "replacement.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    await fs.writeFile(importPath, "[1]\n", { mode: 0o600 });
    await fs.writeFile(replacementPath, "[2]\n", { mode: 0o600 });
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", path.join(root, "state"));
    clearConfigCache();

    const actualOpenSync = fsSync.openSync.bind(fsSync);
    const openSpy = vi.spyOn(fsSync, "openSync").mockImplementation((target, flags, mode) => {
      if (target === importPath) {
        fsSync.renameSync(importPath, originalPath);
        fsSync.renameSync(replacementPath, importPath);
      }
      return actualOpenSync(target, flags, mode);
    });
    try {
      await expect(
        walletSetupCommand({ log: vi.fn() } as never, {
          mode: "local-signer-import",
          chain: "solana",
          walletId: "agent",
          role: "agent",
          importFile: importPath,
          rpcUrl: "https://rpc.example/solana",
          nonInteractive: true,
          noDoctor: true,
        }),
      ).rejects.toThrow(/changed or became unsafe/i);
      expect(signerMocks.importProcess).not.toHaveBeenCalled();
      expect(openSpy).toHaveBeenCalledWith(
        importPath,
        fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW,
      );
    } finally {
      openSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses the restricted Hosting operator socket for native private-key import", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-hosted-import-reject-"));
    const configPath = path.join(root, "fased.json");
    const importPath = path.join(root, "agent-keypair.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    await fs.writeFile(importPath, `[${Array.from({ length: 64 }, () => 1).join(",")}]\n`, {
      mode: 0o600,
    });
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("FASED_HOST_PROFILE", "hosting");
    vi.stubEnv("FASED_HOST_ROOT_PREPARED", "1");
    vi.stubEnv("FASED_WALLET_LOCAL_SIGNER_SOCKET", "/run/fased-signerd/app.sock");
    clearConfigCache();

    try {
      await walletSetupCommand({ log: vi.fn() } as never, {
        mode: "local-signer-import",
        chain: "solana",
        walletId: "agent",
        role: "agent",
        walletName: "Agent",
        importFile: importPath,
        rpcUrl: "https://rpc.example/solana",
        nonInteractive: true,
        noDoctor: true,
      });
      expect(signerMocks.importProcess).toHaveBeenCalledWith(
        "/opt/fased/signer/fased-signerd",
        expect.arrayContaining([
          "admin",
          "wallet",
          "import",
          "--operator-socket",
          "/run/fased-signerd/operator.sock",
          "--wallet-id",
          "agent",
          "--baseline-role",
          "agent",
        ]),
        expect.objectContaining({
          env: expect.not.objectContaining({
            FASED_WALLET_PRIVATE_KEY: expect.anything(),
            FASED_WALLET_PASSPHRASE: expect.anything(),
          }),
        }),
      );
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

  it("exports encrypted recovery with the password read directly by the native signer", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-native-recovery-"));
    const configPath = path.join(root, "fased.json");
    const outputPath = path.join(root, "agent-recovery.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", path.join(root, "state"));
    clearConfigCache();
    try {
      upsertNamedWallet({
        walletId: "agent",
        name: "Agent",
        providerId: "local-socket-signer",
        addresses: { solana: "11111111111111111111111111111111" },
        metadata: { role: "agent", signerWalletId: "agent" },
        env: process.env,
      });
      await walletRecoveryExportCommand({ log: vi.fn() } as never, {
        walletId: "agent",
        output: outputPath,
      });
      expect(signerMocks.importProcess).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([
          "admin",
          "wallet",
          "recovery-export",
          "--wallet-id",
          "agent",
          "--expected-public-key",
          "11111111111111111111111111111111",
          "--output",
          outputPath,
        ]),
        expect.objectContaining({ stdio: "inherit" }),
      );
      expect(JSON.stringify(signerMocks.importProcess.mock.calls)).not.toMatch(
        /password|passphrase|seed|private.key/i,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("restores encrypted recovery with the password read by the native signer and one RPC", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-native-recovery-import-"));
    const configPath = path.join(root, "fased.json");
    const recoveryPath = path.join(root, "agent-recovery.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    await fs.writeFile(recoveryPath, '{"encrypted":"package"}\n', { mode: 0o600 });
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", path.join(root, "state"));
    clearConfigCache();
    try {
      await walletRecoveryImportCommand({ log: vi.fn() } as never, {
        walletId: "agent-restored",
        walletName: "Restored Agent",
        role: "agent",
        recoveryFile: recoveryPath,
        rpcUrl: "https://rpc.example/solana",
      });
      expect(signerMocks.importProcess).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([
          "admin",
          "wallet",
          "recovery-import",
          "--wallet-id",
          "agent_restored",
          "--baseline-role",
          "agent",
          "--recovery-file",
          recoveryPath,
        ]),
        expect.objectContaining({ stdio: ["inherit", "pipe", "pipe"] }),
      );
      expect(signerMocks.networkPut).toHaveBeenCalledWith(
        expect.objectContaining({
          walletId: "agent_restored",
          primaryRpcUrl: "https://rpc.example/solana",
        }),
      );
      expect(JSON.stringify(signerMocks.importProcess.mock.calls)).not.toMatch(
        /password|passphrase|seed|private.key/i,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps advanced raw export native, explicit, and out of argv secrets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-wallet-native-raw-export-"));
    const configPath = path.join(root, "fased.json");
    const outputPath = path.join(root, "agent-keypair.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    vi.stubEnv("FASED_CONFIG_PATH", configPath);
    vi.stubEnv("FASED_DISABLE_CONFIG_CACHE", "1");
    vi.stubEnv("FASED_STATE_DIR", path.join(root, "state"));
    clearConfigCache();
    try {
      upsertNamedWallet({
        walletId: "agent",
        name: "Agent",
        providerId: "local-socket-signer",
        addresses: { solana: "11111111111111111111111111111111" },
        metadata: { role: "agent", signerWalletId: "agent" },
        env: process.env,
      });
      await walletRawExportCommand({ log: vi.fn() } as never, {
        walletId: "agent",
        output: outputPath,
        acknowledgeCustodyReduction: true,
      });
      expect(signerMocks.importProcess).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([
          "admin",
          "wallet",
          "export-raw",
          "--wallet-id",
          "agent",
          "--expected-public-key",
          "11111111111111111111111111111111",
          "--output",
          outputPath,
          "--acknowledge-custody-reduction",
        ]),
        expect.objectContaining({ stdio: "inherit" }),
      );
      expect(JSON.stringify(signerMocks.importProcess.mock.calls)).not.toMatch(
        /password|passphrase|seed|private.key/i,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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
