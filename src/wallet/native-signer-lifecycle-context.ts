import path from "node:path";

export type NativeSignerOperatorLifecycleContext = {
  profile: "hosting" | "protected-local";
  instanceId?: string;
  signerBinPath: string;
  applicationSocketPath: string;
  operatorSocketPath: string;
  controlSocketPath: string;
  ownerHelperPath: string;
};

export function isProtectedLocalSigner(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.FASED_PROTECTED_LOCAL ?? "").trim() === "1";
}

export function resolveNativeSignerOperatorLifecycle(
  env: NodeJS.ProcessEnv = process.env,
): NativeSignerOperatorLifecycleContext | undefined {
  const hostProfile = String(env.FASED_HOST_PROFILE ?? "")
    .trim()
    .toLowerCase();
  if (hostProfile === "hosting") {
    return {
      profile: "hosting",
      signerBinPath: "/opt/fased/signer/fased-signerd",
      applicationSocketPath: "/run/fased-signerd/app.sock",
      operatorSocketPath: "/run/fased-signerd/operator.sock",
      controlSocketPath: "/run/fased-signerd/control.sock",
      ownerHelperPath: "/usr/local/sbin/fased-signer-owner",
    };
  }
  if (!isProtectedLocalSigner(env)) {
    return undefined;
  }
  const instanceId = String(env.FASED_PROTECTED_LOCAL_INSTANCE ?? "").trim();
  if (!/^[a-f0-9]{16}$/u.test(instanceId)) {
    throw new Error("Protected Local signer instance identity is missing or invalid");
  }
  const expectedSocket = `/run/fased-local/${instanceId}/application/app.sock`;
  const expectedBinary = `/opt/fased/local/${instanceId}/signer/fased-signerd`;
  const configuredSocket = String(env.FASED_WALLET_LOCAL_SIGNER_SOCKET ?? "").trim();
  const configuredBinary = String(env.FASED_WALLET_LOCAL_SIGNER_BIN ?? "").trim();
  if (
    configuredSocket !== expectedSocket ||
    !path.isAbsolute(configuredSocket) ||
    path.resolve(configuredSocket) !== configuredSocket
  ) {
    throw new Error(
      "Protected Local signer application socket does not match its instance identity",
    );
  }
  if (
    configuredBinary !== expectedBinary ||
    !path.isAbsolute(configuredBinary) ||
    path.resolve(configuredBinary) !== configuredBinary
  ) {
    throw new Error("Protected Local signer binary does not match its instance identity");
  }
  return {
    profile: "protected-local",
    instanceId,
    signerBinPath: expectedBinary,
    applicationSocketPath: `/run/fased-local/${instanceId}/application/app.sock`,
    operatorSocketPath: `/run/fased-local/${instanceId}/operator/operator.sock`,
    controlSocketPath: `/run/fased-local/${instanceId}/control/control.sock`,
    ownerHelperPath: `/usr/local/sbin/fased-local-signer-owner-${instanceId}`,
  };
}
