import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function currentUserName(): string {
  return (
    process.env.USER?.trim() ||
    process.env.LOGNAME?.trim() ||
    process.env.SUDO_USER?.trim() ||
    os.userInfo().username
  );
}

function canRunHostedMaintenanceCommand(command: string): boolean {
  const probe = spawnSync("bash", ["-lc", command], { stdio: "ignore" });
  return probe.status === 0;
}

export function isHostedSecurityCapableSession(explicitFlag = false): boolean {
  if (explicitFlag) {
    return true;
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return true;
  }
  if (process.platform !== "linux") {
    return false;
  }

  const currentUser = currentUserName();
  if (currentUser) {
    const sudoersPath = path.join("/etc/sudoers.d", `fased-host-maintenance-${currentUser}`);
    if (fs.existsSync(sudoersPath)) {
      return true;
    }
  }

  return (
    canRunHostedMaintenanceCommand("sudo -n tailscale status >/dev/null 2>&1") ||
    canRunHostedMaintenanceCommand("sudo -n ufw status >/dev/null 2>&1") ||
    canRunHostedMaintenanceCommand("sudo -n firewall-cmd --state >/dev/null 2>&1") ||
    canRunHostedMaintenanceCommand(
      "sudo -n systemctl is-active --quiet firewalld >/dev/null 2>&1",
    ) ||
    canRunHostedMaintenanceCommand("sudo -n systemctl status fased-gateway.service >/dev/null 2>&1")
  );
}
