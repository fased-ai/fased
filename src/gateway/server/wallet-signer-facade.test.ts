import { describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../../config/config.js";
import type { WalletProviderRegistry } from "../../wallet/wallet-provider-registry.js";
import type { WalletStatusSnapshot } from "../../wallet/wallet-status.js";
import { createGatewayWalletSignerFacade } from "./wallet-signer-facade.js";

const config = {} as FasedAgentConfig;
const env = { HOME: "/home/app" } as NodeJS.ProcessEnv;

function statusSnapshot(params: { healthy: boolean; walletReady?: boolean }): WalletStatusSnapshot {
  return {
    service: { host: "127.0.0.1", port: 9101, healthy: params.healthy },
    policy: {
      solana: { maxPerTx: "1500000000", maxDaily: "2000000000" },
    },
    wallets: [
      {
        id: "Agent-1",
        name: "Agent 1",
        providerId: "local-socket-signer",
        addresses: { solana: "agent-address" },
        readiness: {
          keystore: true,
          rpc: true,
          ready: params.walletReady ?? params.healthy,
        },
      },
    ],
    authMode: "jwt-bootstrap",
    authSource: "bootstrap",
    authBootstrap: {
      endpoint: "/run/fased-signerd/bootstrap.sock",
      lastError: "old internal error",
      lastSuccessAt: "2026-08-18T00:00:00.000Z",
      expiresAt: "2026-08-18T01:00:00.000Z",
    },
  } as WalletStatusSnapshot;
}

function registry(): WalletProviderRegistry {
  return {
    wallets: [
      {
        id: "Agent-1",
        name: "Agent 1",
        providerId: "local-socket-signer",
        addresses: { solana: "agent-address" },
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
      },
    ],
  } as WalletProviderRegistry;
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    readStatusSnapshot: vi.fn(async () => statusSnapshot({ healthy: true })),
    readRegistry: vi.fn(() => registry()),
    resolveProviderId: vi.fn(() => "local-socket-signer" as const),
    restartLocalSigner: vi.fn(async () => undefined),
    collectSignerDoctor: vi.fn(async () => ({
      ok: true,
      socketPath: "/run/fased-signerd/app.sock",
      pidPath: "/run/fased-signerd/app.pid",
      auditPath: "/var/lib/fased-signer/audit.jsonl",
      checks: [],
    })),
    ...overrides,
  };
}

describe("Gateway Wallet/signer facade", () => {
  it("maps status into the public contract and removes raw signer auth fields", async () => {
    const deps = dependencies();
    const facade = createGatewayWalletSignerFacade(deps);
    const registryEnv = { HOME: "/legacy/operator" } as NodeJS.ProcessEnv;

    const result = await facade.readStatus({ config, env, registryEnv, walletId: "Agent-1" });

    expect(deps.readStatusSnapshot).toHaveBeenCalledWith({
      config,
      env,
      walletId: "Agent-1",
    });
    expect(deps.readRegistry).toHaveBeenCalledWith(registryEnv);
    expect(deps.restartLocalSigner).not.toHaveBeenCalled();
    expect(result.status).toMatchObject({
      configuredProviderId: "local-socket-signer",
      activeSignerMode: "local-native-signer",
      providerAuthMode: "jwt-bootstrap",
      providerAuthSource: "bootstrap",
      policyDisplay: {
        solana: {
          maxPerTx: { raw: "1500000000", human: "1.5 SOL" },
          maxDaily: { raw: "2000000000", human: "2 SOL" },
        },
      },
      wallets: [{ walletId: "Agent-1", rpcConfigured: true, health: "ok" }],
    });
    expect(result.status.authMode).toBeUndefined();
    expect(result.status.authSource).toBeUndefined();
    expect(result.status.authBootstrap).toBeUndefined();
  });

  it("restarts an unhealthy local signer once and returns the refreshed snapshot", async () => {
    const readStatusSnapshot = vi
      .fn()
      .mockResolvedValueOnce(statusSnapshot({ healthy: false }))
      .mockResolvedValueOnce(statusSnapshot({ healthy: true }));
    const deps = dependencies({ readStatusSnapshot });
    const facade = createGatewayWalletSignerFacade(deps);

    const result = await facade.readStatus({ config, env });

    expect(deps.restartLocalSigner).toHaveBeenCalledOnce();
    expect(readStatusSnapshot).toHaveBeenCalledTimes(2);
    expect(result.status.service).toMatchObject({ healthy: true });
  });

  it("keeps the original unhealthy snapshot when signer restart fails", async () => {
    const readStatusSnapshot = vi.fn(async () => statusSnapshot({ healthy: false }));
    const deps = dependencies({
      readStatusSnapshot,
      restartLocalSigner: vi.fn(async () => {
        throw new Error("restart detail must remain internal");
      }),
    });
    const facade = createGatewayWalletSignerFacade(deps);

    const result = await facade.readStatus({ config, env });

    expect(readStatusSnapshot).toHaveBeenCalledOnce();
    expect(result.status.service).toMatchObject({ healthy: false });
    expect(JSON.stringify(result)).not.toContain("restart detail must remain internal");
  });

  it("normalizes signer check wallet IDs into one deterministic doctor result", async () => {
    const deps = dependencies({
      collectSignerDoctor: vi.fn(async () => ({
        ok: true,
        socketPath: "/run/fased-signerd/app.sock",
        pidPath: "/run/fased-signerd/app.pid",
        auditPath: "/var/lib/fased-signer/audit.jsonl",
        checks: [
          { check: "socket.health", ok: true },
          { check: "keystore.file.solana.agent_1", ok: true, detail: "present" },
          { check: "keystore.decrypt.solana.agent_1", ok: true },
          { check: "rpc.configured.solana.agent_1", ok: false, detail: "missing" },
        ],
      })),
    });
    const facade = createGatewayWalletSignerFacade(deps);

    const result = await facade.readSignerDoctor({ config, env });

    expect(result).toMatchObject({
      report: { ok: true, running: true },
      chainWallets: {
        solana: [
          {
            walletId: "agent-1",
            keystoreReady: true,
            decryptReady: true,
            rpcConfigured: false,
            keystoreDetail: "present",
            rpcDetail: "missing",
          },
        ],
      },
    });
  });
});
