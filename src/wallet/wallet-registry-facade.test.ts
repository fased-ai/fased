import { describe, expect, it, vi } from "vitest";
import { createWalletRegistryFacade } from "./wallet-registry-facade.js";

describe("Wallet registry facade", () => {
  it("exposes one typed boundary for registry reads, mutations, and selection", () => {
    const env = { FASED_STATE_DIR: "/tmp/fased-wallet-registry-test" };
    const registry = { version: 1, wallets: [] };
    const wallet = { id: "agent", name: "Agent" };
    const read = vi.fn(() => registry);
    const upsert = vi.fn(() => wallet);
    const resolveSelection = vi.fn(() => ({ walletId: "agent", source: "explicit" }));
    const facade = createWalletRegistryFacade({
      read: read as never,
      upsert: upsert as never,
      resolveSelection: resolveSelection as never,
    });

    expect(facade.read(env)).toBe(registry);
    expect(
      facade.upsert({
        walletId: "agent",
        name: "Agent",
        providerId: "local-socket-signer",
        env,
      }),
    ).toBe(wallet);
    expect(facade.resolveSelection({ walletId: "agent", env })).toEqual({
      walletId: "agent",
      source: "explicit",
    });
    expect(read).toHaveBeenCalledWith(env);
    expect(upsert).toHaveBeenCalledWith({
      walletId: "agent",
      name: "Agent",
      providerId: "local-socket-signer",
      env,
    });
    expect(resolveSelection).toHaveBeenCalledWith({ walletId: "agent", env });
  });

  it("keeps pure role and identity policy behind the same facade", () => {
    const facade = createWalletRegistryFacade();

    expect(facade.normalizeRole(" MINING ")).toBe("mining");
    expect(facade.nextRoleIdentity("agent", [{ id: "agent" }])).toEqual({
      walletId: "agent-2",
      walletName: "Agent 2",
    });
    expect(
      facade.resolveRole({
        id: "mining",
        name: "Mining",
        providerId: "local-socket-signer",
        metadata: { purpose: "mining" },
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
      }),
    ).toBe("mining");
  });
});
