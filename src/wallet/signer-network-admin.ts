import { spawnSync } from "node:child_process";
import path from "node:path";
import { resolveLocalSignerControlSocketPath } from "./wallet-runtime-config.js";

const NETWORK_ADMIN_TIMEOUT_MS = 30_000;
const NETWORK_ADMIN_MAX_OUTPUT_BYTES = 256 * 1024;

export type SignerNetworkSummary = {
  walletId: string;
  configured: boolean;
  version: number;
  hash?: string;
  ready: boolean;
  rootAdminRequired?: boolean;
  rootCommand?: string;
};

export type SignerPolicyInstallSummary = {
  walletId: string;
  role: "agent" | "mining" | "vault";
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

function redactSignerNetworkError(raw: string, secrets: string[]): string {
  let value = raw;
  for (const secret of secrets.filter(Boolean).toSorted((a, b) => b.length - a.length)) {
    value = value.split(secret).join("[redacted-rpc-url]");
  }
  value = value.replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-rpc-url]");
  value = value.replace(
    /\b(api[_-]?key|access[_-]?token|token|key)=([^\s&"']+)/gi,
    "$1=[redacted]",
  );
  return value.trim().slice(0, 2_000) || "signer network administration failed";
}

function signerAdminEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "TZ"] as const) {
    const value = String(env[key] ?? "").trim();
    if (value) {
      out[key] = value;
    }
  }
  return out;
}

function runSignerAdmin(params: {
  command: string;
  args: string[];
  input?: string;
  env: NodeJS.ProcessEnv;
  secrets: string[];
}): string {
  const child = spawnSync(params.command, params.args, {
    input: params.input,
    env: params.env,
    encoding: "utf8",
    timeout: NETWORK_ADMIN_TIMEOUT_MS,
    maxBuffer: NETWORK_ADMIN_MAX_OUTPUT_BYTES,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (child.error || child.status !== 0) {
    const detail = [child.stderr, child.stdout, child.error?.message]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .join("\n");
    throw new Error(redactSignerNetworkError(detail, params.secrets));
  }
  return child.stdout;
}

function assertReadyNetworkSummary(
  summary: SignerNetworkSummary,
  previousVersion: number,
): SignerNetworkSummary {
  if (
    !summary.configured ||
    !summary.ready ||
    !summary.hash ||
    summary.version !== previousVersion + 1
  ) {
    throw new Error("signer network update did not acknowledge the exact next ready version");
  }
  return summary;
}

export function configureSignerOwnedWalletNetwork(params: {
  walletId: string;
  primaryRpcUrl: string;
  fallbackRpcUrl?: string;
  env?: NodeJS.ProcessEnv;
  signerBinPath?: string;
  controlSocketPath?: string;
}): SignerNetworkSummary {
  const env = params.env ?? process.env;
  const walletId = canonicalSignerWalletId(params.walletId);
  const primaryRpcUrl = params.primaryRpcUrl.trim();
  const fallbackRpcUrl = params.fallbackRpcUrl?.trim() || "";
  if (!primaryRpcUrl) {
    throw new Error("signer-owned wallet network requires a primary RPC URL");
  }
  const secrets = [primaryRpcUrl, fallbackRpcUrl];
  const hosting =
    String(env.FASED_HOST_PROFILE ?? "")
      .trim()
      .toLowerCase() === "hosting";

  if (hosting) {
    // The app/Gateway never receives a privileged root channel. Wallet creation remains
    // fail-closed; a host administrator activates RPC state later from a root-only file.
    return {
      walletId,
      configured: false,
      version: 0,
      ready: false,
      rootAdminRequired: true,
      rootCommand:
        `/usr/local/sbin/fased-signer-network --wallet-id ${walletId} ` +
        "--network-file /root/fased-network.json",
    };
  }

  const signerBinPath =
    params.signerBinPath ??
    (String(env.FASED_WALLET_LOCAL_SIGNER_BIN ?? "").trim() ||
      path.join(String(env.HOME ?? ""), ".fased", "bin", "fased-signerd"));
  const controlSocketPath = params.controlSocketPath ?? resolveLocalSignerControlSocketPath(env);
  const adminEnv = signerAdminEnvironment(env);
  const commonArgs = ["--control-socket", controlSocketPath, "--wallet-id", walletId];
  const current = parseSignerNetworkSummary(
    runSignerAdmin({
      command: signerBinPath,
      args: ["admin", "network", "get", ...commonArgs],
      env: adminEnv,
      secrets,
    }),
    walletId,
  );
  const input = `${JSON.stringify({
    expectedVersion: current.version,
    primaryRpcUrl,
    ...(fallbackRpcUrl ? { fallbackRpcUrl } : {}),
  })}\n`;
  const updated = parseSignerNetworkSummary(
    runSignerAdmin({
      command: signerBinPath,
      args: ["admin", "network", "put", ...commonArgs],
      input,
      env: adminEnv,
      secrets,
    }),
    walletId,
  );
  return assertReadyNetworkSummary(updated, current.version);
}

/**
 * Hosted policy changes are deliberately unavailable to the app process. New signer-owned
 * wallets are born deny-all; policy expansion requires the root-only installed policy CLI.
 */
export function applyHostedSignerOwnedWalletPolicy(params: {
  walletId: string;
  policy: {
    walletId?: string;
    role: "agent" | "mining" | "vault";
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
  redactSignerNetworkError,
  signerAdminEnvironment,
};
