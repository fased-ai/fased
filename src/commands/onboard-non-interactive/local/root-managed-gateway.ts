import type { HostSetupProfile } from "../../../wizard/onboarding.types.js";

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
