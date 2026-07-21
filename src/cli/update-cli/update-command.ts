import path from "node:path";
import { confirm, isCancel } from "@clack/prompts";
import {
  ensureOpenAICodexRuntimeComponent,
  hasConfiguredOpenAICodexProfile,
  OPENAI_RUNTIME_COMPONENT_ID,
} from "../../agents/openai-codex-runtime-component.js";
import {
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
} from "../../commands/doctor-completion.js";
import { runPostUpdateDoctorRepair } from "../../commands/doctor-update.js";
import { doctorCommand } from "../../commands/doctor.js";
import {
  readConfigFileSnapshot,
  resolveGatewayPort,
  writeConfigFile,
} from "../../config/config.js";
import { probeGateway } from "../../gateway/probe.js";
import {
  activateLocalSourceSigner,
  commitLocalSourcePairedUpdate,
  isLocalSourceSignerConfigured,
  markLocalSourceAppActive,
  markLocalSourceGatewayVerified,
  prepareLocalSourcePairedUpdate,
  readLocalSourcePairedUpdateJournal,
  recoverLocalSourcePairedUpdate,
  rollbackLocalSourcePairedUpdate,
  verifyLocalSourceSigner,
  type LocalSourcePairedUpdateJournal,
} from "../../infra/local-source-paired-update.js";
import { ensureManagedRuntimeBootstrap } from "../../infra/managed-runtime-bootstrap.js";
import { loadGatewayTlsRuntime } from "../../infra/tls/gateway.js";
import {
  channelToNpmTag,
  DEFAULT_GIT_CHANNEL,
  DEFAULT_PACKAGE_CHANNEL,
  normalizeUpdateChannel,
} from "../../infra/update-channels.js";
import {
  compareSemverStrings,
  resolveNpmChannelTag,
  checkUpdateStatus,
} from "../../infra/update-check.js";
import {
  cleanupGlobalRenameDirs,
  globalInstallArgs,
  resolveGlobalPackageRoot,
  resolveNodeModulesRootForPackageRoot,
} from "../../infra/update-global.js";
import {
  finalizeUpdateTransaction,
  rollbackUpdateTransaction,
  runGatewayUpdate,
  type UpdateRunResult,
} from "../../infra/update-runner.js";
import { recordUpdateSuccess } from "../../infra/update-success-marker.js";
import { syncPluginsForUpdateChannel, updateNpmInstalledPlugins } from "../../plugins/update.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { stylePromptMessage } from "../../terminal/prompt-style.js";
import { theme } from "../../terminal/theme.js";
import { pathExists } from "../../utils.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import { installCompletion } from "../completion-cli.js";
import { runDaemonInstall, runDaemonRestart } from "../daemon-cli.js";
import {
  renderRestartDiagnostics,
  terminateStaleGatewayPids,
  waitForGatewayHealthyRestart,
} from "../daemon-cli/restart-health.js";
import { probeRunningGatewayRuntimeIdentity } from "../lightweight/gateway-runtime-probe.js";
import { createUpdateProgress, printResult } from "./progress.js";
import { prepareRestartScript, runRestartScript } from "./restart-helper.js";
import {
  resolveUpdateGatewayServiceTarget,
  type UpdateGatewayServiceTarget,
} from "./service-target.js";
import {
  DEFAULT_PACKAGE_NAME,
  createGlobalCommandRunner,
  ensureGitCheckout,
  normalizeTag,
  parseTimeoutMsOrExit,
  readPackageName,
  readPackageVersion,
  resolveGitInstallDir,
  resolveGlobalManager,
  resolveNodeRunner,
  resolveTargetVersion,
  resolveUpdateRoot,
  runUpdateStep,
  type UpdateCommandOptions,
} from "./shared.js";
import { suppressDeprecations } from "./suppress-deprecations.js";

const CLI_NAME = resolveCliName();
const SERVICE_REFRESH_TIMEOUT_MS = 60_000;

type UpdateLifecycleTiming = {
  name: string;
  durationMs: number;
};

function formatDuration(durationMs: number): string {
  return durationMs >= 1000 ? `${(durationMs / 1000).toFixed(2)}s` : `${durationMs}ms`;
}

async function measureUpdateStage<T>(
  timings: UpdateLifecycleTiming[],
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    timings.push({ name, durationMs: Date.now() - startedAt });
  }
}

function printUpdateLifecycleTimings(timings: UpdateLifecycleTiming[], jsonMode: boolean): void {
  if (jsonMode || timings.length === 0) {
    return;
  }
  defaultRuntime.log(theme.heading("Post-update timing"));
  for (const timing of timings) {
    defaultRuntime.log(`  ${timing.name}: ${theme.muted(formatDuration(timing.durationMs))}`);
  }
  defaultRuntime.log("");
}

export async function verifyGatewayRuntimeVersion(params: {
  expectedVersion: string;
  rpc: {
    url: string;
    token?: string;
    password?: string;
    tlsFingerprint?: string;
    timeoutMs: number;
  };
}): Promise<{ ok: boolean; actualVersion: string | null; error?: string }> {
  const probe = await probeGateway({
    url: params.rpc.url,
    auth: {
      token: params.rpc.token,
      password: params.rpc.password,
    },
    tlsFingerprint: params.rpc.tlsFingerprint,
    timeoutMs: Math.max(params.rpc.timeoutMs, 3_000),
  });
  const actualVersion = probe.server?.version?.trim() || null;
  if (!probe.ok) {
    return { ok: false, actualVersion, error: probe.error ?? "gateway probe failed" };
  }
  if (actualVersion !== params.expectedVersion) {
    return {
      ok: false,
      actualVersion,
      error: `running gateway version ${actualVersion ?? "unknown"} does not match installed version ${params.expectedVersion}`,
    };
  }
  return { ok: true, actualVersion };
}

const UPDATE_QUIPS = [
  "Leveled up! New skills unlocked. You're welcome.",
  "Fresh code, same agent. Miss me?",
  "Back and better. Did you even notice I was gone?",
  "Update complete. I learned some new tricks while I was out.",
  "Upgraded! Now with 23% more sass.",
  "I've evolved. Try to keep up.",
  "New version, who dis? Oh right, still me but shinier.",
  "Patched, polished, and ready to roll. Let's go.",
  "The agent has evolved. Harder shell, sharper edge.",
  "Update done! Check the changelog or just trust me, it's good.",
  "Reborn from the digital waters of npm. Stronger now.",
  "I went away and came back smarter. You should try it sometime.",
  "Update complete. The bugs feared me, so they left.",
  "New version installed. Old version sends its regards.",
  "Firmware fresh. Brain wrinkles: increased.",
  "I've seen things you wouldn't believe. Anyway, I'm updated.",
  "Back online. The changelog is long but our friendship is longer.",
  "Upgraded! Peter fixed stuff. Blame him if it breaks.",
  "Evolution complete. Please don't look at my soft reboot phase.",
  "Version bump! Same chaos energy, fewer crashes (probably).",
];

function pickUpdateQuip(): string {
  return UPDATE_QUIPS[Math.floor(Math.random() * UPDATE_QUIPS.length)] ?? "Update complete.";
}

function resolveGatewayInstallEntrypointCandidates(root?: string): string[] {
  if (!root) {
    return [];
  }
  return [
    path.join(root, "dist", "entry.js"),
    path.join(root, "dist", "entry.mjs"),
    path.join(root, "dist", "index.js"),
    path.join(root, "dist", "index.mjs"),
  ];
}

function formatCommandFailure(stdout: string, stderr: string): string {
  const detail = (stderr || stdout).trim();
  if (!detail) {
    return "command returned a non-zero exit code";
  }
  return detail.split("\n").slice(-3).join("\n");
}

type GatewayServiceRefreshFailure = {
  candidate: string;
  detail: string;
};

type GatewayServiceRefreshResult =
  | { status: "updated-entrypoint"; failures: GatewayServiceRefreshFailure[] }
  | { status: "daemon-install-fallback"; failures: GatewayServiceRefreshFailure[] };

class GatewayServiceRefreshError extends Error {
  readonly failures: GatewayServiceRefreshFailure[];
  readonly repairCommand: string;

  constructor(params: {
    failures: GatewayServiceRefreshFailure[];
    fallbackDetail?: string;
    repairCommand: string;
  }) {
    const details = formatGatewayRefreshFailures(params.failures);
    const fallback = params.fallbackDetail ? `\nFallback failed:\n${params.fallbackDetail}` : "";
    super(`gateway service refresh failed.${details}${fallback}`);
    this.name = "GatewayServiceRefreshError";
    this.failures = params.failures;
    this.repairCommand = params.repairCommand;
  }
}

function formatGatewayRefreshFailures(failures: GatewayServiceRefreshFailure[]): string {
  if (failures.length === 0) {
    return "";
  }
  return failures.map((failure) => `\n- ${failure.candidate}\n  ${failure.detail}`).join("");
}

function formatInvalidUpdateChannelConfigMessage(
  configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): string {
  const lines = [
    "Config is invalid; cannot set update channel.",
    ...configSnapshot.issues.map((issue) => `- ${issue.path}: ${issue.message}`),
  ];
  if (configSnapshot.legacyIssues.length > 0) {
    lines.push(
      "",
      `Legacy config entries were detected. Run \`${replaceCliName(formatCliCommand("fased doctor --fix"), CLI_NAME)}\`, then rerun the update channel command.`,
      ...configSnapshot.legacyIssues.map((issue) => `- ${issue.path}: ${issue.message}`),
    );
  }
  return lines.join("\n");
}

type UpdateDryRunPreview = {
  dryRun: true;
  root: string;
  installKind: "git" | "package" | "unknown";
  mode: UpdateRunResult["mode"];
  updateInstallKind: "git" | "package" | "unknown";
  switchToGit: boolean;
  switchToPackage: boolean;
  restart: boolean;
  requestedChannel: "stable" | "beta" | "dev" | null;
  storedChannel: "stable" | "beta" | "dev" | null;
  effectiveChannel: "stable" | "beta" | "dev";
  tag: string;
  currentVersion: string | null;
  targetVersion: string | null;
  downgradeRisk: boolean;
  actions: string[];
  notes: string[];
};

function printDryRunPreview(preview: UpdateDryRunPreview, jsonMode: boolean): void {
  if (jsonMode) {
    defaultRuntime.log(JSON.stringify(preview, null, 2));
    return;
  }

  defaultRuntime.log(theme.heading("Update dry-run"));
  defaultRuntime.log(theme.muted("No changes were applied."));
  defaultRuntime.log("");
  defaultRuntime.log(`  Root: ${theme.muted(preview.root)}`);
  defaultRuntime.log(`  Install kind: ${theme.muted(preview.installKind)}`);
  defaultRuntime.log(`  Mode: ${theme.muted(preview.mode)}`);
  defaultRuntime.log(`  Channel: ${theme.muted(preview.effectiveChannel)}`);
  defaultRuntime.log(`  Tag/spec: ${theme.muted(preview.tag)}`);
  if (preview.currentVersion) {
    defaultRuntime.log(`  Current version: ${theme.muted(preview.currentVersion)}`);
  }
  if (preview.targetVersion) {
    defaultRuntime.log(`  Target version: ${theme.muted(preview.targetVersion)}`);
  }
  if (preview.downgradeRisk) {
    defaultRuntime.log(theme.warn("  Downgrade confirmation would be required in a real run."));
  }

  defaultRuntime.log("");
  defaultRuntime.log(theme.heading("Planned actions:"));
  for (const action of preview.actions) {
    defaultRuntime.log(`  - ${action}`);
  }

  if (preview.notes.length > 0) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Notes:"));
    for (const note of preview.notes) {
      defaultRuntime.log(`  - ${theme.muted(note)}`);
    }
  }
}

async function refreshGatewayServiceEnv(params: {
  root?: string;
  jsonMode: boolean;
}): Promise<GatewayServiceRefreshResult> {
  const args = ["gateway", "install", "--force"];
  if (params.jsonMode) {
    args.push("--json");
  }

  const failures: GatewayServiceRefreshFailure[] = [];
  for (const candidate of resolveGatewayInstallEntrypointCandidates(params.root)) {
    if (!(await pathExists(candidate))) {
      continue;
    }
    const res = await runCommandWithTimeout([resolveNodeRunner(), candidate, ...args], {
      cwd: params.root,
      timeoutMs: SERVICE_REFRESH_TIMEOUT_MS,
    });
    if (res.code === 0) {
      return { status: "updated-entrypoint", failures };
    }
    failures.push({
      candidate,
      detail: formatCommandFailure(res.stdout, res.stderr),
    });
  }

  try {
    await runDaemonInstall({ force: true, json: params.jsonMode || undefined });
    return { status: "daemon-install-fallback", failures };
  } catch (err) {
    throw new GatewayServiceRefreshError({
      failures,
      fallbackDetail: String(err),
      repairCommand: replaceCliName(
        `${formatCliCommand("fased gateway install --force", {})} && ${formatCliCommand("fased gateway restart", {})}`,
        CLI_NAME,
      ),
    });
  }
}

async function tryInstallShellCompletion(opts: {
  jsonMode: boolean;
  skipPrompt: boolean;
}): Promise<void> {
  if (opts.jsonMode || !process.stdin.isTTY) {
    return;
  }

  const status = await checkShellCompletionStatus(CLI_NAME);

  if (status.usesSlowPattern) {
    defaultRuntime.log(theme.muted("Upgrading shell completion to cached version..."));
    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME);
    if (cacheGenerated) {
      await installCompletion(status.shell, true, CLI_NAME);
    }
    return;
  }

  if (status.profileInstalled && !status.cacheExists) {
    defaultRuntime.log(theme.muted("Regenerating shell completion cache..."));
    await ensureCompletionCacheExists(CLI_NAME);
    return;
  }

  if (!status.profileInstalled) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Shell completion"));

    const shouldInstall = opts.skipPrompt
      ? true
      : await confirm({
          message: stylePromptMessage(`Enable ${status.shell} shell completion for ${CLI_NAME}?`),
          initialValue: true,
        });

    if (isCancel(shouldInstall) || !shouldInstall) {
      if (!opts.skipPrompt) {
        defaultRuntime.log(
          theme.muted(
            `Skipped. Run \`${replaceCliName(formatCliCommand("fased completion --install"), CLI_NAME)}\` later to enable.`,
          ),
        );
      }
      return;
    }

    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME);
    if (!cacheGenerated) {
      defaultRuntime.log(theme.warn("Failed to generate completion cache."));
      return;
    }

    await installCompletion(status.shell, opts.skipPrompt, CLI_NAME);
  }
}

async function runPackageInstallUpdate(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  tag: string;
  timeoutMs: number;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
}): Promise<UpdateRunResult> {
  const manager = await resolveGlobalManager({
    root: params.root,
    installKind: params.installKind,
    timeoutMs: params.timeoutMs,
  });
  const runCommand = createGlobalCommandRunner();

  const pkgRoot = await resolveGlobalPackageRoot(manager, runCommand, params.timeoutMs);
  const packageName =
    (pkgRoot ? await readPackageName(pkgRoot) : await readPackageName(params.root)) ??
    DEFAULT_PACKAGE_NAME;

  const beforeVersion = pkgRoot ? await readPackageVersion(pkgRoot) : null;
  if (pkgRoot) {
    await cleanupGlobalRenameDirs({
      globalRoot: resolveNodeModulesRootForPackageRoot(pkgRoot),
      packageName,
    });
  }

  const updateStep = await runUpdateStep({
    name: "global update",
    argv: globalInstallArgs(manager, `${packageName}@${params.tag}`),
    timeoutMs: params.timeoutMs,
    progress: params.progress,
  });

  const steps = [updateStep];
  let afterVersion = beforeVersion;

  if (pkgRoot) {
    afterVersion = await readPackageVersion(pkgRoot);
    const entryPath = path.join(pkgRoot, "dist", "entry.js");
    if (await pathExists(entryPath)) {
      const doctorStep = await runUpdateStep({
        name: `${CLI_NAME} doctor`,
        argv: [resolveNodeRunner(), entryPath, "doctor", "--non-interactive"],
        timeoutMs: params.timeoutMs,
        progress: params.progress,
      });
      steps.push(doctorStep);
    }
  }

  const expectedVersion = params.tag.trim().replace(/^v/, "");
  if (
    pkgRoot &&
    compareSemverStrings(expectedVersion, expectedVersion) === 0 &&
    compareSemverStrings(afterVersion, expectedVersion) !== 0
  ) {
    steps.push({
      name: "version verify",
      command: `verify ${packageName}@${expectedVersion}`,
      cwd: pkgRoot,
      durationMs: 0,
      exitCode: 1,
      stderrTail: `expected ${expectedVersion}, found ${afterVersion ?? "unknown"}`,
    });
  }

  const failedStep = steps.find((step) => step.exitCode !== 0);
  return {
    status: failedStep ? "error" : "ok",
    mode: manager,
    root: pkgRoot ?? params.root,
    reason: failedStep ? failedStep.name : undefined,
    before: { version: beforeVersion },
    after: { version: afterVersion },
    steps,
    durationMs: Date.now() - params.startedAt,
  };
}

async function runGitUpdate(params: {
  root: string;
  switchToGit: boolean;
  installKind: "git" | "package" | "unknown";
  timeoutMs: number | undefined;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
  channel: "stable" | "beta" | "dev";
  tag: string;
  showProgress: boolean;
  opts: UpdateCommandOptions;
  stop: () => void;
}): Promise<UpdateRunResult> {
  const updateRoot = params.switchToGit ? resolveGitInstallDir() : params.root;
  const effectiveTimeout = params.timeoutMs ?? 20 * 60_000;

  const cloneStep = params.switchToGit
    ? await ensureGitCheckout({
        dir: updateRoot,
        timeoutMs: effectiveTimeout,
        progress: params.progress,
      })
    : null;

  if (cloneStep && cloneStep.exitCode !== 0) {
    const result: UpdateRunResult = {
      status: "error",
      mode: "git",
      root: updateRoot,
      reason: cloneStep.name,
      steps: [cloneStep],
      durationMs: Date.now() - params.startedAt,
    };
    params.stop();
    printResult(result, { ...params.opts, hideSteps: params.showProgress });
    defaultRuntime.exit(1);
    return result;
  }

  const updateResult = await runGatewayUpdate({
    cwd: updateRoot,
    argv1: params.switchToGit ? undefined : process.argv[1],
    timeoutMs: params.timeoutMs,
    progress: params.progress,
    channel: params.channel,
    tag: params.tag,
    allowDevFallback: Boolean(params.opts.safeFallback),
  });
  const steps = [...(cloneStep ? [cloneStep] : []), ...updateResult.steps];

  if (params.switchToGit && updateResult.status === "ok") {
    const manager = await resolveGlobalManager({
      root: params.root,
      installKind: params.installKind,
      timeoutMs: effectiveTimeout,
    });
    const installStep = await runUpdateStep({
      name: "global install",
      argv: globalInstallArgs(manager, updateRoot),
      cwd: updateRoot,
      timeoutMs: effectiveTimeout,
      progress: params.progress,
    });
    steps.push(installStep);

    const failedStep = installStep.exitCode !== 0 ? installStep : null;
    return {
      ...updateResult,
      status: updateResult.status === "ok" && !failedStep ? "ok" : "error",
      steps,
      durationMs: Date.now() - params.startedAt,
    };
  }

  return {
    ...updateResult,
    steps,
    durationMs: Date.now() - params.startedAt,
  };
}

async function updatePluginsAfterCoreUpdate(params: {
  root: string;
  channel: "stable" | "beta" | "dev";
  targetVersion?: string;
  configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  opts: UpdateCommandOptions;
}): Promise<{ changed: boolean; checked: boolean }> {
  if (!params.configSnapshot.valid) {
    if (!params.opts.json) {
      defaultRuntime.log(theme.warn("Skipping plugin updates: config is invalid."));
    }
    return { changed: false, checked: false };
  }

  const repairResult = runPostUpdateDoctorRepair({
    config: params.configSnapshot.config,
    updateCompleted: true,
  });
  let pluginConfig = repairResult.config;
  let installedOpenAIRuntime = false;
  if (hasConfiguredOpenAICodexProfile(pluginConfig)) {
    const runtimeComponent = await ensureOpenAICodexRuntimeComponent({
      config: pluginConfig,
      version: params.targetVersion,
    });
    pluginConfig = runtimeComponent.config;
    installedOpenAIRuntime = runtimeComponent.installed;
    if (runtimeComponent.installed && !params.opts.json) {
      defaultRuntime.log(
        theme.muted(
          "Installed the managed OpenAI sign-in runtime required by the existing ChatGPT credential.",
        ),
      );
    }
    for (const warning of runtimeComponent.slotWarnings) {
      if (!params.opts.json) {
        defaultRuntime.log(theme.warn(warning));
      }
    }
  }

  const installs = pluginConfig.plugins?.installs ?? {};
  if (Object.keys(installs).length === 0) {
    if (repairResult.changed || installedOpenAIRuntime) {
      await writeConfigFile(pluginConfig);
    }
    return {
      changed: repairResult.changed || installedOpenAIRuntime,
      checked: installedOpenAIRuntime,
    };
  }

  const pluginLogger = params.opts.json
    ? {}
    : {
        info: (msg: string) => defaultRuntime.log(msg),
        warn: (msg: string) => defaultRuntime.log(theme.warn(msg)),
        error: (msg: string) => defaultRuntime.log(theme.error(msg)),
      };

  if (!params.opts.json) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Updating plugins..."));
  }

  const syncResult = await syncPluginsForUpdateChannel({
    config: pluginConfig,
    channel: params.channel,
    workspaceDir: params.root,
    logger: pluginLogger,
  });
  pluginConfig = syncResult.config;

  const npmResult = await updateNpmInstalledPlugins({
    config: pluginConfig,
    skipIds: new Set([
      ...syncResult.summary.switchedToNpm,
      ...(installedOpenAIRuntime ? [OPENAI_RUNTIME_COMPONENT_ID] : []),
    ]),
    updateChannel: params.channel,
    logger: pluginLogger,
  });
  pluginConfig = npmResult.config;

  if (repairResult.changed || installedOpenAIRuntime || syncResult.changed || npmResult.changed) {
    await writeConfigFile(pluginConfig);
  }

  if (params.opts.json) {
    return {
      changed:
        repairResult.changed || installedOpenAIRuntime || syncResult.changed || npmResult.changed,
      checked: true,
    };
  }

  const summarizeList = (list: string[]) => {
    if (list.length <= 6) {
      return list.join(", ");
    }
    return `${list.slice(0, 6).join(", ")} +${list.length - 6} more`;
  };

  if (syncResult.summary.switchedToBundled.length > 0) {
    defaultRuntime.log(
      theme.muted(
        `Switched to bundled plugins: ${summarizeList(syncResult.summary.switchedToBundled)}.`,
      ),
    );
  }
  if (syncResult.summary.switchedToNpm.length > 0) {
    defaultRuntime.log(
      theme.muted(`Restored npm plugins: ${summarizeList(syncResult.summary.switchedToNpm)}.`),
    );
  }
  for (const warning of syncResult.summary.warnings) {
    defaultRuntime.log(theme.warn(warning));
  }
  for (const error of syncResult.summary.errors) {
    defaultRuntime.log(theme.error(error));
  }
  for (const change of repairResult.changes) {
    defaultRuntime.log(theme.muted(change));
  }
  for (const warning of repairResult.warnings) {
    defaultRuntime.log(theme.warn(warning));
  }

  const updated = npmResult.outcomes.filter((entry) => entry.status === "updated").length;
  const unchanged = npmResult.outcomes.filter((entry) => entry.status === "unchanged").length;
  const failed = npmResult.outcomes.filter((entry) => entry.status === "error").length;
  const skipped = npmResult.outcomes.filter((entry) => entry.status === "skipped").length;

  if (npmResult.outcomes.length === 0) {
    defaultRuntime.log(theme.muted("No plugin updates needed."));
  } else {
    const parts = [`${updated} updated`, `${unchanged} unchanged`];
    if (failed > 0) {
      parts.push(`${failed} failed`);
    }
    if (skipped > 0) {
      parts.push(`${skipped} skipped`);
    }
    defaultRuntime.log(theme.muted(`npm plugins: ${parts.join(", ")}.`));
  }

  for (const outcome of npmResult.outcomes) {
    if (outcome.status !== "error") {
      continue;
    }
    defaultRuntime.log(theme.error(outcome.message));
  }
  return {
    changed:
      repairResult.changed || installedOpenAIRuntime || syncResult.changed || npmResult.changed,
    checked: true,
  };
}

async function maybeRestartService(params: {
  shouldRestart: boolean;
  result: UpdateRunResult;
  opts: UpdateCommandOptions;
  refreshServiceEnv: boolean;
  gatewayPort: number;
  restartScriptPath?: string | null;
  serviceTarget: UpdateGatewayServiceTarget;
  serviceLoaded: boolean;
  expectedVersion?: string | null;
  rpc: {
    url: string;
    token?: string;
    password?: string;
    tlsFingerprint?: string;
    timeoutMs: number;
  };
}): Promise<{
  partial: boolean;
  healthy: boolean;
  timings: UpdateLifecycleTiming[];
}> {
  let partial = false;
  const timings: UpdateLifecycleTiming[] = [];
  if (params.shouldRestart) {
    if (!params.opts.json) {
      defaultRuntime.log("");
      defaultRuntime.log(theme.heading("Restarting service..."));
    }

    try {
      let restarted = false;
      let restartInitiated = false;
      if (params.refreshServiceEnv) {
        try {
          const refresh = await measureUpdateStage(timings, "service environment refresh", () =>
            refreshGatewayServiceEnv({
              root: params.result.root,
              jsonMode: Boolean(params.opts.json),
            }),
          );
          if (
            refresh.status === "daemon-install-fallback" &&
            refresh.failures.length > 0 &&
            !params.opts.json
          ) {
            defaultRuntime.log(
              theme.warn(
                `Updated install refresh failed; repaired service with daemon installer fallback.${formatGatewayRefreshFailures(refresh.failures)}`,
              ),
            );
          }
        } catch (err) {
          partial = true;
          if (!params.opts.json) {
            const repairCommand =
              err instanceof GatewayServiceRefreshError
                ? err.repairCommand
                : replaceCliName(
                    `${formatCliCommand("fased gateway install --force", {})} && ${formatCliCommand("fased gateway restart", {})}`,
                    CLI_NAME,
                  );
            defaultRuntime.log(
              theme.warn(`Update installed, but gateway service repair failed: ${String(err)}`),
            );
            defaultRuntime.log(theme.muted(`Repair manually: ${repairCommand}`));
          }
        }
      }
      if (params.serviceTarget.scope === "system" && params.serviceLoaded) {
        await measureUpdateStage(timings, "service restart", () =>
          params.serviceTarget.service.restart({
            env: process.env,
            stdout: process.stdout,
          }),
        );
        restartInitiated = true;
      } else if (params.restartScriptPath) {
        await measureUpdateStage(timings, "service restart", () =>
          runRestartScript(params.restartScriptPath as string),
        );
        restartInitiated = true;
      } else if (params.serviceTarget.scope === "platform") {
        restarted = await measureUpdateStage(timings, "service restart", () => runDaemonRestart());
        restartInitiated = restarted;
      }

      if (restartInitiated) {
        let health = await measureUpdateStage(timings, "gateway health verification", () =>
          waitForGatewayHealthyRestart({
            service: params.serviceTarget.service,
            port: params.gatewayPort,
            rpc: params.rpc,
          }),
        );
        if (!health.healthy && health.staleGatewayPids.length > 0) {
          if (!params.opts.json) {
            defaultRuntime.log(
              theme.warn(
                `Found stale gateway process(es) after restart: ${health.staleGatewayPids.join(", ")}. Cleaning up...`,
              ),
            );
          }
          await measureUpdateStage(timings, "stale process cleanup", () =>
            terminateStaleGatewayPids(health.staleGatewayPids),
          );
          await measureUpdateStage(timings, "service recovery restart", () =>
            params.serviceTarget.service.restart({
              env: process.env,
              stdout: process.stdout,
            }),
          );
          health = await measureUpdateStage(timings, "gateway recovery verification", () =>
            waitForGatewayHealthyRestart({
              service: params.serviceTarget.service,
              port: params.gatewayPort,
              rpc: params.rpc,
            }),
          );
        }

        if (health.healthy && params.expectedVersion) {
          const identity = await measureUpdateStage(timings, "gateway version verification", () =>
            verifyGatewayRuntimeVersion({
              expectedVersion: params.expectedVersion as string,
              rpc: params.rpc,
            }),
          );
          if (!identity.ok) {
            health = { ...health, healthy: false };
            partial = true;
            if (!params.opts.json) {
              defaultRuntime.log(
                theme.warn(`Gateway runtime verification failed: ${identity.error}`),
              );
            }
          }
        }

        if (health.healthy) {
          if (!params.opts.json) {
            defaultRuntime.log(theme.success("Daemon restart completed."));
          }
        } else {
          partial = true;
          if (!params.opts.json) {
            defaultRuntime.log(theme.warn("Gateway did not become healthy after restart."));
            for (const line of renderRestartDiagnostics(health)) {
              defaultRuntime.log(theme.muted(line));
            }
            defaultRuntime.log(
              theme.muted(
                `Run \`${replaceCliName(formatCliCommand("fased gateway status --deep"), CLI_NAME)}\` for details.`,
              ),
            );
          }
        }
        if (!params.opts.json) {
          defaultRuntime.log("");
        }
      }

      if (!partial && restarted && !params.opts.json) {
        process.env.FASED_UPDATE_IN_PROGRESS = "1";
        try {
          const interactiveDoctor = Boolean(process.stdin.isTTY) && params.opts.yes !== true;
          await doctorCommand(defaultRuntime, {
            nonInteractive: !interactiveDoctor,
          });
        } catch (err) {
          defaultRuntime.log(theme.warn(`Doctor failed: ${String(err)}`));
        } finally {
          delete process.env.FASED_UPDATE_IN_PROGRESS;
        }
      }
    } catch (err) {
      partial = true;
      if (!params.opts.json) {
        defaultRuntime.log(theme.warn(`Daemon restart failed: ${String(err)}`));
        defaultRuntime.log(
          theme.muted(
            `You may need to restart the service manually: ${replaceCliName(formatCliCommand("fased gateway restart"), CLI_NAME)}`,
          ),
        );
      }
    }
    return { partial, healthy: !partial, timings };
  }

  if (!params.opts.json) {
    defaultRuntime.log("");
    if (params.result.mode === "npm" || params.result.mode === "pnpm") {
      defaultRuntime.log(
        theme.muted(
          `Tip: Run \`${replaceCliName(formatCliCommand("fased doctor"), CLI_NAME)}\`, then \`${replaceCliName(formatCliCommand("fased gateway restart"), CLI_NAME)}\` to apply updates to a running gateway.`,
        ),
      );
    } else {
      defaultRuntime.log(
        theme.muted(
          `Tip: Run \`${replaceCliName(formatCliCommand("fased gateway restart"), CLI_NAME)}\` to apply updates to a running gateway.`,
        ),
      );
    }
  }
  return { partial, healthy: true, timings };
}

export async function updateCommand(opts: UpdateCommandOptions): Promise<void> {
  const commandStartedAt = Date.now();
  suppressDeprecations();

  const timeoutMs = parseTimeoutMsOrExit(opts.timeout);
  const shouldRestart = opts.restart !== false;
  if (timeoutMs === null) {
    return;
  }

  const root = await resolveUpdateRoot();
  const updateStatus = await checkUpdateStatus({
    root,
    timeoutMs: timeoutMs ?? 3500,
    fetchGit: false,
    includeRegistry: false,
  });

  const configSnapshot = await readConfigFileSnapshot();
  const storedChannel = configSnapshot.valid
    ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
    : null;

  const requestedChannel = normalizeUpdateChannel(opts.channel);
  if (opts.channel && !requestedChannel) {
    defaultRuntime.error(`--channel must be "stable", "beta", or "dev" (got "${opts.channel}")`);
    defaultRuntime.exit(1);
    return;
  }
  if (opts.channel && !configSnapshot.valid) {
    defaultRuntime.error(formatInvalidUpdateChannelConfigMessage(configSnapshot));
    defaultRuntime.exit(1);
    return;
  }

  const installKind = updateStatus.installKind;
  if (installKind === "package" && !opts.dryRun && requestedChannel !== "dev") {
    try {
      const managed = await ensureManagedRuntimeBootstrap({
        packageRoot: root,
        env: process.env,
      });
      if (managed.updaterPath) {
        const managedArgs = [managed.updaterPath, "update"];
        if (opts.json) {
          managedArgs.push("--json");
        }
        if (opts.restart === false) {
          managedArgs.push("--no-restart");
        }
        if (opts.channel) {
          managedArgs.push("--channel", opts.channel);
        }
        if (opts.tag) {
          managedArgs.push("--tag", opts.tag);
        }
        if (opts.timeout) {
          managedArgs.push("--timeout", opts.timeout);
        }
        if (opts.yes) {
          managedArgs.push("--yes");
        }
        if (opts.safeFallback) {
          managedArgs.push("--safe-fallback");
        }
        const result = await runCommandWithTimeout([process.execPath, ...managedArgs], {
          cwd: path.dirname(managed.updaterPath),
          env: process.env,
          timeoutMs: timeoutMs ?? 20 * 60_000,
        });
        if (result.stdout) {
          process.stdout.write(result.stdout);
        }
        if (result.stderr) {
          process.stderr.write(result.stderr);
        }
        if (result.code !== 0) {
          defaultRuntime.exit(result.code ?? 1);
        } else {
          await recordUpdateSuccess({ mode: "managed" });
        }
        return;
      }
    } catch (error) {
      defaultRuntime.error(`Managed updater bootstrap failed: ${String(error)}`);
      defaultRuntime.exit(1);
      return;
    }
  }
  const switchToGit = requestedChannel === "dev" && installKind !== "git";
  const switchToPackage =
    requestedChannel !== null && requestedChannel !== "dev" && installKind === "git";
  const updateInstallKind = switchToGit ? "git" : switchToPackage ? "package" : installKind;
  const defaultChannel =
    updateInstallKind === "git" ? DEFAULT_GIT_CHANNEL : DEFAULT_PACKAGE_CHANNEL;
  const channel = requestedChannel ?? storedChannel ?? defaultChannel;
  const sourceSignerConfigured =
    installKind === "git" && (await isLocalSourceSignerConfigured(process.env));

  const explicitTag = normalizeTag(opts.tag);
  let tag = explicitTag ?? channelToNpmTag(channel);
  let installTag = tag;
  let currentVersion: string | null = null;
  let targetVersion: string | null = null;
  let downgradeRisk = false;
  let alreadyCurrent = false;
  let fallbackToLatest = false;

  if (updateInstallKind !== "git") {
    currentVersion = switchToPackage ? null : await readPackageVersion(root);
    targetVersion = explicitTag
      ? await resolveTargetVersion(tag, timeoutMs)
      : await resolveNpmChannelTag({ channel, timeoutMs }).then((resolved) => {
          tag = resolved.tag;
          fallbackToLatest = channel === "beta" && resolved.tag === "latest";
          return resolved.version;
        });
    const cmp =
      currentVersion && targetVersion ? compareSemverStrings(currentVersion, targetVersion) : null;
    alreadyCurrent = cmp === 0;
    downgradeRisk =
      !fallbackToLatest &&
      currentVersion != null &&
      (targetVersion == null || (cmp != null && cmp > 0));
    installTag = targetVersion ?? tag;
  }

  if (opts.dryRun) {
    let mode: UpdateRunResult["mode"] = "unknown";
    if (updateInstallKind === "git") {
      mode = "git";
    } else if (updateInstallKind === "package") {
      mode = await resolveGlobalManager({
        root,
        installKind,
        timeoutMs: timeoutMs ?? 20 * 60_000,
      });
    }

    const actions: string[] = [];
    if (requestedChannel && requestedChannel !== storedChannel) {
      actions.push(`Persist update.channel=${requestedChannel} in config`);
    }
    if (switchToGit) {
      actions.push("Switch install mode from package to git checkout (dev channel)");
    } else if (switchToPackage) {
      actions.push(`Switch install mode from git to package manager (${mode})`);
    } else if (updateInstallKind === "git") {
      actions.push(`Run git update flow on channel ${channel}`);
      if (channel === "dev") {
        actions.push(
          opts.safeFallback
            ? "Dev repair mode: try older main commits if the latest commit fails preflight"
            : "Dev mode: preflight only latest origin/main",
        );
      }
    } else {
      actions.push(
        `Run global package manager update with spec ${DEFAULT_PACKAGE_NAME}@${installTag}`,
      );
    }
    actions.push("Run plugin update sync after core update");
    actions.push("Refresh shell completion cache (if needed)");
    actions.push(
      shouldRestart
        ? "Restart gateway service and run doctor checks"
        : "Skip restart (because --no-restart is set)",
    );
    if (sourceSignerConfigured) {
      actions.push(
        "Snapshot the built source runtime, activate the exact version-matched native signer, and commit both only after Gateway and signer health",
      );
    }

    const notes: string[] = [];
    if (opts.tag && updateInstallKind === "git") {
      notes.push("--tag applies to npm installs only; git updates ignore it.");
    }
    if (fallbackToLatest) {
      notes.push("Beta channel resolves to latest for this run (fallback).");
    }

    printDryRunPreview(
      {
        dryRun: true,
        root,
        installKind,
        mode,
        updateInstallKind,
        switchToGit,
        switchToPackage,
        restart: shouldRestart,
        requestedChannel,
        storedChannel,
        effectiveChannel: channel,
        tag: installTag,
        currentVersion,
        targetVersion,
        downgradeRisk,
        actions,
        notes,
      },
      Boolean(opts.json),
    );
    return;
  }

  if (sourceSignerConfigured && switchToPackage) {
    defaultRuntime.error(
      "A source checkout with a Local signer cannot switch install modes inside one update transaction. Omit --channel to perform a tagged source update, or use the verified installer migration procedure.",
    );
    defaultRuntime.exit(1);
    return;
  }
  if (sourceSignerConfigured && channel === "dev") {
    defaultRuntime.error(
      "A Local signer can pair only with an exact tagged stable/beta source release; untagged dev commits fail closed.",
    );
    defaultRuntime.exit(1);
    return;
  }
  if (sourceSignerConfigured && !shouldRestart) {
    defaultRuntime.error(
      "A source checkout with a Local signer requires Gateway restart and exact health verification; --no-restart is not allowed.",
    );
    defaultRuntime.exit(1);
    return;
  }

  if (downgradeRisk && !opts.yes) {
    if (!process.stdin.isTTY || opts.json) {
      defaultRuntime.error(
        [
          "Downgrade confirmation required.",
          "Downgrading can break configuration. Re-run in a TTY to confirm.",
        ].join("\n"),
      );
      defaultRuntime.exit(1);
      return;
    }

    const targetLabel = targetVersion ?? `${tag} (unknown)`;
    const message = `Downgrading from ${currentVersion} to ${targetLabel} can break configuration. Continue?`;
    const ok = await confirm({
      message: stylePromptMessage(message),
      initialValue: false,
    });
    if (isCancel(ok) || !ok) {
      if (!opts.json) {
        defaultRuntime.log(theme.muted("Update cancelled."));
      }
      defaultRuntime.exit(0);
      return;
    }
  }

  if (updateInstallKind === "git" && opts.tag && !opts.json) {
    defaultRuntime.log(
      theme.muted("Note: --tag applies to npm installs only; git updates ignore it."),
    );
  }

  if (requestedChannel && configSnapshot.valid) {
    const next = {
      ...configSnapshot.config,
      update: {
        ...configSnapshot.config.update,
        channel: requestedChannel,
      },
    };
    await writeConfigFile(next);
    if (!opts.json) {
      defaultRuntime.log(theme.muted(`Update channel set to ${requestedChannel}.`));
    }
  }

  if (alreadyCurrent && currentVersion && targetVersion) {
    if (configSnapshot.valid && hasConfiguredOpenAICodexProfile(configSnapshot.config)) {
      try {
        const runtimeComponent = await ensureOpenAICodexRuntimeComponent({
          config: configSnapshot.config,
          version: targetVersion,
        });
        if (runtimeComponent.installed) {
          await writeConfigFile(runtimeComponent.config);
          if (!opts.json) {
            defaultRuntime.log(
              theme.muted(
                "Installed the version-matched OpenAI sign-in runtime required by the current release.",
              ),
            );
          }
        }
      } catch (error) {
        defaultRuntime.error(`OpenAI sign-in runtime update failed: ${String(error)}`);
        defaultRuntime.exit(1);
        return;
      }
    }
    const runningRuntime = await probeRunningGatewayRuntimeIdentity({ timeoutMs: 750 });
    const managedRuntimeSources = new Set(["managed-package", "packaged-runtime"]);
    const gatewayRuntimeNeedsRepair =
      runningRuntime.reachable &&
      (runningRuntime.version !== currentVersion ||
        !managedRuntimeSources.has(runningRuntime.runtimeSource ?? ""));
    if (gatewayRuntimeNeedsRepair) {
      if (!shouldRestart) {
        defaultRuntime.error(
          `Installed version is ${currentVersion}, but the running gateway reports ${runningRuntime.version ?? "an older runtime without identity"}. Re-run without --no-restart.`,
        );
        defaultRuntime.exit(1);
        return;
      }
      const serviceTarget = await resolveUpdateGatewayServiceTarget();
      const serviceLoaded = await serviceTarget.service.isLoaded({ env: process.env });
      if (!serviceLoaded) {
        defaultRuntime.error(
          `Installed version is ${currentVersion}, but a different unmanaged gateway is running. Stop it, then run ${formatCliCommand("fased gateway install --force")} and ${formatCliCommand("fased gateway restart")}.`,
        );
        defaultRuntime.exit(1);
        return;
      }
      if (!opts.json) {
        defaultRuntime.log(
          theme.warn(
            `Installed files are current, but gateway runtime is ${runningRuntime.version ?? "legacy/unknown"}. Refreshing the managed service...`,
          ),
        );
      }
      try {
        await refreshGatewayServiceEnv({
          root,
          jsonMode: Boolean(opts.json),
        });
      } catch (error) {
        const repairCommand =
          error instanceof GatewayServiceRefreshError
            ? error.repairCommand
            : `${formatCliCommand("fased gateway install --force")} && ${formatCliCommand("fased gateway restart")}`;
        defaultRuntime.error(`Gateway service refresh failed: ${String(error)}`);
        defaultRuntime.error(`Repair command: ${repairCommand}`);
        defaultRuntime.exit(1);
        return;
      }
      if (serviceTarget.scope === "system") {
        await serviceTarget.service.restart({ env: process.env, stdout: process.stdout });
      } else {
        const restarted = await runDaemonRestart();
        if (!restarted) {
          defaultRuntime.error("Gateway service restart did not start.");
          defaultRuntime.exit(1);
          return;
        }
      }

      const gatewayPort = resolveGatewayPort(
        configSnapshot.valid ? configSnapshot.config : undefined,
      );
      const gatewayConfig = configSnapshot.valid ? configSnapshot.config.gateway : undefined;
      const tlsRuntime = await loadGatewayTlsRuntime(gatewayConfig?.tls);
      const rpc = {
        url: `${tlsRuntime.enabled ? "wss" : "ws"}://127.0.0.1:${gatewayPort}`,
        token: gatewayConfig?.auth?.token,
        password: gatewayConfig?.auth?.password,
        tlsFingerprint: tlsRuntime.enabled ? tlsRuntime.fingerprintSha256 : undefined,
        timeoutMs: 1_500,
      };
      const health = await waitForGatewayHealthyRestart({
        service: serviceTarget.service,
        port: gatewayPort,
        rpc,
      });
      const identity = health.healthy
        ? await verifyGatewayRuntimeVersion({ expectedVersion: currentVersion, rpc })
        : { ok: false, actualVersion: null, error: "gateway did not become healthy" };
      if (!identity.ok) {
        defaultRuntime.error(`Gateway runtime refresh failed: ${identity.error}`);
        defaultRuntime.exit(1);
        return;
      }
      if (opts.json) {
        defaultRuntime.log(
          JSON.stringify(
            {
              status: "repaired",
              currentVersion,
              targetVersion,
              gatewayVersion: identity.actualVersion,
              channel,
            },
            null,
            2,
          ),
        );
      } else {
        defaultRuntime.log(`Gateway runtime refreshed: ${identity.actualVersion}`);
      }
      return;
    }
    if (opts.json) {
      defaultRuntime.log(
        JSON.stringify(
          {
            status: "current",
            currentVersion,
            targetVersion,
            channel,
          },
          null,
          2,
        ),
      );
    } else {
      defaultRuntime.log(`Already current: ${currentVersion}`);
    }
    return;
  }

  const showProgress = !opts.json && process.stdout.isTTY;
  if (!opts.json) {
    defaultRuntime.log(theme.heading("Updating FasedAgent..."));
    defaultRuntime.log("");
  }

  const { progress, stop } = createUpdateProgress(showProgress);
  const startedAt = Date.now();

  let restartScriptPath: string | null = null;
  let shouldRefreshGatewayServiceEnv = false;
  let serviceLoaded = false;
  const serviceTarget = await resolveUpdateGatewayServiceTarget();
  if (shouldRestart) {
    try {
      serviceLoaded = await serviceTarget.service.isLoaded({ env: process.env });
      if (serviceLoaded) {
        if (serviceTarget.scope === "platform") {
          restartScriptPath = await prepareRestartScript(process.env);
          shouldRefreshGatewayServiceEnv = true;
        }
      }
    } catch {
      // Ignore errors during pre-check; fallback to standard restart
    }
  }
  if (sourceSignerConfigured && !serviceLoaded) {
    try {
      await refreshGatewayServiceEnv({ root, jsonMode: Boolean(opts.json) });
      serviceLoaded = await serviceTarget.service.isLoaded({ env: process.env });
      if (!serviceLoaded) {
        throw new Error("the Local Gateway service is still not loaded");
      }
      if (serviceTarget.scope === "platform") {
        restartScriptPath = await prepareRestartScript(process.env);
      }
    } catch (error) {
      stop();
      defaultRuntime.error(
        `A paired source app/signer update requires a managed Local Gateway service: ${String(error)}. Run ${formatCliCommand("fased gateway install --force")}, then retry.`,
      );
      defaultRuntime.exit(1);
      return;
    }
  }

  const gatewayPort = resolveGatewayPort(configSnapshot.valid ? configSnapshot.config : undefined);
  const gatewayConfig = configSnapshot.valid ? configSnapshot.config.gateway : undefined;
  const tlsRuntime = await loadGatewayTlsRuntime(gatewayConfig?.tls);
  const restartRpc = {
    url: `${tlsRuntime.enabled ? "wss" : "ws"}://127.0.0.1:${gatewayPort}`,
    token: gatewayConfig?.auth?.token,
    password: gatewayConfig?.auth?.password,
    tlsFingerprint: tlsRuntime.enabled ? tlsRuntime.fingerprintSha256 : undefined,
    timeoutMs: 1_500,
  };
  const restoreSourcePairAfterFailure = async (
    journal: LocalSourcePairedUpdateJournal,
  ): Promise<boolean> => {
    await rollbackLocalSourcePairedUpdate({
      journal,
      timeoutMs: timeoutMs ?? 20 * 60_000,
      env: process.env,
    });
    if (!serviceLoaded) {
      return true;
    }
    const rollbackRestartScript =
      serviceTarget.scope === "platform" ? await prepareRestartScript(process.env) : null;
    const restored = await maybeRestartService({
      shouldRestart: true,
      result: {
        status: "ok",
        mode: "git",
        root: journal.sourceRoot,
        after: { version: journal.previous.version },
        steps: [],
        durationMs: 0,
      },
      opts,
      refreshServiceEnv: true,
      gatewayPort,
      restartScriptPath: rollbackRestartScript,
      serviceTarget,
      serviceLoaded,
      expectedVersion: journal.previous.version,
      rpc: restartRpc,
    });
    return restored.healthy;
  };

  let interruptedSourcePair: LocalSourcePairedUpdateJournal | null = null;
  if (installKind === "git") {
    try {
      interruptedSourcePair = await readLocalSourcePairedUpdateJournal(process.env);
    } catch (error) {
      stop();
      defaultRuntime.error(`Local source transaction journal is invalid: ${String(error)}`);
      defaultRuntime.exit(1);
      return;
    }
  }
  if (interruptedSourcePair) {
    try {
      const recovery = await recoverLocalSourcePairedUpdate({
        timeoutMs: timeoutMs ?? 20 * 60_000,
        env: process.env,
      });
      if (recovery === "rolled-back" && serviceLoaded) {
        const restored = await maybeRestartService({
          shouldRestart: true,
          result: {
            status: "ok",
            mode: "git",
            root: interruptedSourcePair.sourceRoot,
            after: { version: interruptedSourcePair.previous.version },
            steps: [],
            durationMs: 0,
          },
          opts,
          refreshServiceEnv: true,
          gatewayPort,
          restartScriptPath,
          serviceTarget,
          serviceLoaded,
          expectedVersion: interruptedSourcePair.previous.version,
          rpc: restartRpc,
        });
        if (!restored.healthy) {
          throw new Error("the previous Gateway did not become healthy after source recovery");
        }
        if (serviceTarget.scope === "platform") {
          restartScriptPath = await prepareRestartScript(process.env);
        }
      }
      if (!opts.json) {
        defaultRuntime.log(
          theme.muted(
            recovery === "committed"
              ? "Completed the previously verified Local source app/signer commit."
              : "Recovered the interrupted Local source app/signer transaction.",
          ),
        );
      }
    } catch (error) {
      stop();
      defaultRuntime.error(`Local source app/signer recovery failed: ${String(error)}`);
      defaultRuntime.exit(1);
      return;
    }
  }

  let sourcePair: LocalSourcePairedUpdateJournal | null = null;
  if (sourceSignerConfigured) {
    try {
      sourcePair = await prepareLocalSourcePairedUpdate({
        sourceRoot: root,
        timeoutMs: timeoutMs ?? 20 * 60_000,
        env: process.env,
      });
    } catch (error) {
      stop();
      defaultRuntime.error(`Could not prepare Local source rollback: ${String(error)}`);
      defaultRuntime.exit(1);
      return;
    }
  }

  const result = switchToPackage
    ? await runPackageInstallUpdate({
        root,
        installKind,
        tag: installTag,
        timeoutMs: timeoutMs ?? 20 * 60_000,
        startedAt,
        progress,
      })
    : await runGitUpdate({
        root,
        switchToGit,
        installKind,
        timeoutMs,
        startedAt,
        progress,
        channel,
        tag: installTag,
        showProgress,
        opts,
        stop,
      });

  if (sourcePair && result.status === "ok") {
    try {
      if (!result.after?.sha || !result.after.version) {
        throw new Error("source update did not report an exact target Git SHA and version");
      }
      sourcePair = await markLocalSourceAppActive({
        journal: sourcePair,
        targetSha: result.after.sha,
        targetVersion: result.after.version,
        env: process.env,
      });
      sourcePair = await activateLocalSourceSigner({
        journal: sourcePair,
        timeoutMs: timeoutMs ?? 20 * 60_000,
        env: process.env,
      });
    } catch (error) {
      try {
        await rollbackLocalSourcePairedUpdate({
          journal: sourcePair,
          timeoutMs: timeoutMs ?? 20 * 60_000,
          env: process.env,
        });
      } catch (rollbackError) {
        stop();
        defaultRuntime.error(
          `Local source signer activation failed and rollback is incomplete: ${String(error)}; ${String(rollbackError)}`,
        );
        defaultRuntime.exit(1);
        return;
      }
      stop();
      defaultRuntime.error(
        `Local source update restored the previous app and signer: ${String(error)}`,
      );
      defaultRuntime.exit(1);
      return;
    }
  } else if (sourcePair) {
    try {
      await rollbackLocalSourcePairedUpdate({
        journal: sourcePair,
        timeoutMs: timeoutMs ?? 20 * 60_000,
        env: process.env,
      });
    } catch (error) {
      stop();
      defaultRuntime.error(
        `Source update failed and exact rollback is incomplete: ${String(error)}`,
      );
      defaultRuntime.exit(1);
      return;
    }
    sourcePair = null;
  }

  stop();
  printResult(result, { ...opts, hideSteps: showProgress });

  if (result.status === "error") {
    defaultRuntime.exit(1);
    return;
  }

  if (result.status === "skipped") {
    if (result.reason === "dirty") {
      defaultRuntime.log(
        theme.warn(
          "Skipped: working directory has uncommitted changes. Commit or stash them first.",
        ),
      );
    }
    if (result.reason === "not-git-install") {
      defaultRuntime.log(
        theme.warn(
          `Skipped: this FasedAgent install isn't a git checkout, and the package manager couldn't be detected. Update via your package manager, then run \`${replaceCliName(formatCliCommand("fased doctor"), CLI_NAME)}\` and \`${replaceCliName(formatCliCommand("fased gateway restart"), CLI_NAME)}\`.`,
        ),
      );
      defaultRuntime.log(
        theme.muted(
          `Examples: \`${replaceCliName("npm i -g @fased/fased@latest", CLI_NAME)}\` or \`${replaceCliName("pnpm add -g @fased/fased@latest", CLI_NAME)}\``,
        ),
      );
    }
    defaultRuntime.exit(0);
    return;
  }

  const restartResult = await maybeRestartService({
    shouldRestart,
    result,
    opts,
    refreshServiceEnv: shouldRefreshGatewayServiceEnv,
    gatewayPort,
    restartScriptPath,
    serviceTarget,
    serviceLoaded,
    expectedVersion: result.after?.version ?? targetVersion,
    rpc: restartRpc,
  });

  if (!restartResult.healthy) {
    if (sourcePair) {
      if (!opts.json) {
        defaultRuntime.log(
          theme.warn("Gateway verification failed; restoring the exact source app and signer."),
        );
      }
      try {
        const restored = await restoreSourcePairAfterFailure(sourcePair);
        if (!restored) {
          defaultRuntime.error("Previous source Gateway was restored, but it is not healthy.");
        }
      } catch (error) {
        defaultRuntime.error(`Automatic source app/signer rollback failed: ${String(error)}`);
      }
    } else if (result.transaction) {
      if (!opts.json) {
        defaultRuntime.log(
          theme.warn("Gateway verification failed; restoring the previous runtime."),
        );
      }
      try {
        await rollbackUpdateTransaction(result.transaction);
        await serviceTarget.service.restart({ env: process.env, stdout: process.stdout });
        const rollbackHealth = await waitForGatewayHealthyRestart({
          service: serviceTarget.service,
          port: gatewayPort,
          rpc: restartRpc,
        });
        if (!rollbackHealth.healthy) {
          defaultRuntime.error("Previous runtime was restored, but the gateway is not healthy.");
        }
      } catch (error) {
        defaultRuntime.error(`Automatic runtime rollback failed: ${String(error)}`);
      }
    }
    defaultRuntime.exit(1);
    return;
  }

  if (sourcePair) {
    try {
      await verifyLocalSourceSigner({
        journal: sourcePair,
        timeoutMs: timeoutMs ?? 20 * 60_000,
        env: process.env,
      });
    } catch (error) {
      try {
        const restored = await restoreSourcePairAfterFailure(sourcePair);
        if (!restored) {
          throw new Error("the previous source Gateway did not become healthy", { cause: error });
        }
      } catch (rollbackError) {
        defaultRuntime.error(
          `Signer verification failed and exact source rollback is incomplete: ${String(error)}; ${String(rollbackError)}`,
        );
        defaultRuntime.exit(1);
        return;
      }
      defaultRuntime.error(
        `Signer verification failed; restored the previous source app and signer: ${String(error)}`,
      );
      defaultRuntime.exit(1);
      return;
    }
    try {
      sourcePair = await markLocalSourceGatewayVerified(sourcePair, process.env);
    } catch (error) {
      try {
        await restoreSourcePairAfterFailure(sourcePair);
      } catch (rollbackError) {
        defaultRuntime.error(
          `Could not record paired health and rollback is incomplete: ${String(error)}; ${String(rollbackError)}`,
        );
        defaultRuntime.exit(1);
        return;
      }
      defaultRuntime.error(`Could not durably record paired health: ${String(error)}`);
      defaultRuntime.exit(1);
      return;
    }
    try {
      await commitLocalSourcePairedUpdate({
        journal: sourcePair,
        timeoutMs: timeoutMs ?? 20 * 60_000,
        env: process.env,
      });
    } catch (error) {
      defaultRuntime.error(
        `The source Gateway and signer passed exact health, but commit cleanup is pending: ${String(error)}. Re-run fased update to finish forward recovery; do not downgrade manually.`,
      );
      defaultRuntime.exit(1);
      return;
    }
  }

  const lifecycleTimings = [...restartResult.timings];
  await measureUpdateStage(lifecycleTimings, "transaction cleanup", () =>
    finalizeUpdateTransaction(result.transaction),
  );

  const pluginResult = await measureUpdateStage(lifecycleTimings, "plugin updates", () =>
    updatePluginsAfterCoreUpdate({
      root,
      channel,
      targetVersion: result.after?.version ?? targetVersion ?? undefined,
      configSnapshot,
      opts,
    }),
  );
  if (!pluginResult.checked) {
    const timing = lifecycleTimings.at(-1);
    if (timing?.name === "plugin updates") {
      timing.name = "plugin update check (none installed)";
    }
  }

  await measureUpdateStage(lifecycleTimings, "shell completion", () =>
    tryInstallShellCompletion({
      jsonMode: Boolean(opts.json),
      skipPrompt: Boolean(opts.yes),
    }),
  );

  lifecycleTimings.push({
    name: "total command wall time",
    durationMs: Date.now() - commandStartedAt,
  });

  printUpdateLifecycleTimings(lifecycleTimings, Boolean(opts.json));

  if (!opts.json && !restartResult.partial) {
    defaultRuntime.log(theme.muted(pickUpdateQuip()));
  }
  if (!restartResult.partial) {
    await recordUpdateSuccess({
      mode: result.mode,
      version: result.after?.version ?? targetVersion,
    });
  }
}
