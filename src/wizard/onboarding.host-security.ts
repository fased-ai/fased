import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OnboardOptions } from "../commands/onboard-types.js";
import { redactSensitiveText } from "../logging/redact.js";
import type { RuntimeEnv } from "../runtime.js";
import { redactSensitiveUrlLikeString } from "../shared/net/redact-sensitive-url.js";
import { isHostingProfile } from "./onboarding.types.js";
import type { HostSetupProfile } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";

export type HostSecurityCheck = {
  name: "swap" | "tailscale" | "firewall" | "ssh" | "fail2ban" | "updates";
  ok: boolean;
  detail: string;
};

export type HostSecuritySummary = {
  profile: HostSetupProfile;
  checks: HostSecurityCheck[];
  enforced: boolean;
  logPath?: string;
};

function resolveHostSecurityLogPath(): string {
  const home = process.env.HOME?.trim() || os.homedir();
  const logDir = path.join(home, ".fased", "logs");
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  return path.join(logDir, "onboarding-host-security.log");
}

function appendHostSecurityLog(logPath: string, title: string, detail?: string) {
  const sanitizedTitle = sanitizeHostSecurityLogText(title);
  const sanitizedDetail = detail ? sanitizeHostSecurityLogText(detail) : undefined;
  const body = [
    `\n=== ${new Date().toISOString()} ${sanitizedTitle} ===`,
    sanitizedDetail?.trim() || "(no output)",
    "",
  ].join("\n");
  fs.appendFileSync(logPath, body, "utf8");
}

function resolveTailnetSshConfirmationPath(): string {
  const stateDir =
    process.env.FASED_STATE_DIR?.trim() ||
    process.env.FASED_CONFIG_DIR?.trim() ||
    path.join(process.env.HOME?.trim() || os.homedir(), ".fased");
  return path.join(stateDir, "hosting-tailnet-ssh-confirmed.json");
}

function hasStoredTailnetSshConfirmation(target: TailnetSshTarget): boolean {
  try {
    const raw = fs.readFileSync(resolveTailnetSshConfirmationPath(), "utf8");
    const parsed = JSON.parse(raw) as { user?: unknown; repoDir?: unknown };
    return parsed.user === target.user && parsed.repoDir === target.repoDir;
  } catch {
    return false;
  }
}

function writeTailnetSshConfirmation(target: TailnetSshTarget): void {
  const markerPath = resolveTailnetSshConfirmationPath();
  fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    markerPath,
    `${JSON.stringify(
      {
        confirmedAt: new Date().toISOString(),
        user: target.user,
        host: target.host,
        dns: target.dns,
        ipv4: target.ipv4,
        repoDir: target.repoDir,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function sanitizeHostSecurityLogText(value: string): string {
  return redactSensitiveText(redactSensitiveUrlLikeString(value), { mode: "tools" })
    .replace(/--authkey(?:=|\s+)(["']?)([^\s"']+)\1/gi, "--authkey ***")
    .replace(/\btskey-auth-[A-Za-z0-9_-]+/g, "tskey-auth-***");
}

function hasCommand(name: string): boolean {
  const probe = spawnSync("bash", ["-lc", `command -v ${name}`], { stdio: "ignore" });
  return probe.status === 0;
}

type HostSecurityCommandRunner = (
  command: string,
  logPath?: string,
) => { ok: boolean; detail?: string };

type TailnetSshTarget = {
  user: string;
  host: string;
  dns?: string;
  ipv4?: string;
  repoDir: string;
};

type TailnetSshPrerequisites = {
  ok: boolean;
  detail: string;
};

const LOW_MEMORY_SWAP_THRESHOLD_MB = 2304;
const LOW_MEMORY_HOSTING_SWAP_GB = 4;
const HOSTING_SWAP_GB = 2;

function detectTotalMemoryMb(): number {
  if (process.platform === "linux") {
    try {
      const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
      const match = meminfo.match(/^MemTotal:\s+(\d+)\s+kB/m);
      if (match?.[1]) {
        return Math.floor(Number.parseInt(match[1], 10) / 1024);
      }
    } catch {
      // Fall back to Node's platform memory probe below.
    }
  }
  return Math.floor(os.totalmem() / 1024 / 1024);
}

function resolveHostingSwapGb(explicitSwapGb?: number, totalMemMb = detectTotalMemoryMb()): number {
  if (typeof explicitSwapGb === "number" && Number.isFinite(explicitSwapGb)) {
    return Math.max(0, explicitSwapGb);
  }
  if (
    !Number.isFinite(totalMemMb) ||
    totalMemMb <= 0 ||
    totalMemMb <= LOW_MEMORY_SWAP_THRESHOLD_MB
  ) {
    return LOW_MEMORY_HOSTING_SWAP_GB;
  }
  return HOSTING_SWAP_GB;
}

function run(command: string, logPath?: string): { ok: boolean; detail?: string } {
  const proc = spawnSync("bash", ["-lc", command], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  const detail = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`.trim();
  if (logPath) {
    appendHostSecurityLog(logPath, command, detail);
  }
  if (proc.status === 0) {
    return { ok: true, detail: detail || undefined };
  }
  return { ok: false, detail: detail || `${command} (exit=${proc.status ?? "unknown"})` };
}

function runInteractive(command: string, logPath?: string): { ok: boolean; detail?: string } {
  if (logPath) {
    appendHostSecurityLog(
      logPath,
      command,
      "interactive command started; output shown in terminal",
    );
  }
  const proc = spawnSync("bash", ["-lc", command], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  const detail = `${command} (exit=${proc.status ?? "unknown"})`;
  if (logPath) {
    appendHostSecurityLog(logPath, command, detail);
  }
  if (proc.status === 0) {
    return { ok: true, detail };
  }
  return { ok: false, detail };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isTailscaleLoggedIn(logPath?: string, runner: HostSecurityCommandRunner = run): boolean {
  return (
    runner("tailscale status >/dev/null 2>&1", logPath).ok ||
    runner("sudo -n tailscale status >/dev/null 2>&1", logPath).ok
  );
}

function hasTailscaleIp(logPath?: string, runner: HostSecurityCommandRunner = run): boolean {
  return (
    runner("tailscale ip -4 >/dev/null 2>&1", logPath).ok ||
    runner("sudo -n tailscale ip -4 >/dev/null 2>&1", logPath).ok
  );
}

function readTailscaleIp(
  logPath?: string,
  runner: HostSecurityCommandRunner = run,
): string | undefined {
  const probe = runner("tailscale ip -4", logPath);
  const sudoProbe = probe.ok ? probe : runner("sudo -n tailscale ip -4", logPath);
  if (!sudoProbe.ok || !sudoProbe.detail) {
    return undefined;
  }
  return sudoProbe.detail.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)?.[0];
}

function readTailscaleSelf(
  logPath?: string,
  runner: HostSecurityCommandRunner = run,
): { dns?: string; ipv4?: string } {
  const probe = runner("tailscale status --json", logPath);
  const sudoProbe = probe.ok ? probe : runner("sudo -n tailscale status --json", logPath);
  if (!sudoProbe.ok || !sudoProbe.detail) {
    return { ipv4: readTailscaleIp(logPath, runner) };
  }
  try {
    const parsed = JSON.parse(sudoProbe.detail) as {
      Self?: { DNSName?: string; TailscaleIPs?: string[] };
    };
    const dns = String(parsed.Self?.DNSName ?? "")
      .trim()
      .replace(/\.$/, "");
    const ipv4 =
      parsed.Self?.TailscaleIPs?.find((ip) => typeof ip === "string" && ip.includes(".")) ??
      undefined;
    return {
      dns: dns || undefined,
      ipv4: ipv4 ?? readTailscaleIp(logPath, runner),
    };
  } catch {
    return { ipv4: readTailscaleIp(logPath, runner) };
  }
}

function resolveTailnetSshTarget(params: {
  user?: string;
  repoDir?: string;
  logPath?: string;
  runner?: HostSecurityCommandRunner;
}): TailnetSshTarget {
  const self = readTailscaleSelf(params.logPath, params.runner ?? run);
  const user = params.user?.trim() || "app";
  return {
    user,
    dns: self.dns,
    ipv4: self.ipv4,
    host: self.dns || self.ipv4 || "YOUR_VPS_TAILSCALE_NAME",
    repoDir: params.repoDir?.trim() || `/home/${user}/fased`,
  };
}

function formatLocalDeviceTailnetRequirementNote(): string {
  return [
    "Hosted setup uses two machines. Keep both online:",
    "",
    "1. This VPS runs Fased Agent.",
    "2. Your own computer opens the dashboard and runs the final SSH check.",
    "",
    "Your own computer must have Tailscale installed, running, and signed into the same tailnet before the dashboard or SSH can work.",
    "",
    "Windows: use PowerShell or Windows Terminal with the Windows Tailscale app running.",
    "macOS: use Terminal with the macOS Tailscale app running.",
    "Fedora local computer: `sudo dnf install -y tailscale && sudo systemctl enable --now tailscaled && sudo tailscale up`.",
    "Ubuntu/Debian/Kali local computer: `curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up`.",
    "Arch local computer: `sudo pacman -S tailscale && sudo systemctl enable --now tailscaled && sudo tailscale up`.",
    "WSL: advanced only. Windows Tailscale does not automatically make WSL a Tailscale node. Use PowerShell, or install/start Tailscale inside WSL.",
    "If your own computer says `tailscale: command not found`, install Tailscale on that computer before running the ping/ssh check.",
    "A separate VPN on your own computer can interfere with Tailscale DNS or routing; if ping/SSH fails, disconnect the other VPN or allow Tailscale traffic and try again.",
    "",
    "Keep this VPS installer terminal open while you test from your own device.",
  ].join("\n");
}

function formatTailnetSshVerificationNote(target: TailnetSshTarget): string {
  const pingTargets = [
    target.host,
    target.ipv4 && target.ipv4 !== target.host ? target.ipv4 : undefined,
  ].filter((value): value is string => Boolean(value));
  const sshTargets = pingTargets;
  return [
    "Before Fased locks down public SSH/root/password access, prove the private terminal path works.",
    "",
    "These commands run on your own computer, not inside the VPS SSH session.",
    "Your own computer must have Tailscale installed, running, and signed into the same tailnet as this VPS.",
    "If your own computer says `tailscale: command not found`, install Tailscale there first.",
    "Fedora local computer: `sudo dnf install -y tailscale && sudo systemctl enable --now tailscaled && sudo tailscale up`.",
    "Ubuntu/Debian/Kali local computer: `curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up`.",
    "Arch local computer: `sudo pacman -S tailscale && sudo systemctl enable --now tailscaled && sudo tailscale up`.",
    "Windows/macOS local computer: install and sign into the Tailscale app, then use PowerShell/Terminal.",
    "A separate VPN can interfere with Tailscale DNS/routing; pause it if this check cannot reach the VPS.",
    "",
    "On your own computer, open a second terminal and first check that this VPS is visible in Tailscale:",
    ...pingTargets.map((host) => `tailscale ping ${host}`),
    "",
    'If Tailscale says "no matching peer", this computer and the VPS are not in the same tailnet. Sign this computer into the same Tailscale account, or re-authenticate Tailscale on the VPS, then rerun this check.',
    "",
    "After Tailscale ping works, connect over the tailnet:",
    ...sshTargets.map((host) => `ssh ${target.user}@${host}`),
    "",
    `It must connect over your Tailscale network as ${target.user} and open in ${target.repoDir}.`,
    "Keep this installer running while you test.",
    "",
    "Do not continue until one of those SSH commands works from your own computer.",
  ].join("\n");
}

function verifyTailnetSshServerPrerequisites(params: {
  target: TailnetSshTarget;
  logPath?: string;
  runner?: HostSecurityCommandRunner;
}): TailnetSshPrerequisites {
  const runner = params.runner ?? run;
  const target = params.target;
  const checks: string[] = [];
  const failures: string[] = [];
  const repo = runner(`test -d ${shellQuote(target.repoDir)}`, params.logPath);
  if (repo.ok) {
    checks.push(`repo directory ready: ${target.repoDir}`);
  } else {
    failures.push(`missing app repo directory: ${target.repoDir}`);
  }

  const authorizedKeys = `/home/${target.user}/.ssh/authorized_keys`;
  const keys = runner(`test -s ${shellQuote(authorizedKeys)}`, params.logPath);
  if (keys.ok) {
    checks.push(`SSH keys ready: ${authorizedKeys}`);
  } else {
    failures.push(
      `missing SSH public keys for ${target.user}: ${authorizedKeys}. ` +
        "The root bootstrap should copy your current authorized_keys; if you used password-only SSH, add a public key before hosting lock-down.",
    );
  }

  const sshService = runner(
    "systemctl is-active --quiet ssh || systemctl is-active --quiet sshd || " +
      "sudo -n systemctl is-active --quiet ssh || sudo -n systemctl is-active --quiet sshd",
    params.logPath,
  );
  if (sshService.ok) {
    checks.push("OS SSH service active");
  } else {
    failures.push("OS SSH service is not active");
  }

  if (failures.length > 0) {
    return { ok: false, detail: failures.join("\n") };
  }
  return { ok: true, detail: checks.join("\n") };
}

function ensureTailnetSshIngressForVerification(params: {
  logPath?: string;
  runner?: HostSecurityCommandRunner;
}): { ok: boolean; detail?: string } {
  const runner = params.runner ?? run;
  const command = [
    "if command -v ufw >/dev/null 2>&1; then",
    "  if sudo -n ufw status | grep -qi '^Status: active'; then",
    "    sudo -n ufw insert 1 allow in on tailscale0 to any port 22 proto tcp || sudo -n ufw allow in on tailscale0 to any port 22 proto tcp",
    "  else",
    "    sudo -n ufw allow in on tailscale0 to any port 22 proto tcp >/dev/null 2>&1 || true",
    "  fi",
    "elif command -v firewall-cmd >/dev/null 2>&1 && sudo -n systemctl is-active --quiet firewalld; then",
    "  sudo -n firewall-cmd --permanent --zone=trusted --add-interface=tailscale0 >/dev/null 2>&1 || true",
    "  sudo -n firewall-cmd --reload >/dev/null 2>&1 || true",
    "fi",
  ].join("\n");
  const result = runner(command, params.logPath);
  if (!result.ok) {
    return {
      ok: false,
      detail: result.detail ?? "could not prepare tailnet SSH firewall rule before verification",
    };
  }
  return { ok: true, detail: result.detail ?? "tailnet SSH firewall rule ready" };
}

function hasExplicitTailnetSshConfirmation(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.FASED_HOSTING_TAILNET_SSH_CONFIRMED ?? "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function failTailnetSshConfirmation(params: {
  runtime: RuntimeEnv;
  logPath: string;
  target: TailnetSshTarget;
}) {
  const { runtime, logPath, target } = params;
  runtime.error("Hosting setup stopped before SSH/firewall lock-down.");
  runtime.error(`Confirm SSH over Tailscale first: ssh ${target.user}@${target.host}`);
  runtime.error(`Expected app repo directory after login: ${target.repoDir}`);
  runtime.error(`Host hardening log: ${logPath}`);
  runtime.exit(1);
}

async function confirmTailnetSshBeforeLockdown(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  prompter?: WizardPrompter;
  logPath: string;
  target: TailnetSshTarget;
  runner?: HostSecurityCommandRunner;
  interactiveRunner?: HostSecurityCommandRunner;
}): Promise<boolean> {
  const { opts, runtime, prompter, logPath } = params;
  const runner = params.runner ?? run;
  const interactiveRunner = params.interactiveRunner ?? runInteractive;
  let target = params.target;
  if (hasExplicitTailnetSshConfirmation()) {
    appendHostSecurityLog(logPath, "tailnet ssh confirmation", "confirmed by env");
    return true;
  }
  if (hasStoredTailnetSshConfirmation(target)) {
    appendHostSecurityLog(logPath, "tailnet ssh confirmation", "confirmed by previous run");
    return true;
  }
  if (!prompter || opts.nonInteractive === true) {
    failTailnetSshConfirmation({ runtime, logPath, target });
    return false;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const serverPrereqs = verifyTailnetSshServerPrerequisites({ target, logPath, runner });
    if (!serverPrereqs.ok) {
      runtime.error("Hosting setup stopped before SSH/firewall lock-down.");
      runtime.error(serverPrereqs.detail);
      runtime.error(`Host hardening log: ${logPath}`);
      runtime.exit(1);
      return false;
    }
    appendHostSecurityLog(logPath, "tailnet ssh server prerequisites", serverPrereqs.detail);
    const ingress = ensureTailnetSshIngressForVerification({ logPath, runner });
    if (!ingress.ok) {
      runtime.error("Hosting setup stopped before SSH/firewall lock-down.");
      runtime.error(
        "Could not prepare the tailnet-only SSH firewall rule required for verification.",
      );
      runtime.error(ingress.detail ?? "unknown firewall error");
      runtime.error(`Host hardening log: ${logPath}`);
      runtime.exit(1);
      return false;
    }
    appendHostSecurityLog(logPath, "tailnet ssh ingress prepared for verification", ingress.detail);
    await prompter.note(formatTailnetSshVerificationNote(target), "Verify SSH over Tailscale");
    const pingConfirmed = await prompter.confirm({
      message: "Did tailscale ping find this VPS from your own computer?",
      initialValue: false,
    });
    if (!pingConfirmed) {
      const reauth = await prompter.confirm({
        message: "Re-authenticate Tailscale on this VPS now?",
        initialValue: true,
      });
      if (!reauth) {
        failTailnetSshConfirmation({ runtime, logPath, target });
        return false;
      }
      await prompter.note(
        [
          "Tailscale will print a login URL in this terminal.",
          "Open it from the same computer/account you want to use for the dashboard and SSH.",
          "Leave this command running until it finishes.",
        ].join("\n"),
        "Tailscale login",
      );
      const tsReset = interactiveRunner(
        "sudo -n tailscale logout && sudo -n tailscale up --ssh --accept-routes --reset",
        logPath,
      );
      if (!tsReset.ok || !hasTailscaleIp(logPath, runner)) {
        runtime.error("Hosting setup stopped before SSH/firewall lock-down.");
        runtime.error(tsReset.detail ?? "tailscale re-authentication failed");
        runtime.error(`Host hardening log: ${logPath}`);
        runtime.exit(1);
        return false;
      }
      target = resolveTailnetSshTarget({
        user: target.user,
        repoDir: target.repoDir,
        logPath,
        runner,
      });
      continue;
    }

    const confirmed = await prompter.confirm({
      message: `Did SSH over Tailscale connect as ${target.user} and open ${target.repoDir}?`,
      initialValue: false,
    });
    if (!confirmed) {
      failTailnetSshConfirmation({ runtime, logPath, target });
      return false;
    }
    writeTailnetSshConfirmation(target);
    appendHostSecurityLog(logPath, "tailnet ssh confirmation", "confirmed interactively");
    return true;
  }

  failTailnetSshConfirmation({ runtime, logPath, target });
  return false;
}

function ensureTailscaleServe(port: number, logPath?: string): { ok: boolean; detail?: string } {
  // Prefer modern CLI syntax; fall back to legacy syntax for older tailscale versions.
  // Try unprivileged first, then sudo fallback for hosts where tailscale requires elevated rights.
  const modern = run(`tailscale serve --bg http://127.0.0.1:${port}`, logPath);
  if (modern.ok) {
    return { ok: true, detail: `tailscale serve --bg -> 127.0.0.1:${port}` };
  }
  const modernSudo = run(`sudo -n tailscale serve --bg http://127.0.0.1:${port}`, logPath);
  if (modernSudo.ok) {
    return { ok: true, detail: `sudo tailscale serve --bg -> 127.0.0.1:${port}` };
  }
  const legacy = run(`tailscale serve https / http://127.0.0.1:${port}`, logPath);
  if (legacy.ok) {
    return { ok: true, detail: `tailscale serve https / -> 127.0.0.1:${port}` };
  }
  const legacySudo = run(`sudo -n tailscale serve https / http://127.0.0.1:${port}`, logPath);
  if (legacySudo.ok) {
    return { ok: true, detail: `sudo tailscale serve https / -> 127.0.0.1:${port}` };
  }
  return {
    ok: false,
    detail:
      "serve setup failed (may require manual: sudo tailscale serve --bg http://127.0.0.1:" +
      port +
      ")",
  };
}

function isTailscaleServeReady(port: number): boolean {
  let probe = spawnSync("bash", ["-lc", "tailscale serve status"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if ((probe.status ?? 1) !== 0) {
    probe = spawnSync("bash", ["-lc", "sudo -n tailscale serve status"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  }
  if ((probe.status ?? 1) !== 0) {
    return false;
  }
  const out = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
  return out.includes(`127.0.0.1:${port}`);
}

function runHostSetupCommand(command: string): { ok: boolean; detail?: string } {
  return run(
    `export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a PYTHONWARNINGS=ignore::SyntaxWarning; ${command}`,
    resolveHostSecurityLogPath(),
  );
}

function packageInstallCommand(packages: string[]): string {
  const packageList = packages.map(shellQuote).join(" ");
  return [
    "if command -v apt-get >/dev/null 2>&1; then",
    "  sudo -n apt-get update && sudo -n apt-get install -y " + packageList,
    "elif command -v dnf >/dev/null 2>&1; then",
    "  sudo -n dnf install -y " + packageList,
    "elif command -v dnf5 >/dev/null 2>&1; then",
    "  sudo -n dnf5 install -y " + packageList,
    "elif command -v yum >/dev/null 2>&1; then",
    "  sudo -n yum install -y " + packageList,
    "else",
    "  echo 'unsupported package manager: need apt-get, dnf, dnf5, or yum' >&2",
    "  exit 1",
    "fi",
  ].join("\n");
}

function firewallBaselineCommand(): string {
  return [
    "if command -v ufw >/dev/null 2>&1 || command -v apt-get >/dev/null 2>&1; then",
    "  command -v ufw >/dev/null 2>&1 || { " + packageInstallCommand(["ufw"]) + "; }",
    "  sudo -n ufw default deny incoming",
    "  sudo -n ufw default allow outgoing",
    "  sudo -n ufw insert 1 allow in on tailscale0 to any port 22 proto tcp || sudo -n ufw allow in on tailscale0 to any port 22 proto tcp",
    "  sudo -n ufw insert 2 allow in on tailscale0 to any port 443 proto tcp || sudo -n ufw allow in on tailscale0 to any port 443 proto tcp",
    "  sudo -n ufw deny 22/tcp || true",
    "  sudo -n ufw --force enable",
    "elif command -v firewall-cmd >/dev/null 2>&1 || command -v dnf >/dev/null 2>&1 || command -v dnf5 >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then",
    "  command -v firewall-cmd >/dev/null 2>&1 || { " +
      packageInstallCommand(["firewalld"]) +
      "; }",
    "  sudo -n systemctl enable --now firewalld",
    "  sudo -n firewall-cmd --permanent --zone=trusted --add-interface=tailscale0 >/dev/null 2>&1 || true",
    "  sudo -n firewall-cmd --permanent --zone=public --remove-service=ssh >/dev/null 2>&1 || true",
    "  sudo -n firewall-cmd --permanent --zone=public --remove-port=22/tcp >/dev/null 2>&1 || true",
    "  sudo -n firewall-cmd --reload",
    "else",
    "  echo 'no supported firewall manager found: need ufw or firewalld' >&2",
    "  exit 1",
    "fi",
  ].join("\n");
}

function automaticUpdatesCommand(): string {
  return [
    "if command -v apt-get >/dev/null 2>&1; then",
    "  " + packageInstallCommand(["unattended-upgrades"]),
    "  sudo -n systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true",
    "  sudo -n systemctl enable --now apt-daily.timer apt-daily-upgrade.timer",
    "elif command -v dnf >/dev/null 2>&1 || command -v dnf5 >/dev/null 2>&1; then",
    "  (" +
      packageInstallCommand(["dnf5-plugin-automatic"]) +
      ") || (" +
      packageInstallCommand(["dnf-automatic"]) +
      ")",
    "  sudo -n sed -i 's/^apply_updates[[:space:]]*=.*/apply_updates = yes/' /etc/dnf/automatic.conf >/dev/null 2>&1 || true",
    "  sudo -n systemctl enable --now dnf5-automatic.timer >/dev/null 2>&1 || sudo -n systemctl enable --now dnf-automatic.timer",
    "elif command -v yum >/dev/null 2>&1; then",
    "  (" +
      packageInstallCommand(["dnf-automatic"]) +
      ") || (" +
      packageInstallCommand(["yum-cron"]) +
      ")",
    "  sudo -n systemctl enable --now dnf-automatic.timer >/dev/null 2>&1 || sudo -n systemctl enable --now yum-cron",
    "else",
    "  echo 'unsupported package manager for automatic updates' >&2",
    "  exit 1",
    "fi",
  ].join("\n");
}

function failOrContinue(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  step: string;
  detail?: string;
}) {
  const { opts, runtime, step, detail } = params;
  const body = detail ? `${step}: ${detail}` : step;
  const logPath = resolveHostSecurityLogPath();
  if (opts.allowInsecure === true) {
    runtime.error(`WARN insecure-continue: ${body}`);
    runtime.error(`Host hardening log: ${logPath}`);
    return;
  }
  runtime.error(`Hosting setup failed: ${body}`);
  runtime.error(`Host hardening log: ${logPath}`);
  runtime.error("Re-run with --allow-insecure to bypass (not recommended).");
  runtime.exit(1);
}

export async function applyHostingSecurity(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  prompter?: WizardPrompter;
}): Promise<HostSecuritySummary> {
  const { opts, runtime, prompter } = params;
  const checks: HostSecurityCheck[] = [];
  const logPath = resolveHostSecurityLogPath();
  const hostingProfile = isHostingProfile(opts.hostProfile);

  const profile: HostSetupProfile = hostingProfile ? "hosting" : "local";

  const maybeReauthenticateTailscaleInMaintenance = async (): Promise<{
    ok: boolean;
    detail: string;
  }> => {
    if (!prompter || opts.nonInteractive === true) {
      return {
        ok: true,
        detail: "post-bootstrap hosted maintenance session; skipping host hardening bootstrap",
      };
    }
    const switchAccount = await prompter.confirm({
      message: "Switch or re-authenticate Tailscale account on this VPS now?",
      initialValue: false,
    });
    if (!switchAccount) {
      return {
        ok: true,
        detail: "post-bootstrap hosted maintenance session; skipping host hardening bootstrap",
      };
    }

    let tsAuthkey = opts.tsAuthkey?.trim() ?? "";
    if (!tsAuthkey) {
      const useAuthkey = await prompter.confirm({
        message: "Use a Tailscale auth key instead of browser login? (advanced)",
        initialValue: false,
      });
      if (useAuthkey) {
        const keyValue =
          typeof prompter.secret === "function"
            ? await prompter.secret({
                message: "Paste Tailscale auth key (tskey-auth-...)",
                validate: (value) => (value.trim() ? undefined : "Required"),
              })
            : await prompter.text({
                message: "Paste Tailscale auth key (tskey-auth-...)",
                validate: (value) => (value.trim() ? undefined : "Required"),
              });
        tsAuthkey = keyValue.trim();
      } else {
        await prompter.note(
          [
            "Tailscale will print a login URL in this terminal.",
            "Open it, approve this VPS, then return here.",
            "Leave this command running until it finishes.",
          ].join("\n"),
          "Tailscale login",
        );
      }
    }

    const resetCommand = tsAuthkey
      ? `sudo -n tailscale logout && sudo -n tailscale up --ssh --accept-routes --reset --authkey ${JSON.stringify(tsAuthkey)}`
      : "sudo -n tailscale logout && sudo -n tailscale up --ssh --accept-routes --reset";
    const tsReset = tsAuthkey ? run(resetCommand, logPath) : runInteractive(resetCommand, logPath);
    if (!tsReset.ok) {
      return {
        ok: false,
        detail: tsReset.detail ?? "tailscale account switch failed",
      };
    }
    return {
      ok: true,
      detail: "tailscale re-authenticated in hosted maintenance session",
    };
  };

  if (!hostingProfile) {
    return { profile, checks, enforced: false, logPath };
  }
  if (opts.hostMaintenanceSession === true && opts.hostSecurityCapable !== true) {
    const maintenanceTailscale = await maybeReauthenticateTailscaleInMaintenance();
    return {
      profile,
      checks: [
        {
          name: "tailscale",
          ok: maintenanceTailscale.ok,
          detail: maintenanceTailscale.detail,
        },
      ],
      enforced: false,
      logPath,
    };
  }
  if (process.platform !== "linux") {
    checks.push({
      name: "tailscale",
      ok: false,
      detail: "hosting profile currently supports Linux only",
    });
    failOrContinue({
      opts,
      runtime,
      step: "hosting profile currently supports Linux only",
    });
    return { profile, checks, enforced: false, logPath };
  }

  if (!hasCommand("sudo")) {
    checks.push({ name: "firewall", ok: false, detail: "sudo is required for hosting setup" });
    failOrContinue({ opts, runtime, step: "sudo is required for hosting setup" });
    return { profile, checks, enforced: false, logPath };
  }

  // Hosting is fail-closed and always enforces hardening.

  const swapGb = resolveHostingSwapGb(opts.swapGb);
  if (swapGb > 0) {
    const hasSwap = run("swapon --show | tail -n +2 | grep -q .", logPath).ok;
    if (!hasSwap) {
      const swapCmd =
        `sudo fallocate -l ${swapGb}G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=$((` +
        `${swapGb}*1024)) status=none; ` +
        "sudo chmod 600 /swapfile; sudo mkswap /swapfile >/dev/null; sudo swapon /swapfile; " +
        "grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null";
      const swapRes = run(swapCmd, logPath);
      if (!swapRes.ok) {
        checks.push({ name: "swap", ok: false, detail: swapRes.detail ?? "swap setup failed" });
        failOrContinue({ opts, runtime, step: "swap setup failed", detail: swapRes.detail });
        return { profile, checks, enforced: false, logPath };
      }
      checks.push({ name: "swap", ok: true, detail: `configured ${swapGb}G swapfile` });
    } else {
      checks.push({ name: "swap", ok: true, detail: "existing swap detected" });
    }
  } else {
    checks.push({ name: "swap", ok: true, detail: "disabled (swap-gb=0)" });
  }

  if (!hasCommand("tailscale")) {
    const installTs = run(
      "curl -fsSL https://tailscale.com/install.sh | sudo -E env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a sh",
      logPath,
    );
    if (!installTs.ok) {
      checks.push({
        name: "tailscale",
        ok: false,
        detail: installTs.detail ?? "tailscale install failed",
      });
      failOrContinue({ opts, runtime, step: "tailscale install failed", detail: installTs.detail });
      return { profile, checks, enforced: false, logPath };
    }
  }

  if (prompter && opts.nonInteractive !== true) {
    await prompter.note(formatLocalDeviceTailnetRequirementNote(), "Local device requirement");
  }

  let tsHealthy = isTailscaleLoggedIn(logPath);
  if (tsHealthy && prompter && opts.nonInteractive !== true) {
    const switchAccount = await prompter.confirm({
      message: "Switch or re-authenticate Tailscale account on this VPS now?",
      initialValue: false,
    });
    if (switchAccount) {
      if (prompter) {
        await prompter.note(
          [
            "Tailscale will print a login URL in this terminal.",
            "Open it, approve this VPS, then return here.",
            "Leave this command running until it finishes.",
          ].join("\n"),
          "Tailscale login",
        );
      }
      const tsReset = runInteractive(
        "sudo -n tailscale logout && sudo -n tailscale up --ssh --accept-routes --reset",
        logPath,
      );
      if (!tsReset.ok) {
        checks.push({
          name: "tailscale",
          ok: false,
          detail: tsReset.detail ?? "tailscale account switch failed",
        });
        failOrContinue({
          opts,
          runtime,
          step: "tailscale account switch failed",
          detail: tsReset.detail,
        });
        return { profile, checks, enforced: false, logPath };
      }
      checks.push({
        name: "tailscale",
        ok: true,
        detail: "tailscale re-authenticated via account switch/reset",
      });
      tsHealthy = isTailscaleLoggedIn(logPath);
    }
  }

  if (!tsHealthy) {
    let tsAuthkey = opts.tsAuthkey?.trim() ?? "";
    if (!tsAuthkey && opts.nonInteractive !== true && prompter) {
      const useAuthkey = await prompter.confirm({
        message: "Use a Tailscale auth key instead of browser login? (advanced)",
        initialValue: false,
      });
      if (useAuthkey) {
        const keyValue =
          typeof prompter.secret === "function"
            ? await prompter.secret({
                message: "Paste Tailscale auth key (tskey-auth-...)",
                validate: (value) => (value.trim() ? undefined : "Required"),
              })
            : await prompter.text({
                message: "Paste Tailscale auth key (tskey-auth-...)",
                validate: (value) => (value.trim() ? undefined : "Required"),
              });
        tsAuthkey = keyValue.trim();
      }
    }

    if (tsAuthkey) {
      const tsUp = run(
        `sudo -n tailscale up --authkey ${JSON.stringify(tsAuthkey)} --ssh`,
        logPath,
      );
      if (!tsUp.ok) {
        checks.push({
          name: "tailscale",
          ok: false,
          detail: tsUp.detail ?? "tailscale up with auth key failed",
        });
        failOrContinue({
          opts,
          runtime,
          step: "tailscale up with auth key failed",
          detail: tsUp.detail,
        });
        return { profile, checks, enforced: false, logPath };
      }
      checks.push({ name: "tailscale", ok: true, detail: "tailscale up via auth key" });
    } else if (opts.nonInteractive === true) {
      checks.push({
        name: "tailscale",
        ok: false,
        detail: "non-interactive hosting setup requires --ts-authkey",
      });
      failOrContinue({
        opts,
        runtime,
        step: "non-interactive hosting setup requires --ts-authkey (or --allow-insecure)",
      });
      return { profile, checks, enforced: false, logPath };
    } else {
      if (prompter) {
        await prompter.note(
          [
            "Tailscale will print a login URL in this terminal.",
            "Open it, approve this VPS, then return here.",
            "Leave this command running until it finishes.",
          ].join("\n"),
          "Tailscale login",
        );
      }
      const tsUp = runInteractive("sudo -n tailscale up --ssh", logPath);
      if (!tsUp.ok) {
        checks.push({ name: "tailscale", ok: false, detail: tsUp.detail ?? "tailscale up failed" });
        failOrContinue({ opts, runtime, step: "tailscale up failed", detail: tsUp.detail });
        return { profile, checks, enforced: false, logPath };
      }
      checks.push({ name: "tailscale", ok: true, detail: "tailscale up via interactive login" });
    }
  } else {
    checks.push({ name: "tailscale", ok: true, detail: "tailscale already healthy" });
  }

  if (!hasTailscaleIp(logPath)) {
    checks.push({
      name: "tailscale",
      ok: false,
      detail: "tailscale network is not ready (no tailnet IP)",
    });
    failOrContinue({
      opts,
      runtime,
      step: "tailscale not ready; refusing to apply ssh/firewall lock-down",
    });
    return { profile, checks, enforced: false, logPath };
  }
  checks.push({
    name: "tailscale",
    ok: true,
    detail: "tailnet IP present; verifying app SSH before lock-down",
  });

  const operatorUser = run("id -u app >/dev/null 2>&1", logPath).ok
    ? "app"
    : process.env.SUDO_USER?.trim() || process.env.USER?.trim() || process.env.LOGNAME?.trim();
  if (operatorUser) {
    run(`sudo -n tailscale set --operator='${operatorUser}' >/dev/null 2>&1 || true`, logPath);
  }

  const tailnetSshTarget = resolveTailnetSshTarget({
    user: operatorUser || "app",
    repoDir: operatorUser ? `/home/${operatorUser}/fased` : "/home/app/fased",
    logPath,
  });
  const tailnetSshConfirmed = await confirmTailnetSshBeforeLockdown({
    opts,
    runtime,
    prompter,
    logPath,
    target: tailnetSshTarget,
  });
  if (!tailnetSshConfirmed) {
    return { profile, checks, enforced: false, logPath };
  }
  checks.push({
    name: "ssh",
    ok: true,
    detail: "operator confirmed app SSH over Tailscale before lock-down",
  });

  const servePort = Math.max(1, opts.gatewayPort ?? 18789);
  const serveRes = ensureTailscaleServe(servePort, logPath);
  if (!serveRes.ok || !isTailscaleServeReady(servePort)) {
    checks.push({
      name: "tailscale",
      ok: false,
      detail: serveRes.detail ?? `tailscale serve not ready for 127.0.0.1:${servePort}`,
    });
    failOrContinue({
      opts,
      runtime,
      step: "tailscale serve setup failed; refusing to apply ssh/firewall lock-down",
      detail: serveRes.detail,
    });
    return { profile, checks, enforced: false, logPath };
  }
  checks.push({
    name: "tailscale",
    ok: true,
    detail: `tailscale serve is active for 127.0.0.1:${servePort}`,
  });

  const firewallRes = runHostSetupCommand(firewallBaselineCommand());
  if (!firewallRes.ok) {
    checks.push({
      name: "firewall",
      ok: false,
      detail: firewallRes.detail ?? "firewall baseline failed",
    });
    failOrContinue({
      opts,
      runtime,
      step: "firewall baseline failed",
      detail: firewallRes.detail,
    });
    return { profile, checks, enforced: false };
  }
  checks.push({
    name: "firewall",
    ok: true,
    detail: "default-deny public ingress with tailnet SSH/HTTPS access",
  });

  const sshRes = run(
    "sudo -n sed -i 's/^#\\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config; " +
      "sudo -n sed -i 's/^#\\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config; " +
      "sudo -n systemctl restart ssh || sudo -n systemctl restart sshd",
    logPath,
  );
  if (!sshRes.ok) {
    checks.push({ name: "ssh", ok: false, detail: sshRes.detail ?? "ssh hardening failed" });
    failOrContinue({ opts, runtime, step: "ssh hardening failed", detail: sshRes.detail });
    return { profile, checks, enforced: false, logPath };
  }
  checks.push({
    name: "ssh",
    ok: true,
    detail: "password auth/root login disabled and ssh restarted",
  });

  const f2bRes = runHostSetupCommand(
    `${packageInstallCommand(["fail2ban"])}\nsudo -n systemctl enable --now fail2ban`,
  );
  if (!f2bRes.ok) {
    checks.push({ name: "fail2ban", ok: false, detail: f2bRes.detail ?? "fail2ban setup failed" });
    failOrContinue({ opts, runtime, step: "fail2ban setup failed", detail: f2bRes.detail });
    return { profile, checks, enforced: false, logPath };
  }
  checks.push({ name: "fail2ban", ok: true, detail: "installed and enabled" });

  const updatesRes = runHostSetupCommand(automaticUpdatesCommand());
  if (!updatesRes.ok) {
    checks.push({
      name: "updates",
      ok: false,
      detail: updatesRes.detail ?? "automatic security updates setup failed",
    });
    failOrContinue({
      opts,
      runtime,
      step: "automatic security updates setup failed",
      detail: updatesRes.detail,
    });
    return { profile, checks, enforced: false, logPath };
  }
  checks.push({ name: "updates", ok: true, detail: "automatic security updates enabled" });

  runtime.log("Hosting host hardening complete.");
  return { profile, checks, enforced: true, logPath };
}

export const __testing = {
  formatLocalDeviceTailnetRequirementNote,
  formatTailnetSshVerificationNote,
  hasTailscaleIp,
  hasExplicitTailnetSshConfirmation,
  isTailscaleLoggedIn,
  readTailscaleIp,
  resolveHostingSwapGb,
  resolveTailnetSshTarget,
  sanitizeHostSecurityLogText,
  confirmTailnetSshBeforeLockdown,
  ensureTailnetSshIngressForVerification,
  firewallBaselineCommand,
  packageInstallCommand,
  automaticUpdatesCommand,
  verifyTailnetSshServerPrerequisites,
};
