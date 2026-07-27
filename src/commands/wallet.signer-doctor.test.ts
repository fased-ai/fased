import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectWalletSignerDoctorReport } from "./wallet.js";

const resolveNativeSignerOperatorLifecycleMock = vi.hoisted(() => vi.fn());
const invokeNativeSignerOperatorHealthMock = vi.hoisted(() => vi.fn());

vi.mock("../wallet/native-signer-lifecycle-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wallet/native-signer-lifecycle-context.js")>()),
  resolveNativeSignerOperatorLifecycle: resolveNativeSignerOperatorLifecycleMock,
}));

vi.mock("../wallet/native-signer-operator-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wallet/native-signer-operator-client.js")>()),
  invokeNativeSignerOperatorHealth: invokeNativeSignerOperatorHealthMock,
}));

const tempDirs: string[] = [];

beforeEach(() => {
  resolveNativeSignerOperatorLifecycleMock.mockReset();
  resolveNativeSignerOperatorLifecycleMock.mockReturnValue(undefined);
  invokeNativeSignerOperatorHealthMock.mockReset();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("collectWalletSignerDoctorReport", () => {
  it.each([
    { label: "protected Local signer", profile: "protected-local" as const, mode: 0o600 },
    { label: "Hosting signer", profile: "hosting" as const, mode: 0o660 },
  ])("uses the restricted operator socket for the $label", async ({ profile, mode }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-wallet-doctor-operator-"));
    tempDirs.push(root);
    const stateDir = path.join(root, "state");
    const walletDir = path.join(stateDir, "wallet");
    const applicationSocketPath = path.join(root, "application", "app.sock");
    const operatorSocketPath = path.join(root, "operator", "operator.sock");
    const signerBinPath = path.join(root, "signer", "fased-signerd");
    fs.mkdirSync(walletDir, { recursive: true });
    fs.mkdirSync(path.dirname(operatorSocketPath), { recursive: true });
    fs.writeFileSync(
      path.join(walletDir, "provider-registry.v1.json"),
      JSON.stringify({
        version: 1,
        providers: {
          "embedded-keystore": { enabled: false, updatedAt: "2026-07-27T00:00:00.000Z" },
          "local-socket-signer": { enabled: true, updatedAt: "2026-07-27T00:00:00.000Z" },
          alchemy: { enabled: false, updatedAt: "2026-07-27T00:00:00.000Z" },
          turnkey: { enabled: false, updatedAt: "2026-07-27T00:00:00.000Z" },
          privy: { enabled: false, updatedAt: "2026-07-27T00:00:00.000Z" },
        },
        wallets: [
          {
            id: "agent",
            name: "Agent",
            providerId: "local-socket-signer",
            addresses: { solana: "So11111111111111111111111111111111111111112" },
            createdAt: "2026-07-27T00:00:00.000Z",
            updatedAt: "2026-07-27T00:00:00.000Z",
          },
        ],
        assignments: {},
        updatedAt: "2026-07-27T00:00:00.000Z",
      }),
      "utf8",
    );
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(operatorSocketPath, resolve);
    });
    fs.chmodSync(operatorSocketPath, mode);
    resolveNativeSignerOperatorLifecycleMock.mockReturnValue({
      profile,
      ...(profile === "protected-local" ? { instanceId: "0123456789abcdef" } : {}),
      signerBinPath,
      applicationSocketPath,
      operatorSocketPath,
      controlSocketPath: path.join(root, "control", "control.sock"),
      ownerHelperPath: path.join(root, "fased-local-signer-owner"),
    });
    invokeNativeSignerOperatorHealthMock.mockReturnValue({
      ok: true,
      details: "fased-signerd protocol-v2 ready",
      ready: true,
      network: {
        ready: true,
        wallets: [
          {
            walletId: "agent",
            configured: true,
            version: 1,
            ready: true,
          },
        ],
      },
    });

    try {
      const env = {
        HOME: root,
        FASED_STATE_DIR: stateDir,
        ...(profile === "protected-local"
          ? {
              FASED_HOST_PROFILE: "local",
              FASED_PROTECTED_LOCAL: "1",
              FASED_PROTECTED_LOCAL_INSTANCE: "0123456789abcdef",
            }
          : { FASED_HOST_PROFILE: "hosting" }),
        FASED_WALLET_LOCAL_SIGNER_LIFECYCLE: "external",
        FASED_WALLET_LOCAL_SIGNER_BIN: signerBinPath,
        FASED_WALLET_LOCAL_SIGNER_SOCKET: applicationSocketPath,
      } as NodeJS.ProcessEnv;
      const report = await collectWalletSignerDoctorReport(env, {
        config: { wallet: { provider: { id: "local-socket-signer" } } },
      });

      expect(report.ok).toBe(true);
      expect(report.socketPath).toBe(operatorSocketPath);
      expect(report.checks.find((check) => check.check === "socket.mode")).toMatchObject({
        ok: true,
        detail: `mode=${mode.toString(8)} expected=${mode.toString(8)}`,
      });
      expect(invokeNativeSignerOperatorHealthMock).toHaveBeenCalledWith({
        signerBinPath,
        operatorSocketPath,
        env,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    { label: "single-user signer", mode: 0o600, hosted: false },
    { label: "separate-user hosted signer", mode: 0o660, hosted: true },
  ])("accepts the intended $label socket mode", async ({ mode, hosted }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-wallet-doctor-socket-mode-"));
    tempDirs.push(root);
    const stateDir = path.join(root, "state");
    const walletDir = path.join(stateDir, "wallet");
    const socketPath = path.join(walletDir, "local-signer.sock");
    fs.mkdirSync(walletDir, { recursive: true });
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    fs.chmodSync(socketPath, mode);

    try {
      const report = await collectWalletSignerDoctorReport(
        {
          HOME: "/home/app",
          FASED_STATE_DIR: stateDir,
          FASED_WALLET_LOCAL_SIGNER_SOCKET: socketPath,
          ...(hosted ? { FASED_HOST_PROFILE: "hosting" } : {}),
        } as NodeJS.ProcessEnv,
        {
          socketPath,
          config: {
            wallet: {
              provider: { id: "local-socket-signer" },
            },
          },
        },
      );

      expect(report.checks.find((check) => check.check === "socket.mode")).toMatchObject({
        ok: true,
        detail: `mode=${mode.toString(8)} expected=${mode.toString(8)}`,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails closed when config-merged env still references a Node keystore", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-wallet-doctor-"));
    tempDirs.push(root);
    const stateDir = path.join(root, "state");
    const configuredKeystore = path.join(root, "configured-solana.json");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configuredKeystore, '{"kind":"unknown"}', "utf8");

    await expect(
      collectWalletSignerDoctorReport(
        {
          HOME: "/home/root",
          FASED_STATE_DIR: stateDir,
        } as NodeJS.ProcessEnv,
        {
          config: {
            env: {
              vars: {
                FASED_WALLET_SOLANA_KEYSTORE_PATH: configuredKeystore,
              },
            },
            wallet: {
              provider: { id: "embedded-keystore" },
            },
          },
        },
      ),
    ).rejects.toThrow(/embedded-keystore was retired/i);
  });

  it("fails closed on stale Node keystore mappings after a named signer wallet is configured", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-wallet-doctor-local-signer-"));
    tempDirs.push(root);
    const stateDir = path.join(root, "state");
    const walletDir = path.join(stateDir, "wallet");
    const solanaKeystore = path.join(walletDir, "keystore-solana-solana-1.v1.enc");
    fs.mkdirSync(walletDir, { recursive: true });
    fs.writeFileSync(
      solanaKeystore,
      JSON.stringify(
        {
          kind: "fased-solana-keypair",
          version: 1,
          kdf: "scrypt",
          cipher: "aes-256-gcm",
          salt: "AA",
          iv: "AA",
          authTag: "AA",
          ciphertext: "AA",
          publicKey: "So11111111111111111111111111111111111111112",
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(path.join(walletDir, "passphrase"), "test-passphrase\n", "utf8");
    fs.writeFileSync(
      path.join(walletDir, "provider-registry.v1.json"),
      JSON.stringify(
        {
          version: 1,
          providers: {
            "embedded-keystore": { enabled: true, updatedAt: "2026-01-01T00:00:00.000Z" },
            "local-socket-signer": { enabled: true, updatedAt: "2026-01-01T00:00:00.000Z" },
            alchemy: { enabled: false, updatedAt: "2026-01-01T00:00:00.000Z" },
            turnkey: { enabled: false, updatedAt: "2026-01-01T00:00:00.000Z" },
            privy: { enabled: false, updatedAt: "2026-01-01T00:00:00.000Z" },
          },
          wallets: [
            {
              id: "solana_1",
              name: "Solana 1",
              providerId: "local-socket-signer",
              addresses: { solana: "So11111111111111111111111111111111111111112" },
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          assignments: {},
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(
      collectWalletSignerDoctorReport(
        {
          HOME: "/home/test",
          FASED_STATE_DIR: stateDir,
        } as NodeJS.ProcessEnv,
        {
          config: {
            env: {
              vars: {
                FASED_WALLET_SOLANA_KEYSTORE_PATH__SOLANA_1: solanaKeystore,
                FASED_WALLET_SOLANA_RPC_URL__SOLANA_1:
                  "https://rpc.example/solana?api-key=private-rpc-key",
              },
            },
            wallet: {
              provider: { id: "local-socket-signer" },
              keystore: {
                enabled: true,
                path: path.join(walletDir, "keystore-solana-solana-4.v1.enc"),
              },
            },
          },
        },
      ),
    ).rejects.toThrow(/embedded-keystore was retired/i);
  });

  it("uses signer health metadata for wallet-scoped network readiness", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-wallet-doctor-network-"));
    tempDirs.push(root);
    const stateDir = path.join(root, "state");
    const walletDir = path.join(stateDir, "wallet");
    const socketPath = path.join(walletDir, "local-signer.sock");
    fs.mkdirSync(walletDir, { recursive: true });
    fs.writeFileSync(
      path.join(walletDir, "provider-registry.v1.json"),
      JSON.stringify({
        version: 1,
        providers: {
          "embedded-keystore": { enabled: false, updatedAt: "2026-07-16T00:00:00.000Z" },
          "local-socket-signer": { enabled: true, updatedAt: "2026-07-16T00:00:00.000Z" },
          alchemy: { enabled: false, updatedAt: "2026-07-16T00:00:00.000Z" },
          turnkey: { enabled: false, updatedAt: "2026-07-16T00:00:00.000Z" },
          privy: { enabled: false, updatedAt: "2026-07-16T00:00:00.000Z" },
        },
        wallets: [
          {
            id: "agent-2",
            name: "Agent 2",
            providerId: "local-socket-signer",
            addresses: { solana: "So11111111111111111111111111111111111111112" },
            createdAt: "2026-07-16T00:00:00.000Z",
            updatedAt: "2026-07-16T00:00:00.000Z",
          },
        ],
        assignments: {},
        defaultWalletId: "agent-2",
        updatedAt: "2026-07-16T00:00:00.000Z",
      }),
      "utf8",
    );
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", () => {
        socket.end(
          `${JSON.stringify({
            ok: true,
            result: {
              details: "fased-signerd protocol-v2 ready",
              readOnly: false,
              keystoreType: "signer-owned-v2",
              chains: ["solana"],
              ready: true,
              release: {
                version: "dev",
                commit: "unknown",
                buildInputDigest: "unknown",
                development: true,
              },
              schema: { version: 3, supported: 3, ready: true },
              network: {
                ready: true,
                wallets: [
                  {
                    walletId: "agent_2",
                    configured: true,
                    version: 7,
                    hash: `hmac-sha256:${"a".repeat(64)}`,
                    ready: true,
                  },
                ],
              },
              capabilities: {
                protocol: { current: 2, min: 2, max: 2 },
                nativeFeeReservationLamports: 5_000_000,
                intentTypes: ["solana.nativeTransfer"],
                operationStates: ["reserved", "broadcast", "confirmed", "failed", "unknown"],
                features: ["signerOwnedRPC"],
              },
              policies: [],
              webAuthn: {
                configured: true,
                credentialCount: 1,
                credentialVersion: 9,
                ready: true,
              },
              jupiter: { triggerConfigured: false, liveEnabled: false },
              state: {
                databaseBytes: 4096,
                wallets: 1,
                operations: 80_000,
                operationReplayArchive: 1,
                reviews: 0,
                triggerWorkflows: 0,
                dailyUsageBuckets: 1,
                capacities: {
                  operations: {
                    used: 80_000,
                    maximum: 100_000,
                    warnAt: 80_000,
                    warning: true,
                  },
                },
                capacityWarnings: ["operations signer state is at 80000/100000 records"],
              },
            },
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    fs.chmodSync(socketPath, 0o600);

    try {
      const report = await collectWalletSignerDoctorReport(
        {
          HOME: root,
          FASED_STATE_DIR: stateDir,
          FASED_WALLET_LOCAL_SIGNER_LIFECYCLE: "external",
          FASED_WALLET_LOCAL_SIGNER_SOCKET: socketPath,
          FASED_WALLET_SOLANA_RPC_URL__AGENT_2:
            "https://gateway-rpc-must-not-control-readiness.invalid",
        } as NodeJS.ProcessEnv,
        {
          config: {
            wallet: { provider: { id: "local-socket-signer" } },
          },
        },
      );

      expect(report.checks.find((check) => check.check === "socket.health")).toMatchObject({
        ok: true,
        detail: "fased-signerd protocol-v2 ready",
      });
      expect(report.checks.find((check) => check.check === "rpc.configured.solana")).toMatchObject({
        ok: true,
        detail: "signer-owned network ready",
      });
      expect(
        report.checks.find((check) => check.check === "rpc.configured.solana.agent-2"),
      ).toMatchObject({
        ok: true,
        detail: "signer-owned network ready (version=7)",
      });
      expect(JSON.stringify(report)).not.toContain("gateway-rpc-must-not-control-readiness");
      expect(JSON.stringify(report)).not.toContain("hmac-sha256");
      expect(report.signer).toEqual({
        jupiter: { triggerConfigured: false, liveEnabled: false },
        webAuthn: {
          configured: true,
          credentialCount: 1,
          credentialVersion: 9,
          ready: true,
        },
      });
      expect(
        report.checks.find((check) => check.check === "jupiter.trigger.configured"),
      ).toMatchObject({
        ok: true,
        detail: "not configured (optional; swaps and transfers remain available)",
      });
      expect(report.checks.find((check) => check.check === "jupiter.execution.mode")).toMatchObject(
        { ok: true, detail: "preview-only; signer rejects Jupiter and Trigger execution" },
      );
      expect(
        report.checks.find((check) => check.check === "state.capacity.operations"),
      ).toMatchObject({ ok: false, detail: "80000/100000 records; warning=80000" });
      expect(JSON.stringify(report)).not.toMatch(/api.?key|jwt|secret|jupiter-trigger-api\.key/iu);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses canonical local signer sidecar paths instead of socket-suffixed files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-wallet-doctor-sidecars-"));
    tempDirs.push(root);
    const stateDir = path.join(root, "state");
    const walletDir = path.join(stateDir, "wallet");
    fs.mkdirSync(walletDir, { recursive: true });

    const report = await collectWalletSignerDoctorReport(
      {
        HOME: "/home/test",
        FASED_STATE_DIR: stateDir,
      } as NodeJS.ProcessEnv,
      {
        config: {
          wallet: {
            provider: { id: "local-socket-signer" },
          },
        },
      },
    );

    expect(report.socketPath).toBe(path.join(walletDir, "local-signer.sock"));
    expect(report.pidPath).toBe(path.join(walletDir, "local-signer.pid"));
    expect(report.auditPath).toBe(path.join(walletDir, "local-signer.audit.jsonl"));
  });

  it("does not surface raw missing sidecar ENOENTs before wallet setup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-wallet-doctor-fresh-"));
    tempDirs.push(root);
    const stateDir = path.join(root, "state");
    const walletDir = path.join(stateDir, "wallet");
    fs.mkdirSync(walletDir, { recursive: true });

    const report = await collectWalletSignerDoctorReport(
      {
        HOME: "/home/app",
        FASED_STATE_DIR: stateDir,
      } as NodeJS.ProcessEnv,
      {
        config: {
          wallet: {
            provider: { id: "local-socket-signer" },
          },
        },
      },
    );

    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.check === "socket.exists")).toMatchObject({
      ok: true,
      detail: "Configure",
    });
    expect(report.checks.find((check) => check.check === "pid.alive")).toMatchObject({
      ok: true,
      detail: "Configure",
    });
    expect(report.checks.find((check) => check.check === "audit.exists")).toMatchObject({
      ok: true,
      detail: "Configure",
    });
    expect(report.checks.find((check) => check.check === "socket.health")).toMatchObject({
      ok: true,
      detail: "Configure",
    });
    expect(JSON.stringify(report.checks)).not.toContain("ENOENT");
  });
});
