import { describe, expect, it } from "vitest";
import { normalizeHostedWalletPaths } from "./wallet-path-migration.js";

describe("normalizeHostedWalletPaths", () => {
  it("rewrites stale /home/root wallet env paths to the current state dir", () => {
    const next = normalizeHostedWalletPaths(
      {
        env: {
          vars: {
            FASED_WALLET_SOLANA_KEYSTORE_PATH: "/home/root/.fased/wallet/keystore-solana.v1.enc",
            FASED_WALLET_LOCAL_SIGNER_SOCKET: "/home/root/.fased/wallet/local-signer.sock",
            FASED_WALLET_SIGNER_STATE_DIR: "/home/root/.fased/wallet",
          },
        },
      },
      {
        HOME: "/home/app",
      } as NodeJS.ProcessEnv,
    );

    expect(next.env?.vars?.FASED_WALLET_SOLANA_KEYSTORE_PATH).toBe(
      "/home/app/.fased/wallet/keystore-solana.v1.enc",
    );
    expect(next.env?.vars?.FASED_WALLET_LOCAL_SIGNER_SOCKET).toBe(
      "/home/app/.fased/wallet/local-signer.sock",
    );
    expect(next.env?.vars?.FASED_WALLET_SIGNER_STATE_DIR).toBe("/home/app/.fased/wallet");
  });

  it("rewrites stale root wallet.keystore.path too", () => {
    const next = normalizeHostedWalletPaths(
      {
        wallet: {
          provider: { id: "embedded-keystore" },
          keystore: {
            path: "/home/root/.fased/wallet/keystore.v1.enc",
          },
        },
      },
      {
        HOME: "/home/app",
      } as NodeJS.ProcessEnv,
    );

    expect(next.wallet?.keystore?.path).toBe("/home/app/.fased/wallet/keystore.v1.enc");
  });
});
