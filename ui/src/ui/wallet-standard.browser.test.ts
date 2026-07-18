import type { Wallet } from "@wallet-standard/base";
import { describe, expect, test, vi } from "vitest";

const registry = vi.hoisted(() => ({ wallets: [] as Wallet[] }));

vi.mock("@wallet-standard/app", () => ({
  getWallets: () => ({ get: () => registry.wallets }),
}));

import { connectWalletStandardAccount, signWalletStandardTransaction } from "./wallet-standard.ts";

function compatibleWallet(params?: { address?: string; signed?: Uint8Array }): Wallet {
  const address = params?.address ?? "So11111111111111111111111111111111111111112";
  const account = {
    address,
    publicKey: new Uint8Array(32),
    chains: ["solana:mainnet"],
    features: ["solana:signTransaction"],
  };
  return {
    version: "1.0.0",
    name: "Hardware Wallet",
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
    chains: ["solana:mainnet"],
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: vi.fn(async () => ({ accounts: [account] })),
      },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy"],
        signTransaction: vi.fn(async () => [
          { signedTransaction: params?.signed ?? new Uint8Array([1, 2, 3]) },
        ]),
      },
    },
    accounts: [],
  } as unknown as Wallet;
}

describe("Wallet Standard browser signing", () => {
  test("selects the exact expected Solana account and returns only signed bytes", async () => {
    const wallet = compatibleWallet({ signed: new Uint8Array([7, 8, 9]) });
    registry.wallets = [wallet];

    const connected = await connectWalletStandardAccount({
      expectedAddress: "So11111111111111111111111111111111111111112",
    });
    const signed = await signWalletStandardTransaction({
      unsignedTxBase64: btoa(String.fromCharCode(4, 5, 6)),
      expectedAddress: connected.account.address,
      chain: "solana:mainnet",
    });

    expect(signed).toEqual({
      signedTxBase64: btoa(String.fromCharCode(7, 8, 9)),
      walletName: "Hardware Wallet",
      accountAddress: "So11111111111111111111111111111111111111112",
    });
  });

  test("refuses a different connected account", async () => {
    registry.wallets = [compatibleWallet()];

    await expect(
      connectWalletStandardAccount({ expectedAddress: "11111111111111111111111111111111" }),
    ).rejects.toThrow("is not connected to the reviewed account");
  });
});
