import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { formatCliCommand } from "../cli/command-format.js";
import {
  buildGatewayInstallPlan,
  gatewayInstallErrorHint,
  resolveHostedOnboardingGatewayStartupMode,
  resolveGatewayStartupMode,
} from "../commands/daemon-install-helpers.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
} from "../commands/daemon-runtime.js";
import { formatHealthCheckFailure } from "../commands/health-format.js";
import { healthCommand } from "../commands/health.js";
import {
  detectBrowserOpenSupport,
  formatControlUiSshHint,
  openUrl,
  probeGatewayReachable,
  waitForGatewayReachable,
  resolveControlUiLinks,
} from "../commands/onboard-helpers.js";
import type { OnboardOptions } from "../commands/onboard-types.js";
import type { FasedAgentConfig } from "../config/config.js";
import { collectConfigServiceEnvVars } from "../config/env-vars.js";
import type { GatewayStartupMode } from "../daemon/program-args.js";
import { auditGatewayServiceConfig, SERVICE_AUDIT_CODES } from "../daemon/service-audit.js";
import { resolveGatewayMaxOldSpaceMb } from "../daemon/service-env.js";
import { resolveGatewayService } from "../daemon/service.js";
import { buildSystemdUnit } from "../daemon/systemd-unit.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import { loadPersistedFederationToken } from "../federation/access-token.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui-shared.js";
import { clearDeviceAuthStore } from "../infra/device-auth-store.js";
import { enableTailscaleFunnel, enableTailscaleServe } from "../infra/tailscale.js";
import { readManagedFederationTokenSummary } from "../managed/federation.js";
import { readManagedReservationSummaries } from "../managed/tunnel.js";
import { describeOperatorReadinessChecklist } from "../operator/operator-readiness.js";
import type { RuntimeEnv } from "../runtime.js";
import { restoreTerminalState } from "../terminal/restore.js";
import { runTui } from "../tui/tui.js";
import { resolveUserPath } from "../utils.js";
import { readWalletProviderRegistry } from "../wallet/wallet-provider-registry.js";
import { readWalletStatusSnapshot } from "../wallet/wallet-status.js";
import type {
  FederationWizardSettings,
  GatewayWizardSettings,
  WizardFlow,
} from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";

type FinalizeOnboardingOptions = {
  flow: WizardFlow;
  opts: OnboardOptions;
  baseConfig: FasedAgentConfig;
  nextConfig: FasedAgentConfig;
  workspaceDir: string;
  settings: GatewayWizardSettings;
  federation: FederationWizardSettings;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  walletSecurityFocus?: {
    walletId: string;
    role: "agent" | "vault";
  } | null;
};

export function buildOnboardingDashboardUrl(params: {
  baseUrl: string;
  basePath?: string;
  token?: string;
  walletSecurityFocus?: {
    walletId: string;
    role: "agent" | "vault";
  } | null;
}): string {
  const url = new URL(params.baseUrl);
  const basePath = normalizeControlUiBasePath(params.basePath);
  url.pathname = basePath ? `${basePath}/` : "/";
  url.searchParams.delete("wallet");
  url.searchParams.delete("wallet_role");
  url.searchParams.delete("wallet_security");
  url.searchParams.delete("token");
  const hashParams = new URLSearchParams();
  const token = params.token?.trim();
  if (token) {
    hashParams.set("token", token);
  }
  const walletSecurityFocus = params.walletSecurityFocus;
  if (walletSecurityFocus?.walletId) {
    hashParams.set("wallet", walletSecurityFocus.walletId);
    hashParams.set("wallet_role", walletSecurityFocus.role);
    hashParams.set("wallet_security", "1");
  }
  const hash = hashParams.toString();
  url.hash = hash ? `#${hash}` : "";
  return url.toString();
}

export function formatStrictRemoteAccessDetails(params: {
  tailscaleSshUser: string;
  tailscaleNodeName?: string;
  tailscaleIpv4?: string;
  dashboardUrl: string;
  tunnelUrl: string;
  port: number;
  gatewayToken?: string;
}): string {
  const sshTarget = params.tailscaleNodeName || params.tailscaleIpv4 || "(tailscale-node)";
  return [
    "Use both access paths after hosted setup:",
    "",
    "1. WEB DASHBOARD",
    "   Open this on your own computer after signing into the same Tailscale account:",
    `   ${params.dashboardUrl}`,
    "",
    "2. SSH TERMINAL",
    "   Use this for CLI commands, updates, logs, and repairs:",
    `   tailscale ssh ${params.tailscaleSshUser}@${sshTarget}`,
    "   The app user shell opens in the Fased repo directory.",
    "",
    "ADVANCED FALLBACK",
    "   If the Tailscale web URL is unavailable, run this on your local computer and leave it open:",
    `   ssh -N -L ${params.port}:127.0.0.1:${params.port} ${params.tailscaleSshUser}@${sshTarget}`,
    "   Then open:",
    `   ${params.tunnelUrl}`,
    "",
    "GATEWAY TOKEN BACKUP",
    "   Only paste this if the browser asks for a token:",
    `   ${params.gatewayToken || "(token not available)"}`,
  ].join("\n");
}

export function buildGatewayWsUrlFromHttpUrl(params: {
  httpUrl: string;
  basePath?: string;
}): string {
  const url = new URL(params.httpUrl);
  const protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const basePath = normalizeControlUiBasePath(params.basePath);
  return `${protocol}//${url.host}${basePath}`;
}

async function runShell(
  command: string,
  options?: { timeoutMs?: number },
): Promise<{ ok: boolean; detail?: string }> {
  return await new Promise((resolve) => {
    const timeoutMs = Math.max(1_000, options?.timeoutMs ?? 30_000);
    const child = spawn("bash", ["-lc", command], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      cwd: process.cwd(),
    });
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (result: { ok: boolean; detail?: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => finish({ ok: false, detail: String(err) }));
    child.on("close", (code) => {
      if (timedOut) {
        const detail = (stderr || stdout || "timed out").trim();
        finish({ ok: false, detail: `timeout after ${timeoutMs}ms: ${detail}` });
        return;
      }
      if ((code ?? 1) === 0) {
        const detail = stdout.trim() || undefined;
        finish({ ok: true, detail });
        return;
      }
      const detail = (stderr || stdout || `exit=${code ?? 1}`).trim();
      finish({ ok: false, detail });
    });
  });
}

async function installRootServiceMaintenanceAccess(params: {
  serviceName: string;
  runAsUser: string;
}): Promise<{ ok: boolean; detail?: string }> {
  const safeServiceName = params.serviceName.replace(/[^A-Za-z0-9@_.-]/g, "");
  const safeUser = params.runAsUser.replace(/[^A-Za-z0-9@_.-]/g, "");
  const sudoersPath = `/etc/sudoers.d/${safeServiceName}-${safeUser}-maintenance`;
  const sudoers = [
    `${safeUser} ALL=(root) NOPASSWD: /usr/bin/systemctl restart ${safeServiceName}.service`,
    `${safeUser} ALL=(root) NOPASSWD: /usr/bin/systemctl restart --no-block ${safeServiceName}.service`,
    `${safeUser} ALL=(root) NOPASSWD: /usr/bin/systemctl status ${safeServiceName}.service`,
    `${safeUser} ALL=(root) NOPASSWD: /usr/bin/systemctl is-active ${safeServiceName}.service`,
  ].join("\n");
  const b64 = Buffer.from(`${sudoers}\n`, "utf8").toString("base64");
  const installCommand = [
    `echo '${b64}' | base64 -d | sudo -n tee '${sudoersPath}' >/dev/null`,
    `sudo -n chmod 440 '${sudoersPath}'`,
    `if command -v visudo >/dev/null 2>&1; then sudo -n visudo -cf '${sudoersPath}' >/dev/null; fi`,
  ].join(" && ");
  return await runShell(installCommand);
}

async function installRootSystemdFallback(params: {
  serviceName: string;
  runAsUser: string;
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
}): Promise<{ ok: boolean; detail?: string }> {
  const unitPath = `/etc/systemd/system/${params.serviceName}.service`;
  const escapedUser = params.runAsUser.replace(/"/g, '\\"');
  const baseUnit = buildSystemdUnit({
    description: "Fased Gateway (managed)",
    programArguments: params.programArguments,
    workingDirectory: params.workingDirectory,
    environment: params.environment,
  });
  const unitLines = baseUnit.split("\n");
  const installIndex = unitLines.findIndex((line) => line.trim() === "[Install]");
  const wantedByIndex = unitLines.findIndex((line) => line.trim() === "WantedBy=default.target");
  if (wantedByIndex !== -1) {
    unitLines[wantedByIndex] = "WantedBy=multi-user.target";
  }
  if (installIndex !== -1) {
    unitLines.splice(installIndex, 0, "NoNewPrivileges=true", "PrivateTmp=true");
  }
  const serviceIndex = unitLines.findIndex((line) => line.trim() === "[Service]");
  if (serviceIndex !== -1) {
    unitLines.splice(
      serviceIndex + 1,
      0,
      "Type=simple",
      `User=${escapedUser}`,
      `Group=${escapedUser}`,
    );
  }
  const unit = unitLines.join("\n");
  const b64 = Buffer.from(unit, "utf8").toString("base64");
  const installCommand = [
    `echo '${b64}' | base64 -d | sudo -n tee '${unitPath}' >/dev/null`,
    "sudo -n systemctl daemon-reload",
    `sudo -n systemctl enable --now '${params.serviceName}.service'`,
  ].join(" && ");
  const result = await runShell(installCommand);
  if (!result.ok) {
    return {
      ok: false,
      detail:
        `systemd install failed (exit=${result.detail}). This usually requires interactive sudo. ` +
        `Please run manually: sudo tee ${unitPath} <<EOF\n${unit}\nEOF && ` +
        `sudo systemctl daemon-reload && sudo systemctl enable --now ${params.serviceName}.service`,
    };
  }
  if (params.runAsUser !== "root") {
    const maintenanceAccess = await installRootServiceMaintenanceAccess({
      serviceName: params.serviceName,
      runAsUser: params.runAsUser,
    });
    if (!maintenanceAccess.ok) {
      return {
        ok: false,
        detail:
          `systemd install succeeded, but post-install maintenance access failed (${maintenanceAccess.detail ?? "unknown error"}). ` +
          `Without this, ${params.runAsUser} cannot restart ${params.serviceName}.service after updates.`,
      };
    }
  }
  return result;
}

async function buildOnboardingGatewayInstallPlan(params: {
  port: number;
  token?: string;
  runtime: (typeof GATEWAY_DAEMON_RUNTIME_OPTIONS)[number]["value"];
  config: FasedAgentConfig;
  prompter: WizardPrompter;
  strictVps?: boolean;
  startupMode?: GatewayStartupMode;
}): Promise<{
  programArguments: string[];
  workingDirectory?: string;
  environment: Record<string, string | undefined>;
}> {
  return await buildGatewayInstallPlan({
    env:
      params.startupMode === "managed-up" || params.strictVps
        ? {
            ...process.env,
            FASED_GATEWAY_MODE: "managed",
          }
        : process.env,
    port: params.port,
    token: params.token,
    runtime: params.runtime,
    warn: (message, title) => params.prompter.note(message, title),
    config: params.config,
    startupMode: params.startupMode,
  });
}

export function resolveGatewayServiceRunAsUser(): string | undefined {
  const currentUser = process.env.USER?.trim() || process.env.LOGNAME?.trim();
  if (currentUser && currentUser !== "root") {
    return currentUser;
  }
  const installUser = process.env.FASED_INSTALL_USER?.trim();
  if (installUser && installUser !== "root") {
    return installUser;
  }
  const sudoUser = process.env.SUDO_USER?.trim();
  if (sudoUser && sudoUser !== "root") {
    return sudoUser;
  }
  try {
    const osUser = os.userInfo().username.trim();
    if (osUser && osUser !== "root") {
      return osUser;
    }
    return currentUser || installUser || sudoUser || osUser || undefined;
  } catch {
    return currentUser || installUser || sudoUser || undefined;
  }
}

export function resolveVerifiedRootServiceReady(params: {
  restartQueued: boolean;
  activeAfterRestart: boolean;
  repairInstalled: boolean;
}): boolean {
  void params.restartQueued;
  return params.activeAfterRestart || params.repairInstalled;
}

export function resolveLocalSignerSyncForFinalize(params: { strictVps: boolean }): {
  sync: boolean;
  restart: boolean;
} {
  return {
    sync: true,
    restart: !params.strictVps,
  };
}

export function formatPersistentRuntimeServiceFailure(params: {
  strictVps: boolean;
  startupMode: GatewayStartupMode;
  lastDetail: string;
}): string {
  const detail = params.lastDetail || "inactive";
  if (params.strictVps) {
    const hint =
      detail === "failed"
        ? "\nCheck logs with: sudo journalctl -u fased-gateway -n 50 --no-pager"
        : "";
    return `Hosting requires persistent runtime service, but no active fased-gateway systemd service was detected (status=${detail}).${hint}`;
  }
  if (params.startupMode === "managed-up") {
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : "1000";
    const logDir = path.join("/tmp", `fased-${uid}`);
    return [
      `Local managed runtime requires an active fased-gateway systemd user service, but no active service was detected (status=${detail}).`,
      "Check logs with:",
      "  systemctl --user status fased-gateway --no-pager -l",
      "  journalctl --user -u fased-gateway -n 120 --no-pager",
      `  tail -n 80 ${path.join(logDir, "start-managed-gateway.log")}`,
      `  tail -n 80 ${path.join(logDir, "start-managed-zrok.log")}`,
    ].join("\n");
  }
  return `Persistent runtime service was not detected (status=${detail}).`;
}

async function migrateStrictVpsGatewayServices(): Promise<{ ok: boolean; detail?: string }> {
  return await runShell(
    [
      "systemctl --user disable --now fased-gateway 2>/dev/null || true",
      "systemctl --user reset-failed fased-gateway 2>/dev/null || true",
      "rm -f ~/.config/systemd/user/fased-gateway.service 2>/dev/null || true",
      "rm -rf ~/.config/systemd/user/fased-gateway.service.d 2>/dev/null || true",
      "systemctl --user daemon-reload 2>/dev/null || true",
      "sudo -n systemctl disable --now fased-gateway 2>/dev/null || true",
      "sudo -n systemctl reset-failed fased-gateway 2>/dev/null || true",
      "sudo -n rm -rf /etc/systemd/system/fased-gateway.service.d 2>/dev/null || true",
      "sudo -n pkill -f 'start-managed.sh|start-vps.sh|run-node.mjs managed up|run-node.mjs gateway|dist/index.js managed up|fased.mjs start --mode managed|zrok share' 2>/dev/null || true",
      "sleep 1",
      "sudo -n systemctl daemon-reload 2>/dev/null || true",
      "true",
    ].join(" ; "),
  );
}

async function verifyStrictRootGatewayExecStart(
  serviceName = "fased-gateway",
  startupMode: GatewayStartupMode = "gateway",
  runAsUser?: string,
): Promise<{ ok: boolean; detail?: string }> {
  const safeRunAsUser = runAsUser?.trim();
  return await runShell(
    [
      startupMode === "managed-up"
        ? `sudo -n systemctl cat ${serviceName}.service 2>/dev/null | grep -E '^ExecStart=' | grep -E ' managed up|start-(managed|vps)\\.sh' >/dev/null`
        : `sudo -n systemctl cat ${serviceName}.service 2>/dev/null | grep -E '^ExecStart=' | grep -F ' gateway ' >/dev/null`,
      `sudo -n systemctl cat ${serviceName}.service 2>/dev/null | grep -F 'Environment=FASED_GATEWAY_PORT=' >/dev/null`,
      ...(safeRunAsUser
        ? [
            `sudo -n systemctl cat ${serviceName}.service 2>/dev/null | grep -F 'User=${safeRunAsUser}' >/dev/null`,
          ]
        : []),
      "true",
    ].join(" ; "),
  );
}

async function isSystemdServiceActive(params: {
  name: string;
  scope: "root" | "user";
}): Promise<{ ok: boolean; detail?: string }> {
  const command =
    params.scope === "root"
      ? `sudo -n systemctl is-active ${params.name} 2>/dev/null`
      : `systemctl --user is-active ${params.name} 2>/dev/null`;
  const result = await runShell(command, { timeoutMs: 5_000 });
  return result;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function verifyStrictVpsMaintenanceReadiness(params: {
  repoRoot: string;
  runAsUser: string;
  configDir: string;
  nextConfig: FasedAgentConfig;
}): Promise<void> {
  const repoRoot = params.repoRoot.trim();
  const configDir = params.configDir.trim();
  const runAsUser = params.runAsUser.trim();
  const repoRootQuoted = shellQuote(repoRoot);
  const configDirQuoted = shellQuote(configDir);
  const runAsUserQuoted = shellQuote(runAsUser);

  const origin = await runShell(`git -C ${repoRootQuoted} remote get-url origin`);
  const originUrl = origin.detail?.trim() ?? "";
  if (!origin.ok || !originUrl) {
    throw new Error("Hosting requires a Git remote for the app checkout before completion.");
  }
  if (originUrl.startsWith("/") || originUrl.startsWith("file://")) {
    throw new Error(
      `Hosting requires the app checkout remote to point at GitHub/auth remote, not ${originUrl}`,
    );
  }

  const repoOwner = await runShell(`test "$(stat -c %U ${repoRootQuoted})" = ${runAsUserQuoted}`);
  if (!repoOwner.ok) {
    throw new Error(`Hosting requires ${repoRoot} to be owned by ${runAsUser} before completion.`);
  }

  const stateOwner = await runShell(`test "$(stat -c %U ${configDirQuoted})" = ${runAsUserQuoted}`);
  if (!stateOwner.ok) {
    throw new Error(`Hosting requires ${configDir} to be owned by ${runAsUser} before completion.`);
  }

  const tailscaleOperator = await runShell("tailscale serve status >/dev/null 2>&1");
  if (!tailscaleOperator.ok) {
    throw new Error(
      "Hosting requires unprivileged tailscale serve status access for the app maintenance user before completion.",
    );
  }

  const walletStatus = await readWalletStatusSnapshot({
    config: params.nextConfig,
    env: process.env,
  });
  if (walletStatus.enabled && !walletStatus.service.healthy) {
    let detail = walletStatus.error ?? `${walletStatus.provider.id} wallet runtime is unhealthy`;
    if (walletStatus.provider.id === "local-socket-signer") {
      try {
        const { collectWalletSignerDoctorReport } = await import("../commands/wallet.js");
        const doctor = await collectWalletSignerDoctorReport(process.env);
        const firstFailedCheck = doctor.checks.find((check) => !check.ok);
        if (firstFailedCheck) {
          detail = `${firstFailedCheck.check}: ${firstFailedCheck.detail ?? "failed"}`;
        }
      } catch {
        // Keep the wallet status detail when signer doctor is unavailable.
      }
    }
    throw new Error(`Hosting requires healthy wallet runtime before completion (${detail})`);
  }
}

async function isSystemdServiceRunningOrStarting(params: {
  name: string;
  scope: "root" | "user";
}): Promise<boolean> {
  const command =
    params.scope === "root"
      ? `sudo -n systemctl show ${params.name}.service -p ActiveState --value 2>/dev/null | grep -E '^(active|activating|deactivating)$' >/dev/null 2>&1`
      : `systemctl --user show ${params.name}.service -p ActiveState --value 2>/dev/null | grep -E '^(active|activating|deactivating)$' >/dev/null 2>&1`;
  const result = await runShell(command, { timeoutMs: 5_000 });
  return result.ok;
}

async function formatStrictListenerFailureDiagnostics(reason: string): Promise<string> {
  const [rootState, userState] = await Promise.all([
    isSystemdServiceActive({ name: "fased-gateway", scope: "root" }),
    isSystemdServiceActive({ name: "fased-gateway", scope: "user" }),
  ]);
  const gatewayLogTails = await collectManagedGatewayBootLogTails();
  return [
    reason,
    `systemd root is-active: ${rootState.detail ?? (rootState.ok ? "active" : "unknown")}`,
    `systemd user is-active: ${userState.detail ?? (userState.ok ? "active" : "unknown")}`,
    ...gatewayLogTails.flatMap(({ file, tail }) => [`Gateway boot log tail (${file}):`, tail]),
    "Debug commands:",
    "  sudo systemctl status fased-gateway --no-pager",
    "  sudo journalctl -u fased-gateway -n 120 --no-pager",
  ].join("\n");
}

async function collectManagedGatewayBootLogTails(): Promise<Array<{ file: string; tail: string }>> {
  const candidates = new Set<string>();
  const configDir = process.env.FASED_CONFIG_DIR?.trim() || resolveUserPath("~/.fased");
  candidates.add(path.join(configDir, "logs", "start-managed-gateway.log"));
  candidates.add(path.join(configDir, "logs", "start-managed.log"));
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "1000";
  candidates.add(path.join("/tmp", `fased-${uid}`, "start-managed-gateway.log"));
  try {
    const entries = await fs.readdir("/tmp", { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^fased-\d+$/.test(entry.name)) {
        continue;
      }
      candidates.add(path.join("/tmp", entry.name, "start-managed-gateway.log"));
    }
  } catch {
    // Keep the UID-specific fallback only.
  }

  const tails: Array<{ file: string; tail: string }> = [];
  for (const file of candidates) {
    try {
      const logText = await fs.readFile(file, "utf8");
      const lines = logText
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean);
      if (lines.length > 0) {
        tails.push({ file, tail: lines.slice(-20).join("\n") });
      }
    } catch {
      // Missing or unreadable boot logs are expected during early startup.
    }
    if (tails.length >= 3) {
      break;
    }
  }
  return tails;
}

async function restartGatewayServiceOnce(
  serviceName = "fased-gateway",
): Promise<{ ok: boolean; detail?: string }> {
  const attempts: Array<{
    label: string;
    command: string;
    timeoutMs?: number;
    timeoutIsProgress?: boolean;
  }> = [
    {
      label: "root restart",
      command: `sudo -n systemctl restart --no-block ${serviceName}.service >/dev/null 2>&1`,
      timeoutMs: 8_000,
      timeoutIsProgress: true,
    },
    {
      label: "root start",
      command: `sudo -n systemctl start --no-block ${serviceName}.service >/dev/null 2>&1`,
      timeoutMs: 8_000,
      timeoutIsProgress: true,
    },
    {
      label: "root enable+start",
      command: `sudo -n systemctl enable --now ${serviceName}.service >/dev/null 2>&1`,
      timeoutMs: 12_000,
      timeoutIsProgress: true,
    },
    {
      label: "user restart",
      command: `systemctl --user restart --no-block ${serviceName}.service >/dev/null 2>&1`,
      timeoutMs: 8_000,
      timeoutIsProgress: true,
    },
    {
      label: "user start",
      command: `systemctl --user start --no-block ${serviceName}.service >/dev/null 2>&1`,
      timeoutMs: 8_000,
      timeoutIsProgress: true,
    },
  ];

  const failures: string[] = [];
  for (const attempt of attempts) {
    const result = await runShell(attempt.command, { timeoutMs: attempt.timeoutMs });
    if (result.ok) {
      return { ok: true, detail: `queued ${attempt.label}` };
    }
    const detail = String(result.detail ?? "unknown error");
    failures.push(`${attempt.label}: ${detail}`);
    if (attempt.timeoutIsProgress && detail.toLowerCase().includes("timeout")) {
      return {
        ok: true,
        detail: `${attempt.label} still progressing (continuing listener wait)`,
      };
    }
  }

  return {
    ok: false,
    detail: failures.join(" | ") || "gateway service restart unavailable",
  };
}

export function isCanonicalGatewayServiceCommand(
  programArguments: string[] | undefined,
  startupMode: GatewayStartupMode = "gateway",
): boolean {
  const args = Array.isArray(programArguments) ? programArguments : [];
  if (args.length === 0) {
    return false;
  }
  const joined = args.join(" ");
  const isGatewayCommand = joined.includes(" gateway ") && joined.includes(" --port ");
  const isManagedUpCommand =
    joined.includes(" managed up") ||
    args.some((arg) => /(^|[\\/])start-(managed|vps)\.sh$/i.test(arg));
  return startupMode === "managed-up" ? isManagedUpCommand : isGatewayCommand;
}

function wsToHttpUrl(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  return parsed.toString();
}

async function waitForGatewayHttpListener(params: {
  wsUrl: string;
  deadlineMs: number;
  pollMs?: number;
}): Promise<{ ok: boolean; detail?: string }> {
  const deadlineAt = Date.now() + Math.max(1, params.deadlineMs);
  const pollMs = Math.max(100, params.pollMs ?? 500);
  const httpUrl = wsToHttpUrl(params.wsUrl);
  let lastError = "connection not ready";
  while (Date.now() < deadlineAt) {
    try {
      const res = await fetch(httpUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });
      if (res.status > 0) {
        return { ok: true };
      }
      lastError = `http status ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { ok: false, detail: lastError };
}

async function waitForManagedFederationSummary(params: {
  env: NodeJS.ProcessEnv;
  deadlineMs?: number;
  pollMs?: number;
}): Promise<{
  fedToken: ReturnType<typeof readManagedFederationTokenSummary>;
  reservations: ReturnType<typeof readManagedReservationSummaries>;
}> {
  const deadlineAt = Date.now() + Math.max(1_000, params.deadlineMs ?? 12_000);
  const pollMs = Math.max(200, params.pollMs ?? 750);
  let fedToken = readManagedFederationTokenSummary(params.env);
  let reservations = readManagedReservationSummaries(params.env);
  while (Date.now() < deadlineAt) {
    const resolvedPublicUrl = (fedToken.publicUrl ?? "").trim();
    if (resolvedPublicUrl || fedToken.exists || reservations.length > 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    fedToken = readManagedFederationTokenSummary(params.env);
    reservations = readManagedReservationSummaries(params.env);
  }
  return { fedToken, reservations };
}

function readSatMiningWalletId(config: FasedAgentConfig): string | null {
  const raw = config.plugins?.entries?.["sat-mining"]?.config;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const walletId = "walletId" in raw ? raw.walletId : undefined;
  return typeof walletId === "string" && walletId.trim().length > 0 ? walletId.trim() : null;
}

function formatOperatorReadinessSummary(
  items: ReturnType<typeof describeOperatorReadinessChecklist>,
): string {
  const summaryLines = items.map((item) => `- ${item.title}: ${item.summary}`);
  const nextActionLines: string[] = [];
  if (
    items.some((item) => item.title === "Wallet Control Passkey ready" && item.tone !== "success")
  ) {
    nextActionLines.push(
      "- Wallet: finish Wallet Control Passkey before trusting higher-risk automation.",
    );
  }
  if (items.some((item) => item.title === "Agent wallet set" && item.tone !== "success")) {
    nextActionLines.push(
      "- Wallet: set a dedicated Agent wallet before paid Fased Network or skill wallet work.",
    );
  }
  if (
    items.some((item) => item.title === "Mining wallet separate" && item.summary === "Conflict")
  ) {
    nextActionLines.push(
      "- Mining: move Mining to a separate wallet before using paid Agent wallet flows.",
    );
  } else if (
    items.some(
      (item) =>
        item.title === "Mining wallet separate" && item.summary === "Optional and not configured",
    )
  ) {
    nextActionLines.push(
      "- Mining: optional. If you enable it later, create or import the singleton @wallet:mining wallet.",
    );
  }
  if (
    items.some(
      (item) => item.title === "Fased Network joined / trusted" && item.summary !== "Verified",
    )
  ) {
    nextActionLines.push(
      "- Fased Network: register, attest, and complete trust review before expecting normal network routing.",
    );
  }
  if (
    items.some(
      (item) =>
        item.title === "Fased Network reachability state" &&
        item.summary !== "Ready" &&
        item.summary !== "Disabled",
    )
  ) {
    nextActionLines.push(
      "- Fased Network: check hosted token issuance if you expect a public URL.",
    );
  }
  return [
    "Operator readiness summary:",
    ...summaryLines,
    ...(nextActionLines.length > 0 ? ["", "Next actions:", ...nextActionLines] : []),
  ].join("\n");
}

async function waitForStableGatewayHttpListener(params: {
  wsUrl: string;
  deadlineMs: number;
  stableMs?: number;
  pollMs?: number;
}): Promise<{ ok: boolean; detail?: string }> {
  const deadlineAt = Date.now() + Math.max(1, params.deadlineMs);
  const stableMs = Math.max(1_000, params.stableMs ?? 8_000);
  const pollMs = Math.max(200, params.pollMs ?? 500);
  let stableSince = 0;
  let lastDetail = "listener not ready";
  while (Date.now() < deadlineAt) {
    const probe = await waitForGatewayHttpListener({
      wsUrl: params.wsUrl,
      deadlineMs: 2_500,
      pollMs: 250,
    });
    if (probe.ok) {
      if (stableSince === 0) {
        stableSince = Date.now();
      }
      if (Date.now() - stableSince >= stableMs) {
        return { ok: true };
      }
    } else {
      stableSince = 0;
      lastDetail = probe.detail ?? lastDetail;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { ok: false, detail: lastDetail };
}

async function verifyStrictHostedGatewayReady(params: {
  wsUrl: string;
  token?: string;
  password?: string;
  lowRamMode: boolean;
}): Promise<{ ok: boolean; detail?: string }> {
  const listener = await waitForStableGatewayHttpListener({
    wsUrl: params.wsUrl,
    deadlineMs: params.lowRamMode ? 180_000 : 90_000,
    stableMs: 8_000,
    pollMs: 750,
  });
  if (!listener.ok) {
    return {
      ok: false,
      detail: `listener not stable: ${listener.detail ?? "not reachable"}`,
    };
  }
  const probe = await waitForGatewayReachable({
    url: params.wsUrl,
    token: params.token,
    password: params.password,
    deadlineMs: params.lowRamMode ? 60_000 : 30_000,
    probeTimeoutMs: 5_000,
    pollMs: 750,
  });
  if (!probe.ok) {
    return {
      ok: false,
      detail: `gateway health failed: ${probe.detail ?? "not reachable"}`,
    };
  }
  return { ok: true };
}

async function waitForHttpUrlReachable(params: {
  url: string;
  deadlineMs: number;
  pollMs?: number;
  requestTimeoutMs?: number;
  successStatuses?: number[];
}): Promise<{ ok: boolean; detail?: string }> {
  const deadlineAt = Date.now() + Math.max(1, params.deadlineMs);
  const pollMs = Math.max(250, params.pollMs ?? 1_000);
  const requestTimeoutMs = Math.max(500, params.requestTimeoutMs ?? 4_000);
  const successStatuses = new Set([
    200,
    201,
    202,
    203,
    204,
    205,
    206,
    301,
    302,
    303,
    304,
    307,
    308,
    ...(params.successStatuses ?? []),
  ]);
  let lastError = "connection not ready";
  while (Date.now() < deadlineAt) {
    try {
      const res = await fetch(params.url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (successStatuses.has(res.status)) {
        return { ok: true };
      }
      lastError = `http status ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { ok: false, detail: lastError };
}

async function waitForTailscaleServeRoute(params: {
  port: number;
  deadlineMs: number;
  pollMs?: number;
}): Promise<{ ok: boolean; detail?: string }> {
  const deadlineAt = Date.now() + Math.max(1, params.deadlineMs);
  const pollMs = Math.max(500, params.pollMs ?? 1_000);
  let lastDetail = "tailscale serve status unavailable";
  while (Date.now() < deadlineAt) {
    const status = spawnSync("tailscale", ["serve", "status"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if ((status.status ?? 1) === 0) {
      const out = `${status.stdout ?? ""}\n${status.stderr ?? ""}`;
      if (out.includes(`127.0.0.1:${params.port}`)) {
        return { ok: true };
      }
      lastDetail = "serve route not yet mapped";
    } else {
      lastDetail = String(status.stderr ?? status.stdout ?? "tailscale serve status failed").trim();
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { ok: false, detail: lastDetail };
}

type TailscaleIdentity = {
  nodeName: string;
  ipv4: string;
  adminUrl?: string;
  detail?: string;
};

function readTailscaleIdentity(basePath?: string): TailscaleIdentity {
  const probe = spawnSync("tailscale", ["status", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if ((probe.status ?? 1) !== 0 || !probe.stdout) {
    return {
      nodeName: "",
      ipv4: "",
      detail: String(probe.stderr ?? probe.stdout ?? "tailscale status unavailable").trim(),
    };
  }
  try {
    const parsed = JSON.parse(probe.stdout) as {
      Self?: { DNSName?: string; TailscaleIPs?: string[] };
    };
    const dns = String(parsed.Self?.DNSName ?? "")
      .trim()
      .replace(/\.$/, "");
    const ipv4 =
      parsed.Self?.TailscaleIPs?.find((ip) => typeof ip === "string" && ip.includes(".")) ?? "";
    return {
      nodeName: dns,
      ipv4,
      adminUrl: dns ? `https://${dns}${basePath || "/"}` : undefined,
      detail: dns ? undefined : "tailscale DNS name not ready",
    };
  } catch (err) {
    return {
      nodeName: "",
      ipv4: "",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function waitForTailscaleIdentity(params: {
  basePath?: string;
  deadlineMs: number;
  pollMs?: number;
}): Promise<{ ok: boolean; state: TailscaleIdentity; detail?: string }> {
  const deadlineAt = Date.now() + Math.max(1, params.deadlineMs);
  const pollMs = Math.max(500, params.pollMs ?? 1_000);
  let last = readTailscaleIdentity(params.basePath);
  while (Date.now() < deadlineAt) {
    if (last.adminUrl) {
      return { ok: true, state: last };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    last = readTailscaleIdentity(params.basePath);
  }
  return { ok: false, state: last, detail: last.detail ?? "tailscale identity not ready" };
}

export async function finalizeOnboardingWizard(
  options: FinalizeOnboardingOptions,
): Promise<{ launchedTui: boolean }> {
  const { flow, opts, baseConfig, nextConfig, settings, federation, prompter, runtime } = options;
  const strictVps = opts.hostProfile === "hosting";
  const hostedMaintenanceSession = strictVps && opts.hostMaintenanceSession === true;
  const recommendedGatewayMaxOldSpaceMb = resolveGatewayMaxOldSpaceMb({
    env: process.env,
    fallbackMb: 1024,
  });
  const totalMemMb = Math.floor(os.totalmem() / (1024 * 1024));
  const lowRamMode = totalMemMb <= 2300;
  process.env.FASED_GATEWAY_MAX_OLD_SPACE_MB = String(recommendedGatewayMaxOldSpaceMb);
  process.env.NODE_OPTIONS = (() => {
    const existing = String(process.env.NODE_OPTIONS ?? "").trim();
    if (existing.includes("--max-old-space-size=")) {
      return existing;
    }
    return `${existing}${existing ? " " : ""}--max-old-space-size=${recommendedGatewayMaxOldSpaceMb}`;
  })();
  const preferredGatewayToken =
    settings.authMode === "token"
      ? (nextConfig.gateway?.auth?.mode === "token"
          ? nextConfig.gateway.auth.token
          : (await fs
              .readFile(resolveUserPath("~/.fased/gateway-secret"), "utf8")
              .then((value) => value.trim())
              .catch(() => "")) ||
            settings.gatewayToken ||
            ""
        )?.trim() || ""
      : "";

  const withWizardProgress = async <T>(
    label: string,
    options: { doneMessage?: string },
    work: (progress: { update: (message: string) => void }) => Promise<T>,
  ): Promise<T> => {
    const progress =
      options.doneMessage === undefined
        ? {
            update: (_message: string) => {},
            stop: (_message?: string) => {},
          }
        : prompter.progress(label);
    let completed = false;
    try {
      const result = await work(progress);
      completed = true;
      return result;
    } finally {
      progress.stop(completed ? options.doneMessage : `${label} failed.`);
    }
  };
  const quietGatewayServiceStdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const gatewayServiceStdout = flow === "quickstart" ? quietGatewayServiceStdout : process.stdout;

  const systemdAvailable =
    process.platform === "linux" ? await isSystemdUserServiceAvailable() : true;
  if (process.platform === "linux" && !systemdAvailable) {
    await prompter.note(
      strictVps
        ? "Systemd user services are unavailable in this session. Skipping linger checks; hosted install will use root-managed service fallback if needed."
        : "Systemd user services are unavailable. Skipping lingering checks and user-service install.",
      "Systemd",
    );
  }

  if (process.platform === "linux" && systemdAvailable) {
    const { ensureSystemdUserLingerInteractive } = await import("../commands/systemd-linger.js");
    await ensureSystemdUserLingerInteractive({
      runtime,
      prompter: {
        confirm: prompter.confirm,
        note: prompter.note,
      },
      reason:
        "Linux installs use a systemd user service by default. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
      requireConfirm: false,
    });
  }

  const explicitInstallDaemon =
    typeof opts.installDaemon === "boolean" ? opts.installDaemon : undefined;
  const preferredDaemonRuntime =
    flow === "quickstart"
      ? DEFAULT_GATEWAY_DAEMON_RUNTIME
      : (opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME);
  const expectedGatewayStartupMode: GatewayStartupMode =
    resolveHostedOnboardingGatewayStartupMode(opts.hostProfile) === "managed-up"
      ? "managed-up"
      : resolveGatewayStartupMode({
          env: process.env,
          config: nextConfig,
        });
  let installDaemon: boolean;
  if (explicitInstallDaemon !== undefined) {
    installDaemon = explicitInstallDaemon;
  } else if (process.platform === "linux" && !systemdAvailable) {
    installDaemon = false;
  } else if (flow === "quickstart") {
    installDaemon = true;
  } else {
    installDaemon = await prompter.confirm({
      message: "Install Gateway service for auto-start on reboot? (recommended)",
      initialValue: true,
    });
  }

  if (process.platform === "linux" && !systemdAvailable && installDaemon) {
    await prompter.note(
      [
        "Systemd user services are unavailable.",
        "Attempting root-managed systemd fallback next (runs as non-root user).",
      ].join("\n"),
      "Gateway service",
    );
    installDaemon = false;
  }

  if (installDaemon) {
    const sudoCheck =
      process.platform === "linux"
        ? await runShell("command -v sudo >/dev/null 2>&1")
        : { ok: false };
    const canUseRootService = process.platform === "linux" && sudoCheck.ok;
    const preferRootService = strictVps;

    let rootServiceActiveSuccessfully = false;
    if (preferRootService && canUseRootService) {
      const runAsUser = resolveGatewayServiceRunAsUser();
      if (!runAsUser) {
        if (strictVps && !opts.allowInsecure && !hostedMaintenanceSession) {
          throw new Error(
            "Hosting mode requires root-managed persistent service, but the runtime user could not be resolved.",
          );
        }
        await prompter.note(
          hostedMaintenanceSession
            ? "Unable to resolve root service bootstrap inputs in hosted maintenance session; falling back to app-managed persistent service."
            : "Unable to resolve root service runtime user; falling back to non-root service install.",
          "Gateway service",
        );
      } else {
        const strictExec = await verifyStrictRootGatewayExecStart(
          "fased-gateway",
          expectedGatewayStartupMode,
          runAsUser,
        );
        const rootActive = await isSystemdServiceActive({
          name: "fased-gateway",
          scope: "root",
        });
        if (strictExec.ok && rootActive.ok) {
          // Always patch heap size in the existing unit so install.sh picks up adaptive changes.
          const patchHeap = await runShell(
            [
              `sudo -n sed -i 's/FASED_GATEWAY_MAX_OLD_SPACE_MB=[0-9]*/FASED_GATEWAY_MAX_OLD_SPACE_MB=${recommendedGatewayMaxOldSpaceMb}/' /etc/systemd/system/fased-gateway.service`,
              `sudo -n sed -i 's/max-old-space-size=[0-9]*/max-old-space-size=${recommendedGatewayMaxOldSpaceMb}/' /etc/systemd/system/fased-gateway.service`,
              "sudo -n systemctl daemon-reload",
              "sudo -n systemctl restart --no-block fased-gateway.service",
            ].join(" && "),
            { timeoutMs: 12_000 },
          );
          await prompter.note(
            [
              "Hosting root-managed gateway service already healthy; reusing existing service.",
              patchHeap.ok
                ? `Updated heap limit to ${recommendedGatewayMaxOldSpaceMb}MB and restarted.`
                : `Heap patch skipped (${patchHeap.detail ?? "unknown error"}); unit may need manual update.`,
            ].join("\n"),
            "Gateway service",
          );
          rootServiceActiveSuccessfully = true;
        } else {
          let rootRestartQueued = false;
          if (strictExec.ok && !rootActive.ok) {
            const restartExisting = await runShell(
              "sudo -n systemctl restart --no-block fased-gateway.service",
            );
            if (restartExisting.ok) {
              await prompter.note(
                `Started existing ${strictVps ? "Hosting" : "Local"} root-managed gateway service.`,
                "Gateway service",
              );
              rootRestartQueued = true;
            }
          }
          const rootNowActive = await isSystemdServiceActive({
            name: "fased-gateway",
            scope: "root",
          });
          if (!rootNowActive.ok) {
            await withWizardProgress(
              "Gateway service",
              { doneMessage: "Gateway service migration complete." },
              async (progress) => {
                progress.update("Removing conflicting gateway services…");
                await migrateStrictVpsGatewayServices();
              },
            );
            const rootInstallPlan = await buildOnboardingGatewayInstallPlan({
              port: settings.port,
              token: preferredGatewayToken,
              runtime: preferredDaemonRuntime,
              config: nextConfig,
              prompter,
              strictVps,
              startupMode: expectedGatewayStartupMode,
            });
            const rootService = await installRootSystemdFallback({
              serviceName: "fased-gateway",
              runAsUser,
              programArguments: rootInstallPlan.programArguments,
              workingDirectory: rootInstallPlan.workingDirectory,
              environment: rootInstallPlan.environment,
            });
            rootServiceActiveSuccessfully = resolveVerifiedRootServiceReady({
              restartQueued: rootRestartQueued,
              activeAfterRestart: rootNowActive.ok,
              repairInstalled: rootService.ok,
            });
            if (!rootService.ok) {
              if (strictVps && !opts.allowInsecure && !hostedMaintenanceSession) {
                throw new Error(
                  `Hosting mode requires root-managed persistent service. Install failed: ${rootService.detail ?? "unknown error"}`,
                );
              }
              await prompter.note(
                hostedMaintenanceSession
                  ? "Hosted maintenance could not repair the root-managed gateway service with the current sudo capability set. Falling back to app-managed persistent service."
                  : `${strictVps ? "Hosting" : "Local"} root service install failed: ${rootService.detail ?? "unknown error"}. Falling back to non-root service.`,
                "Gateway service",
              );
            }
          } else {
            rootServiceActiveSuccessfully = resolveVerifiedRootServiceReady({
              restartQueued: rootRestartQueued,
              activeAfterRestart: rootNowActive.ok,
              repairInstalled: false,
            });
          }
          if (rootServiceActiveSuccessfully) {
            const strictExecAfter = await verifyStrictRootGatewayExecStart(
              "fased-gateway",
              expectedGatewayStartupMode,
              runAsUser,
            );
            if (!strictExecAfter.ok) {
              if (strictVps && !opts.allowInsecure) {
                throw new Error(
                  "Hosting root service check failed: ExecStart is not the canonical hosted service command.",
                );
              }
              await prompter.note(
                `${strictVps ? "Hosting" : "Local"} root service check failed: unit ExecStart is not the canonical hosted service command.`,
                "Gateway service",
              );
            }
          }
          if (rootServiceActiveSuccessfully) {
            await runShell(
              "systemctl --user disable --now fased-gateway 2>/dev/null || true && systemctl --user reset-failed fased-gateway 2>/dev/null || true",
            );
            await prompter.note(
              `${strictVps ? "Hosting" : "Local"} root-managed gateway service ready (fased-gateway).`,
              "Gateway service",
            );
          }
        }
      }
    }
    if (!rootServiceActiveSuccessfully) {
      const daemonRuntime =
        flow === "quickstart"
          ? DEFAULT_GATEWAY_DAEMON_RUNTIME
          : await prompter.select({
              message: "Gateway service runtime",
              options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
              initialValue: opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME,
            });
      const service = resolveGatewayService();
      if (process.platform === "linux") {
        const userActive = await isSystemdServiceActive({
          name: "fased-gateway",
          scope: "user",
        });
        const rootActive = await isSystemdServiceActive({
          name: "fased-gateway",
          scope: "root",
        });
        const shouldMigrate =
          strictVps || (!strictVps && rootActive.ok) || (userActive.ok && rootActive.ok);
        if (shouldMigrate) {
          await withWizardProgress(
            "Gateway service",
            { doneMessage: "Gateway service migration complete." },
            async (progress) => {
              progress.update("Removing conflicting gateway services…");
              await migrateStrictVpsGatewayServices();
            },
          );
        }
      }
      const loaded = await service.isLoaded({ env: process.env });
      if (loaded) {
        let action: "restart" | "reinstall" | "skip" = strictVps
          ? ("reinstall" as const)
          : await prompter.select({
              message: "Gateway service already installed",
              options: [
                { value: "restart", label: "Restart" },
                { value: "reinstall", label: "Reinstall" },
                { value: "skip", label: "Skip" },
              ],
            });
        if (process.platform === "linux") {
          const existing = await service.readCommand(process.env);
          const serviceAudit = await auditGatewayServiceConfig({
            env: process.env,
            command: existing,
            expectedGatewayToken: preferredGatewayToken || undefined,
          });
          if (
            !isCanonicalGatewayServiceCommand(
              existing?.programArguments,
              expectedGatewayStartupMode,
            )
          ) {
            action = "reinstall";
            await prompter.note(
              "Detected legacy gateway service command; reinstalling canonical hosted service.",
              "Gateway service",
            );
          } else if (
            serviceAudit.issues.some(
              (issue) => issue.code === SERVICE_AUDIT_CODES.gatewayTokenMismatch,
            )
          ) {
            action = "reinstall";
            await prompter.note(
              "Gateway service token is stale; reinstalling service to align it with gateway.auth.token.",
              "Gateway service",
            );
          }
        }
        if (action === "restart") {
          await withWizardProgress(
            "Gateway service",
            {
              doneMessage:
                flow === "quickstart" && process.platform === "linux"
                  ? "Gateway service restart queued."
                  : "Gateway service restarted.",
            },
            async (progress) => {
              progress.update("Restarting Gateway service…");
              if (flow === "quickstart" && process.platform === "linux") {
                const restarted = await restartGatewayServiceOnce("fased-gateway");
                if (!restarted.ok) {
                  throw new Error(
                    `gateway service restart unavailable: ${restarted.detail ?? "unknown error"}`,
                  );
                }
                return;
              }
              await service.restart({
                env: process.env,
                stdout: gatewayServiceStdout,
              });
            },
          );
        } else if (action === "reinstall") {
          await withWizardProgress(
            "Gateway service",
            { doneMessage: "Gateway service uninstalled." },
            async (progress) => {
              progress.update("Uninstalling Gateway service…");
              await service.uninstall({
                env: process.env,
                stdout: gatewayServiceStdout,
              });
            },
          );
        }
      }

      if (!loaded || (loaded && !(await service.isLoaded({ env: process.env })))) {
        const progress = prompter.progress("Gateway service");
        let installError: string | null = null;
        try {
          progress.update("Preparing Gateway service…");
          const { programArguments, workingDirectory, environment } =
            await buildOnboardingGatewayInstallPlan({
              port: settings.port,
              token: preferredGatewayToken,
              runtime: daemonRuntime,
              prompter,
              config: nextConfig,
              strictVps,
              startupMode: expectedGatewayStartupMode,
            });

          progress.update("Installing Gateway service…");
          await service.install({
            env: process.env,
            stdout: gatewayServiceStdout,
            programArguments,
            workingDirectory,
            environment,
          });
        } catch (err) {
          installError = err instanceof Error ? err.message : String(err);
        } finally {
          progress.stop(
            installError ? "Gateway service install failed." : "Gateway service installed.",
          );
        }
        if (installError) {
          await prompter.note(`Gateway service install failed: ${installError}`, "Gateway");
          await prompter.note(gatewayInstallErrorHint(), "Gateway");
        }
      }
    }
  }

  if (!installDaemon) {
    if (process.platform === "linux" && !systemdAvailable) {
      const sudoCheck = await runShell("command -v sudo >/dev/null 2>&1");
      if (sudoCheck.ok) {
        const shouldInstallRootService =
          flow === "quickstart"
            ? true
            : await prompter.confirm({
                message:
                  "Install root-managed systemd service fallback? (auto-start on reboot, runs as your user)",
                initialValue: true,
              });
        if (shouldInstallRootService) {
          const runAsUser = resolveGatewayServiceRunAsUser();
          if (!runAsUser) {
            if (strictVps && !opts.allowInsecure) {
              throw new Error(
                "Hosting mode requires persistent runtime service, but run-as user could not be resolved.",
              );
            }
            await prompter.note(
              "Unable to resolve runtime user for root systemd fallback; skipping fallback install.",
              "Runtime start",
            );
          } else {
            const rootInstallPlan = await buildOnboardingGatewayInstallPlan({
              port: settings.port,
              token: preferredGatewayToken,
              runtime: preferredDaemonRuntime,
              config: nextConfig,
              prompter,
              strictVps,
              startupMode: expectedGatewayStartupMode,
            });
            const rootService = await installRootSystemdFallback({
              serviceName: "fased-gateway",
              runAsUser,
              programArguments: rootInstallPlan.programArguments,
              workingDirectory: rootInstallPlan.workingDirectory,
              environment: rootInstallPlan.environment,
            });
            if (!rootService.ok) {
              if (strictVps && !opts.allowInsecure) {
                throw new Error(
                  `Hosting mode requires persistent runtime service. Root systemd fallback failed: ${rootService.detail ?? "unknown error"}`,
                );
              }
              await prompter.note(
                `Root systemd fallback failed: ${rootService.detail ?? "unknown error"}`,
                "Runtime start",
              );
            } else {
              await prompter.note(
                "Installed root-managed systemd fallback service (fased-gateway.service) running as non-root user.",
                "Runtime start",
              );
              installDaemon = true;
            }
          }
        }
      } else if (strictVps && !opts.allowInsecure) {
        throw new Error(
          "Hosting mode requires persistent runtime service, but sudo is unavailable for root systemd fallback.",
        );
      }
    }
    const entryScript = process.argv[1];
    if (!installDaemon && flow === "quickstart" && entryScript) {
      try {
        const child = spawn(process.execPath, [entryScript, "start"], {
          env: process.env,
          cwd: process.cwd(),
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        await prompter.note(
          "Systemd unavailable: launched runtime in background (`fased start`).",
          "Runtime start",
        );
      } catch {
        await prompter.note(
          `Systemd unavailable and background launch failed. Start manually: ${formatCliCommand("fased start")}`,
          "Runtime start",
        );
      }
    } else if (!installDaemon) {
      await prompter.note(
        `Start runtime in this shell with: ${formatCliCommand("fased start")}`,
        "Runtime start",
      );
    }
  }

  if (process.platform === "linux") {
    const localSignerSync = resolveLocalSignerSyncForFinalize({ strictVps });
    if (localSignerSync.sync) {
      try {
        const { syncLocalSocketSignerFromConfig } = await import("./onboarding.wallet.js");
        await syncLocalSocketSignerFromConfig({
          config: nextConfig,
          env: process.env,
          restart: localSignerSync.restart,
        });
      } catch (err) {
        runtime.error(
          `Local signer refresh warning: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Warmup after any non-blocking restarts above.
    // Low-memory VPS nodes can take significant time to actually enter 'active' state.
    const warmupMs = lowRamMode ? 8_000 : 3_000;
    await new Promise((resolve) => setTimeout(resolve, warmupMs));

    let userSvcActive = false;
    let rootSvcActive = false;
    let lastDetail = "";

    // Retry check for up to 10s total if not immediately active, as V8 startup
    // on a single-core low-memory VPS is highly variable.
    const deadline = Date.now() + (strictVps ? (lowRamMode ? 45_000 : 30_000) : 10_000);
    while (Date.now() < deadline) {
      userSvcActive = await isSystemdServiceRunningOrStarting({
        name: "fased-gateway",
        scope: "user",
      });
      rootSvcActive = await isSystemdServiceRunningOrStarting({
        name: "fased-gateway",
        scope: "root",
      });
      if (userSvcActive || rootSvcActive) {
        break;
      }
      // If not active, capture why from is-active (might show 'failed' or 'inactive').
      const rootCheck = await isSystemdServiceActive({
        name: "fased-gateway",
        scope: "root",
      });
      const userCheck = await isSystemdServiceActive({
        name: "fased-gateway",
        scope: "user",
      });
      lastDetail = rootCheck.detail || userCheck.detail || "inactive";
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    let autoStartEnabled = userSvcActive || rootSvcActive;
    if (
      strictVps &&
      !autoStartEnabled &&
      (lastDetail === "deactivating" || lastDetail === "activating")
    ) {
      const restarted = await restartGatewayServiceOnce("fased-gateway");
      if (restarted.ok) {
        const settleDeadline = Date.now() + (lowRamMode ? 45_000 : 20_000);
        while (Date.now() < settleDeadline) {
          userSvcActive = await isSystemdServiceRunningOrStarting({
            name: "fased-gateway",
            scope: "user",
          });
          rootSvcActive = await isSystemdServiceRunningOrStarting({
            name: "fased-gateway",
            scope: "root",
          });
          if (userSvcActive || rootSvcActive) {
            autoStartEnabled = true;
            break;
          }
          const rootCheck = await isSystemdServiceActive({
            name: "fased-gateway",
            scope: "root",
          });
          const userCheck = await isSystemdServiceActive({
            name: "fased-gateway",
            scope: "user",
          });
          lastDetail = rootCheck.detail || userCheck.detail || lastDetail;
          if (lastDetail !== "deactivating" && lastDetail !== "activating") {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
    }
    if (strictVps) {
      await prompter.note(
        [
          "Hosted runtime is private by default.",
          "",
          "Web dashboard: Tailscale HTTPS URL.",
          "SSH terminal: tailscale ssh app@YOUR_VPS_TAILSCALE_NAME.",
          "Public SSH and Gateway ports remain blocked.",
        ].join("\n"),
        "Hosting access",
      );
    }
    const requirePersistentRuntime = strictVps || expectedGatewayStartupMode === "managed-up";
    if (requirePersistentRuntime && !autoStartEnabled && !opts.allowInsecure) {
      throw new Error(
        formatPersistentRuntimeServiceFailure({
          strictVps,
          startupMode: expectedGatewayStartupMode,
          lastDetail,
        }),
      );
    }
  }

  if (settings.tailscaleMode !== "off") {
    await withWizardProgress(
      `Tailscale ${settings.tailscaleMode}`,
      { doneMessage: undefined },
      async (progress) => {
        progress.update(`Configuring Tailscale ${settings.tailscaleMode}…`);
        try {
          if (settings.tailscaleMode === "serve") {
            await enableTailscaleServe(settings.port);
          } else if (settings.tailscaleMode === "funnel") {
            await enableTailscaleFunnel(settings.port);
          }
        } catch (err) {
          runtime.error(
            `Tailscale ${settings.tailscaleMode} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          await prompter.note(
            `Tailscale setup failed. You may need to run manually: sudo tailscale ${settings.tailscaleMode} --bg http://127.0.0.1:${settings.port}`,
            "Tailscale",
          );
        }
      },
    );
  }

  if (!opts.skipHealth) {
    const probeLinks = resolveControlUiLinks({
      bind: nextConfig.gateway?.bind ?? "loopback",
      port: settings.port,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: undefined,
    });
    const healthProbeToken =
      settings.authMode === "token" ? preferredGatewayToken || undefined : undefined;
    const healthProbePassword =
      settings.authMode === "password" ? nextConfig.gateway?.auth?.password || "" : "";
    // Default behavior is fast, non-blocking health unless explicitly disabled.
    const fastHealth = opts.fastHealth !== false;
    const allowGatewayWarmupComplete =
      String(process.env.FASED_ALLOW_GATEWAY_WARMUP_COMPLETE ?? "").trim() === "1";
    const fastProbeTimeoutMs = strictVps ? 2_500 : 1_500;
    let fastHealthSatisfied = false;
    let restartAttemptedInHealth = false;
    const warmupDeadlineMs = strictVps
      ? fastHealth
        ? 3_000
        : 90_000
      : fastHealth
        ? 3_000
        : 60_000;
    const listenerDeadlineMs = strictVps
      ? fastHealth
        ? 3_000
        : 90_000
      : fastHealth
        ? 3_000
        : 60_000;
    const strictProbeTimeoutMs = fastHealth ? 5_000 : 15_000;

    // Ensure local listener is actually up for systemd-managed installs.
    if (installDaemon && opts.mode !== "remote") {
      const initialListenerReady = await waitForGatewayHttpListener({
        wsUrl: probeLinks.wsUrl,
        deadlineMs: fastHealth ? 8_000 : 15_000,
      });
      let listenerReady = initialListenerReady;
      if (!listenerReady.ok && fastHealth) {
        listenerReady = await waitForGatewayHttpListener({
          wsUrl: probeLinks.wsUrl,
          deadlineMs: strictVps ? 25_000 : 10_000,
        });
      }
      if (!listenerReady.ok) {
        let skippedRestartForWarmup = false;
        if (fastHealth) {
          const rootBusy = await isSystemdServiceRunningOrStarting({
            name: "fased-gateway",
            scope: "root",
          });
          const userBusy = await isSystemdServiceRunningOrStarting({
            name: "fased-gateway",
            scope: "user",
          });
          if (rootBusy || userBusy) {
            skippedRestartForWarmup = true;
            // (log removed per user request)
          }
        }
        if (!skippedRestartForWarmup) {
          restartAttemptedInHealth = true;
          const restarted = await restartGatewayServiceOnce("fased-gateway");
          if (restarted.ok) {
            await prompter.note(
              "Gateway listener was not ready; restarted runtime service once.",
              "Runtime service",
            );
          } else {
            runtime.error(
              `Gateway listener not ready and service restart was unavailable: ${restarted.detail ?? "unknown error"}`,
            );
          }
        }
        const listenerAfterRestart = await waitForGatewayHttpListener({
          wsUrl: probeLinks.wsUrl,
          deadlineMs: fastHealth
            ? strictVps
              ? lowRamMode
                ? 120_000
                : 60_000
              : 20_000
            : strictVps
              ? lowRamMode
                ? 120_000
                : 60_000
              : 45_000,
        });
        if (!listenerAfterRestart.ok && strictVps && !opts.allowInsecure) {
          const rootBusy = await isSystemdServiceRunningOrStarting({
            name: "fased-gateway",
            scope: "root",
          });
          const userBusy = await isSystemdServiceRunningOrStarting({
            name: "fased-gateway",
            scope: "user",
          });
          if (fastHealth && (rootBusy || userBusy) && allowGatewayWarmupComplete) {
            // (log removed per user request)
          } else {
            throw new Error(
              await formatStrictListenerFailureDiagnostics(
                `Gateway listener failed after service restart for ${probeLinks.wsUrl} (${listenerAfterRestart.detail ?? "listener not reachable"})`,
              ),
            );
          }
        }
        if (!listenerAfterRestart.ok) {
        }
      }
    }

    if (fastHealth) {
      let fastProbe = await probeGatewayReachable({
        url: probeLinks.wsUrl,
        token: healthProbeToken,
        password: healthProbePassword,
        timeoutMs: fastProbeTimeoutMs,
      });
      if (
        !fastProbe.ok &&
        String(fastProbe.detail ?? "")
          .toLowerCase()
          .includes("device token mismatch")
      ) {
        const cleared = clearDeviceAuthStore(process.env);
        await prompter.note(
          [
            "Detected stale local device auth token cache.",
            cleared
              ? "Cleared local cached device auth and retrying fast health probe once."
              : "Device auth cache was already empty; retrying fast health probe once.",
          ].join("\n"),
          "Gateway auth recovery",
        );
        fastProbe = await probeGatewayReachable({
          url: probeLinks.wsUrl,
          token: healthProbeToken,
          password: healthProbePassword,
          timeoutMs: fastProbeTimeoutMs,
        });
      }
      if (fastProbe.ok) {
        fastHealthSatisfied = true;
      } else {
        const userSvcActive = await isSystemdServiceActive({
          name: "fased-gateway",
          scope: "user",
        });
        const rootSvcActive = await isSystemdServiceActive({
          name: "fased-gateway",
          scope: "root",
        });
        const serviceActive = userSvcActive.ok || rootSvcActive.ok;
        await prompter.note(
          serviceActive
            ? strictVps
              ? "Gateway service is active; verifying listener readiness."
              : "Gateway service is active."
            : "Gateway startup is still warming; setup will keep checking before completion.",
          serviceActive ? "Health check" : "Gateway startup",
        );
        fastHealthSatisfied = true;
      }
    }

    if (strictVps && fastHealthSatisfied) {
      await withWizardProgress(
        "Listener readiness",
        { doneMessage: undefined },
        async (progress) => {
          progress.update("Waiting for hosting gateway listener…");
          let strictFastListener = await waitForGatewayHttpListener({
            wsUrl: probeLinks.wsUrl,
            deadlineMs: lowRamMode ? 120_000 : 60_000,
          });
          if (!strictFastListener.ok) {
            const rootBusy = await isSystemdServiceRunningOrStarting({
              name: "fased-gateway",
              scope: "root",
            });
            const userBusy = await isSystemdServiceRunningOrStarting({
              name: "fased-gateway",
              scope: "user",
            });
            // Don't restart while the service is already starting; let warmup continue.
            if (!rootBusy && !userBusy && !restartAttemptedInHealth) {
              restartAttemptedInHealth = true;
              const restarted = await restartGatewayServiceOnce("fased-gateway");
              if (restarted.ok) {
                progress.update(
                  "Listener not ready yet; restarted service once and waiting again…",
                );
                strictFastListener = await waitForGatewayHttpListener({
                  wsUrl: probeLinks.wsUrl,
                  deadlineMs: lowRamMode ? 120_000 : 75_000,
                });
              }
            } else {
              progress.update("Service is still warming; waiting once more without restart…");
              // Give slow VPS starts one more bounded warmup pass without service churn.
              strictFastListener = await waitForGatewayHttpListener({
                wsUrl: probeLinks.wsUrl,
                deadlineMs: lowRamMode ? 120_000 : 60_000,
              });
            }
          }
          if (!strictFastListener.ok) {
            const [rootState, userState] = await Promise.all([
              isSystemdServiceActive({ name: "fased-gateway", scope: "root" }),
              isSystemdServiceActive({ name: "fased-gateway", scope: "user" }),
            ]);
            const serviceStillRunning =
              rootState.ok ||
              userState.ok ||
              (await isSystemdServiceRunningOrStarting({
                name: "fased-gateway",
                scope: "root",
              })) ||
              (await isSystemdServiceRunningOrStarting({
                name: "fased-gateway",
                scope: "user",
              }));
            if (fastHealth && serviceStillRunning && allowGatewayWarmupComplete) {
              await prompter.note(
                [
                  "Gateway service is still starting.",
                  "Setup will keep checking the Tailscale dashboard before it completes.",
                ].join("\n"),
                "Gateway startup",
              );
              progress.update("Service active; listener still warming.");
              return;
            }
          }
          if (!strictFastListener.ok && !opts.allowInsecure) {
            throw new Error(
              await formatStrictListenerFailureDiagnostics(
                `Hosting listener did not become reachable (${strictFastListener.detail ?? "listener not reachable"})`,
              ),
            );
          }
          if (strictFastListener.ok) {
            progress.update("Listener reachable; confirming stable startup…");
            const stableListener = await waitForStableGatewayHttpListener({
              wsUrl: probeLinks.wsUrl,
              deadlineMs: lowRamMode ? 90_000 : 45_000,
              stableMs: 8_000,
              pollMs: 750,
            });
            if (!stableListener.ok && !opts.allowInsecure) {
              throw new Error(
                await formatStrictListenerFailureDiagnostics(
                  `Hosting listener became reachable but did not stay stable (${stableListener.detail ?? "listener flapped"})`,
                ),
              );
            }
          }
          if (!strictFastListener.ok) {
            runtime.error(
              `Hosting listener still warming after fast health: ${strictFastListener.detail ?? "listener not reachable"}`,
            );
          }
        },
      );
    }

    if (!fastHealthSatisfied) {
      // Daemon install/restart can briefly flap the WS; wait a bit so health check doesn't false-fail.
      let wsWarmupError: unknown = null;
      try {
        await waitForGatewayReachable({
          url: probeLinks.wsUrl,
          token: healthProbeToken,
          password: healthProbePassword,
          deadlineMs: warmupDeadlineMs,
          probeTimeoutMs: strictVps ? 12_000 : 5_000,
        });
      } catch (err) {
        wsWarmupError = err;
        runtime.error(
          `Gateway WS warmup warning for ${probeLinks.wsUrl}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (strictVps) {
        const httpReady = await waitForGatewayHttpListener({
          wsUrl: probeLinks.wsUrl,
          deadlineMs: listenerDeadlineMs,
        });
        let strictProbe = await probeGatewayReachable({
          url: probeLinks.wsUrl,
          token: healthProbeToken,
          password: healthProbePassword,
          timeoutMs: strictProbeTimeoutMs,
        });
        if (
          !strictProbe.ok &&
          String(strictProbe.detail ?? "")
            .toLowerCase()
            .includes("device token mismatch")
        ) {
          const cleared = clearDeviceAuthStore(process.env);
          await prompter.note(
            [
              "Detected stale local device auth token cache.",
              cleared
                ? "Cleared local cached device auth and retrying strict gateway probe once."
                : "Device auth cache was already empty; retrying strict gateway probe once.",
            ].join("\n"),
            "Gateway auth recovery",
          );
          strictProbe = await probeGatewayReachable({
            url: probeLinks.wsUrl,
            token: healthProbeToken,
            password: healthProbePassword,
            timeoutMs: strictProbeTimeoutMs,
          });
        }
        if (!httpReady.ok && !strictProbe.ok) {
          const userSvcActive = await isSystemdServiceActive({
            name: "fased-gateway",
            scope: "user",
          });
          const rootSvcActive = await isSystemdServiceActive({
            name: "fased-gateway",
            scope: "root",
          });
          const serviceActive = userSvcActive.ok || rootSvcActive.ok;
          if (fastHealth && serviceActive && allowGatewayWarmupComplete) {
            await prompter.note(
              [
                "Gateway service is active but still warming.",
                "Setup will keep checking the Tailscale dashboard before it completes.",
              ].join("\n"),
              "Gateway startup",
            );
          } else if (!opts.allowInsecure) {
            throw new Error(
              `Hosting listener verification failed for ${probeLinks.wsUrl} (${httpReady.detail ?? strictProbe.detail ?? (wsWarmupError ? (wsWarmupError instanceof Error ? wsWarmupError.message : "verification failed") : "listener/probe not reachable")})`,
            );
          }
        }
        if (!strictProbe.ok) {
          const userSvcActive = await isSystemdServiceActive({
            name: "fased-gateway",
            scope: "user",
          });
          const rootSvcActive = await isSystemdServiceActive({
            name: "fased-gateway",
            scope: "root",
          });
          const serviceActive = userSvcActive.ok || rootSvcActive.ok;
          if (fastHealth && serviceActive && allowGatewayWarmupComplete) {
            runtime.error(`Gateway probe still warming: ${strictProbe.detail ?? "unknown error"}`);
          } else if (!opts.allowInsecure) {
            throw new Error(
              `Hosting gateway probe failed for ${probeLinks.wsUrl} (${strictProbe.detail ?? "unknown error"})`,
            );
          } else {
            runtime.error(`Gateway probe warning: ${strictProbe.detail ?? "unknown error"}`);
          }
        }
      } else {
        const localHttpReady = await waitForGatewayHttpListener({
          wsUrl: probeLinks.wsUrl,
          deadlineMs: listenerDeadlineMs,
        });
        if (!localHttpReady.ok) {
          runtime.error(
            `Gateway listener warmup warning for ${probeLinks.wsUrl}: ${localHttpReady.detail ?? "listener not reachable yet"}`,
          );
        }
        try {
          await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
        } catch (err) {
          let finalError = err;
          const rawError = String(err).toLowerCase();
          if (rawError.includes("device token mismatch")) {
            const cleared = clearDeviceAuthStore(process.env);
            await prompter.note(
              [
                "Detected stale local device auth token cache.",
                cleared
                  ? "Cleared local cached device auth and retrying health check once."
                  : "Device auth cache was already empty; retrying health check once.",
              ].join("\n"),
              "Gateway auth recovery",
            );
            try {
              await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
              finalError = null;
            } catch (retryErr) {
              finalError = retryErr;
            }
          }
          if (finalError) {
            runtime.error(formatHealthCheckFailure(finalError));
            await prompter.note(
              [
                "Docs:",
                "https://docs.fased.ai/gateway/health",
                "https://docs.fased.ai/gateway/troubleshooting",
              ].join("\n"),
              "Health check help",
            );
          }
        }
      }
    }
  }

  const controlUiBasePath =
    nextConfig.gateway?.controlUi?.basePath ?? baseConfig.gateway?.controlUi?.basePath;
  const gatewayTokenForUi = preferredGatewayToken;
  const links = resolveControlUiLinks({
    bind: settings.bind,
    port: settings.port,
    customBindHost: settings.customBindHost,
    basePath: controlUiBasePath,
  });
  const authedUrl = buildOnboardingDashboardUrl({
    baseUrl: links.httpUrl,
    basePath: controlUiBasePath,
    token: settings.authMode === "token" ? gatewayTokenForUi || undefined : undefined,
    walletSecurityFocus: options.walletSecurityFocus ?? null,
  });
  let gatewayProbe = await probeGatewayReachable({
    url: links.wsUrl,
    token: settings.authMode === "token" ? gatewayTokenForUi || undefined : undefined,
    password: settings.authMode === "password" ? nextConfig.gateway?.auth?.password : "",
  });
  const gatewayStatusLine = gatewayProbe.ok
    ? "Gateway: reachable"
    : `Gateway: not detected${gatewayProbe.detail ? ` (${gatewayProbe.detail})` : ""}`;
  const tailscaleSshUser = process.env.USER?.trim() || "app";
  let tailscaleAdminUrl: string | undefined;
  let tailscaleNodeName = "";
  let tailscaleIpv4 = "";
  if (settings.tailscaleMode !== "off") {
    const identity = strictVps
      ? await waitForTailscaleIdentity({
          basePath: controlUiBasePath,
          deadlineMs: lowRamMode ? 180_000 : 90_000,
        })
      : {
          ok: true,
          state: readTailscaleIdentity(controlUiBasePath),
          detail: undefined,
        };
    tailscaleNodeName = identity.state.nodeName;
    tailscaleIpv4 = identity.state.ipv4;
    tailscaleAdminUrl = identity.state.adminUrl;
    if (!identity.ok) {
      const detail = identity.detail ?? "tailscale status unavailable";
      if (strictVps && !opts.allowInsecure) {
        throw new Error(`Hosting requires Tailscale DNS readiness before completion (${detail})`);
      }
      runtime.error(`Tailscale identity still warming: ${detail}`);
    }
  }
  if (strictVps && settings.tailscaleMode === "serve") {
    await withWizardProgress(
      "Tailscale serve warmup",
      { doneMessage: undefined },
      async (progress) => {
        progress.update("Waiting for tailscale serve route mapping…");
        const serveWarmup = await waitForTailscaleServeRoute({
          port: settings.port,
          deadlineMs: lowRamMode ? 180_000 : 90_000,
        });
        if (serveWarmup.ok) {
          return;
        }
        const detail = serveWarmup.detail ?? "mapping not detected";
        if (!opts.allowInsecure) {
          throw new Error(
            `Hosting requires tailscale serve route mapping before completion (${detail})`,
          );
        }
        runtime.error(`Tailscale serve route still warming: ${detail}`);
      },
    );
  }
  if (strictVps && settings.tailscaleMode !== "off") {
    if (!tailscaleAdminUrl && !opts.allowInsecure) {
      throw new Error("Hosting requires a Tailscale HTTPS dashboard URL before completion.");
    }
    if (tailscaleAdminUrl) {
      const tailscaleGatewayWsUrl = buildGatewayWsUrlFromHttpUrl({
        httpUrl: tailscaleAdminUrl,
        basePath: controlUiBasePath,
      });
      await withWizardProgress(
        "Tailscale dashboard warmup",
        { doneMessage: undefined },
        async (progress) => {
          progress.update("Waiting for Tailscale HTTPS dashboard URL to become reachable…");
          const warmup = await waitForHttpUrlReachable({
            url: tailscaleAdminUrl,
            deadlineMs: lowRamMode ? 300_000 : 180_000,
            pollMs: 1_000,
            requestTimeoutMs: 5_000,
            // 401/403 still prove Tailscale HTTPS endpoint is reachable;
            // auth happens in browser with the gateway token shown separately.
            successStatuses: [401, 403],
          });
          if (!warmup.ok) {
            const detail = warmup.detail ?? "not reachable yet";
            if (!opts.allowInsecure) {
              throw new Error(
                `Hosting requires reachable Tailscale dashboard URL before completion (${detail})`,
              );
            }
            runtime.error(`Tailscale dashboard URL still warming: ${detail}`);
          }
          progress.update("Confirming dashboard gateway connection…");
          const wsWarmup = await waitForGatewayReachable({
            url: tailscaleGatewayWsUrl,
            token: settings.authMode === "token" ? gatewayTokenForUi || undefined : undefined,
            password:
              settings.authMode === "password" ? nextConfig.gateway?.auth?.password : undefined,
            deadlineMs: lowRamMode ? 180_000 : 90_000,
            probeTimeoutMs: 8_000,
            pollMs: 1_500,
          });
          if (!wsWarmup.ok) {
            if (!opts.allowInsecure) {
              throw new Error(
                [
                  "Tailscale dashboard page is reachable, but the Gateway is not online through that URL.",
                  `Gateway URL: ${tailscaleGatewayWsUrl}`,
                  `Detail: ${wsWarmup.detail ?? "gateway websocket not reachable"}`,
                  "Check from the app user terminal:",
                  "  systemctl status --user fased-gateway --no-pager",
                  "  sudo systemctl status fased-gateway --no-pager",
                  "  tail -n 120 ~/.fased/logs/start-managed-gateway.log",
                ].join("\n"),
              );
            }
            runtime.error(
              `Tailscale dashboard Gateway still warming: ${wsWarmup.detail ?? "websocket not reachable"}`,
            );
          }
        },
      );
    }
  }
  const isStrict = strictVps || (opts.hostProfile === "local" && settings.tailscaleMode !== "off");
  if (isStrict) {
    const strictDashboardUrl = tailscaleAdminUrl
      ? buildOnboardingDashboardUrl({
          baseUrl: tailscaleAdminUrl,
          basePath: controlUiBasePath,
          token: settings.authMode === "token" ? gatewayTokenForUi || undefined : undefined,
          walletSecurityFocus: options.walletSecurityFocus ?? null,
        })
      : authedUrl;
    const tunnelDashboardUrl = buildOnboardingDashboardUrl({
      baseUrl: `http://localhost:${settings.port}/`,
      basePath: controlUiBasePath,
      token: settings.authMode === "token" ? gatewayTokenForUi || undefined : undefined,
      walletSecurityFocus: options.walletSecurityFocus ?? null,
    });
    await prompter.note(
      formatStrictRemoteAccessDetails({
        tailscaleSshUser,
        tailscaleNodeName,
        tailscaleIpv4,
        dashboardUrl: strictDashboardUrl,
        tunnelUrl: tunnelDashboardUrl,
        port: settings.port,
        gatewayToken: gatewayTokenForUi || undefined,
      }),
      "Remote Access Details",
    );
  } else if (flow !== "quickstart") {
    await prompter.note(
      [
        `Dashboard: ${links.httpUrl}`,
        settings.authMode === "token" && gatewayTokenForUi
          ? `Gateway token: ${gatewayTokenForUi}`
          : undefined,
        `Gateway WS: ${links.wsUrl}`,
        gatewayStatusLine,
      ]
        .filter(Boolean)
        .join("\n"),
      "Remote Access Details",
    );
  }

  if (strictVps) {
    const maintenanceUser = resolveGatewayServiceRunAsUser() || "app";
    await verifyStrictVpsMaintenanceReadiness({
      repoRoot: process.cwd(),
      runAsUser: maintenanceUser,
      configDir: path.join(os.homedir(), ".fased"),
      nextConfig,
    });
  }

  const onboardingEnv = {
    ...process.env,
    ...collectConfigServiceEnvVars(nextConfig),
  } as NodeJS.ProcessEnv;
  const walletRegistry = readWalletProviderRegistry(onboardingEnv);
  const miningWalletId = readSatMiningWalletId(nextConfig);
  const persistedFederationToken = federation.enabled
    ? await loadPersistedFederationToken(onboardingEnv).catch(() => null)
    : null;
  let walletStatusForReadiness: Awaited<ReturnType<typeof readWalletStatusSnapshot>> | null = null;
  try {
    walletStatusForReadiness = await readWalletStatusSnapshot({
      config: nextConfig,
      env: onboardingEnv,
    });
  } catch {
    walletStatusForReadiness = null;
  }

  if (federation.enabled) {
    const resolvedBase = (federation.baseUrl ?? "").trim() || "https://ff1.fased.app";
    const handle = (federation.handle ?? "").trim() || "(auto)";
    const { fedToken, reservations } = strictVps
      ? await waitForManagedFederationSummary({
          env: onboardingEnv,
        })
      : {
          fedToken: readManagedFederationTokenSummary(onboardingEnv),
          reservations: readManagedReservationSummaries(onboardingEnv),
        };
    const resolvedPublicUrl = (fedToken.publicUrl ?? "").trim();
    await prompter.note(
      strictVps
        ? [
            resolvedPublicUrl
              ? `Agent URL (Fased Network): ${resolvedPublicUrl}`
              : "Agent URL (Fased Network): not issued yet",
            !resolvedPublicUrl && fedToken.exists
              ? `Fased Network token: present at ${fedToken.path}`
              : undefined,
            !resolvedPublicUrl && reservations.length > 0
              ? `Reservation: ${reservations[0]?.slug} (public URL still pending token refresh)`
              : undefined,
            !resolvedPublicUrl && !fedToken.exists && reservations.length === 0
              ? "Managed Fased Network token has not been issued in this session yet."
              : undefined,
            !resolvedPublicUrl ? "Inspect details: `fased managed up --json`" : undefined,
          ]
            .filter(Boolean)
            .join("\n")
        : [
            "Fased Network:",
            `Join: enabled`,
            `Server: ${resolvedBase}`,
            `Handle: ${handle}`,
            resolvedPublicUrl ? `Final public URL: ${resolvedPublicUrl}` : undefined,
            !resolvedPublicUrl && reservations.length > 0
              ? `Reservation present: ${reservations[0]?.slug} (public URL pending token refresh)`
              : undefined,
            !resolvedPublicUrl && reservations.length === 0
              ? "Public URL not issued yet (will appear after managed tunnel/Fased Network token refresh)."
              : undefined,
            !resolvedPublicUrl ? "Inspect details: `fased managed up --json`" : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
      "Fased Network",
    );
  } else {
    await prompter.note("Fased Network join is disabled.", "Fased Network");
  }

  const operatorReadiness = describeOperatorReadinessChecklist({
    walletStatus: walletStatusForReadiness
      ? {
          approvalAuth: {
            mode: walletStatusForReadiness.approvalAuth?.mode,
            ready: walletStatusForReadiness.approvalAuth?.ready,
            passkeyCount: walletStatusForReadiness.approvalAuth?.passkeyCount,
          },
        }
      : null,
    walletNamedWallets: walletRegistry.wallets.map((wallet) => ({
      id: wallet.id,
      name: wallet.name,
      metadata: wallet.metadata,
    })),
    defaultWalletId: walletRegistry.defaultWalletId ?? null,
    miningAttachedWalletId: miningWalletId,
    federationBondWalletId: nextConfig.federation?.bond?.walletId ?? null,
    joined: federation.enabled && Boolean(persistedFederationToken),
    trustState: federation.enabled ? (persistedFederationToken?.trustState ?? "pending") : null,
    hostedState: federation.enabled
      ? (persistedFederationToken?.hostedState ?? "disabled")
      : "disabled",
    publicUrl: federation.enabled ? (persistedFederationToken?.publicUrl ?? null) : null,
  });
  await prompter.note(formatOperatorReadinessSummary(operatorReadiness), "Operator readiness");

  if (strictVps && !opts.allowInsecure) {
    await withWizardProgress(
      "Final dashboard check",
      { doneMessage: undefined },
      async (progress) => {
        progress.update("Confirming gateway stays reachable before completing setup…");
        const finalGateway = await verifyStrictHostedGatewayReady({
          wsUrl: links.wsUrl,
          token: settings.authMode === "token" ? gatewayTokenForUi || undefined : undefined,
          password: settings.authMode === "password" ? nextConfig.gateway?.auth?.password : "",
          lowRamMode,
        });
        if (!finalGateway.ok) {
          throw new Error(
            await formatStrictListenerFailureDiagnostics(
              `Hosting dashboard is not ready at completion (${finalGateway.detail ?? "gateway not reachable"})`,
            ),
          );
        }
        gatewayProbe = { ok: true };
      },
    );
  }

  let controlUiOpened = false;
  let controlUiOpenHint: string | undefined;
  let seededInBackground = false;
  let hatchChoice: "tui" | "web" | "later" | null = null;
  let launchedTui = false;

  if (!opts.skipUi) {
    if (!gatewayProbe.ok) {
      await prompter.note(
        strictVps
          ? `Gateway probe warning: ${gatewayProbe.detail ?? "not reachable yet"}. Continue and open dashboard when ready.`
          : `Gateway probe warning: ${gatewayProbe.detail ?? "not reachable yet"}. You can still hatch in TUI or continue and open dashboard when ready.`,
        "Gateway probe",
      );
    }
    if (!strictVps) {
      hatchChoice = "web";
    } else {
      hatchChoice = "later";
    }

    if ((hatchChoice as "tui" | "web" | "later" | null) === "tui") {
      const tuiProbeToken =
        settings.authMode === "token" ? gatewayTokenForUi || undefined : undefined;
      const tuiProbePassword =
        settings.authMode === "password" ? nextConfig.gateway?.auth?.password || "" : "";
      let tuiReady = await waitForGatewayReachable({
        url: links.wsUrl,
        token: tuiProbeToken,
        password: tuiProbePassword,
        deadlineMs: lowRamMode ? 90_000 : 45_000,
        probeTimeoutMs: 3_000,
        pollMs: 750,
      });
      if (!tuiReady.ok) {
        const restarted = await restartGatewayServiceOnce("fased-gateway");
        if (restarted.ok) {
          const listenerReady = await waitForGatewayHttpListener({
            wsUrl: links.wsUrl,
            deadlineMs: lowRamMode ? 120_000 : 60_000,
            pollMs: 750,
          });
          tuiReady = listenerReady.ok
            ? await waitForGatewayReachable({
                url: links.wsUrl,
                token: tuiProbeToken,
                password: tuiProbePassword,
                deadlineMs: lowRamMode ? 120_000 : 60_000,
                probeTimeoutMs: 3_000,
                pollMs: 750,
              })
            : {
                ok: false,
                detail: listenerReady.detail ?? tuiReady.detail,
              };
        }
      }
      if (!tuiReady.ok) {
        if (strictVps && !opts.allowInsecure) {
          throw new Error(
            `TUI hatch requires a reachable gateway, but it is still unavailable (${tuiReady.detail ?? "connection failed"}).`,
          );
        }
        await prompter.note(
          `Gateway is not reachable for TUI yet (${tuiReady.detail ?? "connection failed"}). Use dashboard link and retry in a few seconds.`,
          "TUI unavailable",
        );
      } else {
        restoreTerminalState("pre-onboarding tui", { resumeStdinIfPaused: true });
        await runTui({
          url: links.wsUrl,
          token: settings.authMode === "token" ? gatewayTokenForUi || undefined : undefined,
          password: settings.authMode === "password" ? nextConfig.gateway?.auth?.password : "",
          // Safety: onboarding TUI should not auto-deliver to lastProvider/lastTo.
          deliver: false,
        });
        launchedTui = true;
      }
    } else if (hatchChoice === "web" && !strictVps) {
      const browserSupport = await detectBrowserOpenSupport();
      if (browserSupport.ok) {
        controlUiOpened = await openUrl(authedUrl);
        if (!controlUiOpened) {
          controlUiOpenHint = formatControlUiSshHint({
            port: settings.port,
            basePath: controlUiBasePath,
            token: settings.authMode === "token" ? gatewayTokenForUi || undefined : undefined,
          });
        }
      } else {
        controlUiOpenHint = formatControlUiSshHint({
          port: settings.port,
          basePath: controlUiBasePath,
          token: settings.authMode === "token" ? gatewayTokenForUi || undefined : undefined,
        });
      }
      const strictDashboardUrl = tailscaleAdminUrl
        ? buildOnboardingDashboardUrl({
            baseUrl: tailscaleAdminUrl,
            basePath: controlUiBasePath,
            token: settings.authMode === "token" ? gatewayTokenForUi || undefined : undefined,
            walletSecurityFocus: options.walletSecurityFocus ?? null,
          })
        : authedUrl;
      await prompter.note(
        [
          `Dashboard: ${strictDashboardUrl}`,
          settings.authMode === "token" && gatewayTokenForUi
            ? `Gateway token: ${gatewayTokenForUi}`
            : undefined,
          controlUiOpened
            ? "Opened in your browser. Keep that tab to control Fased Agent."
            : "Copy/paste this URL in a browser on this machine to control Fased Agent.",
        ]
          .filter(Boolean)
          .join("\n"),
        "Dashboard ready",
      );
    } else {
      // User chose to continue without opening UI during onboarding.
    }
  } else if (opts.skipUi) {
    await prompter.note("Skipping Control UI/TUI prompts.", "Control UI");
  }

  const shouldOpenControlUi =
    !opts.skipUi &&
    settings.authMode === "token" &&
    Boolean(gatewayTokenForUi) &&
    hatchChoice === null;
  if (shouldOpenControlUi && !strictVps) {
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      controlUiOpened = await openUrl(authedUrl);
      if (!controlUiOpened) {
        controlUiOpenHint = formatControlUiSshHint({
          port: settings.port,
          basePath: controlUiBasePath,
          token: gatewayTokenForUi,
        });
      }
    } else {
      controlUiOpenHint = formatControlUiSshHint({
        port: settings.port,
        basePath: controlUiBasePath,
        token: gatewayTokenForUi,
      });
    }

    const strictDashboardUrl = tailscaleAdminUrl
      ? buildOnboardingDashboardUrl({
          baseUrl: tailscaleAdminUrl,
          basePath: controlUiBasePath,
          token: settings.authMode === "token" ? gatewayTokenForUi || undefined : undefined,
          walletSecurityFocus: options.walletSecurityFocus ?? null,
        })
      : authedUrl;
    await prompter.note(
      [
        `Dashboard: ${strictVps || (opts.hostProfile === "local" && settings.tailscaleMode !== "off") ? strictDashboardUrl : authedUrl}`,
        settings.authMode === "token" && gatewayTokenForUi
          ? `Gateway token: ${gatewayTokenForUi}`
          : undefined,
        controlUiOpened
          ? "Opened in your browser. Keep that tab to control Fased Agent."
          : strictVps
            ? "Open from a Tailscale-connected device/browser."
            : "Copy/paste this URL in a browser on this machine to control Fased Agent.",
        !strictVps ? controlUiOpenHint : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      "Dashboard ready",
    );
  }

  await prompter.outro(
    controlUiOpened
      ? "Onboarding complete. Dashboard opened; keep that tab to control Fased Agent."
      : seededInBackground
        ? "Onboarding complete. Web UI seeded in the background; open it anytime with the dashboard link above."
        : "Onboarding complete. Use the dashboard link above to control Fased Agent.",
  );

  return { launchedTui };
}
