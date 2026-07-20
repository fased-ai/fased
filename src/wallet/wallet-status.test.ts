import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("./wallet-provider-resolver.js", () => ({
  createWalletProviderAdapter: vi.fn(),
  resolveWalletProviderId: vi.fn(),
}));

vi.mock("./wallet-runtime-config.js", () => ({
  ensureWalletStateDir: vi.fn(),
  resolveLocalSignerSocketPath: vi.fn(),
  resolveWalletRuntimeConfig: vi.fn(),
  resolveWalletStatePaths: vi.fn(),
}));

vi.mock("./wallet-provider-registry.js", () => ({
  readWalletProviderRegistry: vi.fn(),
}));

vi.mock("./local-socket-signer-lifecycle.js", () => ({
  readSignerOwnedWalletReadiness: vi.fn(),
}));

vi.mock("./wallet-approval-auth.js", () => ({
  readWalletApprovalAuthSnapshot: vi.fn(),
}));

vi.mock("./wallet-policy.js", () => ({
  resolveWalletPolicyConfig: vi.fn(),
}));

import { loadConfig } from "../config/config.js";
import { readSignerOwnedWalletReadiness } from "./local-socket-signer-lifecycle.js";
import { readWalletApprovalAuthSnapshot } from "./wallet-approval-auth.js";
import { resolveWalletPolicyConfig } from "./wallet-policy.js";
import { readWalletProviderRegistry } from "./wallet-provider-registry.js";
import {
  createWalletProviderAdapter,
  resolveWalletProviderId,
} from "./wallet-provider-resolver.js";
import {
  ensureWalletStateDir,
  resolveLocalSignerSocketPath,
  resolveWalletRuntimeConfig,
  resolveWalletStatePaths,
} from "./wallet-runtime-config.js";
import { readWalletStatusSnapshot } from "./wallet-status.js";

describe("readWalletStatusSnapshot", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    vi.mocked(loadConfig).mockReturnValue({
      wallet: {
        provider: { id: "local-socket-signer" },
      },
    } as never);

    vi.mocked(resolveWalletProviderId).mockReturnValue("local-socket-signer");
    vi.mocked(readWalletProviderRegistry).mockReturnValue({
      version: 1,
      providers: {},
      wallets: [],
      assignments: {},
      updatedAt: "2026-07-20T00:00:00.000Z",
    } as never);
    vi.mocked(resolveWalletRuntimeConfig).mockReturnValue({
      enabled: true,
      mode: "managed",
      runtime: "external-custom",
      chains: ["solana"],
      service: { host: "127.0.0.1", port: 18789 },
      execution: { mode: "manual" },
      policy: {
        directSigning: false,
        solana: { allowPrograms: [], caps: { maxPerTx: 0n, maxDaily: 0n } },
      },
      toolAccess: { mode: "owner-only", allowAgents: [] },
    } as never);
    vi.mocked(resolveWalletPolicyConfig).mockReturnValue({
      enabled: true,
      mode: "managed",
      runtime: "external-custom",
      chains: ["solana"],
      service: { host: "127.0.0.1", port: 18789 },
      execution: { mode: "manual" },
      policy: {
        directSigning: false,
        solana: { allowPrograms: [], caps: { maxPerTx: 0n, maxDaily: 0n } },
      },
      toolAccess: { mode: "owner-only", allowAgents: [] },
    } as never);
    vi.mocked(ensureWalletStateDir).mockReturnValue({
      rootDir: "/tmp/fased-wallet",
    } as never);
    vi.mocked(resolveLocalSignerSocketPath).mockReturnValue("/tmp/fased-signerd.sock");
    vi.mocked(resolveWalletStatePaths).mockReturnValue({
      keysPath: "/tmp/fased-wallet/keys.json",
      sidecarPidPath: "/tmp/fased-wallet/wallet-service.pid",
    } as never);
    vi.mocked(readWalletApprovalAuthSnapshot).mockReturnValue({
      mode: "none",
      ready: true,
      passkeyCount: 0,
      notes: [],
      passkeys: [],
      statePath: "/tmp/fased-wallet/approval.json",
    } as never);
  });

  it("keeps service healthy when address lookup fails after provider health passes", async () => {
    vi.mocked(createWalletProviderAdapter).mockReturnValue({
      health: vi.fn().mockResolvedValue({ ok: true, details: "socket healthy" }),
      getAddresses: vi.fn().mockRejectedValue(new Error("missing default wallet")),
    } as never);

    const status = await readWalletStatusSnapshot();

    expect(status.service.healthy).toBe(true);
    expect(status.startupState).toBe("healthy");
    expect(status.error).toContain("address probe warning:");
    expect(status.error).toContain("missing default wallet");
  });

  it("exposes only sanitized native signer approval readiness", async () => {
    vi.mocked(createWalletProviderAdapter).mockReturnValue({
      health: vi.fn().mockResolvedValue({
        ok: true,
        provider: "local-socket-signer",
        configured: true,
        checkedAt: "2026-07-19T00:00:00.000Z",
        nativeSignerApproval: {
          configured: true,
          ready: true,
          credentialCount: 2,
          credentialVersion: 7,
        },
      }),
      getAddresses: vi.fn().mockResolvedValue({ solana: "abc" }),
    } as never);

    const status = await readWalletStatusSnapshot();

    expect(status.nativeSignerApproval).toEqual({
      configured: true,
      ready: true,
      credentialCount: 2,
      credentialVersion: 7,
    });
    expect(JSON.stringify(status.nativeSignerApproval)).not.toMatch(
      /credentialId|publicKey|secret/iu,
    );
  });

  it("redacts secret-bearing provider diagnostics from status errors", async () => {
    vi.mocked(resolveWalletProviderId).mockReturnValue("embedded-keystore");
    vi.mocked(createWalletProviderAdapter).mockReturnValue({
      health: vi.fn().mockResolvedValue({
        ok: false,
        details: "rpc failed at https://rpc.example.com/?api_key=super-secret-rpc-key&ok=1",
      }),
      getAddresses: vi.fn(),
    } as never);

    const status = await readWalletStatusSnapshot();

    expect(status.error).toContain("api_key=***");
    expect(status.error).not.toContain("super-secret-rpc-key");
  });

  it("treats fresh local-signer installs with no wallets as setup pending", async () => {
    vi.mocked(createWalletProviderAdapter).mockReturnValue({
      health: vi.fn().mockResolvedValue({
        ok: false,
        details:
          "local-socket-signer socket is unavailable: ENOENT: no such file or directory, stat '/home/app/.fased/wallet/local-signer.sock'",
      }),
      getAddresses: vi.fn(),
    } as never);

    const status = await readWalletStatusSnapshot();

    expect(status.service.healthy).toBe(true);
    expect(status.startupState).toBe("healthy");
    expect(status.error).toBeUndefined();
  });

  it("uses config env vars when probing wallet provider health", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      env: {
        vars: {
          FASED_WALLET_LOCAL_SIGNER_SOCKET: "/tmp/from-config.sock",
        },
      },
      wallet: {
        provider: { id: "local-socket-signer" },
      },
    } as never);
    vi.mocked(createWalletProviderAdapter).mockReturnValue({
      health: vi.fn().mockResolvedValue({ ok: true, details: "socket healthy" }),
      getAddresses: vi.fn().mockResolvedValue({ solana: "abc" }),
    } as never);

    await readWalletStatusSnapshot({ env: {} as NodeJS.ProcessEnv });

    expect(createWalletProviderAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          FASED_WALLET_LOCAL_SIGNER_SOCKET: "/tmp/from-config.sock",
        }),
      }),
    );
  });

  it("does not expose the removed Gateway custody status", async () => {
    vi.mocked(createWalletProviderAdapter).mockReturnValue({
      health: vi.fn().mockResolvedValue({ ok: true, details: "socket healthy" }),
      getAddresses: vi.fn().mockResolvedValue({ solana: "abc" }),
    } as never);

    const status = await readWalletStatusSnapshot({
      env: {} as NodeJS.ProcessEnv,
      walletId: "solana-2",
    });
    expect(status).not.toHaveProperty("custody");
  });

  it("returns exact live signer readiness for every registered signer wallet", async () => {
    vi.mocked(readWalletProviderRegistry).mockReturnValue({
      version: 1,
      providers: {},
      wallets: [
        {
          id: "Agent-1",
          name: "Agent 1",
          providerId: "local-socket-signer",
          addresses: { solana: "11111111111111111111111111111111" },
          metadata: { role: "agent", signerWalletId: "agent_1" },
          createdAt: "2026-07-20T00:00:00.000Z",
          updatedAt: "2026-07-20T00:00:00.000Z",
        },
      ],
      assignments: {},
      updatedAt: "2026-07-20T00:00:00.000Z",
    } as never);
    vi.mocked(readSignerOwnedWalletReadiness).mockResolvedValue({
      walletId: "agent_1",
      publicKey: "11111111111111111111111111111111",
      role: "agent",
      baselineVersion: 1,
      policyVersion: 3,
      policyHash: `sha256:${"a".repeat(64)}`,
      networkVersion: 2,
      networkHash: `hmac-sha256:${"b".repeat(64)}`,
      keyReady: true,
      policyReady: true,
      networkReady: true,
      operationLane: "agent-reviewed-and-autonomous",
      ready: true,
    });
    vi.mocked(createWalletProviderAdapter).mockReturnValue({
      health: vi.fn().mockResolvedValue({ ok: true, details: "socket healthy" }),
      getAddresses: vi.fn().mockResolvedValue({ solana: "11111111111111111111111111111111" }),
    } as never);

    const status = await readWalletStatusSnapshot({ walletId: "Agent-1" });

    expect(readSignerOwnedWalletReadiness).toHaveBeenCalledWith({
      socketPath: "/tmp/fased-signerd.sock",
      walletId: "agent_1",
    });
    expect(status.wallets).toHaveLength(1);
    expect(status.wallets?.[0]?.readiness).toMatchObject({
      keystore: true,
      rpc: true,
      ready: true,
      signer: {
        baselineVersion: 1,
        policyVersion: 3,
        networkVersion: 2,
        operationLane: "agent-reviewed-and-autonomous",
      },
    });
  });
});
