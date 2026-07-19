import { LOCAL_SIGNER_NATIVE_FEE_RESERVATION_LAMPORTS_V2 } from "./local-socket-signer-protocol.js";
import type { LocalSocketSignerNetworkSummaryV2 } from "./local-socket-signer-protocol.js";
import {
  callLocalSocketSigner,
  type LocalSocketSignerHealthProbe,
} from "./providers/local-socket-signer-adapter.js";

export type LocalSignerWalletRole = "agent" | "mining" | "vault";

export type LocalSignerWalletPublicRecord = {
  walletId: string;
  publicKey: string;
  version: number;
  createdAt: string;
  rotatedAt?: string;
};

export type LocalSignerPolicyRecord = {
  walletId: string;
  role: LocalSignerWalletRole;
  version: number;
  operations: string[];
  programs: string[];
  assets: Array<{
    asset: string;
    destinations: string[];
    maxPerTx: string;
    maxDaily: string;
  }>;
  hash: string;
};

export type LocalSignerWalletPolicyRecord = {
  wallet: LocalSignerWalletPublicRecord;
  policy: LocalSignerPolicyRecord;
};

export function lockedLocalSignerPolicy(role: LocalSignerWalletRole) {
  return {
    role,
    operations: [] as string[],
    programs: [] as string[],
    assets: [] as LocalSignerPolicyRecord["assets"],
  };
}

async function requireSignerOwnedProtocolV2(socketPath: string): Promise<void> {
  const result = await callLocalSocketSigner<{
    ready?: boolean;
    capabilities?: LocalSocketSignerHealthProbe["capabilities"];
  }>(socketPath, { op: "v2.capabilities" });
  const capabilities = result.capabilities;
  const required = [
    "failClosedPolicies",
    "policyHashes",
    "signerOwnedKeys",
    "applicationNetworkBootstrap",
    "atomicMultiAssetCaps",
    "signerControlledNativeFeeCaps",
  ];
  const missing = required.filter((feature) => !capabilities?.features.includes(feature));
  if (
    result.ready !== true ||
    capabilities?.protocol.current !== 2 ||
    capabilities.protocol.min > 2 ||
    capabilities.protocol.max < 2 ||
    capabilities.nativeFeeReservationLamports !== LOCAL_SIGNER_NATIVE_FEE_RESERVATION_LAMPORTS_V2 ||
    missing.length > 0
  ) {
    throw new Error(
      `fased-signerd does not provide the required signer-owned protocol-v2 capabilities${missing.length > 0 ? `: ${missing.join(", ")}` : ""}`,
    );
  }
}

export async function readSignerOwnedWallet(params: {
  socketPath: string;
  walletId: string;
}): Promise<LocalSignerWalletPolicyRecord> {
  const [wallet, policy] = await Promise.all([
    callLocalSocketSigner<LocalSignerWalletPublicRecord>(params.socketPath, {
      op: "v2.wallet.get",
      walletId: params.walletId,
    }),
    callLocalSocketSigner<LocalSignerPolicyRecord>(params.socketPath, {
      op: "v2.policy.get",
      walletId: params.walletId,
    }),
  ]);
  return { wallet, policy };
}

/**
 * Create a signer-owned key without returning its secret to normal Fased Node code. Local runs the
 * signer under the same OS account, so this code-path separation is not a hard compromise boundary.
 *
 * The application socket may create only this explicit empty/deny-all policy. Policy expansion is
 * a separate signer-admin action, so a compromised Gateway cannot turn key creation into spending.
 */
export async function createLockedSignerOwnedWallet(params: {
  socketPath: string;
  walletId: string;
  role: LocalSignerWalletRole;
  allowExisting?: boolean;
}): Promise<LocalSignerWalletPolicyRecord> {
  const walletId = params.walletId.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(walletId)) {
    throw new Error("walletId must contain only letters, numbers, hyphens, or underscores");
  }
  await requireSignerOwnedProtocolV2(params.socketPath);
  try {
    const existing = await readSignerOwnedWallet({ socketPath: params.socketPath, walletId });
    if (!params.allowExisting) {
      throw new Error(`signer-owned wallet already exists: ${walletId}`);
    }
    if (existing.policy.role !== params.role) {
      throw new Error(
        `signer-owned wallet ${walletId} already has role=${existing.policy.role}, not ${params.role}`,
      );
    }
    return existing;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("signer-owned wallet")) {
      throw error;
    }
  }

  try {
    return await callLocalSocketSigner<LocalSignerWalletPolicyRecord>(params.socketPath, {
      op: "v2.wallet.create",
      walletId,
      request: {
        expectedPolicyVersion: 0,
        policy: lockedLocalSignerPolicy(params.role),
      },
    });
  } catch (error) {
    if (!params.allowExisting) {
      throw error;
    }
    // A concurrent, identical create may have won. Read back the durable result; role mismatch
    // still fails closed above on the normal retry path.
    const existing = await readSignerOwnedWallet({ socketPath: params.socketPath, walletId });
    if (existing.policy.role !== params.role) {
      throw new Error(
        `signer-owned wallet ${walletId} was concurrently created with role=${existing.policy.role}`,
        { cause: error },
      );
    }
    return existing;
  }
}

export async function configureSignerOwnedWalletPrimaryRpc(params: {
  socketPath: string;
  walletId: string;
  primaryRpcUrl: string;
}): Promise<LocalSocketSignerNetworkSummaryV2> {
  const walletId = params.walletId.trim();
  const primaryRpcUrl = params.primaryRpcUrl.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(walletId)) {
    throw new Error("walletId must contain only letters, numbers, hyphens, or underscores");
  }
  if (!primaryRpcUrl) {
    throw new Error("signer-owned wallet network requires one primary RPC URL");
  }
  await requireSignerOwnedProtocolV2(params.socketPath);
  const current = await callLocalSocketSigner<LocalSocketSignerNetworkSummaryV2>(
    params.socketPath,
    { op: "v2.network.get", walletId },
  );
  const updated = await callLocalSocketSigner<LocalSocketSignerNetworkSummaryV2>(
    params.socketPath,
    {
      op: "v2.network.bootstrap",
      walletId,
      request: { expectedVersion: current.version, primaryRpcUrl },
    },
  );
  if (
    updated.walletId !== walletId ||
    !updated.configured ||
    !updated.ready ||
    updated.version !== current.version + 1 ||
    !updated.hash
  ) {
    throw new Error("signer-owned RPC activation did not return the exact next ready version");
  }
  return updated;
}
