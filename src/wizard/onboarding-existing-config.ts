import type { ConfigFileSnapshot } from "../config/types.fased.js";

const PROTECTED_LOCAL_SCAFFOLD_ENV_KEYS = new Set([
  "FASED_HOST_PROFILE",
  "FASED_HOST_UPDATER_SOCKET",
  "FASED_HOST_UPDATERCTL_STATE",
  "FASED_PROTECTED_LOCAL",
  "FASED_PROTECTED_LOCAL_INSTANCE",
  "FASED_UPDATE_CHANNEL",
  "FASED_WALLET_LOCAL_SIGNER_BIN",
  "FASED_WALLET_LOCAL_SIGNER_LIFECYCLE",
  "FASED_WALLET_LOCAL_SIGNER_SOCKET",
]);

export function isProtectedLocalInstallerScaffold(
  snapshot: ConfigFileSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (
    !snapshot.exists ||
    !snapshot.valid ||
    env.FASED_INSTALLER_ONBOARD?.trim() !== "1" ||
    env.FASED_PROTECTED_LOCAL?.trim() !== "1"
  ) {
    return false;
  }

  const config = snapshot.resolved as Record<string, unknown>;
  if (Object.keys(config).some((key) => key !== "env")) {
    return false;
  }
  const configEnv = config.env;
  if (!configEnv || typeof configEnv !== "object" || Array.isArray(configEnv)) {
    return false;
  }
  const envRecord = configEnv as Record<string, unknown>;
  if (Object.keys(envRecord).some((key) => key !== "vars")) {
    return false;
  }
  const variables = envRecord.vars;
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    return false;
  }
  const entries = Object.entries(variables as Record<string, unknown>);
  return (
    entries.some(([key, value]) => key === "FASED_PROTECTED_LOCAL" && value === "1") &&
    entries.every(
      ([key, value]) => PROTECTED_LOCAL_SCAFFOLD_ENV_KEYS.has(key) && typeof value === "string",
    )
  );
}
