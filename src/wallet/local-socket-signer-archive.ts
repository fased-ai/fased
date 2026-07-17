import type { LocalSocketSignerPolicyV2 } from "./local-socket-signer-protocol.js";
import { resolveNativeSignerWalletId } from "./native-signer-wallet-id.js";
import { LocalSocketSignerAdapter } from "./providers/local-socket-signer-adapter.js";
import type { WalletNamedWallet } from "./wallet-provider-registry.js";

type SignerPolicyLocker = Pick<LocalSocketSignerAdapter, "getSignerPolicy" | "tightenSignerPolicy">;

export async function lockSignerOwnedWalletForArchive(params: {
  wallet: Pick<WalletNamedWallet, "id" | "providerId" | "metadata">;
  socketPath: string;
  signer?: SignerPolicyLocker;
}): Promise<LocalSocketSignerPolicyV2> {
  const signerWalletId = resolveNativeSignerWalletId(params.wallet);
  const signer = params.signer ?? new LocalSocketSignerAdapter(params.socketPath);
  const current = await signer.getSignerPolicy(signerWalletId);
  if (current.walletId !== signerWalletId) {
    throw new Error("native signer returned policy state for a different wallet");
  }
  const acknowledged = await signer.tightenSignerPolicy({
    walletId: signerWalletId,
    expectedVersion: current.version,
    policy: {
      walletId: signerWalletId,
      role: current.role,
      operations: [],
      programs: [],
      assets: [],
    },
  });
  if (
    acknowledged.operations.length !== 0 ||
    acknowledged.programs.length !== 0 ||
    acknowledged.assets.length !== 0
  ) {
    throw new Error("native signer did not durably acknowledge the exact deny-all archive policy");
  }
  return acknowledged;
}
