import type { RuntimeEnv } from "../runtime.js";

export type WalletRetireOptions = {
  walletId: string;
  successorWalletId: string;
  successorWalletName: string;
  recoveryFile: string;
  rpcUrl: string;
  liveMiningStatus: unknown;
  json?: boolean;
};

export type WalletMiningRotationFacade = {
  retireAndReplace(runtime: RuntimeEnv, options: WalletRetireOptions): Promise<void>;
};

type WalletMiningRotationFacadeDependencies = WalletMiningRotationFacade;

export function createWalletMiningRotationFacade(
  overrides: Partial<WalletMiningRotationFacadeDependencies> = {},
): WalletMiningRotationFacade {
  return {
    retireAndReplace: async (runtime, options) => {
      const { walletRetireCommand } = await import("../commands/wallet.js");
      await walletRetireCommand(runtime, options);
    },
    ...overrides,
  };
}

export const walletMiningRotationFacade = createWalletMiningRotationFacade();
