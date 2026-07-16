import { describe, expect, test, vi } from "vitest";
import { WalletProviderError } from "../wallet-provider-adapter.js";
import { WalletStandardAdapter } from "./wallet-standard-adapter.js";

describe("WalletStandardAdapter", () => {
  test("reports browser-only signing capabilities", async () => {
    const adapter = new WalletStandardAdapter({
      address: "So11111111111111111111111111111111111111112",
      rpcUrl: "https://rpc.invalid",
    });

    expect(adapter.capabilities).toMatchObject({
      signingLocation: "browser",
      supportsSignTransaction: true,
      supportsSignMessage: false,
      supportsSend: false,
      supportedExecutionModes: ["manual"],
    });
    expect(await adapter.getAddresses()).toEqual({
      solana: "So11111111111111111111111111111111111111112",
    });
  });

  test("never exposes a server-side send path", async () => {
    const adapter = new WalletStandardAdapter();
    await expect(adapter.sendTx({ chain: "solana" })).rejects.toMatchObject({
      code: "wallet_provider_browser_required",
    } satisfies Partial<WalletProviderError>);
  });

  test("does not fabricate a zero balance when RPC is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const adapter = new WalletStandardAdapter({
      address: "So11111111111111111111111111111111111111112",
      rpcUrl: "https://rpc.invalid",
    });

    await expect(adapter.getBalance("solana")).rejects.toMatchObject({
      code: "wallet_provider_unavailable",
    } satisfies Partial<WalletProviderError>);
    vi.unstubAllGlobals();
  });
});
