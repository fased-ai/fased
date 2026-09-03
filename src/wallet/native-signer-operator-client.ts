import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  validateLocalSocketSignerResult,
  type LocalSocketSignerRPCProfileBindingV1,
  type LocalSocketSignerRPCProfileSummaryV1,
} from "./local-socket-signer-protocol.js";
import type { LocalSocketSignerHealthProbe } from "./providers/local-socket-signer-adapter.js";
import { redactWalletDiagnosticText } from "./wallet-redaction.js";

export type NativeSignerOperatorCapabilities = {
  ready: true;
  capabilities: {
    protocol: {
      current: 2;
      min: number;
      max: number;
    };
    features: string[];
  };
};

function lifecycleEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    HOME: env.HOME,
    LANG: env.LANG || "C.UTF-8",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
}

function invokeNativeSignerOperatorJSON(params: {
  signerBinPath: string;
  operatorSocketPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  label: string;
  input?: string;
}): unknown {
  if (
    !path.isAbsolute(params.signerBinPath) ||
    path.resolve(params.signerBinPath) !== params.signerBinPath
  ) {
    throw new Error("native signer binary path must be absolute and clean");
  }
  if (
    !path.isAbsolute(params.operatorSocketPath) ||
    path.resolve(params.operatorSocketPath) !== params.operatorSocketPath
  ) {
    throw new Error("native signer operator socket path must be absolute and clean");
  }
  const child = spawnSync(
    params.signerBinPath,
    ["admin", ...params.args, "--operator-socket", params.operatorSocketPath],
    {
      env: lifecycleEnv(params.env),
      input: params.input,
      stdio: [params.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      timeout: 30_000,
    },
  );
  if (child.error) {
    throw new Error(`${params.label} failed: ${child.error.message}`, { cause: child.error });
  }
  if (child.status !== 0) {
    const detail = redactWalletDiagnosticText(
      String(child.stderr || `${params.label} failed`).trim(),
    );
    throw new Error(detail || `${params.label} failed`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(child.stdout ?? ""));
  } catch {
    throw new Error(`${params.label} returned invalid JSON`);
  }
  return parsed;
}

export function invokeNativeSignerOperatorCapabilities(params: {
  signerBinPath: string;
  operatorSocketPath: string;
  env?: NodeJS.ProcessEnv;
}): NativeSignerOperatorCapabilities {
  const raw = invokeNativeSignerOperatorJSON({
    signerBinPath: params.signerBinPath,
    operatorSocketPath: params.operatorSocketPath,
    args: ["service", "capabilities"],
    env: params.env ?? process.env,
    label: "native signer capabilities",
  });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("native signer capabilities returned an invalid result");
  }
  const result = raw as Record<string, unknown>;
  const capabilities =
    result.capabilities &&
    typeof result.capabilities === "object" &&
    !Array.isArray(result.capabilities)
      ? (result.capabilities as Record<string, unknown>)
      : undefined;
  const protocol =
    capabilities?.protocol &&
    typeof capabilities.protocol === "object" &&
    !Array.isArray(capabilities.protocol)
      ? (capabilities.protocol as Record<string, unknown>)
      : undefined;
  const features = Array.isArray(capabilities?.features)
    ? capabilities.features.filter((value): value is string => typeof value === "string")
    : [];
  if (
    result.ready !== true ||
    protocol?.current !== 2 ||
    !Number.isSafeInteger(protocol.min) ||
    !Number.isSafeInteger(protocol.max)
  ) {
    throw new Error("native signer capabilities did not acknowledge protocol v2 readiness");
  }
  return {
    ready: true,
    capabilities: {
      protocol: {
        current: 2,
        min: Number(protocol.min),
        max: Number(protocol.max),
      },
      features,
    },
  };
}

export function invokeNativeSignerOperatorHealth(params: {
  signerBinPath: string;
  operatorSocketPath: string;
  env?: NodeJS.ProcessEnv;
}): LocalSocketSignerHealthProbe {
  const result = invokeNativeSignerOperatorJSON({
    signerBinPath: params.signerBinPath,
    operatorSocketPath: params.operatorSocketPath,
    args: ["service", "health"],
    env: params.env ?? process.env,
    label: "native signer health",
  });
  if (!validateLocalSocketSignerResult("health", result)) {
    throw new Error("native signer health returned an invalid protocol v2 result");
  }
  return {
    ok: true,
    ...(result as Omit<LocalSocketSignerHealthProbe, "ok">),
  };
}

export function invokeNativeSignerRPCProfileList(params: {
  signerBinPath: string;
  operatorSocketPath: string;
  env?: NodeJS.ProcessEnv;
}): LocalSocketSignerRPCProfileSummaryV1[] {
  const result = invokeNativeSignerOperatorJSON({
    signerBinPath: params.signerBinPath,
    operatorSocketPath: params.operatorSocketPath,
    args: ["rpc-profile", "list"],
    env: params.env ?? process.env,
    label: "native signer RPC profile list",
  });
  if (!validateLocalSocketSignerResult("v2.rpcProfile.list", result)) {
    throw new Error("native signer RPC profile list returned an invalid result");
  }
  return result as LocalSocketSignerRPCProfileSummaryV1[];
}

export function invokeNativeSignerRPCProfileCreate(params: {
  signerBinPath: string;
  operatorSocketPath: string;
  profileId: string;
  name: string;
  primaryRpcUrl: string;
  websocketRpcUrl?: string;
  executionFallbackRpcUrl?: string;
  verificationRpcUrl?: string;
  env?: NodeJS.ProcessEnv;
}): LocalSocketSignerRPCProfileSummaryV1 {
  const result = invokeNativeSignerOperatorJSON({
    signerBinPath: params.signerBinPath,
    operatorSocketPath: params.operatorSocketPath,
    args: ["rpc-profile", "create"],
    input: JSON.stringify({
      profileId: params.profileId,
      name: params.name,
      primaryRpcUrl: params.primaryRpcUrl,
      ...(params.websocketRpcUrl ? { websocketRpcUrl: params.websocketRpcUrl } : {}),
      ...(params.executionFallbackRpcUrl
        ? { executionFallbackRpcUrl: params.executionFallbackRpcUrl }
        : {}),
      ...(params.verificationRpcUrl ? { verificationRpcUrl: params.verificationRpcUrl } : {}),
      commitment: "finalized",
    }),
    env: params.env ?? process.env,
    label: "native signer RPC profile create",
  });
  if (!validateLocalSocketSignerResult("v2.rpcProfile.create", result)) {
    throw new Error("native signer RPC profile create returned an invalid result");
  }
  return result as LocalSocketSignerRPCProfileSummaryV1;
}

export function invokeNativeSignerRPCProfileBind(params: {
  signerBinPath: string;
  operatorSocketPath: string;
  walletId: string;
  profile: Pick<LocalSocketSignerRPCProfileSummaryV1, "profileId" | "version" | "hash">;
  env?: NodeJS.ProcessEnv;
}): LocalSocketSignerRPCProfileBindingV1 {
  const result = invokeNativeSignerOperatorJSON({
    signerBinPath: params.signerBinPath,
    operatorSocketPath: params.operatorSocketPath,
    args: [
      "rpc-profile",
      "bind",
      "--wallet-id",
      params.walletId,
      "--profile-id",
      params.profile.profileId,
      "--profile-version",
      String(params.profile.version),
      "--profile-hash",
      params.profile.hash,
    ],
    env: params.env ?? process.env,
    label: "native signer RPC profile bind",
  });
  if (!validateLocalSocketSignerResult("v2.rpcProfile.bind", result)) {
    throw new Error("native signer RPC profile bind returned an invalid result");
  }
  return result as LocalSocketSignerRPCProfileBindingV1;
}
