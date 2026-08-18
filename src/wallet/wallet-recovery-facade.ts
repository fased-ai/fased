import type { RuntimeEnv } from "../runtime.js";

export type WalletRecoveryExportOptions = {
  walletId: string;
  output: string;
};

export type WalletRecoveryImportOptions = {
  walletId: string;
  walletName?: string;
  role: string;
  recoveryFile: string;
  rpcUrl: string;
};

export type WalletRawExportOptions = {
  walletId: string;
  output: string;
  acknowledgeCustodyReduction: boolean;
};

export type WalletRecoveryFacade = {
  exportEncrypted(runtime: RuntimeEnv, options: WalletRecoveryExportOptions): Promise<void>;
  restoreEncrypted(runtime: RuntimeEnv, options: WalletRecoveryImportOptions): Promise<void>;
  exportRaw(runtime: RuntimeEnv, options: WalletRawExportOptions): Promise<void>;
};

type WalletRecoveryFacadeDependencies = WalletRecoveryFacade;

export function createWalletRecoveryFacade(
  overrides: Partial<WalletRecoveryFacadeDependencies> = {},
): WalletRecoveryFacade {
  return {
    exportEncrypted: async (runtime, options) => {
      const { walletRecoveryExportCommand } = await import("../commands/wallet.js");
      await walletRecoveryExportCommand(runtime, options);
    },
    restoreEncrypted: async (runtime, options) => {
      const { walletRecoveryImportCommand } = await import("../commands/wallet.js");
      await walletRecoveryImportCommand(runtime, options);
    },
    exportRaw: async (runtime, options) => {
      const { walletRawExportCommand } = await import("../commands/wallet.js");
      await walletRawExportCommand(runtime, options);
    },
    ...overrides,
  };
}

export const walletRecoveryFacade = createWalletRecoveryFacade();
