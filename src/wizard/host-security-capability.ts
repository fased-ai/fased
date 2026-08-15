import { hasRootPreparedHostingMarker } from "./onboarding.host-security.js";

export function isHostedSecurityCapableSession(explicitFlag = false): boolean {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return true;
  }
  return (
    process.platform === "linux" &&
    explicitFlag &&
    process.env.FASED_HOST_ROOT_PREPARED?.trim() === "1" &&
    hasRootPreparedHostingMarker()
  );
}

export const __testing = { hasRootPreparedHostingMarker };
