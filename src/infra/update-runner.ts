import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { type CommandOptions, runCommandWithTimeout } from "../process/exec.js";
import {
  resolveControlUiDistIndexHealth,
  resolveControlUiDistIndexPathForRoot,
} from "./control-ui-assets.js";
import { detectPackageManager as detectPackageManagerImpl } from "./detect-package-manager.js";
import { downloadHostedRuntimeArtifact } from "./hosted-runtime-artifact.js";
import { readPackageName, readPackageVersion } from "./package-json.js";
import { trimLogTail } from "./restart-sentinel.js";
import {
  channelToNpmTag,
  DEFAULT_GIT_CHANNEL,
  DEFAULT_PACKAGE_CHANNEL,
  DEV_BRANCH,
  isBetaTag,
  isStableTag,
  type UpdateChannel,
} from "./update-channels.js";
import { compareSemverStrings } from "./update-check.js";
import {
  cleanupGlobalRenameDirs,
  detectGlobalInstallManagerForRoot,
  globalInstallArgs,
  globalInstallFallbackArgs,
  type HostedNpmInstallTarget,
  resolveHostedNpmInstallTarget,
  resolveNodeModulesRootForPackageRoot,
} from "./update-global.js";

export type UpdateStepResult = {
  name: string;
  command: string;
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
};

export type UpdateRunStrategy =
  | {
      kind: "git";
      reason?: string;
    }
  | {
      kind: "hosted-artifact";
      reason?: string;
    }
  | {
      kind: "artifact-swap";
      reason?: string;
    }
  | {
      kind: "package-manager";
      reason?: string;
    }
  | {
      kind: "package-manager-fallback";
      reason?: string;
    }
  | {
      kind: "unknown";
      reason?: string;
    };

export type UpdateRunResult = {
  status: "ok" | "error" | "skipped";
  mode: "git" | "pnpm" | "bun" | "npm" | "unknown";
  strategy?: UpdateRunStrategy;
  root?: string;
  reason?: string;
  before?: { sha?: string | null; version?: string | null };
  after?: { sha?: string | null; version?: string | null };
  steps: UpdateStepResult[];
  durationMs: number;
};

type CommandRunner = (
  argv: string[],
  options: CommandOptions,
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

type PackageRuntimeMeta = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

type PackageMeta = PackageRuntimeMeta & {
  name?: string;
  version?: string;
};

type HostedArtifactUpdateResult =
  | {
      kind: "updated";
      steps: UpdateStepResult[];
      afterVersion: string | null;
    }
  | {
      kind: "fallback";
      steps: UpdateStepResult[];
      reason: string;
    }
  | {
      kind: "error";
      steps: UpdateStepResult[];
      reason: string;
      afterVersion: string | null;
    };

export type UpdateStepInfo = {
  name: string;
  command: string;
  cwd: string;
  index: number;
  total: number;
};

export type UpdateStepCompletion = UpdateStepInfo & {
  durationMs: number;
  exitCode: number | null;
  stderrTail?: string | null;
};

export type UpdateStepProgress = {
  onStepStart?: (step: UpdateStepInfo) => void;
  onStepComplete?: (step: UpdateStepCompletion) => void;
};

type UpdateRunnerOptions = {
  cwd?: string;
  argv1?: string;
  tag?: string;
  channel?: UpdateChannel;
  allowDevFallback?: boolean;
  timeoutMs?: number;
  runCommand?: CommandRunner;
  progress?: UpdateStepProgress;
  hostedReleaseFetch?: typeof fetch | null;
  hostedReleaseBaseUrl?: string;
};

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const MAX_LOG_CHARS = 8000;
const PREFLIGHT_MAX_COMMITS = 10;
const START_DIRS = ["cwd", "argv1", "process"];
const DEFAULT_PACKAGE_NAME = "@fased/fased";
const LEGACY_PACKAGE_NAME = "fased";
const CORE_PACKAGE_NAMES = new Set([LEGACY_PACKAGE_NAME, DEFAULT_PACKAGE_NAME]);
const DEV_PREFLIGHT_LINT_OPT_IN_ENV = "FASED_UPDATE_PREFLIGHT_LINT";

function normalizeDir(value?: string | null) {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return path.resolve(trimmed);
}

function resolveNodeModulesBinPackageRoot(argv1: string): string | null {
  const normalized = path.resolve(argv1);
  const parts = normalized.split(path.sep);
  const binIndex = parts.lastIndexOf(".bin");
  if (binIndex <= 0) {
    return null;
  }
  if (parts[binIndex - 1] !== "node_modules") {
    return null;
  }
  const binName = path.basename(normalized);
  const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
  return path.join(nodeModulesDir, binName);
}

function buildStartDirs(opts: UpdateRunnerOptions): string[] {
  const dirs: string[] = [];
  const cwd = normalizeDir(opts.cwd);
  if (cwd) {
    dirs.push(cwd);
  }
  const argv1 = normalizeDir(opts.argv1);
  if (argv1) {
    dirs.push(path.dirname(argv1));
    const packageRoot = resolveNodeModulesBinPackageRoot(argv1);
    if (packageRoot) {
      dirs.push(packageRoot);
    }
  }
  const proc = normalizeDir(process.cwd());
  if (proc) {
    dirs.push(proc);
  }
  return Array.from(new Set(dirs));
}

async function readBranchName(
  runCommand: CommandRunner,
  root: string,
  timeoutMs: number,
): Promise<string | null> {
  const res = await runCommand(["git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD"], {
    timeoutMs,
  }).catch(() => null);
  if (!res || res.code !== 0) {
    return null;
  }
  const branch = res.stdout.trim();
  return branch || null;
}

async function listGitTags(
  runCommand: CommandRunner,
  root: string,
  timeoutMs: number,
  pattern = "v*",
): Promise<string[]> {
  const res = await runCommand(["git", "-C", root, "tag", "--list", pattern, "--sort=-v:refname"], {
    timeoutMs,
  }).catch(() => null);
  if (!res || res.code !== 0) {
    return [];
  }
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function resolveChannelTag(
  runCommand: CommandRunner,
  root: string,
  timeoutMs: number,
  channel: Exclude<UpdateChannel, "dev">,
): Promise<string | null> {
  const tags = await listGitTags(runCommand, root, timeoutMs);
  if (channel === "beta") {
    const betaTag = tags.find((tag) => isBetaTag(tag)) ?? null;
    const stableTag = tags.find((tag) => isStableTag(tag)) ?? null;
    if (!betaTag) {
      return stableTag;
    }
    if (!stableTag) {
      return betaTag;
    }
    const cmp = compareSemverStrings(betaTag, stableTag);
    if (cmp != null && cmp < 0) {
      return stableTag;
    }
    return betaTag;
  }
  return tags.find((tag) => isStableTag(tag)) ?? null;
}

async function resolveGitRoot(
  runCommand: CommandRunner,
  candidates: string[],
  timeoutMs: number,
): Promise<string | null> {
  for (const dir of candidates) {
    const res = await runCommand(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
      timeoutMs,
    });
    if (res.code === 0) {
      const root = res.stdout.trim();
      if (root) {
        return root;
      }
    }
  }
  return null;
}

async function findPackageRoot(candidates: string[]) {
  for (const dir of candidates) {
    let current = dir;
    for (let i = 0; i < 12; i += 1) {
      const pkgPath = path.join(current, "package.json");
      try {
        const raw = await fs.readFile(pkgPath, "utf-8");
        const parsed = JSON.parse(raw) as { name?: string };
        const name = parsed?.name?.trim();
        if (name && CORE_PACKAGE_NAMES.has(name)) {
          return current;
        }
      } catch {
        // ignore
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return null;
}

async function detectPackageManager(root: string) {
  return (await detectPackageManagerImpl(root)) ?? "npm";
}

type RunStepOptions = {
  runCommand: CommandRunner;
  name: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  progress?: UpdateStepProgress;
  stepIndex: number;
  totalSteps: number;
};

async function runStep(opts: RunStepOptions): Promise<UpdateStepResult> {
  const { runCommand, name, argv, cwd, timeoutMs, env, progress, stepIndex, totalSteps } = opts;
  const command = argv.join(" ");

  const stepInfo: UpdateStepInfo = {
    name,
    command,
    cwd,
    index: stepIndex,
    total: totalSteps,
  };

  progress?.onStepStart?.(stepInfo);

  const started = Date.now();
  const result = await runCommand(argv, { cwd, timeoutMs, env });
  const durationMs = Date.now() - started;

  const stderrTail = trimLogTail(result.stderr, MAX_LOG_CHARS);

  progress?.onStepComplete?.({
    ...stepInfo,
    durationMs,
    exitCode: result.code,
    stderrTail,
  });

  return {
    name,
    command,
    cwd,
    durationMs,
    exitCode: result.code,
    stdoutTail: trimLogTail(result.stdout, MAX_LOG_CHARS),
    stderrTail: trimLogTail(result.stderr, MAX_LOG_CHARS),
  };
}

function managerScriptArgs(manager: "pnpm" | "bun" | "npm", script: string, args: string[] = []) {
  if (manager === "pnpm") {
    return ["pnpm", script, ...args];
  }
  if (manager === "bun") {
    return ["bun", "run", script, ...args];
  }
  if (args.length > 0) {
    return ["npm", "run", script, "--", ...args];
  }
  return ["npm", "run", script];
}

function managerInstallArgs(manager: "pnpm" | "bun" | "npm") {
  if (manager === "pnpm") {
    return ["pnpm", "install"];
  }
  if (manager === "bun") {
    return ["bun", "install"];
  }
  return ["npm", "install"];
}

function shouldRunDevPreflightLint(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[DEV_PREFLIGHT_LINT_OPT_IN_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function isDiscardedPreflightCandidateFailure(step: UpdateStepResult): boolean {
  return (
    step.exitCode !== 0 &&
    (step.name.startsWith("preflight checkout ") ||
      step.name.startsWith("preflight deps install ") ||
      step.name.startsWith("preflight build:app ") ||
      step.name.startsWith("preflight lint "))
  );
}

function normalizeTag(tag?: string) {
  const trimmed = tag?.trim();
  if (!trimmed) {
    return "latest";
  }
  if (trimmed.startsWith(`${LEGACY_PACKAGE_NAME}@`)) {
    return trimmed.slice(`${LEGACY_PACKAGE_NAME}@`.length);
  }
  if (trimmed.startsWith(`${DEFAULT_PACKAGE_NAME}@`)) {
    return trimmed.slice(`${DEFAULT_PACKAGE_NAME}@`.length);
  }
  return trimmed;
}

function normalizeVersionSpec(tag: string): string | null {
  const cleaned = tag.trim().replace(/^v/, "");
  return compareSemverStrings(cleaned, cleaned) === 0 ? cleaned : null;
}

async function readPackageMeta(root: string): Promise<PackageMeta | null> {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
    return JSON.parse(raw) as PackageMeta;
  } catch {
    return null;
  }
}

function normalizeRuntimeMeta(meta: PackageMeta | null): PackageRuntimeMeta {
  return {
    dependencies: meta?.dependencies ?? {},
    optionalDependencies: meta?.optionalDependencies ?? {},
    peerDependencies: meta?.peerDependencies ?? {},
  };
}

function runtimeDependencyMetaChanged(before: PackageMeta | null, after: PackageMeta | null) {
  return (
    JSON.stringify(normalizeRuntimeMeta(before)) !== JSON.stringify(normalizeRuntimeMeta(after))
  );
}

async function listTgzFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
    .map((entry) => path.join(dir, entry.name))
    .toSorted();
}

async function safeRemove(pathname: string): Promise<void> {
  await fs.rm(pathname, { recursive: true, force: true }).catch(() => undefined);
}

async function swapPackageRoot(params: {
  pkgRoot: string;
  artifactRoot: string;
}): Promise<{ backupRoot: string }> {
  const packageParent = path.dirname(params.pkgRoot);
  const backupRoot = path.join(
    packageParent,
    `.fased-backup-${Date.now()}-${path.basename(params.pkgRoot)}`,
  );

  try {
    await fs.rename(params.pkgRoot, backupRoot);
    await fs.rename(params.artifactRoot, params.pkgRoot);
    return { backupRoot };
  } catch (err) {
    await fs.rename(backupRoot, params.pkgRoot).catch(() => undefined);
    throw err;
  }
}

async function runHostedArtifactUpdate(params: {
  runCommand: CommandRunner;
  pkgRoot: string;
  packageName: string;
  expectedVersion: string;
  hostedTarget: HostedNpmInstallTarget;
  beforeMeta: PackageMeta | null;
  timeoutMs: number;
  progress?: UpdateStepProgress;
}): Promise<HostedArtifactUpdateResult> {
  const packageParent = path.dirname(params.pkgRoot);
  const tempRoot = await fs.mkdtemp(path.join(packageParent, ".fased-artifact-update-"));
  const steps: UpdateStepResult[] = [];
  let backupRoot: string | null = null;

  try {
    const spec = `${params.packageName}@${params.expectedVersion}`;
    const packStep = await runStep({
      runCommand: params.runCommand,
      name: "npm pack artifact",
      argv: [
        "npm",
        "pack",
        spec,
        "--pack-destination",
        tempRoot,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
      ],
      cwd: params.pkgRoot,
      timeoutMs: params.timeoutMs,
      env: { ...process.env, ...params.hostedTarget.env },
      progress: params.progress,
      stepIndex: 0,
      totalSteps: 1,
    });
    steps.push(packStep);
    if (packStep.exitCode !== 0) {
      return { kind: "fallback", steps, reason: "npm pack artifact failed" };
    }

    const tgzPath = (await listTgzFiles(tempRoot)).at(-1);
    if (!tgzPath) {
      steps.push({
        name: "artifact locate",
        command: `find ${tempRoot}/*.tgz`,
        cwd: params.pkgRoot,
        durationMs: 0,
        exitCode: 1,
        stderrTail: "npm pack produced no tgz artifact",
      });
      return { kind: "fallback", steps, reason: "npm pack produced no artifact" };
    }

    const extractDir = path.join(tempRoot, "extract");
    await fs.mkdir(extractDir, { recursive: true });
    const extractStarted = Date.now();
    try {
      await tar.x({ file: tgzPath, cwd: extractDir });
      steps.push({
        name: "artifact extract",
        command: `tar -xzf ${tgzPath}`,
        cwd: params.pkgRoot,
        durationMs: Date.now() - extractStarted,
        exitCode: 0,
      });
    } catch (err) {
      steps.push({
        name: "artifact extract",
        command: `tar -xzf ${tgzPath}`,
        cwd: params.pkgRoot,
        durationMs: Date.now() - extractStarted,
        exitCode: 1,
        stderrTail: String(err),
      });
      return { kind: "fallback", steps, reason: "artifact extract failed" };
    }

    const artifactRoot = path.join(extractDir, "package");
    const artifactMeta = await readPackageMeta(artifactRoot);
    const artifactVersion = artifactMeta?.version ?? null;
    if (compareSemverStrings(artifactVersion, params.expectedVersion) !== 0) {
      steps.push({
        name: "artifact version check",
        command: `verify ${params.packageName}@${params.expectedVersion}`,
        cwd: params.pkgRoot,
        durationMs: 0,
        exitCode: 1,
        stderrTail: `expected ${params.expectedVersion}, found ${artifactVersion ?? "unknown"}`,
      });
      return { kind: "fallback", steps, reason: "artifact version mismatch" };
    }

    const dependenciesChanged = runtimeDependencyMetaChanged(params.beforeMeta, artifactMeta);
    steps.push({
      name: "artifact dependency check",
      command: `compare package dependency metadata`,
      cwd: params.pkgRoot,
      durationMs: 0,
      exitCode: 0,
      stdoutTail: dependenciesChanged
        ? "dependency metadata changed; falling back to package manager"
        : "dependency metadata unchanged; using package artifact swap",
    });
    if (dependenciesChanged) {
      return {
        kind: "fallback",
        steps,
        reason: "runtime dependency metadata changed",
      };
    }

    const swapStarted = Date.now();
    try {
      const swapped = await swapPackageRoot({ pkgRoot: params.pkgRoot, artifactRoot });
      backupRoot = swapped.backupRoot;
      steps.push({
        name: "artifact swap",
        command: `replace ${params.pkgRoot}`,
        cwd: packageParent,
        durationMs: Date.now() - swapStarted,
        exitCode: 0,
      });
    } catch (err) {
      steps.push({
        name: "artifact swap",
        command: `replace ${params.pkgRoot}`,
        cwd: packageParent,
        durationMs: Date.now() - swapStarted,
        exitCode: 1,
        stderrTail: String(err),
      });
      return {
        kind: "error",
        steps,
        reason: "artifact swap",
        afterVersion: await readPackageVersion(params.pkgRoot),
      };
    }

    const afterVersion = await readPackageVersion(params.pkgRoot);
    return { kind: "updated", steps, afterVersion };
  } finally {
    if (backupRoot) {
      await safeRemove(backupRoot);
    }
    await safeRemove(tempRoot);
  }
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await fs.stat(pathname);
    return true;
  } catch {
    return false;
  }
}

async function runHostedReleaseArtifactUpdate(params: {
  fetchImpl: typeof fetch;
  baseUrl?: string;
  pkgRoot: string;
  expectedVersion: string;
  runCommand: CommandRunner;
  timeoutMs: number;
  progress?: UpdateStepProgress;
}): Promise<HostedArtifactUpdateResult> {
  const packageParent = path.dirname(params.pkgRoot);
  const tempRoot = await fs.mkdtemp(path.join(packageParent, ".fased-release-update-"));
  const steps: UpdateStepResult[] = [];
  let backupRoot: string | null = null;
  let progressIndex = 0;
  const totalSteps = 4;
  const startProgress = (name: string, command: string, cwd: string): UpdateStepInfo => {
    const info = { name, command, cwd, index: progressIndex, total: totalSteps };
    progressIndex += 1;
    params.progress?.onStepStart?.(info);
    return info;
  };
  const completeProgress = (info: UpdateStepInfo, step: UpdateStepResult): void => {
    steps.push(step);
    params.progress?.onStepComplete?.({
      ...info,
      durationMs: step.durationMs,
      exitCode: step.exitCode,
      stderrTail: step.stderrTail,
    });
  };

  try {
    const downloadCommand = `download hosted runtime v${params.expectedVersion}`;
    const downloadInfo = startProgress("hosted artifact download", downloadCommand, params.pkgRoot);
    const downloadStarted = Date.now();
    const download = await downloadHostedRuntimeArtifact({
      version: params.expectedVersion,
      destinationDir: tempRoot,
      fetchImpl: params.fetchImpl,
      baseUrl: params.baseUrl,
    });
    completeProgress(downloadInfo, {
      name: "hosted artifact download",
      command: downloadCommand,
      cwd: params.pkgRoot,
      durationMs: Date.now() - downloadStarted,
      exitCode: download.kind === "error" ? 1 : 0,
      ...(download.kind === "downloaded"
        ? { stdoutTail: `${download.descriptor.assetName} checksum verified` }
        : { stderrTail: download.reason }),
    });
    if (download.kind === "unavailable") {
      return { kind: "fallback", steps, reason: download.reason };
    }
    if (download.kind === "error") {
      return {
        kind: "error",
        steps,
        reason: download.reason,
        afterVersion: await readPackageVersion(params.pkgRoot),
      };
    }

    const extractDir = path.join(tempRoot, "extract");
    await fs.mkdir(extractDir, { recursive: true });
    const extractCommand = `extract ${download.descriptor.assetName}`;
    const extractInfo = startProgress("hosted artifact extract", extractCommand, params.pkgRoot);
    const extractStarted = Date.now();
    try {
      await tar.x({ file: download.archivePath, cwd: extractDir });
      completeProgress(extractInfo, {
        name: "hosted artifact extract",
        command: extractCommand,
        cwd: params.pkgRoot,
        durationMs: Date.now() - extractStarted,
        exitCode: 0,
      });
    } catch (error) {
      completeProgress(extractInfo, {
        name: "hosted artifact extract",
        command: extractCommand,
        cwd: params.pkgRoot,
        durationMs: Date.now() - extractStarted,
        exitCode: 1,
        stderrTail: String(error),
      });
      return {
        kind: "error",
        steps,
        reason: "hosted artifact extract failed",
        afterVersion: await readPackageVersion(params.pkgRoot),
      };
    }

    const artifactRoot = path.join(extractDir, "package");
    const artifactVersion = await readPackageVersion(artifactRoot);
    const runtimeShapeReady =
      compareSemverStrings(artifactVersion, params.expectedVersion) === 0 &&
      (await pathExists(path.join(artifactRoot, "fased.mjs"))) &&
      (await pathExists(path.join(artifactRoot, "node_modules")));
    const smokeHome = path.join(tempRoot, "smoke-home");
    const smokeStateDir = path.join(smokeHome, ".fased");
    const smokeArgv = [process.execPath, path.join(artifactRoot, "fased.mjs"), "plugins", "doctor"];
    const verifyCommand = smokeArgv.join(" ");
    const verifyInfo = startProgress("hosted artifact verify", verifyCommand, artifactRoot);
    const verifyStarted = Date.now();
    let smokeResult: Awaited<ReturnType<CommandRunner>> | null = null;
    let smokeError: string | null = null;
    if (runtimeShapeReady) {
      try {
        await fs.mkdir(smokeHome, { recursive: true });
        smokeResult = await params.runCommand(smokeArgv, {
          cwd: artifactRoot,
          timeoutMs: params.timeoutMs,
          env: {
            ...process.env,
            HOME: smokeHome,
            FASED_STATE_DIR: smokeStateDir,
            FASED_CONFIG_PATH: path.join(smokeStateDir, "fased.json"),
          },
        });
      } catch (error) {
        smokeError = String(error);
      }
    }
    const runtimeReady = runtimeShapeReady && smokeResult?.code === 0;
    const verifyFailure = !runtimeShapeReady
      ? `expected complete v${params.expectedVersion}, found ${artifactVersion ?? "unknown"}`
      : trimLogTail(
          [smokeResult?.stderr, smokeResult?.stdout, smokeError]
            .filter((value): value is string => Boolean(value?.trim()))
            .join("\n"),
          MAX_LOG_CHARS,
        ) || "hosted runtime CLI and plugin check failed";
    completeProgress(verifyInfo, {
      name: "hosted artifact verify",
      command: verifyCommand,
      cwd: artifactRoot,
      durationMs: Date.now() - verifyStarted,
      exitCode: runtimeReady ? 0 : 1,
      ...(runtimeReady
        ? { stdoutTail: `v${params.expectedVersion} CLI and bundled plugins passed` }
        : { stderrTail: verifyFailure }),
    });
    if (!runtimeReady) {
      return {
        kind: "error",
        steps,
        reason: "hosted artifact verification failed",
        afterVersion: await readPackageVersion(params.pkgRoot),
      };
    }

    const swapCommand = `replace ${params.pkgRoot}`;
    const swapInfo = startProgress("hosted artifact swap", swapCommand, packageParent);
    const swapStarted = Date.now();
    try {
      const swapped = await swapPackageRoot({ pkgRoot: params.pkgRoot, artifactRoot });
      backupRoot = swapped.backupRoot;
      completeProgress(swapInfo, {
        name: "hosted artifact swap",
        command: swapCommand,
        cwd: packageParent,
        durationMs: Date.now() - swapStarted,
        exitCode: 0,
      });
    } catch (error) {
      completeProgress(swapInfo, {
        name: "hosted artifact swap",
        command: swapCommand,
        cwd: packageParent,
        durationMs: Date.now() - swapStarted,
        exitCode: 1,
        stderrTail: String(error),
      });
      return {
        kind: "error",
        steps,
        reason: "hosted artifact swap failed",
        afterVersion: await readPackageVersion(params.pkgRoot),
      };
    }

    return {
      kind: "updated",
      steps,
      afterVersion: await readPackageVersion(params.pkgRoot),
    };
  } finally {
    if (backupRoot) {
      await safeRemove(backupRoot);
    }
    await safeRemove(tempRoot);
  }
}

export async function runGatewayUpdate(opts: UpdateRunnerOptions = {}): Promise<UpdateRunResult> {
  const startedAt = Date.now();
  const runCommand =
    opts.runCommand ??
    (async (argv, options) => {
      const res = await runCommandWithTimeout(argv, options);
      return { stdout: res.stdout, stderr: res.stderr, code: res.code };
    });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const progress = opts.progress;
  const steps: UpdateStepResult[] = [];
  const candidates = buildStartDirs(opts);

  let stepIndex = 0;
  let gitTotalSteps = 0;

  const step = (
    name: string,
    argv: string[],
    cwd: string,
    env?: NodeJS.ProcessEnv,
  ): RunStepOptions => {
    const currentIndex = stepIndex;
    stepIndex += 1;
    return {
      runCommand,
      name,
      argv,
      cwd,
      timeoutMs,
      env,
      progress,
      stepIndex: currentIndex,
      totalSteps: gitTotalSteps,
    };
  };

  const pkgRoot = await findPackageRoot(candidates);

  let gitRoot = await resolveGitRoot(runCommand, candidates, timeoutMs);
  if (gitRoot && pkgRoot && path.resolve(gitRoot) !== path.resolve(pkgRoot)) {
    gitRoot = null;
  }

  if (gitRoot && !pkgRoot) {
    return {
      status: "error",
      mode: "unknown",
      root: gitRoot,
      reason: "not-fased-root",
      steps: [],
      durationMs: Date.now() - startedAt,
    };
  }

  if (gitRoot && pkgRoot && path.resolve(gitRoot) === path.resolve(pkgRoot)) {
    // Get current SHA (not a visible step, no progress)
    const beforeShaResult = await runCommand(["git", "-C", gitRoot, "rev-parse", "HEAD"], {
      cwd: gitRoot,
      timeoutMs,
    });
    const beforeSha = beforeShaResult.stdout.trim() || null;
    const beforeVersion = await readPackageVersion(gitRoot);
    const channel: UpdateChannel = opts.channel ?? DEFAULT_GIT_CHANNEL;
    const branch = channel === "dev" ? await readBranchName(runCommand, gitRoot, timeoutMs) : null;
    const needsCheckoutMain = channel === "dev" && branch !== DEV_BRANCH;
    gitTotalSteps = channel === "dev" ? (needsCheckoutMain ? 11 : 10) : 9;
    const buildGitErrorResult = (reason: string): UpdateRunResult => ({
      status: "error",
      mode: "git",
      strategy: { kind: "git", reason: `${channel} channel` },
      root: gitRoot,
      reason,
      before: { sha: beforeSha, version: beforeVersion },
      steps,
      durationMs: Date.now() - startedAt,
    });
    const runGitCheckoutOrFail = async (name: string, argv: string[]) => {
      const checkoutStep = await runStep(step(name, argv, gitRoot));
      steps.push(checkoutStep);
      if (checkoutStep.exitCode !== 0) {
        return buildGitErrorResult("checkout-failed");
      }
      return null;
    };

    const statusCheck = await runStep(
      step(
        "clean check",
        ["git", "-C", gitRoot, "status", "--porcelain", "--", ":!dist/control-ui/"],
        gitRoot,
      ),
    );
    steps.push(statusCheck);
    const hasUncommittedChanges =
      statusCheck.stdoutTail && statusCheck.stdoutTail.trim().length > 0;
    if (hasUncommittedChanges) {
      return {
        status: "skipped",
        mode: "git",
        strategy: { kind: "git", reason: `${channel} channel` },
        root: gitRoot,
        reason: "dirty",
        before: { sha: beforeSha, version: beforeVersion },
        steps,
        durationMs: Date.now() - startedAt,
      };
    }

    if (channel === "dev") {
      if (needsCheckoutMain) {
        const failure = await runGitCheckoutOrFail(`git checkout ${DEV_BRANCH}`, [
          "git",
          "-C",
          gitRoot,
          "checkout",
          DEV_BRANCH,
        ]);
        if (failure) {
          return failure;
        }
      }

      const upstreamStep = await runStep(
        step(
          "upstream check",
          [
            "git",
            "-C",
            gitRoot,
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
          ],
          gitRoot,
        ),
      );
      steps.push(upstreamStep);
      if (upstreamStep.exitCode !== 0) {
        return {
          status: "skipped",
          mode: "git",
          strategy: { kind: "git", reason: `${channel} channel` },
          root: gitRoot,
          reason: "no-upstream",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const fetchStep = await runStep(
        step("git fetch", ["git", "-C", gitRoot, "fetch", "--all", "--prune", "--tags"], gitRoot),
      );
      steps.push(fetchStep);
      if (fetchStep.exitCode !== 0) {
        return {
          status: "error",
          mode: "git",
          strategy: { kind: "git", reason: `${channel} channel` },
          root: gitRoot,
          reason: "fetch-failed",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const upstreamShaStep = await runStep(
        step(
          "git rev-parse @{upstream}",
          ["git", "-C", gitRoot, "rev-parse", "@{upstream}"],
          gitRoot,
        ),
      );
      steps.push(upstreamShaStep);
      const upstreamSha = upstreamShaStep.stdoutTail?.trim();
      if (!upstreamShaStep.stdoutTail || !upstreamSha) {
        return {
          status: "error",
          mode: "git",
          strategy: { kind: "git", reason: `${channel} channel` },
          root: gitRoot,
          reason: "no-upstream-sha",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const preflightMaxCommits = opts.allowDevFallback ? PREFLIGHT_MAX_COMMITS : 1;
      const revListStep = await runStep(
        step(
          "git rev-list",
          ["git", "-C", gitRoot, "rev-list", `--max-count=${preflightMaxCommits}`, upstreamSha],
          gitRoot,
        ),
      );
      steps.push(revListStep);
      if (revListStep.exitCode !== 0) {
        return {
          status: "error",
          mode: "git",
          strategy: { kind: "git", reason: `${channel} channel` },
          root: gitRoot,
          reason: "preflight-revlist-failed",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const candidates = (revListStep.stdoutTail ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (candidates.length === 0) {
        return {
          status: "error",
          mode: "git",
          strategy: { kind: "git", reason: `${channel} channel` },
          root: gitRoot,
          reason: "preflight-no-candidates",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const manager = await detectPackageManager(gitRoot);
      const preflightRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fased-update-preflight-"));
      const worktreeDir = path.join(preflightRoot, "worktree");
      const worktreeStep = await runStep(
        step(
          "preflight worktree",
          ["git", "-C", gitRoot, "worktree", "add", "--detach", worktreeDir, upstreamSha],
          gitRoot,
        ),
      );
      steps.push(worktreeStep);
      if (worktreeStep.exitCode !== 0) {
        await fs.rm(preflightRoot, { recursive: true, force: true }).catch(() => {});
        return {
          status: "error",
          mode: "git",
          strategy: { kind: "git", reason: `${channel} channel` },
          root: gitRoot,
          reason: "preflight-worktree-failed",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      let selectedSha: string | null = null;
      try {
        for (const sha of candidates) {
          const shortSha = sha.slice(0, 8);
          const checkoutStep = await runStep(
            step(
              `preflight checkout (${shortSha})`,
              ["git", "-C", worktreeDir, "checkout", "--detach", sha],
              worktreeDir,
            ),
          );
          steps.push(checkoutStep);
          if (checkoutStep.exitCode !== 0) {
            continue;
          }

          const depsStep = await runStep(
            step(`preflight deps install (${shortSha})`, managerInstallArgs(manager), worktreeDir),
          );
          steps.push(depsStep);
          if (depsStep.exitCode !== 0) {
            continue;
          }

          const buildStep = await runStep(
            step(
              `preflight build:app (${shortSha})`,
              managerScriptArgs(manager, "build:app"),
              worktreeDir,
            ),
          );
          steps.push(buildStep);
          if (buildStep.exitCode !== 0) {
            continue;
          }

          if (shouldRunDevPreflightLint()) {
            const lintStep = await runStep(
              step(`preflight lint (${shortSha})`, managerScriptArgs(manager, "lint"), worktreeDir),
            );
            steps.push(lintStep);
            if (lintStep.exitCode !== 0) {
              continue;
            }
          }

          selectedSha = sha;
          break;
        }
      } finally {
        const removeStep = await runStep(
          step(
            "preflight cleanup",
            ["git", "-C", gitRoot, "worktree", "remove", "--force", worktreeDir],
            gitRoot,
          ),
        );
        steps.push(removeStep);
        await runCommand(["git", "-C", gitRoot, "worktree", "prune"], {
          cwd: gitRoot,
          timeoutMs,
        }).catch(() => null);
        await fs.rm(preflightRoot, { recursive: true, force: true }).catch(() => {});
      }

      if (!selectedSha) {
        return {
          status: "error",
          mode: "git",
          strategy: { kind: "git", reason: `${channel} channel` },
          root: gitRoot,
          reason: "preflight-no-good-commit",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const rebaseStep = await runStep(
        step("git rebase", ["git", "-C", gitRoot, "rebase", selectedSha], gitRoot),
      );
      steps.push(rebaseStep);
      if (rebaseStep.exitCode !== 0) {
        const abortResult = await runCommand(["git", "-C", gitRoot, "rebase", "--abort"], {
          cwd: gitRoot,
          timeoutMs,
        });
        steps.push({
          name: "git rebase --abort",
          command: "git rebase --abort",
          cwd: gitRoot,
          durationMs: 0,
          exitCode: abortResult.code,
          stdoutTail: trimLogTail(abortResult.stdout, MAX_LOG_CHARS),
          stderrTail: trimLogTail(abortResult.stderr, MAX_LOG_CHARS),
        });
        return {
          status: "error",
          mode: "git",
          strategy: { kind: "git", reason: `${channel} channel` },
          root: gitRoot,
          reason: "rebase-failed",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }
    } else {
      const fetchStep = await runStep(
        step("git fetch", ["git", "-C", gitRoot, "fetch", "--all", "--prune", "--tags"], gitRoot),
      );
      steps.push(fetchStep);
      if (fetchStep.exitCode !== 0) {
        return {
          status: "error",
          mode: "git",
          strategy: { kind: "git", reason: `${channel} channel` },
          root: gitRoot,
          reason: "fetch-failed",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const tag = await resolveChannelTag(runCommand, gitRoot, timeoutMs, channel);
      if (!tag) {
        return {
          status: "error",
          mode: "git",
          strategy: { kind: "git", reason: `${channel} channel` },
          root: gitRoot,
          reason: "no-release-tag",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const failure = await runGitCheckoutOrFail(`git checkout ${tag}`, [
        "git",
        "-C",
        gitRoot,
        "checkout",
        "--detach",
        tag,
      ]);
      if (failure) {
        return failure;
      }
    }

    const manager = await detectPackageManager(gitRoot);

    const depsStep = await runStep(step("deps install", managerInstallArgs(manager), gitRoot));
    steps.push(depsStep);
    if (depsStep.exitCode !== 0) {
      return {
        status: "error",
        mode: "git",
        strategy: { kind: "git", reason: `${channel} channel` },
        root: gitRoot,
        reason: "deps-install-failed",
        before: { sha: beforeSha, version: beforeVersion },
        steps,
        durationMs: Date.now() - startedAt,
      };
    }

    const buildStep = await runStep(
      step("build:app", managerScriptArgs(manager, "build:app"), gitRoot),
    );
    steps.push(buildStep);
    if (buildStep.exitCode !== 0) {
      return {
        status: "error",
        mode: "git",
        strategy: { kind: "git", reason: `${channel} channel` },
        root: gitRoot,
        reason: "build-app-failed",
        before: { sha: beforeSha, version: beforeVersion },
        steps,
        durationMs: Date.now() - startedAt,
      };
    }

    const doctorEntry = path.join(gitRoot, "fased.mjs");
    const doctorEntryExists = await fs
      .stat(doctorEntry)
      .then(() => true)
      .catch(() => false);
    if (!doctorEntryExists) {
      steps.push({
        name: "fased doctor entry",
        command: `verify ${doctorEntry}`,
        cwd: gitRoot,
        durationMs: 0,
        exitCode: 1,
        stderrTail: `missing ${doctorEntry}`,
      });
      return {
        status: "error",
        mode: "git",
        strategy: { kind: "git", reason: `${channel} channel` },
        root: gitRoot,
        reason: "doctor-entry-missing",
        before: { sha: beforeSha, version: beforeVersion },
        steps,
        durationMs: Date.now() - startedAt,
      };
    }

    // Use --fix so that doctor auto-strips unknown config keys introduced by
    // schema changes between versions, preventing a startup validation crash.
    const doctorArgv = [process.execPath, doctorEntry, "doctor", "--non-interactive", "--fix"];
    const doctorStep = await runStep(
      step("fased doctor", doctorArgv, gitRoot, { FASED_UPDATE_IN_PROGRESS: "1" }),
    );
    steps.push(doctorStep);

    const uiIndexHealth = await resolveControlUiDistIndexHealth({ root: gitRoot });
    if (!uiIndexHealth.exists) {
      const repairArgv = managerScriptArgs(manager, "ui:build");
      const started = Date.now();
      const repairResult = await runCommand(repairArgv, { cwd: gitRoot, timeoutMs });
      const repairStep: UpdateStepResult = {
        name: "ui:build (post-doctor repair)",
        command: repairArgv.join(" "),
        cwd: gitRoot,
        durationMs: Date.now() - started,
        exitCode: repairResult.code,
        stdoutTail: trimLogTail(repairResult.stdout, MAX_LOG_CHARS),
        stderrTail: trimLogTail(repairResult.stderr, MAX_LOG_CHARS),
      };
      steps.push(repairStep);

      if (repairResult.code !== 0) {
        return {
          status: "error",
          mode: "git",
          strategy: { kind: "git", reason: `${channel} channel` },
          root: gitRoot,
          reason: repairStep.name,
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }

      const repairedUiIndexHealth = await resolveControlUiDistIndexHealth({ root: gitRoot });
      if (!repairedUiIndexHealth.exists) {
        const uiIndexPath =
          repairedUiIndexHealth.indexPath ?? resolveControlUiDistIndexPathForRoot(gitRoot);
        steps.push({
          name: "ui assets verify",
          command: `verify ${uiIndexPath}`,
          cwd: gitRoot,
          durationMs: 0,
          exitCode: 1,
          stderrTail: `missing ${uiIndexPath}`,
        });
        return {
          status: "error",
          mode: "git",
          strategy: { kind: "git", reason: `${channel} channel` },
          root: gitRoot,
          reason: "ui-assets-missing",
          before: { sha: beforeSha, version: beforeVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }
    }

    const failedStep = steps.find(
      (s) => s.exitCode !== 0 && !isDiscardedPreflightCandidateFailure(s),
    );
    const afterShaStep = await runStep(
      step("git rev-parse HEAD (after)", ["git", "-C", gitRoot, "rev-parse", "HEAD"], gitRoot),
    );
    steps.push(afterShaStep);
    const afterVersion = await readPackageVersion(gitRoot);

    return {
      status: failedStep ? "error" : "ok",
      mode: "git",
      strategy: { kind: "git", reason: `${channel} channel` },
      root: gitRoot,
      reason: failedStep ? failedStep.name : undefined,
      before: { sha: beforeSha, version: beforeVersion },
      after: {
        sha: afterShaStep.stdoutTail?.trim() ?? null,
        version: afterVersion,
      },
      steps,
      durationMs: Date.now() - startedAt,
    };
  }

  if (!pkgRoot) {
    return {
      status: "error",
      mode: "unknown",
      strategy: { kind: "unknown", reason: "no Fased package root found" },
      reason: `no root (${START_DIRS.join(",")})`,
      steps: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const beforeVersion = await readPackageVersion(pkgRoot);
  const beforeMeta = await readPackageMeta(pkgRoot);
  const hostedTarget = resolveHostedNpmInstallTarget(pkgRoot);
  const globalManager =
    hostedTarget?.manager ??
    (await detectGlobalInstallManagerForRoot(runCommand, pkgRoot, timeoutMs));
  if (globalManager) {
    const packageName = (await readPackageName(pkgRoot)) ?? DEFAULT_PACKAGE_NAME;
    const globalEnv = hostedTarget?.env ? { ...process.env, ...hostedTarget.env } : undefined;
    await cleanupGlobalRenameDirs({
      globalRoot: hostedTarget?.globalRoot ?? resolveNodeModulesRootForPackageRoot(pkgRoot),
      packageName,
    });
    const channel = opts.channel ?? DEFAULT_PACKAGE_CHANNEL;
    const tag = normalizeTag(opts.tag ?? channelToNpmTag(channel));
    const spec = `${packageName}@${tag}`;
    const steps: UpdateStepResult[] = [];
    const expectedVersion = normalizeVersionSpec(tag);
    let artifactFallbackReason: string | null = null;

    if (hostedTarget && expectedVersion) {
      const releaseFetch =
        opts.hostedReleaseFetch === undefined ? globalThis.fetch : opts.hostedReleaseFetch;
      if (releaseFetch) {
        const releaseResult = await runHostedReleaseArtifactUpdate({
          fetchImpl: releaseFetch,
          baseUrl: opts.hostedReleaseBaseUrl ?? process.env.FASED_HOSTED_ARTIFACT_BASE_URL,
          pkgRoot,
          expectedVersion,
          runCommand,
          timeoutMs,
          progress,
        });
        steps.push(...releaseResult.steps);
        if (releaseResult.kind === "updated") {
          return {
            status: "ok",
            mode: globalManager,
            strategy: {
              kind: "hosted-artifact",
              reason: "verified self-contained hosted runtime",
            },
            root: pkgRoot,
            before: { version: beforeVersion },
            after: { version: releaseResult.afterVersion },
            steps,
            durationMs: Date.now() - startedAt,
          };
        }
        if (releaseResult.kind === "error") {
          return {
            status: "error",
            mode: globalManager,
            strategy: { kind: "hosted-artifact", reason: releaseResult.reason },
            root: pkgRoot,
            reason: releaseResult.reason,
            before: { version: beforeVersion },
            after: { version: releaseResult.afterVersion },
            steps,
            durationMs: Date.now() - startedAt,
          };
        }
        artifactFallbackReason = releaseResult.reason;
      }

      const artifactResult = await runHostedArtifactUpdate({
        runCommand,
        pkgRoot,
        packageName,
        expectedVersion,
        hostedTarget,
        beforeMeta,
        timeoutMs,
        progress,
      });
      steps.push(...artifactResult.steps);
      if (artifactResult.kind === "updated") {
        return {
          status: "ok",
          mode: globalManager,
          strategy: {
            kind: "artifact-swap",
            reason: "hosted install with unchanged runtime dependencies",
          },
          root: pkgRoot,
          before: { version: beforeVersion },
          after: { version: artifactResult.afterVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }
      if (artifactResult.kind === "error") {
        return {
          status: "error",
          mode: globalManager,
          strategy: { kind: "artifact-swap", reason: artifactResult.reason },
          root: pkgRoot,
          reason: artifactResult.reason,
          before: { version: beforeVersion },
          after: { version: artifactResult.afterVersion },
          steps,
          durationMs: Date.now() - startedAt,
        };
      }
      if (artifactResult.kind === "fallback") {
        artifactFallbackReason = artifactFallbackReason
          ? `${artifactFallbackReason}; ${artifactResult.reason}`
          : artifactResult.reason;
      }
    }

    const updateStep = await runStep({
      runCommand,
      name: "global update",
      argv: globalInstallArgs(globalManager, spec),
      cwd: pkgRoot,
      timeoutMs,
      env: globalEnv,
      progress,
      stepIndex: 0,
      totalSteps: 1,
    });
    steps.push(updateStep);

    let finalStep = updateStep;
    if (updateStep.exitCode !== 0) {
      const fallbackArgv = globalInstallFallbackArgs(globalManager, spec);
      if (fallbackArgv) {
        const fallbackStep = await runStep({
          runCommand,
          name: "global update (omit optional)",
          argv: fallbackArgv,
          cwd: pkgRoot,
          timeoutMs,
          env: globalEnv,
          progress,
          stepIndex: 0,
          totalSteps: 1,
        });
        steps.push(fallbackStep);
        finalStep = fallbackStep;
      }
    }

    const afterVersion = await readPackageVersion(pkgRoot);
    let versionVerifyStep: UpdateStepResult | null = null;
    if (
      finalStep.exitCode === 0 &&
      expectedVersion &&
      compareSemverStrings(afterVersion, expectedVersion) !== 0
    ) {
      versionVerifyStep = {
        name: "version verify",
        command: `verify ${packageName}@${expectedVersion}`,
        cwd: pkgRoot,
        durationMs: 0,
        exitCode: 1,
        stderrTail: `expected ${expectedVersion}, found ${afterVersion ?? "unknown"}`,
      };
      steps.push(versionVerifyStep);
    }
    const failedStep =
      finalStep.exitCode !== 0
        ? finalStep
        : versionVerifyStep?.exitCode !== 0
          ? versionVerifyStep
          : null;
    return {
      status: failedStep ? "error" : "ok",
      mode: globalManager,
      strategy: {
        kind: artifactFallbackReason ? "package-manager-fallback" : "package-manager",
        reason:
          artifactFallbackReason ??
          (hostedTarget
            ? expectedVersion
              ? "hosted artifact fast path not used"
              : "non-exact package target"
            : "global package install"),
      },
      root: pkgRoot,
      reason: failedStep?.name,
      before: { version: beforeVersion },
      after: { version: afterVersion },
      steps,
      durationMs: Date.now() - startedAt,
    };
  }

  return {
    status: "skipped",
    mode: "unknown",
    strategy: { kind: "unknown", reason: "package manager not detected" },
    root: pkgRoot,
    reason: "not-git-install",
    before: { version: beforeVersion },
    steps: [],
    durationMs: Date.now() - startedAt,
  };
}
