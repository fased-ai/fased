import {
  createWalletProviderAdapter,
  resolveScopedRpcUrlForWallet,
  resolveWalletProviderId,
} from "./wallet-provider-resolver.js";

export type WalletProviderFacade = {
  createAdapter: typeof createWalletProviderAdapter;
  resolveId: typeof resolveWalletProviderId;
  resolveRpcUrl: typeof resolveScopedRpcUrlForWallet;
};

type WalletProviderFacadeDependencies = WalletProviderFacade;

export function createWalletProviderFacade(
  overrides: Partial<WalletProviderFacadeDependencies> = {},
): WalletProviderFacade {
  return {
    createAdapter: createWalletProviderAdapter,
    resolveId: resolveWalletProviderId,
    resolveRpcUrl: resolveScopedRpcUrlForWallet,
    ...overrides,
  };
}

export const walletProviderFacade = createWalletProviderFacade();
