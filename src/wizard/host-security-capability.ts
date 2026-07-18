import fs from "node:fs";

const HOSTING_PREREQUISITES = "/etc/fased/hosting-prerequisites";

function hasRootPreparedHostingMarker(): boolean {
  try {
    const stat = fs.lstatSync(HOSTING_PREREQUISITES);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      stat.nlink !== 1 ||
      (stat.mode & 0o022) !== 0 ||
      stat.size <= 0 ||
      stat.size > 4_096
    ) {
      return false;
    }
    const content = fs.readFileSync(HOSTING_PREREQUISITES, "utf8");
    return (
      /^schemaVersion=2$/m.test(content) &&
      /^release=\d+\.\d+\.\d+$/m.test(content) &&
      /^gatewayPort=18789$/m.test(content) &&
      /^tailscaleDns=[a-z0-9.-]+$/m.test(content) &&
      /^tailnetSshConfirmed=true$/m.test(content) &&
      /^tailscaleServeReady=true$/m.test(content) &&
      /^firewallReady=true$/m.test(content) &&
      /^sshHardened=true$/m.test(content) &&
      /^fail2banReady=true$/m.test(content) &&
      /^automaticUpdatesReady=true$/m.test(content) &&
      /^signerReady=true$/m.test(content) &&
      /^appSudoDisabled=true$/m.test(content) &&
      /^preparedBy=root$/m.test(content)
    );
  } catch {
    return false;
  }
}

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
