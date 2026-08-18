import {
  readWalletStatusSnapshot,
  resolveWalletConfigForRuntime,
  summarizeWalletStatus,
} from "./wallet-status.js";

export type WalletReadinessFacade = {
  read: typeof readWalletStatusSnapshot;
  resolveRuntimeConfig: typeof resolveWalletConfigForRuntime;
  summarize: typeof summarizeWalletStatus;
};

type WalletReadinessFacadeDependencies = WalletReadinessFacade;

export function createWalletReadinessFacade(
  overrides: Partial<WalletReadinessFacadeDependencies> = {},
): WalletReadinessFacade {
  return {
    read: readWalletStatusSnapshot,
    resolveRuntimeConfig: resolveWalletConfigForRuntime,
    summarize: summarizeWalletStatus,
    ...overrides,
  };
}

export const walletReadinessFacade = createWalletReadinessFacade();
