import { describe, expect, test } from "vitest";
import type { WalletProviderAdapter } from "./wallet-provider-adapter.js";
import {
  buildWalletProviderCapabilityMatrix,
  extractRpcApiKeyFromUrl,
  inferRpcProviderFromUrl,
  validateRpcProviderChainCompatibility,
} from "./wallet-provider-capabilities.js";

function createAdapter(overrides: Partial<WalletProviderAdapter>): WalletProviderAdapter {
  const id = overrides.id ?? "alchemy";
  return {
    id,
    displayName: overrides.displayName ?? "test-provider",
    capabilities: overrides.capabilities ?? {
      custodyModel: id === "embedded-keystore" ? "self-hosted" : "provider-managed",
      supportsCreateWallet: true,
      supportsPrepare: true,
      supportsSend: true,
      supportsRotateKeys: false,
      supportsResetKeys: false,
      supportsPasskeyGate: false,
      supportedExecutionModes: ["manual", "autonomous"],
      supportedChains: ["solana"],
    },
    supportsChain: overrides.supportsChain ?? (() => true),
    health:
      overrides.health ??
      (async () => ({
        ok: true,
        provider: id,
        configured: true,
        checkedAt: new Date().toISOString(),
      })),
    createWallet: overrides.createWallet,
    getAddresses:
      overrides.getAddresses ??
      (async () => ({ solana: "So11111111111111111111111111111111111111112" })),
    getBalance:
      overrides.getBalance ??
      (async (chain) => ({
        ok: true,
        chain,
        address: "So11111111111111111111111111111111111111112",
        balance: "1",
      })),
    prepareTx:
      overrides.prepareTx ??
      (async (request) => ({
        ok: true,
        chain: request.chain,
        preparedId: "prep",
      })),
    sendTx:
      overrides.sendTx ??
      (async (request) => ({
        ok: true,
        chain: request.chain,
        txHash: "0xtx",
      })),
    rotateKeys: overrides.rotateKeys,
    resetKeys: overrides.resetKeys,
  };
}

describe("wallet provider capabilities", () => {
  test("alchemy keeps outbound wallet sends disabled in Solana-only runtime", () => {
    const matrix = buildWalletProviderCapabilityMatrix(
      createAdapter({
        id: "alchemy",
        capabilities: {
          custodyModel: "provider-managed",
          supportsCreateWallet: true,
          supportsPrepare: true,
          supportsSend: true,
          supportsRotateKeys: false,
          supportsResetKeys: false,
          supportsPasskeyGate: false,
          supportedExecutionModes: ["manual", "autonomous"],
          supportedChains: ["solana"],
        },
      }),
    );
    expect(matrix.integrationMode).toBe("native");
    expect(matrix.chains.solana.send).toBe(false);
  });

  test("turnkey is explicitly marked as native integration mode", () => {
    const matrix = buildWalletProviderCapabilityMatrix(
      createAdapter({
        id: "turnkey",
      }),
    );
    expect(matrix.integrationMode).toBe("native");
  });
});

describe("rpc provider compatibility", () => {
  test("helius rejects multi chain settings", () => {
    expect(
      validateRpcProviderChainCompatibility({
        provider: "helius",
        chain: "multi",
      }).ok,
    ).toBe(false);
  });

  test("alchemy and quicknode reject multi-chain wallet settings", () => {
    expect(
      validateRpcProviderChainCompatibility({
        provider: "alchemy",
        chain: "multi",
      }).ok,
    ).toBe(false);
    expect(
      validateRpcProviderChainCompatibility({
        provider: "quicknode",
        chain: "multi",
      }).ok,
    ).toBe(false);
  });

  test("unknown providers stay permissive", () => {
    expect(
      validateRpcProviderChainCompatibility({
        provider: "custom-rpc",
        chain: "solana",
      }).ok,
    ).toBe(true);
  });

  test("infers provider from known RPC URL hosts", () => {
    expect(inferRpcProviderFromUrl("https://solana-mainnet.g.alchemy.com/v2/demo-key")).toBe(
      "alchemy",
    );
    expect(inferRpcProviderFromUrl("https://mainnet.helius-rpc.com/?api-key=abc")).toBe("helius");
    expect(inferRpcProviderFromUrl("https://example.invalid/rpc")).toBeUndefined();
  });

  test("extracts API key from RPC URL query or v2 path", () => {
    expect(extractRpcApiKeyFromUrl("https://mainnet.helius-rpc.com/?api-key=helius-demo-key")).toBe(
      "helius-demo-key",
    );
    expect(extractRpcApiKeyFromUrl("https://eth-mainnet.g.alchemy.com/v2/alchemy-demo-key")).toBe(
      "alchemy-demo-key",
    );
    expect(extractRpcApiKeyFromUrl("https://rpc.unknown.example/")).toBeUndefined();
  });
});
