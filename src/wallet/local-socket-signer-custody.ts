import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import { resolveLocalSignerBackendSocketPath } from "./wallet-runtime-config.js";

export type LocalSignerCustodyStatus = {
  active: boolean;
  sessionId?: string;
  host?: string;
  expiresAt?: string;
  walletId?: string;
  role?: "mining" | "agent" | "vault";
  chains?: Array<"solana">;
  allowPrograms?: string[];
  solanaMaxPerTx?: string;
  solanaMaxDaily?: string;
};

export async function readLocalSignerCustodyStatus(
  walletId?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalSignerCustodyStatus> {
  return await callLocalSocketSigner<LocalSignerCustodyStatus>(
    resolveLocalSignerBackendSocketPath(env),
    {
      op: "custodyStatus",
      ...(walletId?.trim() ? { walletId: walletId.trim() } : {}),
    },
  );
}

export async function unlockLocalSignerCustody(params: {
  sessionId: string;
  host: string;
  walletId: string;
  role?: "mining" | "agent" | "vault";
  chains?: Array<"solana">;
  allowPrograms?: string[];
  expiresAt: string;
  passphrase: string;
  solanaMaxPerTx?: string;
  solanaMaxDaily?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<LocalSignerCustodyStatus> {
  const env = params.env ?? process.env;
  return await callLocalSocketSigner<LocalSignerCustodyStatus>(
    resolveLocalSignerBackendSocketPath(env),
    {
      op: "unlockCustody",
      request: {
        sessionId: params.sessionId,
        host: params.host,
        walletId: params.walletId,
        ...(params.role ? { role: params.role } : {}),
        ...(params.chains?.length ? { chains: params.chains } : {}),
        ...(params.allowPrograms?.length ? { allowPrograms: params.allowPrograms } : {}),
        expiresAt: params.expiresAt,
        passphrase: params.passphrase,
        ...(params.solanaMaxPerTx ? { solanaMaxPerTx: params.solanaMaxPerTx } : {}),
        ...(params.solanaMaxDaily ? { solanaMaxDaily: params.solanaMaxDaily } : {}),
      },
    },
  );
}

export async function lockLocalSignerCustody(params?: {
  sessionId?: string;
  host?: string;
  walletId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ active: boolean; removed: boolean }> {
  const env = params?.env ?? process.env;
  return await callLocalSocketSigner<{ active: boolean; removed: boolean }>(
    resolveLocalSignerBackendSocketPath(env),
    {
      op: "lockCustody",
      request: {
        ...(params?.sessionId?.trim() ? { sessionId: params.sessionId.trim() } : {}),
        ...(params?.host?.trim() ? { host: params.host.trim() } : {}),
        ...(params?.walletId?.trim() ? { walletId: params.walletId.trim() } : {}),
      },
    },
  );
}
