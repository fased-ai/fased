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
    const legacyReady =
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
      /^preparedBy=root$/m.test(content);
    if (legacyReady) {
      return true;
    }
    const release = content.match(/^release=(.+)$/m)?.[1] || "";
    const channel = content.match(/^updateChannel=(.+)$/m)?.[1] || "";
    const expectedRelease = process.env.FASED_HOSTING_RELEASE?.trim();
    const expectedChannel = process.env.FASED_UPDATE_CHANNEL?.trim();
    return (
      /^schemaVersion=3$/m.test(content) &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(release) &&
      /^(stable|beta)$/.test(channel) &&
      (!release.includes("-") || channel === "beta") &&
      (!expectedRelease || release === expectedRelease) &&
      (!expectedChannel || channel === expectedChannel) &&
      /^transactionId=[0-9a-fA-F-]{36}$/m.test(content) &&
      /^gatewayPort=18789$/m.test(content) &&
      /^tailscaleDns=[a-z0-9.-]+$/m.test(content) &&
      /^tailscaleServeReady=true$/m.test(content) &&
      /^firewallReady=(?:pending|true)$/m.test(content) &&
      /^sshHardened=(?:pending|true)$/m.test(content) &&
      /^fail2banReady=(?:pending|true)$/m.test(content) &&
      /^automaticUpdatesReady=(?:pending|true)$/m.test(content) &&
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
