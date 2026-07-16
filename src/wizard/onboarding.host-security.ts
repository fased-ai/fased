import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OnboardOptions } from "../commands/onboard-types.js";
import { redactSensitiveText } from "../logging/redact.js";
import type { RuntimeEnv } from "../runtime.js";
import { redactSensitiveUrlLikeString } from "../shared/net/redact-sensitive-url.js";
import { noteCommands, noteHeading, noteStep, noteWarn } from "./onboarding-note-format.js";
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
) => { ok: boolean; detail?: string; timedOut?: boolean };

type HostSecurityCommandResult = ReturnType<HostSecurityCommandRunner>;

type InteractiveHostSecurityCommandRunner = (
  command: string,
  logPath?: string,
  prompter?: WizardPrompter,
) => HostSecurityCommandResult | Promise<HostSecurityCommandResult>;

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
  method: TailnetSshVerificationMethod;
};

type SshPublicKeyParseResult =
  | { ok: true; keys: string[] }
  | { ok: false; keys: string[]; detail: string };

type TailnetSshVerificationMethod = "ssh-key" | "tailscale-ssh";

const LOW_MEMORY_SWAP_THRESHOLD_MB = 2304;
const LOW_MEMORY_HOSTING_SWAP_GB = 4;
const HOSTING_SWAP_GB = 2;
const TAILSCALE_INTERACTIVE_TIMEOUT_MS = 2 * 60 * 1000;
const TAILSCALE_LOGIN_URL_RE = /https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9_-]+/i;
const HOST_MAINTENANCE_HELPER = "/usr/local/sbin/fased-host-maintenance";

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

async function runInteractive(
  command: string,
  logPath?: string,
  options?: { timeoutMs?: number; prompter?: WizardPrompter; noteTitle?: string },
): Promise<{ ok: boolean; detail?: string; timedOut?: boolean }> {
  if (logPath) {
    appendHostSecurityLog(
      logPath,
      command,
      "interactive command started; output captured for framed wizard display",
    );
  }
  return await new Promise((resolve) => {
    const proc = spawn("bash", ["-lc", command], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let loginUrlShown = false;
    let timedOut = false;
    let noteQueue = Promise.resolve();
    const timer =
      options?.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            proc.kill("SIGINT");
          }, options.timeoutMs)
        : null;

    const maybeShowLoginUrl = (chunk: string) => {
      output += chunk;
      if (loginUrlShown) {
        return;
      }
      const loginUrl = output.match(TAILSCALE_LOGIN_URL_RE)?.[0];
      if (!loginUrl) {
        return;
      }
      loginUrlShown = true;
      if (options?.prompter) {
        const message = [
          noteHeading("Open login URL"),
          "Open this URL in your local browser:",
          ...noteCommands([loginUrl]),
          "Return here after approving this VPS.",
        ].join("\n");
        noteQueue = noteQueue.then(() =>
          options.prompter?.note(message, options.noteTitle ?? "Tailscale login URL"),
        );
      }
    };

    proc.stdout?.on("data", (chunk: Buffer | string) => {
      maybeShowLoginUrl(String(chunk));
    });
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      maybeShowLoginUrl(String(chunk));
    });
    proc.on("error", (error) => {
      output += `\n${error instanceof Error ? error.message : String(error)}`;
    });
    proc.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      const detail = timedOut
        ? `${command} timed out after ${Math.round((options?.timeoutMs ?? 0) / 1000)}s\n${output}`.trim()
        : `${command} (exit=${code ?? "unknown"})\n${output}`.trim();
      if (logPath) {
        appendHostSecurityLog(logPath, command, detail);
      }
      void noteQueue.then(() => {
        if (code === 0) {
          resolve({ ok: true, detail });
          return;
        }
        resolve({ ok: false, detail, timedOut });
      });
    });
  });
}

function buildTailscaleLoginWaitCommand(command: string): string {
  const quotedCommand = shellQuote(command);
  return [
    "set +e",
    `bash -lc ${quotedCommand} &`,
    "ts_pid=$!",
    "for _ in $(seq 1 55); do",
    `  if tailscale ip -4 >/dev/null 2>&1 || ${hostMaintenanceCommand("tailscale-ip4")} >/dev/null 2>&1 || sudo -n tailscale ip -4 >/dev/null 2>&1; then`,
    '    kill -INT "$ts_pid" >/dev/null 2>&1 || true',
    '    wait "$ts_pid" >/dev/null 2>&1 || true',
    "    exit 0",
    "  fi",
    '  if ! kill -0 "$ts_pid" >/dev/null 2>&1; then',
    '    wait "$ts_pid"',
    "    exit $?",
    "  fi",
    "  sleep 2",
    "done",
    'kill -INT "$ts_pid" >/dev/null 2>&1 || true',
    'wait "$ts_pid" >/dev/null 2>&1 || true',
    `if tailscale ip -4 >/dev/null 2>&1 || ${hostMaintenanceCommand("tailscale-ip4")} >/dev/null 2>&1 || sudo -n tailscale ip -4 >/dev/null 2>&1; then`,
    "  exit 0",
    "fi",
    "exit 124",
  ].join("\n");
}

async function runInteractiveTailscaleLogin(
  command: string,
  logPath?: string,
  prompter?: WizardPrompter,
) {
  if (logPath) {
    appendHostSecurityLog(
      logPath,
      command,
      "interactive Tailscale login started; login URL shown in framed wizard note",
    );
  }
  const result = await runInteractive(buildTailscaleLoginWaitCommand(command), undefined, {
    timeoutMs: TAILSCALE_INTERACTIVE_TIMEOUT_MS,
    prompter,
    noteTitle: "Tailscale login URL",
  });
  if (logPath) {
    appendHostSecurityLog(
      logPath,
      "tailscale login result",
      result.ok
        ? "tailnet IP appeared or tailscale up completed"
        : (result.detail ?? "tailscale login failed"),
    );
  }
  if (result.ok) {
    return { ok: true, detail: "tailnet IP appeared or tailscale up completed" };
  }
  return result;
}

function formatTailscaleBrowserLoginNote(): string {
  return [
    noteStep(1, "Open login URL"),
    "Use the Tailscale login URL printed below.",
    "",
    noteStep(2, "Approve VPS"),
    "Approve this VPS in your local browser.",
    "",
    noteHeading("If it waits"),
    noteWarn("Setup continues after about two minutes when a tailnet IP is already present."),
  ].join("\n");
}

function formatTailscaleAccountBrowserLoginNote(): string {
  return [
    noteStep(1, "Open login URL"),
    "Use the Tailscale login URL printed below.",
    "",
    noteStep(2, "Use same account"),
    "Use the account you want for dashboard and SSH access.",
    "",
    noteHeading("If it waits"),
    noteWarn("Setup continues after about two minutes when a tailnet IP is already present."),
  ].join("\n");
}

function tailscaleTimedOutButReady(
  result: { ok: boolean; detail?: string; timedOut?: boolean },
  logPath?: string,
  runner: HostSecurityCommandRunner = run,
): boolean {
  if (!result.timedOut) {
    return false;
  }
  const ready = hasTailscaleIp(logPath, runner);
  if (ready && logPath) {
    appendHostSecurityLog(
      logPath,
      "tailscale login timeout accepted",
      "tailscale up timed out, but a tailnet IPv4 is present; continuing",
    );
  }
  return ready;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function hostMaintenanceCommand(action: string): string {
  const bootstrapCtl = process.env.FASED_HOST_BOOTSTRAP_CTL?.trim();
  if (bootstrapCtl) {
    return `${shellQuote(process.execPath)} ${shellQuote(bootstrapCtl)} ${shellQuote(action)}`;
  }
  return `sudo -n ${HOST_MAINTENANCE_HELPER} ${action}`;
}

function hostMaintenanceCommandWithInput(action: string, input: string): string {
  return `printf '%s\\n' ${shellQuote(input)} | ${hostMaintenanceCommand(action)}`;
}

function isTailscaleLoggedIn(logPath?: string, runner: HostSecurityCommandRunner = run): boolean {
  return (
    runner("tailscale status >/dev/null 2>&1", logPath).ok ||
    runner(`${hostMaintenanceCommand("tailscale-status")} >/dev/null 2>&1`, logPath).ok ||
    runner("sudo -n tailscale status >/dev/null 2>&1", logPath).ok
  );
}

function hasTailscaleIp(logPath?: string, runner: HostSecurityCommandRunner = run): boolean {
  return (
    runner("tailscale ip -4 >/dev/null 2>&1", logPath).ok ||
    runner(`${hostMaintenanceCommand("tailscale-ip4")} >/dev/null 2>&1`, logPath).ok ||
    runner("sudo -n tailscale ip -4 >/dev/null 2>&1", logPath).ok
  );
}

function readTailscaleIp(
  logPath?: string,
  runner: HostSecurityCommandRunner = run,
): string | undefined {
  const probe = runner("tailscale ip -4", logPath);
  const helperProbe = probe.ok ? probe : runner(hostMaintenanceCommand("tailscale-ip4"), logPath);
  const sudoProbe = helperProbe.ok ? helperProbe : runner("sudo -n tailscale ip -4", logPath);
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
  const helperProbe = probe.ok
    ? probe
    : runner(hostMaintenanceCommand("tailscale-status-json"), logPath);
  const sudoProbe = helperProbe.ok
    ? helperProbe
    : runner("sudo -n tailscale status --json", logPath);
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
    noteStep(1, "Prepare local computer"),
    "Do this on your own computer, not inside the VPS.",
    "",
    "Turn off any non-Tailscale VPN.",
    "Sign into the same Tailscale account used on this VPS.",
    "Leave this VPS installer open.",
    "",
    noteStep(2, "Check Tailscale"),
    "Run these on your own computer:",
    ...noteCommands(["tailscale status", "tailscale ip -4"]),
    "Continue only after `tailscale ip -4` prints a `100.x.x.x` address.",
    "",
    noteStep(3, "Install if needed"),
    noteHeading("Windows and macOS"),
    "Install the Tailscale app. Sign in. Then run step 2.",
    "",
    noteHeading("Fedora"),
    ...noteCommands([
      "sudo dnf install -y tailscale",
      "sudo systemctl enable --now tailscaled",
      "sudo tailscale up",
    ]),
    noteHeading("Ubuntu Debian Kali"),
    ...noteCommands([
      "curl -fsSL https://tailscale.com/install.sh | sh",
      "sudo systemctl enable --now tailscaled",
      "sudo tailscale up",
    ]),
    noteHeading("Common blockers"),
    noteWarn("`tailscale` not found means Tailscale is not installed locally."),
    noteWarn("Another VPN can break MagicDNS."),
    noteWarn("Use the `100.x.x.x` IP fallback when hostname lookup fails."),
    "",
  ].join("\n");
}

function formatTailnetSshVerificationNote(
  target: TailnetSshTarget,
  method: TailnetSshVerificationMethod = "ssh-key",
): string {
  const pingTargets = [
    target.host,
    target.ipv4 && target.ipv4 !== target.host ? target.ipv4 : undefined,
  ].filter((value): value is string => Boolean(value));
  const sshTargets = pingTargets;
  const sshCommands =
    method === "tailscale-ssh"
      ? sshTargets.map((host) => `tailscale ssh ${target.user}@${host}`)
      : sshTargets.map((host) => `ssh ${target.user}@${host}`);
  return [
    noteStep(1, "Check visibility"),
    "Run on your own computer:",
    ...noteCommands([
      "tailscale status",
      "tailscale ip -4",
      ...pingTargets.map((host) => `tailscale ping ${host}`),
    ]),
    noteWarn('"no matching peer" means this computer and VPS are not in the same tailnet.'),
    "",
    noteStep(2, "SSH into VPS"),
    "Run one command:",
    ...(method === "tailscale-ssh"
      ? [
          "No app SSH key was found on this VPS.",
          "Use Tailscale SSH from your own Tailscale-connected computer:",
        ]
      : []),
    ...noteCommands(sshCommands),
    `Continue only after SSH opens in ${target.repoDir}.`,
    "",
    noteHeading("Fallback"),
    noteWarn(
      method === "tailscale-ssh"
        ? "If Tailscale SSH is unavailable in your tailnet, choose the SSH public key fallback."
        : "If hostname lookup fails, keep the other VPN off and use the `100.x.x.x` command.",
    ),
  ].join("\n");
}

function formatTailnetSshPublicKeyNote(target: TailnetSshTarget): string {
  return [
    noteStep(1, "Find your public key"),
    "Use this fallback only when Tailscale SSH is unavailable in your tailnet.",
    "Do this on your own computer while this VPS installer stays open.",
    ...noteCommands(["cat ~/.ssh/id_ed25519.pub", "type $env:USERPROFILE\\.ssh\\id_ed25519.pub"]),
    noteWarn("Paste a `.pub` key only. Never paste a private key."),
    "",
    noteStep(2, "Create one if needed"),
    "Run this on your own computer, then paste the `.pub` line here:",
    ...noteCommands(['ssh-keygen -t ed25519 -C "fased-vps" -f ~/.ssh/id_ed25519']),
    "",
    noteStep(3, "What Fased will do"),
    `Install that public key for ${target.user} at /home/${target.user}/.ssh/authorized_keys.`,
    "Then you will test regular SSH over Tailscale before root/password access is locked down.",
  ].join("\n");
}

function normalizeSshPublicKeys(input: string): SshPublicKeyParseResult {
  const acceptedTypes = new Set([
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ecdsa-sha2-nistp256@openssh.com",
    "sk-ssh-ed25519@openssh.com",
    "ssh-ed25519",
    "ssh-rsa",
  ]);
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return { ok: false, keys: [], detail: "Paste one SSH public key line." };
  }
  if (lines.some((line) => /^-{5}BEGIN\b/i.test(line) || /PRIVATE KEY/i.test(line))) {
    return {
      ok: false,
      keys: [],
      detail: "That looks like a private key. Paste the `.pub` key only.",
    };
  }
  const normalized: string[] = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    const keyType = parts[0] ?? "";
    const keyBody = parts[1] ?? "";
    if (!acceptedTypes.has(keyType) || !/^[A-Za-z0-9+/]+={0,3}$/.test(keyBody)) {
      return {
        ok: false,
        keys: [],
        detail:
          "Paste a valid OpenSSH public key, for example `ssh-ed25519 AAAA... user@computer`.",
      };
    }
    normalized.push(parts.join(" "));
  }
  return { ok: true, keys: Array.from(new Set(normalized)) };
}

function buildInstallTailnetSshAuthorizedKeysCommand(
  target: TailnetSshTarget,
  keys: string[],
): string {
  const sshDir = `/home/${target.user}/.ssh`;
  const authorizedKeys = `${sshDir}/authorized_keys`;
  const encodedKeys = Buffer.from(`${keys.join("\n")}\n`, "utf8").toString("base64");
  return [
    "set -e",
    "umask 077",
    `mkdir -p ${shellQuote(sshDir)}`,
    'tmp_keys="$(mktemp)"',
    'tmp_merged="$(mktemp)"',
    `printf '%s' ${shellQuote(encodedKeys)} | base64 -d > "$tmp_keys"`,
    `{ cat ${shellQuote(authorizedKeys)} 2>/dev/null || true; cat "$tmp_keys"; } | awk 'NF { print }' | sort -u > "$tmp_merged"`,
    `install -m 600 "$tmp_merged" ${shellQuote(authorizedKeys)}`,
    `chmod 700 ${shellQuote(sshDir)}`,
    `chmod 600 ${shellQuote(authorizedKeys)}`,
    'rm -f "$tmp_keys" "$tmp_merged"',
  ].join("\n");
}

async function ensureTailnetSshAuthorizedKeys(params: {
  target: TailnetSshTarget;
  logPath: string;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  runner: HostSecurityCommandRunner;
}): Promise<boolean> {
  const { target, logPath, runtime, prompter, runner } = params;
  const authorizedKeys = `/home/${target.user}/.ssh/authorized_keys`;
  const existing = runner(`test -s ${shellQuote(authorizedKeys)}`, logPath);
  if (existing.ok) {
    return true;
  }

  await prompter.note(formatTailnetSshPublicKeyNote(target), "SSH key fallback");
  const pasted = await prompter.text({
    message: `Paste the SSH public key to install for ${target.user}`,
    placeholder: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... user@computer",
    validate: (value) => {
      const parsed = normalizeSshPublicKeys(value);
      return parsed.ok ? undefined : parsed.detail;
    },
  });
  const parsed = normalizeSshPublicKeys(pasted);
  if (!parsed.ok) {
    runtime.error("Hosting setup stopped before SSH/firewall lock-down.");
    runtime.error(parsed.detail);
    runtime.error(`Host hardening log: ${logPath}`);
    runtime.exit(1);
    return false;
  }

  const installResult = runner(
    buildInstallTailnetSshAuthorizedKeysCommand(target, parsed.keys),
    logPath,
  );
  if (!installResult.ok) {
    runtime.error("Hosting setup stopped before SSH/firewall lock-down.");
    runtime.error(`Could not install SSH public key for ${target.user}: ${authorizedKeys}`);
    runtime.error(installResult.detail ?? "unknown SSH key install error");
    runtime.error(`Host hardening log: ${logPath}`);
    runtime.exit(1);
    return false;
  }

  const verify = runner(`test -s ${shellQuote(authorizedKeys)}`, logPath);
  if (!verify.ok) {
    runtime.error("Hosting setup stopped before SSH/firewall lock-down.");
    runtime.error(`SSH public key was not written for ${target.user}: ${authorizedKeys}`);
    runtime.error(`Host hardening log: ${logPath}`);
    runtime.exit(1);
    return false;
  }

  appendHostSecurityLog(
    logPath,
    "tailnet ssh public key installed",
    `installed ${parsed.keys.length} public key(s) for ${target.user}: ${authorizedKeys}`,
  );
  return true;
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
  let method: TailnetSshVerificationMethod = "tailscale-ssh";
  const repo = runner(`test -d ${shellQuote(target.repoDir)}`, params.logPath);
  if (repo.ok) {
    checks.push(`repo directory ready: ${target.repoDir}`);
  } else {
    failures.push(`missing app repo directory: ${target.repoDir}`);
  }

  const authorizedKeys = `/home/${target.user}/.ssh/authorized_keys`;
  const keys = runner(`test -s ${shellQuote(authorizedKeys)}`, params.logPath);
  if (keys.ok) {
    method = "ssh-key";
    checks.push(`SSH keys ready: ${authorizedKeys}`);
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
  } else {
    checks.push(`no app SSH keys at ${authorizedKeys}; using Tailscale SSH`);
  }

  if (failures.length > 0) {
    return { ok: false, detail: failures.join("\n"), method };
  }
  return { ok: true, detail: checks.join("\n"), method };
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
  const helperResult = runner(hostMaintenanceCommand("tailnet-ssh-ingress"), params.logPath);
  const result = helperResult.ok ? helperResult : runner(command, params.logPath);
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
  method?: TailnetSshVerificationMethod;
}) {
  const { runtime, logPath, target } = params;
  const commandPrefix = params.method === "tailscale-ssh" ? "tailscale ssh" : "ssh";
  runtime.error("Hosting setup stopped before SSH/firewall lock-down.");
  runtime.error(`Confirm SSH over Tailscale first: ${commandPrefix} ${target.user}@${target.host}`);
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
  interactiveRunner?: InteractiveHostSecurityCommandRunner;
}): Promise<boolean> {
  const { opts, runtime, prompter, logPath } = params;
  const runner = params.runner ?? run;
  const interactiveRunner = params.interactiveRunner ?? runInteractiveTailscaleLogin;
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
    const serverPrereqs = verifyTailnetSshServerPrerequisites({ target, logPath, runner });
    failTailnetSshConfirmation({ runtime, logPath, target, method: serverPrereqs.method });
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
    if (serverPrereqs.method === "ssh-key") {
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
      appendHostSecurityLog(
        logPath,
        "tailnet ssh ingress prepared for verification",
        ingress.detail,
      );
    } else {
      appendHostSecurityLog(
        logPath,
        "tailnet ssh verification mode",
        "using Tailscale SSH because app authorized_keys is empty",
      );
    }
    await prompter.note(
      formatTailnetSshVerificationNote(target, serverPrereqs.method),
      "Verify SSH over Tailscale",
    );
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
        failTailnetSshConfirmation({ runtime, logPath, target, method: serverPrereqs.method });
        return false;
      }
      await prompter.note(formatTailscaleAccountBrowserLoginNote(), "Tailscale login");
      const tsReset = await interactiveRunner(
        hostMaintenanceCommand("tailscale-up-reset-ssh"),
        logPath,
        prompter,
      );
      const acceptedTimedOutLogin = tailscaleTimedOutButReady(tsReset, logPath, runner);
      if ((!tsReset.ok && !acceptedTimedOutLogin) || !hasTailscaleIp(logPath, runner)) {
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
      message:
        serverPrereqs.method === "tailscale-ssh"
          ? `Did Tailscale SSH connect as ${target.user} and open ${target.repoDir}?`
          : `Did SSH over Tailscale connect as ${target.user} and open ${target.repoDir}?`,
      initialValue: false,
    });
    if (!confirmed) {
      if (serverPrereqs.method === "tailscale-ssh") {
        const useKeyFallback = await prompter.confirm({
          message: "Use SSH public key fallback instead?",
          initialValue: false,
        });
        if (useKeyFallback) {
          const keysReady = await ensureTailnetSshAuthorizedKeys({
            target,
            logPath,
            runtime,
            prompter,
            runner,
          });
          if (!keysReady) {
            return false;
          }
          continue;
        }
      }
      failTailnetSshConfirmation({ runtime, logPath, target, method: serverPrereqs.method });
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
  const modernSudo = run(hostMaintenanceCommandWithInput("tailscale-serve", String(port)), logPath);
  if (modernSudo.ok) {
    return { ok: true, detail: `host maintenance tailscale serve -> 127.0.0.1:${port}` };
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
    probe = spawnSync("bash", ["-lc", hostMaintenanceCommand("tailscale-serve-status")], {
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

function tailscaleInstallCommand(): string {
  return [
    `${hostMaintenanceCommand("tailscale-install-start")} && exit 0`,
    "if command -v tailscale >/dev/null 2>&1; then",
    "  :",
    "elif command -v apt-get >/dev/null 2>&1; then",
    "  curl -fsSL https://tailscale.com/install.sh | sudo -E env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a sh",
    "elif command -v dnf >/dev/null 2>&1; then",
    "  sudo -n dnf install -y tailscale || curl -fsSL https://tailscale.com/install.sh | sudo -E sh",
    "elif command -v dnf5 >/dev/null 2>&1; then",
    "  sudo -n dnf5 install -y tailscale || curl -fsSL https://tailscale.com/install.sh | sudo -E sh",
    "elif command -v yum >/dev/null 2>&1; then",
    "  sudo -n yum install -y tailscale || curl -fsSL https://tailscale.com/install.sh | sudo -E sh",
    "elif command -v pacman >/dev/null 2>&1; then",
    "  sudo -n pacman -Sy --needed --noconfirm tailscale",
    "elif command -v apk >/dev/null 2>&1; then",
    "  sudo -n apk add --no-cache tailscale",
    "else",
    "  curl -fsSL https://tailscale.com/install.sh | sudo -E sh",
    "fi",
    "if command -v systemctl >/dev/null 2>&1; then",
    "  sudo -n systemctl enable --now tailscaled >/dev/null 2>&1 || true",
    "fi",
    "command -v tailscale >/dev/null 2>&1",
  ].join("\n");
}

function firewallBaselineCommand(): string {
  return [
    `${hostMaintenanceCommand("firewall-baseline")} && exit 0`,
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
    `${hostMaintenanceCommand("automatic-updates")} && exit 0`,
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
    "  sudo -n /usr/local/sbin/fased-host-maintenance enable-dnf-automatic >/dev/null 2>&1 || sudo -n sed -i 's/^apply_updates[[:space:]]*=.*/apply_updates = yes/' /etc/dnf/automatic.conf >/dev/null 2>&1 || true",
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

function sshHardeningCommand(): string {
  return hostMaintenanceCommand("harden-ssh");
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
      const useBrowserLogin = await prompter.confirm({
        message: "Use browser login for Tailscale? (recommended)",
        initialValue: true,
      });
      if (!useBrowserLogin) {
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
        await prompter.note(formatTailscaleBrowserLoginNote(), "Tailscale login");
      }
    }

    const resetCommand = tsAuthkey
      ? hostMaintenanceCommandWithInput("tailscale-up-reset-authkey-ssh", tsAuthkey)
      : hostMaintenanceCommand("tailscale-up-reset-ssh");
    const tsReset = tsAuthkey
      ? run(resetCommand, logPath)
      : await runInteractiveTailscaleLogin(resetCommand, logPath, prompter);
    if (!tsReset.ok && !tailscaleTimedOutButReady(tsReset, logPath)) {
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
    const installTs = run(tailscaleInstallCommand(), logPath);
    if (!installTs.ok) {
      checks.push({
        name: "tailscale",
        ok: false,
        detail: installTs.detail ?? "tailscale install failed",
      });
      failOrContinue({ opts, runtime, step: "tailscale install failed", detail: installTs.detail });
      return { profile, checks, enforced: false, logPath };
    }
  } else if (hasCommand("systemctl")) {
    run(
      `${hostMaintenanceCommand("tailscale-install-start")} >/dev/null 2>&1 || sudo -n systemctl enable --now tailscaled >/dev/null 2>&1 || true`,
      logPath,
    );
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
        await prompter.note(formatTailscaleBrowserLoginNote(), "Tailscale login");
      }
      const tsReset = await runInteractiveTailscaleLogin(
        hostMaintenanceCommand("tailscale-up-reset-ssh"),
        logPath,
        prompter,
      );
      if (!tsReset.ok && !tailscaleTimedOutButReady(tsReset, logPath)) {
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
      const useBrowserLogin = await prompter.confirm({
        message: "Use browser login for Tailscale? (recommended)",
        initialValue: true,
      });
      if (!useBrowserLogin) {
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
        hostMaintenanceCommandWithInput("tailscale-up-authkey-ssh", tsAuthkey),
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
        await prompter.note(formatTailscaleBrowserLoginNote(), "Tailscale login");
      }
      const tsUp = await runInteractiveTailscaleLogin(
        hostMaintenanceCommand("tailscale-up-ssh"),
        logPath,
        prompter,
      );
      if (!tsUp.ok && !tailscaleTimedOutButReady(tsUp, logPath)) {
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
    run(
      `${hostMaintenanceCommand("tailscale-set-operator-self")} >/dev/null 2>&1 || true`,
      logPath,
    );
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

  const sshRes = run(sshHardeningCommand(), logPath);
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
    `${hostMaintenanceCommand("fail2ban-enable")} || (${packageInstallCommand(["fail2ban"])}\nsudo -n systemctl enable --now fail2ban)`,
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

  appendHostSecurityLog(logPath, "hosting host hardening complete", "enforced");
  return { profile, checks, enforced: true, logPath };
}

export const __testing = {
  formatLocalDeviceTailnetRequirementNote,
  formatTailscaleBrowserLoginNote,
  formatTailnetSshVerificationNote,
  hasTailscaleIp,
  hasExplicitTailnetSshConfirmation,
  isTailscaleLoggedIn,
  readTailscaleIp,
  resolveHostingSwapGb,
  resolveTailnetSshTarget,
  sanitizeHostSecurityLogText,
  confirmTailnetSshBeforeLockdown,
  buildInstallTailnetSshAuthorizedKeysCommand,
  formatTailnetSshPublicKeyNote,
  normalizeSshPublicKeys,
  ensureTailnetSshIngressForVerification,
  firewallBaselineCommand,
  packageInstallCommand,
  tailscaleInstallCommand,
  automaticUpdatesCommand,
  sshHardeningCommand,
  buildTailscaleLoginWaitCommand,
  verifyTailnetSshServerPrerequisites,
};
