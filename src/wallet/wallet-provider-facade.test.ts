import { describe, expect, it, vi } from "vitest";
import { createWalletProviderFacade } from "./wallet-provider-facade.js";

describe("Wallet provider facade", () => {
  it("exposes provider selection, adapter creation, and scoped RPC resolution", () => {
    const adapter = { id: "fixture-provider" };
    const createAdapter = vi.fn(() => adapter);
    const resolveId = vi.fn(() => "local-socket-signer");
    const resolveRpcUrl = vi.fn(() => "https://rpc.example.test");
    const facade = createWalletProviderFacade({
      createAdapter: createAdapter as never,
      resolveId: resolveId as never,
      resolveRpcUrl: resolveRpcUrl as never,
    });
    const config = { wallet: { enabled: true } };
    const env = { FASED_WALLET_PROVIDER: "local-socket-signer" };
    const wallet = { chains: ["solana"] };

    expect(facade.resolveId(config as never, env)).toBe("local-socket-signer");
    expect(facade.createAdapter({ cfg: config as never, wallet: wallet as never, env })).toBe(
      adapter,
    );
    expect(facade.resolveRpcUrl({ env, chains: ["solana"], walletId: "primary" })).toBe(
      "https://rpc.example.test",
    );
    expect(resolveId).toHaveBeenCalledWith(config, env);
    expect(createAdapter).toHaveBeenCalledWith({ cfg: config, wallet, env });
    expect(resolveRpcUrl).toHaveBeenCalledWith({
      env,
      chains: ["solana"],
      walletId: "primary",
    });
  });
});
