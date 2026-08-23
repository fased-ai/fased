import path from "node:path";
import type { HostSetupProfile } from "./onboarding.types.js";

export function shouldDeferRootManagedGatewayActivation(params: {
  env: NodeJS.ProcessEnv;
  hostProfile: HostSetupProfile;
}): boolean {
  if (params.env.FASED_INSTALLER_ONBOARD?.trim() !== "1") {
    return false;
  }
  if (params.env.FASED_PROTECTED_LOCAL?.trim() === "1") {
    return true;
  }
  return params.hostProfile === "hosting" && params.env.FASED_HOST_ROOT_PREPARED?.trim() === "1";
}

export function resolveInstallerOnboardingCwd(
  params: {
    env?: NodeJS.ProcessEnv;
    currentCwd?: string;
  } = {},
): string {
  const env = params.env ?? process.env;
  const currentCwd = params.currentCwd ?? process.cwd();
  if (env.FASED_INSTALLER_ONBOARD?.trim() !== "1") {
    return currentCwd;
  }
  const home = env.HOME?.trim();
  if (!home || !path.isAbsolute(home)) {
    throw new Error("installer onboarding requires an absolute operator home");
  }
  return path.resolve(home);
}

export function shouldManageGatewayServiceDuringOnboarding(params: {
  installDaemon: boolean;
  deferRootManagedActivation: boolean;
}): boolean {
  return params.installDaemon && !params.deferRootManagedActivation;
}
