import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
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
import { waitForHostedDashboardBrowserPath } from "../commands/hosted-dashboard-probe.js";
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
import { runFederationAutoConnectOnce } from "../federation/auto-connect.js";
import {
  CONTROL_UI_BOOT_CHECK_PATH,
  type ControlUiBootCheck,
  type ControlUiBootCheckAsset,
} from "../gateway/control-ui-boot-check.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui-shared.js";
import { clearDeviceAuthStore } from "../infra/device-auth-store.js";
import { enableTailscaleFunnel, enableTailscaleServe } from "../infra/tailscale.js";
import { readManagedFederationTokenSummary } from "../managed/federation.js";
import { readManagedReservationSummaries } from "../managed/tunnel.js";
import { describeOperatorReadinessChecklist } from "../operator/operator-readiness.js";
import type { RuntimeEnv } from "../runtime.js";
import { restoreTerminalState } from "../terminal/restore.js";
import { theme } from "../terminal/theme.js";
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

function noteHeading(value: string): string {
  return theme.heading(value.toUpperCase());
}

function noteLabel(value: string): string {
  return theme.accentBright(value);
}

function noteInfo(value: string): string {
  return theme.info(value);
}

function noteSuccess(value: string): string {
  return theme.success(value);
}

function noteWarn(value: string): string {
  return theme.warn(value);
}

function noteMuted(value: string): string {
  return theme.muted(value);
}

function noteCommand(value: string): string {
  return theme.command(value);
}

function noteBullet(value: string): string {
  return `- ${value}`;
}

function formatFasedNetworkAutoConnectSummary(messages: string[]): string {
  return [
    noteHeading("Connection confirmed"),
    ...messages.map((message) => noteBullet(noteSuccess(message))),
  ].join("\n");
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
  const tailscaleIpv4 = params.tailscaleIpv4?.trim();
  const hasIpFallback = Boolean(tailscaleIpv4 && tailscaleIpv4 !== sshTarget);
  return [
    noteInfo("Use both access paths after hosted setup:"),
    "",
    noteHeading("1. Web dashboard"),
    `   ${noteInfo("Open this on your own computer after signing into the same Tailscale account:")}`,
    `   ${noteCommand(params.dashboardUrl)}`,
    "",
    noteHeading("2. SSH terminal"),
    `   ${noteInfo("Use this for CLI commands, updates, logs, and repairs over Tailscale:")}`,
    `   ${noteCommand(`ssh ${params.tailscaleSshUser}@${sshTarget}`)}`,
    hasIpFallback
      ? `   ${noteWarn("If hostname DNS fails but Tailscale IP ping works, use:")} ${noteCommand(
          `ssh ${params.tailscaleSshUser}@${tailscaleIpv4}`,
        )}`
      : undefined,
    `   ${noteInfo("The app user shell opens in the Fased repo directory.")}`,
    "",
    noteHeading("Advanced fallback"),
    `   ${noteInfo(
      "If the Tailscale web URL is unavailable, run this on your local computer and leave it open:",
    )}`,
    `   ${noteCommand(
      `ssh -N -L ${params.port}:127.0.0.1:${params.port} ${params.tailscaleSshUser}@${sshTarget}`,
    )}`,
    hasIpFallback
      ? `   ${noteWarn("If a VPN blocks MagicDNS hostname lookup, use:")} ${noteCommand(
          `ssh -N -L ${params.port}:127.0.0.1:${params.port} ${params.tailscaleSshUser}@${tailscaleIpv4}`,
        )}`
      : undefined,
    `   ${noteInfo("Then open:")}`,
    `   ${noteCommand(params.tunnelUrl)}`,
    hasIpFallback
      ? `   ${noteWarn(
          "Note: another VPN can break Tailscale MagicDNS while raw 100.x Tailscale IP access still works.",
        )}`
      : undefined,
    "",
    noteHeading("Gateway token backup"),
    `   ${noteWarn("Only paste this if the browser asks for a token:")}`,
    `   ${noteCommand(params.gatewayToken || "(token not available)")}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function formatLocalDashboardReady(params: {
  dashboardUrl: string;
  gatewayToken?: string;
  opened: boolean;
  fallbackHint?: string;
  healthCheck?: string;
}): string {
  return [
    "1. Dashboard",
    params.opened
      ? "   Opened in your browser. Keep that tab open."
      : "   Open this URL in a browser on this machine:",
    params.opened ? `   Backup link: ${params.dashboardUrl}` : `   ${params.dashboardUrl}`,
    "",
    "2. First setup",
    "   In the dashboard, go to Agent > Models and connect a model provider.",
    "",
    "3. First chat",
    "   Open Chat and send a test message.",
    params.gatewayToken ? "" : undefined,
    params.gatewayToken ? "Token backup" : undefined,
    params.gatewayToken ? `   ${params.gatewayToken}` : undefined,
    params.healthCheck ? "" : undefined,
    params.healthCheck,
    params.fallbackHint ? "" : undefined,
    params.fallbackHint ? "Remote browser fallback" : undefined,
    params.fallbackHint,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
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
  const existingAccess = await runShell(
    `sudo -n systemctl show ${safeServiceName}.service -p ActiveState --value >/dev/null`,
  );
  if (existingAccess.ok) {
    return { ok: true };
  }
  const sudoersPath = `/etc/sudoers.d/${safeServiceName}-${safeUser}-maintenance`;
  const sudoers = [
    `${safeUser} ALL=(root) NOPASSWD: /usr/bin/systemctl restart ${safeServiceName}.service`,
    `${safeUser} ALL=(root) NOPASSWD: /usr/bin/systemctl restart --no-block ${safeServiceName}.service`,
    `${safeUser} ALL=(root) NOPASSWD: /usr/bin/systemctl status ${safeServiceName}.service`,
    `${safeUser} ALL=(root) NOPASSWD: /usr/bin/systemctl status ${safeServiceName}.service *`,
    `${safeUser} ALL=(root) NOPASSWD: /usr/bin/systemctl status ${safeServiceName} *`,
    `${safeUser} ALL=(root) NOPASSWD: /usr/bin/systemctl is-active ${safeServiceName}.service`,
    `${safeUser} ALL=(root) NOPASSWD: /usr/bin/systemctl is-active ${safeServiceName}.service *`,
    `${safeUser} ALL=(root) NOPASSWD: /usr/bin/systemctl is-active ${safeServiceName} *`,
    `${safeUser} ALL=(root) NOPASSWD: /usr/bin/systemctl show ${safeServiceName}.service *`,
    `${safeUser} ALL=(root) NOPASSWD: /usr/bin/systemctl show ${safeServiceName} *`,
    `${safeUser} ALL=(root) NOPASSWD: /usr/bin/journalctl -u ${safeServiceName}.service *`,
    `${safeUser} ALL=(root) NOPASSWD: /usr/bin/journalctl -u ${safeServiceName} *`,
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
  const safeServiceName = params.serviceName.replace(/[^A-Za-z0-9@_.-]/g, "");
  const safeRunAsUser = params.runAsUser.replace(/[^A-Za-z0-9@_.-]/g, "");
  const unitPath = `/etc/systemd/system/${safeServiceName}.service`;
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
  const helperInstallCommand = `printf '%s' '${b64}' | base64 -d | sudo -n /usr/local/sbin/fased-install-gateway-service '${safeServiceName}' '${safeRunAsUser}'`;
  const helperResult = await runShell(helperInstallCommand);
  const installCommand = [
    `echo '${b64}' | base64 -d | sudo -n tee '${unitPath}' >/dev/null`,
    "sudo -n systemctl daemon-reload",
    `sudo -n systemctl enable --now '${safeServiceName}.service'`,
  ].join(" && ");
  const result = helperResult.ok ? helperResult : await runShell(installCommand);
  if (!result.ok) {
    return {
      ok: false,
      detail:
        `systemd install failed (${result.detail ?? "unknown error"}). ` +
        `Installer helper result: ${helperResult.detail ?? (helperResult.ok ? "ok" : "unavailable")}. ` +
        "Rerun ./install.sh --hosting from root so the hosted service helper and sudoers are refreshed.",
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

export function formatHostedRootServiceRequiredFailure(params: {
  runAsUser?: string;
  detail?: string;
}): string {
  const runAsUser = params.runAsUser?.trim() || "app";
  const detail = params.detail?.trim() || "unknown error";
  return [
    `Hosting requires the root-managed fased-gateway.service running as User=${runAsUser}.`,
    "The installer will not fall back to an app-managed user service for the hosting profile.",
    `Root service repair failed: ${detail}`,
    "Repair: rerun ./install.sh --hosting from root on the VPS, or restore the installer sudoers for the app user and rerun ./install.sh --hosting.",
    "Inspect: sudo systemctl status fased-gateway --no-pager",
    "Inspect logs: sudo journalctl -u fased-gateway -n 120 --no-pager",
  ].join("\n");
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

  // Wallet/signer readiness is feature readiness, not host access readiness.
  // If the user creates/imports a self-hosted wallet in this onboarding run,
  // the wallet ceremony already enforces signer checks earlier. A skipped or
  // deferred wallet setup must not block SSH/dashboard hardening completion.
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

export type GatewayServiceRestartProfile = "local" | "hosting";

export type GatewayServiceRestartAttempt = {
  label: string;
  command: string;
  timeoutMs?: number;
  timeoutIsProgress?: boolean;
};

export function buildGatewayServiceRestartAttempts(
  serviceName = "fased-gateway",
  profile: GatewayServiceRestartProfile = "local",
): GatewayServiceRestartAttempt[] {
  const userAttempts = [
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
  const rootAttempts = [
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
  ];
  return [
    ...(profile === "hosting" ? rootAttempts : userAttempts),
    ...(profile === "hosting" ? [] : rootAttempts),
  ];
}

async function restartGatewayServiceOnce(
  serviceName = "fased-gateway",
  profile: GatewayServiceRestartProfile = "local",
): Promise<{ ok: boolean; detail?: string }> {
  const attempts = buildGatewayServiceRestartAttempts(serviceName, profile);
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

function normalizeServicePath(value: string): string {
  return path.resolve(value).replaceAll("\\", "/");
}

function isPathInside(baseDir: string, candidate: string): boolean {
  const normalizedBase = normalizeServicePath(baseDir);
  const normalizedCandidate = normalizeServicePath(candidate);
  return (
    normalizedCandidate === normalizedBase || normalizedCandidate.startsWith(`${normalizedBase}/`)
  );
}

export async function ensureGatewaySecretMatchesToken(token: string): Promise<boolean> {
  const normalizedToken = token.trim();
  if (!normalizedToken) {
    return false;
  }
  const tokenPath = resolveGatewaySecretPathForEnv(process.env);
  const existing = await fs.readFile(tokenPath, "utf8").catch(() => "");
  if (existing.trim() === normalizedToken) {
    return false;
  }
  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  await fs.writeFile(tokenPath, `${normalizedToken}\n`, { mode: 0o600 });
  await fs.chmod(tokenPath, 0o600).catch(() => {});
  return true;
}

export function gatewayServiceMatchesCurrentInstall(params: {
  command: { programArguments?: string[]; workingDirectory?: string } | null | undefined;
  repoRoot: string;
}): { ok: boolean; detail?: string } {
  const command = params.command;
  const args = Array.isArray(command?.programArguments) ? command.programArguments : [];
  const repoRoot = path.resolve(params.repoRoot);

  const workingDirectory = command?.workingDirectory?.trim();
  if (
    workingDirectory &&
    path.isAbsolute(workingDirectory) &&
    !isPathInside(repoRoot, workingDirectory)
  ) {
    return {
      ok: false,
      detail: `working directory ${workingDirectory} is outside ${repoRoot}`,
    };
  }

  for (const arg of args) {
    const value = arg.trim();
    if (!value || !path.isAbsolute(value)) {
      continue;
    }
    const basename = path.basename(value);
    if (basename === "start-managed.sh" || basename === "start-vps.sh") {
      const expected = path.join(repoRoot, "scripts", basename);
      if (normalizeServicePath(value) !== normalizeServicePath(expected)) {
        return {
          ok: false,
          detail: `${basename} points to ${value}; expected ${expected}`,
        };
      }
      continue;
    }
    if (basename === "entry.js" || basename === "index.js" || basename === "fased.mjs") {
      if (!isPathInside(repoRoot, value)) {
        return {
          ok: false,
          detail: `entrypoint ${value} is outside ${repoRoot}`,
        };
      }
    }
  }

  return { ok: true };
}

function wsToHttpUrl(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  return parsed.toString();
}

function resolveGatewaySecretPathForEnv(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = env.FASED_STATE_DIR?.trim()
    ? resolveUserPath(env.FASED_STATE_DIR.trim())
    : resolveUserPath("~/.fased");
  return path.join(stateDir, "gateway-secret");
}

async function checkHttpStatusOk(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(2_000),
    });
    return {
      ok: res.status === 200,
      detail: `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function describeBootAsset(asset: ControlUiBootCheckAsset | null, label: string): string | null {
  if (!asset) {
    return `${label} is not referenced`;
  }
  if (!asset.ok) {
    const status = Number.isFinite(asset.status) ? `HTTP ${asset.status}` : "fetch failed";
    return `${label} failed (${status}; ${asset.contentType || "missing content-type"}; ${asset.message ?? "unknown error"})`;
  }
  return null;
}

export function validateLocalDashboardBootCheck(
  bootCheck: ControlUiBootCheck,
): { ok: true } | { ok: false; detail: string } {
  if (bootCheck.index !== "ok" || !bootCheck.indexResponse.ok) {
    return {
      ok: false,
      detail:
        bootCheck.indexResponse.message ??
        `dashboard index failed with HTTP ${bootCheck.indexResponse.status}`,
    };
  }
  const entryFailure = describeBootAsset(bootCheck.entryJs, "entry JS");
  if (entryFailure) {
    return { ok: false, detail: entryFailure };
  }
  const appFailure = describeBootAsset(bootCheck.appJs, "app JS");
  if (appFailure) {
    return { ok: false, detail: appFailure };
  }
  return { ok: true };
}

async function fetchLocalDashboardBootCheck(params: {
  httpUrl: string;
  timeoutMs?: number;
}): Promise<{ ok: true; bootCheck: ControlUiBootCheck } | { ok: false; detail: string }> {
  const url = new URL(CONTROL_UI_BOOT_CHECK_PATH, params.httpUrl);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(Math.max(500, params.timeoutMs ?? 4_000)),
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return {
        ok: false,
        detail: `boot-check returned ${res.status} ${contentType || "missing content-type"}`,
      };
    }
    const bootCheck = (await res.json()) as ControlUiBootCheck;
    const valid = validateLocalDashboardBootCheck(bootCheck);
    if (!valid.ok) {
      return { ok: false, detail: valid.detail };
    }
    return { ok: true, bootCheck };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function waitForLocalDashboardReady(params: {
  links: { httpUrl: string; wsUrl: string };
  token?: string;
  password?: string;
  deadlineMs: number;
  pollMs?: number;
}): Promise<{ ok: boolean; detail?: string }> {
  const deadlineAt = Date.now() + Math.max(1_000, params.deadlineMs);
  const pollMs = Math.max(250, params.pollMs ?? 750);
  let lastDetail = "dashboard not ready";
  while (Date.now() < deadlineAt) {
    const index = await checkHttpStatusOk(params.links.httpUrl);
    if (!index.ok) {
      lastDetail = `dashboard HTTP ${index.detail}`;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }

    const bootCheck = await fetchLocalDashboardBootCheck({
      httpUrl: params.links.httpUrl,
      timeoutMs: 4_000,
    });
    if (!bootCheck.ok) {
      lastDetail = bootCheck.detail;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }

    const gateway = await probeGatewayReachable({
      url: params.links.wsUrl,
      token: params.token,
      password: params.password,
      timeoutMs: 5_000,
    });
    if (gateway.ok) {
      return { ok: true };
    }
    lastDetail = gateway.detail ?? "gateway websocket not reachable";
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { ok: false, detail: lastDetail };
}

async function collectLocalGatewayHealthCheck(params: {
  links: { httpUrl: string; wsUrl: string };
  token?: string;
  password?: string;
  gatewayProbe: { ok: boolean; detail?: string };
}): Promise<string> {
  const service = resolveGatewayService();
  const command = await service.readCommand(process.env).catch(() => null);
  const serviceMatch = gatewayServiceMatchesCurrentInstall({
    command,
    repoRoot: process.cwd(),
  });
  const secretPath = resolveGatewaySecretPathForEnv(process.env);
  const secret = await fs.readFile(secretPath, "utf8").catch(() => "");
  const token = params.token?.trim() ?? "";
  const tokenMatches = token ? secret.trim() === token : true;
  const http = await checkHttpStatusOk(params.links.httpUrl);
  const gateway = params.gatewayProbe.ok
    ? params.gatewayProbe
    : await probeGatewayReachable({
        url: params.links.wsUrl,
        token: params.token,
        password: params.password,
        timeoutMs: 3_000,
      });

  const line = (ok: boolean, label: string, detail: string) =>
    `${ok ? "✓" : "!"} ${label}: ${detail}`;
  return [
    "Local health check",
    `   ${line(serviceMatch.ok, "Service path", serviceMatch.ok ? "current checkout" : (serviceMatch.detail ?? "not installed"))}`,
    `   ${line(tokenMatches, "Gateway token", token ? "matches service secret" : "not required")}`,
    `   ${line(http.ok, "Dashboard HTTP", http.detail)}`,
    `   ${line(gateway.ok, "Gateway", gateway.ok ? "online" : (gateway.detail ?? "not reachable"))}`,
    "   Local security: loopback bind (127.0.0.1) with token auth.",
    "   Run anytime: fased health",
  ].join("\n");
}

function parseGatewayTcpEndpoint(wsUrl: string): { host: string; port: number } | null {
  try {
    const url = new URL(wsUrl);
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    const defaultPort = url.protocol === "wss:" ? 443 : url.protocol === "ws:" ? 80 : 0;
    const port = Number(url.port || defaultPort);
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) {
      return null;
    }
    return { host, port };
  } catch {
    return null;
  }
}

function isLoopbackTcpHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.")
  );
}

async function probeTcpEndpoint(params: {
  host: string;
  port: number;
  timeoutMs: number;
}): Promise<{ ok: boolean; detail?: string }> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: params.host, port: params.port });
    let settled = false;
    const finish = (result: { ok: boolean; detail?: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(Math.max(100, params.timeoutMs));
    socket.once("connect", () => finish({ ok: true }));
    socket.once("timeout", () => finish({ ok: false, detail: "tcp connection timed out" }));
    socket.once("error", (err) => finish({ ok: false, detail: err.message }));
  });
}

export async function waitForGatewayHttpListener(params: {
  wsUrl: string;
  deadlineMs: number;
  pollMs?: number;
}): Promise<{ ok: boolean; detail?: string }> {
  const deadlineAt = Date.now() + Math.max(1, params.deadlineMs);
  const pollMs = Math.max(100, params.pollMs ?? 500);
  const httpUrl = wsToHttpUrl(params.wsUrl);
  const tcpEndpoint = parseGatewayTcpEndpoint(params.wsUrl);
  const canUseTcpListenerProbe =
    tcpEndpoint != null && isLoopbackTcpHost(tcpEndpoint.host) && tcpEndpoint.port > 0;
  let lastError = "connection not ready";
  while (Date.now() < deadlineAt) {
    if (canUseTcpListenerProbe) {
      const tcp = await probeTcpEndpoint({
        host: tcpEndpoint.host,
        port: tcpEndpoint.port,
        timeoutMs: 750,
      });
      if (tcp.ok) {
        return { ok: true };
      }
      lastError = `tcp ${tcp.detail ?? "connection failed"}`;
    }
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
      const httpError = err instanceof Error ? err.message : String(err);
      lastError = lastError.startsWith("tcp ") ? `${lastError}; http ${httpError}` : httpError;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { ok: false, detail: lastError };
}

async function waitForManagedFederationSummary(params: {
  env: NodeJS.ProcessEnv;
  deadlineMs?: number;
  pollMs?: number;
  requireToken?: boolean;
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
    const ready = params.requireToken
      ? fedToken.exists
      : resolvedPublicUrl || fedToken.exists || reservations.length > 0;
    if (ready) {
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
  const titleLabel = (title: string) => {
    if (title === "Wallet Control Passkey ready") {
      return "Passkey";
    }
    if (title === "Agent wallet set") {
      return "Agent wallet";
    }
    if (title === "Mining wallet separate") {
      return "Mining wallet";
    }
    if (title === "Vault wallet present") {
      return "Vault wallet";
    }
    if (title === "Fased Network joined / trusted") {
      return "Network trust";
    }
    if (title === "Fased Network reachability state") {
      return "Network reachability";
    }
    return title;
  };
  const tone = (item: (typeof items)[number]) => {
    if (item.tone === "success") {
      return theme.success(item.summary);
    }
    if (item.tone === "warn") {
      return theme.warn(item.summary);
    }
    return theme.info(item.summary);
  };
  const summaryLines = items.map((item) => `- ${titleLabel(item.title)}: ${tone(item)}`);
  const nextActionLines: string[] = [];
  if (
    items.some((item) => item.title === "Wallet Control Passkey ready" && item.tone !== "success")
  ) {
    nextActionLines.push("- Wallet: finish passkey before higher-risk automation.");
  }
  if (items.some((item) => item.title === "Agent wallet set" && item.tone !== "success")) {
    nextActionLines.push("- Wallet: set an Agent wallet before paid network or skill wallet work.");
  }
  if (
    items.some((item) => item.title === "Mining wallet separate" && item.summary === "Conflict")
  ) {
    nextActionLines.push("- Mining: move Mining to a separate wallet before paid Agent flows.");
  } else if (
    items.some(
      (item) =>
        item.title === "Mining wallet separate" && item.summary === "Optional and not configured",
    )
  ) {
    nextActionLines.push("- Mining: optional; create/import @wallet:mining later.");
  }
  if (
    items.some(
      (item) => item.title === "Fased Network joined / trusted" && item.summary !== "Verified",
    )
  ) {
    nextActionLines.push("- Fased Network: complete registration and trust review.");
  }
  if (
    items.some(
      (item) =>
        item.title === "Fased Network reachability state" &&
        item.summary !== "Ready" &&
        item.summary !== "Disabled",
    )
  ) {
    nextActionLines.push("- Fased Network: check hosted token issuance for public URL.");
  }
  return [
    theme.heading("Operator readiness summary"),
    ...summaryLines,
    ...(nextActionLines.length > 0 ? ["", theme.heading("Next actions"), ...nextActionLines] : []),
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
}): Promise<{ ok: boolean; detail?: string; gatewayHealthReady?: boolean }> {
  const listener = await waitForStableGatewayHttpListener({
    wsUrl: params.wsUrl,
    deadlineMs: params.lowRamMode ? 45_000 : 15_000,
    stableMs: 2_000,
    pollMs: 750,
  });
  if (!listener.ok) {
    return {
      ok: false,
      detail: `listener not stable: ${listener.detail ?? "not reachable"}`,
    };
  }
  const probe = await probeGatewayReachable({
    url: params.wsUrl,
    token: params.token,
    password: params.password,
    timeoutMs: params.lowRamMode ? 6_000 : 3_000,
  });
  if (!probe.ok) {
    return {
      ok: true,
      gatewayHealthReady: false,
      detail: `dashboard listener ready; gateway health still warming (${probe.detail ?? "not reachable"})`,
    };
  }
  return { ok: true, gatewayHealthReady: true };
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
              .readFile(resolveGatewaySecretPathForEnv(process.env), "utf8")
              .then((value) => value.trim())
              .catch(() => "")) ||
            settings.gatewayToken ||
            ""
        )?.trim() || ""
      : "";
  if (settings.authMode === "token" && preferredGatewayToken) {
    const synced = await ensureGatewaySecretMatchesToken(preferredGatewayToken);
    if (synced) {
      await prompter.note(
        "Aligned the gateway service token with the dashboard token.",
        "Gateway auth",
      );
    }
  }

  const withWizardProgress = async <T>(
    label: string,
    options: { doneMessage?: string },
    work: (progress: { update: (message: string) => void }) => Promise<T>,
  ): Promise<T> => {
    const progress = prompter.progress(label);
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
        ? "Systemd user services are unavailable in this session. Skipping linger checks; hosted install requires the root-managed gateway service."
        : "Systemd user services are unavailable. Skipping lingering checks and user-service install.",
      "Systemd",
    );
  }

  if (process.platform === "linux" && systemdAvailable && strictVps) {
    await prompter.note(
      [
        "Hosted setup uses the root-managed fased-gateway.service running as the non-root app user.",
        "Skipping systemd user lingering; no app sudo password is required.",
      ].join("\n"),
      "Systemd",
    );
  } else if (process.platform === "linux" && systemdAvailable) {
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
    if (strictVps && !canUseRootService) {
      throw new Error(
        formatHostedRootServiceRequiredFailure({
          runAsUser: resolveGatewayServiceRunAsUser(),
          detail: "non-interactive sudo is unavailable for systemd service install/repair",
        }),
      );
    }
    if (preferRootService && canUseRootService) {
      const runAsUser = resolveGatewayServiceRunAsUser();
      if (!runAsUser) {
        if (strictVps) {
          throw new Error(
            formatHostedRootServiceRequiredFailure({
              detail: "runtime user could not be resolved",
            }),
          );
        }
        await prompter.note(
          "Unable to resolve root service runtime user; falling back to non-root service install.",
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
              if (strictVps) {
                throw new Error(
                  formatHostedRootServiceRequiredFailure({
                    runAsUser,
                    detail: rootService.detail,
                  }),
                );
              }
              await prompter.note(
                `${strictVps ? "Hosting" : "Local"} root service install failed: ${rootService.detail ?? "unknown error"}. Falling back to non-root service.`,
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
              if (strictVps) {
                throw new Error(
                  formatHostedRootServiceRequiredFailure({
                    runAsUser,
                    detail:
                      strictExecAfter.detail ||
                      "unit ExecStart/User is not the canonical hosted service command",
                  }),
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
    if (strictVps && !rootServiceActiveSuccessfully) {
      throw new Error(
        formatHostedRootServiceRequiredFailure({
          runAsUser: resolveGatewayServiceRunAsUser(),
          detail: "root-managed gateway service was not verified after restart/repair",
        }),
      );
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
          } else {
            const installMatch = gatewayServiceMatchesCurrentInstall({
              command: existing,
              repoRoot: process.cwd(),
            });
            if (!installMatch.ok) {
              action = "reinstall";
              await prompter.note(
                `Detected gateway service from another checkout; reinstalling current service. ${installMatch.detail ?? ""}`.trim(),
                "Gateway service",
              );
            }
          }
          if (
            action !== "reinstall" &&
            serviceAudit.issues.some(
              (issue) => issue.code === SERVICE_AUDIT_CODES.gatewayEntrypointMismatch,
            )
          ) {
            action = "reinstall";
            await prompter.note(
              "Gateway service entrypoint is stale; reinstalling current service.",
              "Gateway service",
            );
          } else if (
            action !== "reinstall" &&
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
                const restarted = await restartGatewayServiceOnce(
                  "fased-gateway",
                  strictVps ? "hosting" : "local",
                );
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
      const restarted = await restartGatewayServiceOnce(
        "fased-gateway",
        strictVps ? "hosting" : "local",
      );
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
          noteHeading("Private access"),
          noteInfo("Hosted runtime is private by default."),
          "",
          `${noteLabel("Web dashboard:")} ${noteCommand("Tailscale HTTPS URL")}`,
          `${noteLabel("SSH terminal:")} ${noteCommand("ssh app@YOUR_VPS_TAILSCALE_NAME")} ${noteInfo("over Tailscale")}`,
          noteBullet(noteWarn("Public SSH and Gateway ports remain blocked.")),
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
    const localFastReadinessDeadlineMs = lowRamMode ? 60_000 : 20_000;
    const hostingReadinessDeadlineMs = lowRamMode ? 90_000 : 45_000;
    const hostingProbeTimeoutMs = lowRamMode ? 15_000 : 8_000;
    const warmupDeadlineMs = strictVps
      ? hostingReadinessDeadlineMs
      : fastHealth
        ? localFastReadinessDeadlineMs
        : 60_000;
    const listenerDeadlineMs = strictVps
      ? hostingReadinessDeadlineMs
      : fastHealth
        ? localFastReadinessDeadlineMs
        : 60_000;
    const strictProbeTimeoutMs = strictVps ? hostingProbeTimeoutMs : fastHealth ? 5_000 : 15_000;

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
          deadlineMs: strictVps ? (lowRamMode ? 60_000 : 30_000) : 10_000,
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
          const restarted = await restartGatewayServiceOnce(
            "fased-gateway",
            strictVps ? "hosting" : "local",
          );
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
                ? 90_000
                : 30_000
              : 20_000
            : strictVps
              ? lowRamMode
                ? 90_000
                : 30_000
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
              : "Gateway service is active; verifying dashboard readiness."
            : "Gateway startup is still warming; setup will keep checking before completion.",
          serviceActive ? "Health check" : "Gateway startup",
        );
        fastHealthSatisfied = strictVps && serviceActive;
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
            deadlineMs: lowRamMode ? 90_000 : 30_000,
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
              const restarted = await restartGatewayServiceOnce(
                "fased-gateway",
                strictVps ? "hosting" : "local",
              );
              if (restarted.ok) {
                progress.update(
                  "Listener not ready yet; restarted service once and waiting again…",
                );
                strictFastListener = await waitForGatewayHttpListener({
                  wsUrl: probeLinks.wsUrl,
                  deadlineMs: lowRamMode ? 90_000 : 45_000,
                });
              }
            } else {
              progress.update("Service is still warming; waiting once more without restart…");
              // Give slow VPS starts one more bounded warmup pass without service churn.
              strictFastListener = await waitForGatewayHttpListener({
                wsUrl: probeLinks.wsUrl,
                deadlineMs: lowRamMode ? 90_000 : 30_000,
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
              deadlineMs: lowRamMode ? 45_000 : 20_000,
              stableMs: 2_000,
              pollMs: 750,
            });
            if (!stableListener.ok) {
              const [rootState, userState] = await Promise.all([
                isSystemdServiceActive({ name: "fased-gateway", scope: "root" }),
                isSystemdServiceActive({ name: "fased-gateway", scope: "user" }),
              ]);
              if (rootState.ok || userState.ok) {
                await prompter.note(
                  [
                    "Gateway listener was reachable, but one stability recheck was slow.",
                    `Detail: ${stableListener.detail ?? "listener recheck timed out"}`,
                    "The active service and browser dashboard checks will continue.",
                  ].join("\n"),
                  "Listener readiness",
                );
                return;
              }
            }
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
      let wsWarmupProbe: { ok: boolean; detail?: string } | null = null;
      try {
        wsWarmupProbe = await waitForGatewayReachable({
          url: probeLinks.wsUrl,
          token: healthProbeToken,
          password: healthProbePassword,
          deadlineMs: warmupDeadlineMs,
          probeTimeoutMs: strictVps ? hostingProbeTimeoutMs : 5_000,
          pollMs: 750,
        });
        if (!wsWarmupProbe.ok) {
          wsWarmupError = new Error(wsWarmupProbe.detail ?? "gateway not reachable");
        }
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
        let strictProbe =
          wsWarmupProbe?.ok === true
            ? wsWarmupProbe
            : await waitForGatewayReachable({
                url: probeLinks.wsUrl,
                token: healthProbeToken,
                password: healthProbePassword,
                deadlineMs: hostingReadinessDeadlineMs,
                probeTimeoutMs: strictProbeTimeoutMs,
                pollMs: 750,
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
          strictProbe = await waitForGatewayReachable({
            url: probeLinks.wsUrl,
            token: healthProbeToken,
            password: healthProbePassword,
            deadlineMs: hostingReadinessDeadlineMs,
            probeTimeoutMs: strictProbeTimeoutMs,
            pollMs: 750,
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
        let localGatewayReady = wsWarmupProbe ?? {
          ok: false,
          detail:
            wsWarmupError instanceof Error
              ? wsWarmupError.message
              : typeof wsWarmupError === "string" && wsWarmupError
                ? wsWarmupError
                : "gateway not reachable",
        };
        if (
          !localGatewayReady.ok &&
          String(localGatewayReady.detail ?? "")
            .toLowerCase()
            .includes("device token mismatch")
        ) {
          const cleared = clearDeviceAuthStore(process.env);
          await prompter.note(
            [
              "Detected stale local device auth token cache.",
              cleared
                ? "Cleared local cached device auth and retrying gateway readiness once."
                : "Device auth cache was already empty; retrying gateway readiness once.",
            ].join("\n"),
            "Gateway auth recovery",
          );
          localGatewayReady = await waitForGatewayReachable({
            url: probeLinks.wsUrl,
            token: healthProbeToken,
            password: healthProbePassword,
            deadlineMs: warmupDeadlineMs,
            probeTimeoutMs: 5_000,
            pollMs: 750,
          });
        }
        if (!localGatewayReady.ok) {
          await prompter.note(
            [
              "Gateway is still warming after the service restart.",
              "Setup will keep checking dashboard HTTP/assets/WebSocket readiness before it prints a dashboard link.",
              `Detail: ${localGatewayReady.detail ?? "gateway not reachable yet"}`,
            ].join("\n"),
            "Gateway startup",
          );
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
  if (!strictVps && opts.mode !== "remote" && !opts.skipUi && !gatewayProbe.ok) {
    const warmup = await waitForGatewayReachable({
      url: links.wsUrl,
      token: settings.authMode === "token" ? gatewayTokenForUi || undefined : undefined,
      password: settings.authMode === "password" ? nextConfig.gateway?.auth?.password : "",
      deadlineMs: lowRamMode ? 120_000 : 30_000,
      probeTimeoutMs: 5_000,
      pollMs: 750,
    });
    if (warmup.ok) {
      gatewayProbe = warmup;
    }
  }
  if (!strictVps && opts.mode !== "remote" && !opts.skipUi && !gatewayProbe.ok) {
    await prompter.note(
      "Gateway is not reachable yet; restarting the service once before showing the dashboard link.",
      "Gateway startup",
    );
    await restartGatewayServiceOnce("fased-gateway", strictVps ? "hosting" : "local");
    const ready = await waitForGatewayReachable({
      url: links.wsUrl,
      token: settings.authMode === "token" ? gatewayTokenForUi || undefined : undefined,
      password: settings.authMode === "password" ? nextConfig.gateway?.auth?.password : "",
      deadlineMs: lowRamMode ? 120_000 : 60_000,
      probeTimeoutMs: 5_000,
      pollMs: 750,
    });
    if (!ready.ok) {
      throw new Error(
        [
          "Gateway did not become reachable, so the dashboard link would be offline.",
          `Detail: ${ready.detail ?? gatewayProbe.detail ?? "gateway not reachable"}`,
          "Debug commands:",
          "  systemctl --user status fased-gateway --no-pager",
          "  journalctl --user -u fased-gateway -n 120 --no-pager",
          "Repair command:",
          `  ${formatCliCommand("fased gateway install --force")}`,
        ].join("\n"),
      );
    }
    gatewayProbe = { ok: true };
  }
  if (!strictVps && opts.mode !== "remote" && !opts.skipUi) {
    let localDashboardReady = await waitForLocalDashboardReady({
      links,
      token: settings.authMode === "token" ? gatewayTokenForUi || undefined : undefined,
      password: settings.authMode === "password" ? nextConfig.gateway?.auth?.password : "",
      deadlineMs: lowRamMode ? 120_000 : 60_000,
      pollMs: 750,
    });
    if (!localDashboardReady.ok) {
      await prompter.note(
        "Dashboard HTTP/assets/WebSocket readiness did not pass; restarting the local gateway service once.",
        "Dashboard readiness",
      );
      await restartGatewayServiceOnce("fased-gateway", "local");
      localDashboardReady = await waitForLocalDashboardReady({
        links,
        token: settings.authMode === "token" ? gatewayTokenForUi || undefined : undefined,
        password: settings.authMode === "password" ? nextConfig.gateway?.auth?.password : "",
        deadlineMs: lowRamMode ? 120_000 : 60_000,
        pollMs: 750,
      });
    }
    if (!localDashboardReady.ok) {
      throw new Error(
        [
          "Local dashboard is not ready, so setup will not print a ready dashboard link.",
          `Detail: ${localDashboardReady.detail ?? "dashboard readiness failed"}`,
          "Debug commands:",
          "  systemctl --user status fased-gateway --no-pager",
          "  journalctl --user -u fased-gateway -n 120 --no-pager",
          "  fased dashboard --no-open",
          "Repair command:",
          "  ./install.sh",
        ].join("\n"),
      );
    }
    gatewayProbe = { ok: true };
  }
  const gatewayStatusLine = gatewayProbe.ok
    ? "Gateway: reachable"
    : `Gateway: not detected${gatewayProbe.detail ? ` (${gatewayProbe.detail})` : ""}`;
  const localHealthCheck =
    !strictVps && opts.mode !== "remote" && !opts.skipHealth && !opts.skipUi
      ? await collectLocalGatewayHealthCheck({
          links,
          token: settings.authMode === "token" ? gatewayTokenForUi || undefined : undefined,
          password:
            settings.authMode === "password" ? nextConfig.gateway?.auth?.password : undefined,
          gatewayProbe,
        })
      : undefined;
  const tailscaleSshUser = process.env.USER?.trim() || "app";
  let tailscaleAdminUrl: string | undefined;
  let tailscaleNodeName = "";
  let tailscaleIpv4 = "";
  if (settings.tailscaleMode !== "off") {
    const identity = strictVps
      ? await waitForTailscaleIdentity({
          basePath: controlUiBasePath,
          deadlineMs: lowRamMode ? 60_000 : 30_000,
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
          deadlineMs: lowRamMode ? 45_000 : 20_000,
        });
        if (serveWarmup.ok) {
          return;
        }
        const detail = serveWarmup.detail ?? "mapping not detected";
        await prompter.note(
          [
            "Tailscale serve is still warming.",
            `Detail: ${detail}`,
            "",
            "Setup will continue if the local Gateway service is healthy.",
            "Use the SSH tunnel fallback immediately, or open the Tailscale dashboard URL again shortly.",
          ].join("\n"),
          "Tailscale serve warmup",
        );
      },
    );
  }
  let hostedDashboardBrowserVerified = false;
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
            deadlineMs: lowRamMode ? 45_000 : 20_000,
            pollMs: 1_000,
            requestTimeoutMs: 3_000,
            // 401/403 still prove Tailscale HTTPS endpoint is reachable;
            // auth happens in browser with the gateway token shown separately.
            successStatuses: [401, 403],
          });
          if (!warmup.ok) {
            const detail = warmup.detail ?? "not reachable yet";
            await prompter.note(
              [
                noteHeading("Tailscale HTTPS"),
                noteWarn("The Tailscale HTTPS dashboard URL is still warming from this VPS."),
                `${noteMuted("Detail:")} ${noteInfo(detail)}`,
                "",
                noteBullet(
                  noteSuccess("Setup will continue if the local Gateway listener is healthy."),
                ),
                noteBullet(
                  noteInfo(
                    "Open the printed Tailscale URL from your own Tailscale-connected computer.",
                  ),
                ),
                noteBullet(
                  noteWarn(
                    "If another VPN breaks MagicDNS, turn it off or use the 100.x Tailscale IP fallback.",
                  ),
                ),
              ].join("\n"),
              "Dashboard warmup",
            );
            return;
          }
          progress.update("Confirming browser dashboard connection…");
          const wsWarmup =
            settings.authMode === "token" && gatewayTokenForUi
              ? await waitForHostedDashboardBrowserPath({
                  httpUrl: tailscaleAdminUrl,
                  token: gatewayTokenForUi,
                  deadlineMs: lowRamMode ? 45_000 : 20_000,
                  probeTimeoutMs: lowRamMode ? 6_000 : 3_000,
                  pollMs: 1_500,
                })
              : await waitForGatewayReachable({
                  url: tailscaleGatewayWsUrl,
                  token: settings.authMode === "token" ? gatewayTokenForUi || undefined : undefined,
                  password:
                    settings.authMode === "password"
                      ? nextConfig.gateway?.auth?.password
                      : undefined,
                  deadlineMs: lowRamMode ? 45_000 : 20_000,
                  probeTimeoutMs: lowRamMode ? 6_000 : 3_000,
                  pollMs: 1_500,
                });
          if (!wsWarmup.ok) {
            await prompter.note(
              [
                noteHeading("Gateway connection"),
                noteWarn(
                  "The Tailscale dashboard page is reachable, but the browser Gateway connection is still warming.",
                ),
                `${noteLabel("Gateway URL:")} ${noteCommand(tailscaleGatewayWsUrl)}`,
                `${noteMuted("Detail:")} ${noteInfo(
                  "stage" in wsWarmup
                    ? `${wsWarmup.stage}: ${wsWarmup.message}`
                    : (wsWarmup.detail ?? "websocket not reachable"),
                )}`,
                "",
                noteBullet(
                  noteSuccess("Setup will continue if the local Gateway listener is healthy."),
                ),
                noteBullet(
                  noteInfo(
                    "Use the SSH tunnel fallback immediately, or open the Tailscale dashboard URL again shortly.",
                  ),
                ),
              ].join("\n"),
              "Dashboard warmup",
            );
          } else {
            hostedDashboardBrowserVerified = true;
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
        "Local dashboard:",
        `  ${links.httpUrl}`,
        settings.authMode === "token" && gatewayTokenForUi
          ? `Token backup: ${gatewayTokenForUi}`
          : undefined,
        gatewayStatusLine,
      ]
        .filter(Boolean)
        .join("\n"),
      "Dashboard access",
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
  let persistedFederationToken = federation.enabled
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
    let hostedFederationAutoConnectAttempted = false;
    let hostedFederationAutoConnectReason = "";
    const hostedFederationAutoConnectMessages: string[] = [];
    if (strictVps && !readManagedFederationTokenSummary(onboardingEnv).exists) {
      hostedFederationAutoConnectAttempted = true;
      const autoConnect = await runFederationAutoConnectOnce({
        env: onboardingEnv,
        log: {
          info: (message) => {
            hostedFederationAutoConnectMessages.push(message);
          },
          warn: (message) => {
            hostedFederationAutoConnectReason = message;
          },
          error: (message) => {
            hostedFederationAutoConnectReason = message;
          },
        },
      });
      hostedFederationAutoConnectReason = autoConnect.reason ?? hostedFederationAutoConnectReason;
    }
    const { fedToken, reservations } = strictVps
      ? await waitForManagedFederationSummary({
          env: onboardingEnv,
          deadlineMs: 20_000,
          requireToken: true,
        })
      : {
          fedToken: readManagedFederationTokenSummary(onboardingEnv),
          reservations: readManagedReservationSummaries(onboardingEnv),
        };
    if (fedToken.exists && !persistedFederationToken) {
      persistedFederationToken = await loadPersistedFederationToken(onboardingEnv).catch(
        () => null,
      );
    }
    if (
      strictVps &&
      hostedFederationAutoConnectAttempted &&
      hostedFederationAutoConnectMessages.length > 0
    ) {
      await prompter.note(
        formatFasedNetworkAutoConnectSummary(hostedFederationAutoConnectMessages),
        "Fased Network",
      );
    }
    if (strictVps && hostedFederationAutoConnectAttempted && !fedToken.exists) {
      await prompter.note(
        [
          noteWarn("Fased Network silent join did not finish."),
          hostedFederationAutoConnectReason
            ? `${noteMuted("Reason:")} ${noteInfo(hostedFederationAutoConnectReason)}`
            : `${noteMuted("Reason:")} ${noteInfo("token was not issued before final readiness.")}`,
          reservations.length > 0
            ? `${noteMuted("Reservation:")} ${noteCommand(reservations[0]?.slug ?? "")}`
            : undefined,
          noteSuccess("Dashboard and SSH are ready over Tailscale."),
          `${noteMuted("Inspect details:")} ${noteCommand("fased managed up --json")}`,
        ]
          .filter(Boolean)
          .join("\n"),
        "Fased Network",
      );
    }
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
          const [rootState, userState] = await Promise.all([
            isSystemdServiceActive({ name: "fased-gateway", scope: "root" }),
            isSystemdServiceActive({ name: "fased-gateway", scope: "user" }),
          ]);
          const serviceActive = rootState.ok || userState.ok;
          if (hostedDashboardBrowserVerified || serviceActive) {
            gatewayProbe = {
              ok: false,
              detail: finalGateway.detail ?? "final gateway recheck timed out",
            };
            await prompter.note(
              [
                noteHeading("Service active"),
                serviceActive
                  ? noteWarn(
                      "The hosted Gateway service is active, but the dashboard is still warming.",
                    )
                  : noteInfo("The hosted browser dashboard passed its full check earlier."),
                `${noteMuted("Detail:")} ${noteInfo(
                  finalGateway.detail ?? "gateway not reachable yet",
                )}`,
                "",
                noteBullet(noteSuccess("Setup will finish and leave the Gateway service running.")),
                noteBullet(
                  noteInfo("Open the printed Tailscale dashboard URL again in a few minutes."),
                ),
                noteBullet(
                  noteWarn(
                    "If MagicDNS is slow or another VPN is active, use the 100.x Tailscale IP fallback.",
                  ),
                ),
                "",
                noteHeading("Check from the app terminal"),
                noteCommand("fased status"),
                noteCommand("fased dashboard --no-open"),
              ].join("\n"),
              "Dashboard warmup",
            );
            return;
          }
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
        const restarted = await restartGatewayServiceOnce(
          "fased-gateway",
          strictVps ? "hosting" : "local",
        );
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
        formatLocalDashboardReady({
          dashboardUrl: strictDashboardUrl,
          gatewayToken:
            settings.authMode === "token" && gatewayTokenForUi ? gatewayTokenForUi : undefined,
          opened: controlUiOpened,
          healthCheck: localHealthCheck,
        }),
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
      formatLocalDashboardReady({
        dashboardUrl:
          strictVps || (opts.hostProfile === "local" && settings.tailscaleMode !== "off")
            ? strictDashboardUrl
            : authedUrl,
        gatewayToken:
          settings.authMode === "token" && gatewayTokenForUi ? gatewayTokenForUi : undefined,
        opened: controlUiOpened,
        healthCheck: localHealthCheck,
        fallbackHint: !strictVps ? controlUiOpenHint : undefined,
      }),
      "Dashboard ready",
    );
  }

  await prompter.outro(
    controlUiOpened
      ? "Setup complete. Next: Agent > Models, then Chat."
      : seededInBackground
        ? "Setup complete. Open the dashboard link above, then use Agent > Models and Chat."
        : "Setup complete. Use the dashboard link above, then use Agent > Models and Chat.",
  );

  return { launchedTui };
}
