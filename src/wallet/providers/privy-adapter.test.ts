import { describe, expect, test } from "vitest";
import { WalletProviderError } from "../wallet-provider-adapter.js";
import { PrivyAdapter } from "./privy-adapter.js";

function createAdapter(defaultSolanaAddress?: string) {
  return new PrivyAdapter({
    chains: ["solana"],
    credentials: {
      appId: "privy-app",
      appSecret: "privy-secret",
      defaultSolanaAddress,
    },
    service: {
      host: "127.0.0.1",
      port: 0,
    },
  });
}

describe("PrivyAdapter", () => {
  test("reports discovery-only Privy configuration as unavailable", async () => {
    const adapter = createAdapter("So11111111111111111111111111111111111111112");

    const health = await adapter.health();
    const addresses = await adapter.getAddresses();

    expect(health.ok).toBe(false);
    expect(health.configured).toBe(true);
    expect(adapter.capabilities.supportedChains).toEqual(["solana"]);
    expect(adapter.capabilities.supportsSend).toBe(false);
    expect(addresses).toEqual({ solana: "So11111111111111111111111111111111111111112" });
  });

  test("requires a configured Solana address for balance checks", async () => {
    const adapter = createAdapter();

    await expect(adapter.getBalance("solana")).rejects.toMatchObject({
      code: "wallet_provider_invalid_config",
    } satisfies Partial<WalletProviderError>);
  });

  test("does not expose provider-managed transaction sending", async () => {
    const adapter = createAdapter("So11111111111111111111111111111111111111112");

    await expect(
      adapter.sendTx({
        chain: "solana",
        to: "So11111111111111111111111111111111111111112",
        amount: "1",
      }),
    ).rejects.toMatchObject({
      code: "wallet_provider_not_implemented",
    } satisfies Partial<WalletProviderError>);
  });
});
