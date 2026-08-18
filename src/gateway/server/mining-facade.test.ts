import { describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../../config/config.js";
import type {
  WalletNamedWallet,
  WalletProviderRegistry,
  WalletUserRole,
} from "../../wallet/wallet-provider-registry.js";
import { createGatewayMiningFacade } from "./mining-facade.js";

const env = { HOME: "/home/app" } as NodeJS.ProcessEnv;

function config(params?: { token?: string; walletId?: string }): FasedAgentConfig {
  return {
    gateway: params?.token ? { auth: { mode: "token", token: params.token } } : undefined,
    plugins: params?.walletId
      ? {
          entries: {
            "sat-mining": { enabled: true, config: { walletId: params.walletId } },
          },
        }
      : undefined,
  } as FasedAgentConfig;
}

function wallet(id: string, role: WalletUserRole): WalletNamedWallet {
  return {
    id,
    name: id,
    providerId: "local-socket-signer",
    metadata: { role },
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
}

function registry(wallets: WalletNamedWallet[], defaultWalletId?: string): WalletProviderRegistry {
  return { wallets, defaultWalletId } as WalletProviderRegistry;
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    env,
    loadConfig: vi.fn(() => config({ token: "gateway-token" })),
    resolvePort: vi.fn(() => 18_789),
    callGateway: vi.fn(async () => ({ payload: { running: true } })),
    readRegistry: vi.fn(() => registry([wallet("mining", "mining")])),
    resolveRole: vi.fn(
      (entry: WalletNamedWallet) => entry.metadata?.role as WalletUserRole | undefined,
    ),
    ...overrides,
  };
}

describe("Gateway Mining facade", () => {
  it("binds every Mining call to the loopback Gateway and operator scope", async () => {
    const deps = dependencies();
    const facade = createGatewayMiningFacade(deps as never);

    await facade.call("sat.getMiningStatus", { statusMode: "ui" });

    expect(deps.resolvePort).toHaveBeenCalledWith(deps.loadConfig.mock.results[0]?.value, env);
    expect(deps.callGateway).toHaveBeenCalledWith({
      url: "ws://localhost:18789",
      token: "gateway-token",
      config: deps.loadConfig.mock.results[0]?.value,
      method: "sat.getMiningStatus",
      params: { statusMode: "ui" },
      scopes: ["operator.admin"],
      deviceAuth: "disabled",
      timeoutMs: 15_000,
    });
  });

  it("preserves explicit bounded timeouts and omits non-token credentials", async () => {
    const deps = dependencies({ loadConfig: vi.fn(() => config()) });
    const facade = createGatewayMiningFacade(deps as never);

    await facade.call("sat.startMining", undefined, { timeoutMs: 90_000 });

    expect(deps.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ token: undefined, timeoutMs: 90_000 }),
    );
  });

  it("returns only object Mining status payloads", async () => {
    const objectDeps = dependencies();
    const objectFacade = createGatewayMiningFacade(objectDeps as never);
    await expect(objectFacade.readStatusPayload()).resolves.toEqual({ running: true });

    const arrayDeps = dependencies({
      callGateway: vi.fn(async () => ({ payload: ["not", "a", "status"] })),
    });
    const arrayFacade = createGatewayMiningFacade(arrayDeps as never);
    await expect(arrayFacade.readStatusPayload()).resolves.toEqual({});
  });

  it("reads only a non-empty configured singleton wallet ID", () => {
    const facade = createGatewayMiningFacade(dependencies() as never);
    expect(facade.readConfiguredWalletId(config({ walletId: " mining " }))).toBe("mining");
    expect(facade.readConfiguredWalletId(config({ walletId: " " }))).toBeUndefined();
    expect(facade.readConfiguredWalletId(config())).toBeUndefined();
  });

  it("rejects conflicting, missing, Agent, and Vault wallets but accepts Mining", () => {
    const activeFacade = createGatewayMiningFacade(
      dependencies({ loadConfig: vi.fn(() => config({ walletId: "active-mining" })) }) as never,
    );
    expect(activeFacade.resolveWalletConflict("replacement")).toContain(
      "already uses active-mining",
    );

    const otherMiningFacade = createGatewayMiningFacade(
      dependencies({
        loadConfig: vi.fn(() => config()),
        readRegistry: vi.fn(() =>
          registry([wallet("candidate", "mining"), wallet("other", "mining")]),
        ),
      }) as never,
    );
    expect(otherMiningFacade.resolveWalletConflict("candidate")).toContain(
      "already has the singleton wallet other",
    );

    const missingFacade = createGatewayMiningFacade(
      dependencies({
        loadConfig: vi.fn(() => config()),
        readRegistry: vi.fn(() => registry([])),
      }) as never,
    );
    expect(missingFacade.resolveWalletConflict("missing")).toContain("requires an existing");

    const facadeForRole = (id: string, role: WalletUserRole) =>
      createGatewayMiningFacade(
        dependencies({
          loadConfig: vi.fn(() => config()),
          readRegistry: vi.fn(() => registry([wallet(id, role)])),
        }) as never,
      );
    expect(facadeForRole("agent", "agent").resolveWalletConflict("agent")).toContain(
      "dedicated Mining wallet",
    );
    expect(facadeForRole("vault", "vault").resolveWalletConflict("vault")).toContain(
      "is a vault wallet",
    );
    expect(facadeForRole("mining", "mining").resolveWalletConflict("mining")).toBeNull();
    expect(facadeForRole("mining", "mining").resolveWalletConflict(undefined)).toBeNull();
  });
});
