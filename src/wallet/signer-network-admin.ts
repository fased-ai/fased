import { configureSignerOwnedWalletPrimaryRpc } from "./local-socket-signer-lifecycle.js";
import { resolveLocalSignerSocketPath } from "./wallet-runtime-config.js";

export type SignerNetworkSummary = {
  walletId: string;
  configured: boolean;
  version: number;
  hash?: string;
  ready: boolean;
};

export type SignerPolicyInstallSummary = {
  walletId: string;
  role: "agent" | "mining" | "vault" | "profile" | "strategy";
  version: number;
  hash: string;
};

function canonicalSignerWalletId(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "default";
}

function parseSignerNetworkSummary(raw: string, expectedWalletId: string): SignerNetworkSummary {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("signer network administration returned invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("signer network administration returned an invalid summary");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  const allowedKeys =
    record.hash === undefined
      ? ["configured", "ready", "version", "walletId"]
      : ["configured", "hash", "ready", "version", "walletId"];
  if (keys.join(",") !== allowedKeys.join(",")) {
    throw new Error("signer network administration returned unsupported summary fields");
  }
  if (
    record.walletId !== expectedWalletId ||
    typeof record.configured !== "boolean" ||
    !Number.isSafeInteger(record.version) ||
    Number(record.version) < 0 ||
    typeof record.ready !== "boolean" ||
    (record.hash !== undefined &&
      (typeof record.hash !== "string" || !/^hmac-sha256:[0-9a-f]{64}$/.test(record.hash)))
  ) {
    throw new Error("signer network administration returned an invalid summary");
  }
  return {
    walletId: record.walletId,
    configured: record.configured,
    version: Number(record.version),
    ...(typeof record.hash === "string" ? { hash: record.hash } : {}),
    ready: record.ready,
  };
}

export async function configureSignerOwnedWalletNetwork(params: {
  walletId: string;
  primaryRpcUrl: string;
  executionFallbackRpcUrl?: string;
  verificationRpcUrl?: string;
  env?: NodeJS.ProcessEnv;
  socketPath?: string;
}): Promise<SignerNetworkSummary> {
  const env = params.env ?? process.env;
  const walletId = canonicalSignerWalletId(params.walletId);
  const primaryRpcUrl = params.primaryRpcUrl.trim();
  const executionFallbackRpcUrl = params.executionFallbackRpcUrl?.trim() || "";
  const verificationRpcUrl = params.verificationRpcUrl?.trim() || "";
  if (!primaryRpcUrl) {
    throw new Error("signer-owned wallet network requires a primary RPC URL");
  }
  if (executionFallbackRpcUrl || verificationRpcUrl) {
    throw new Error(
      "Normal wallet setup accepts one primary RPC. Configure an advanced execution fallback or explicit witness with the native signer admin network command.",
    );
  }
  return configureSignerOwnedWalletPrimaryRpc({
    socketPath: params.socketPath ?? resolveLocalSignerSocketPath(env),
    walletId,
    primaryRpcUrl,
  });
}

/**
 * Hosted policy changes are deliberately unavailable to the app process. New signer-owned
 * wallets are born deny-all; policy expansion requires the root-only installed policy CLI.
 */
export function applyHostedSignerOwnedWalletPolicy(params: {
  walletId: string;
  policy: {
    walletId?: string;
    role: "agent" | "mining" | "vault" | "profile" | "strategy";
    operations: string[];
    programs: string[];
    assets: unknown[];
  };
  env?: NodeJS.ProcessEnv;
}): SignerPolicyInstallSummary {
  void (params.env ?? process.env);
  const walletId = canonicalSignerWalletId(params.walletId);
  if (
    params.policy.operations.length !== 0 ||
    params.policy.programs.length !== 0 ||
    params.policy.assets.length !== 0
  ) {
    throw new Error("Fresh hosted signer setup accepts only the signer's built-in deny-all policy");
  }
  throw new Error(
    `Hosted signer policy for ${walletId} requires the root-only ` +
      "/usr/local/sbin/fased-signer-policy command and a root-owned policy file.",
  );
}

export const __testing = {
  canonicalSignerWalletId,
  parseSignerNetworkSummary,
};
