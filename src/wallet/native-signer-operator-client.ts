import { spawnSync } from "node:child_process";
import path from "node:path";
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
}): Record<string, unknown> {
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
      stdio: ["ignore", "pipe", "pipe"],
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${params.label} returned an invalid result`);
  }
  return parsed as Record<string, unknown>;
}

export function invokeNativeSignerOperatorCapabilities(params: {
  signerBinPath: string;
  operatorSocketPath: string;
  env?: NodeJS.ProcessEnv;
}): NativeSignerOperatorCapabilities {
  const result = invokeNativeSignerOperatorJSON({
    signerBinPath: params.signerBinPath,
    operatorSocketPath: params.operatorSocketPath,
    args: ["service", "capabilities"],
    env: params.env ?? process.env,
    label: "native signer capabilities",
  });
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
