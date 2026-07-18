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
import {
  downloadHostedRuntimeArtifact,
  downloadHostedRuntimeDescriptor,
  resolveHostedRuntimeAppArtifact,
  resolveHostedRuntimeDependencyArtifact,
} from "./hosted-runtime-artifact.js";
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
  transaction?: UpdateTransaction;
  steps: UpdateStepResult[];
  durationMs: number;
};

export type UpdateTransaction = {
  kind: "package-root-swap";
  packageRoot: string;
  backupRoot: string;
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
      reason: string;
      transaction: UpdateTransaction;
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

type HostedRuntimeMetadata = {
  schemaVersion: 1;
  dependencyHash: string;
};

async function readControlUiBuildVersion(root: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(root, "dist", "control-ui", "version.json"), "utf8"),
    ) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

async function controlUiBuildMatches(root: string, expectedVersion: string): Promise<boolean> {
  return compareSemverStrings(await readControlUiBuildVersion(root), expectedVersion) === 0;
}

async function readHostedRuntimeMetadata(root: string): Promise<HostedRuntimeMetadata | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(root, ".fased-hosted-runtime.json"), "utf8"),
    ) as Partial<HostedRuntimeMetadata>;
    if (parsed.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(parsed.dependencyHash ?? "")) {
      return null;
    }
    return parsed as HostedRuntimeMetadata;
  } catch {
    return null;
  }
}

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
const SOURCE_RELEASE_REPOSITORY = "fased-ai/fased";
const SOURCE_RELEASE_WORKFLOW = "fased-ai/fased/.github/workflows/hosted-runtime-release.yml";

async function verifyAttestedSourceRelease(params: {
  tag: string;
  tagCommit: string;
  timeoutMs: number;
  runCommand: CommandRunner;
  fetchImpl: typeof fetch;
  baseUrl?: string;
}): Promise<UpdateStepResult> {
  const startedAt = Date.now();
  const version = params.tag.replace(/^v/u, "");
  const command = `verify attested source ${params.tag} at ${params.tagCommit}`;
  const cwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fased-source-attestation-"));
  try {
    const base =
      (params.baseUrl?.trim().replace(/\/+$/u, "") ||
        "https://github.com/fased-ai/fased/releases/download") + `/${params.tag}`;
    const manifestPath = path.join(tempRoot, "fased-hosted-release-v2.json");
    const bundlePath = `${manifestPath}.attestation.json`;
    for (const [name, destination] of [
      ["fased-hosted-release-v2.json", manifestPath],
      ["fased-hosted-release-v2.json.attestation.json", bundlePath],
    ] as const) {
      const response = await params.fetchImpl(`${base}/${name}`, { redirect: "follow" });
      if (!response.ok) {
        throw new Error(`release identity asset ${name} is unavailable (${response.status})`);
      }
      await fs.writeFile(destination, new Uint8Array(await response.arrayBuffer()), {
        mode: 0o600,
      });
    }
    const verification = await params.runCommand(
      [
        "gh",
        "attestation",
        "verify",
        manifestPath,
        "--repo",
        SOURCE_RELEASE_REPOSITORY,
        "--bundle",
        bundlePath,
        "--signer-workflow",
        SOURCE_RELEASE_WORKFLOW,
        "--source-ref",
        `refs/tags/${params.tag}`,
        "--deny-self-hosted-runners",
      ],
      {
        cwd: tempRoot,
        timeoutMs: params.timeoutMs,
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      },
    );
    if (verification.code !== 0) {
      throw new Error(verification.stderr.trim() || "GitHub attestation verification failed");
    }
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      schemaVersion?: unknown;
      release?: { version?: unknown; tag?: unknown; commit?: unknown };
      signer?: { release?: { version?: unknown; commit?: unknown; development?: unknown } };
    };
    if (
      manifest.schemaVersion !== 2 ||
      manifest.release?.version !== version ||
      manifest.release?.tag !== params.tag ||
      manifest.release?.commit !== params.tagCommit ||
      !/^[a-f0-9]{40}$/u.test(String(manifest.release?.commit ?? "")) ||
      manifest.signer?.release?.version !== version ||
      manifest.signer?.release?.commit !== params.tagCommit ||
      manifest.signer?.release?.development !== false
    ) {
      throw new Error("attested release does not bind the exact source tag, commit, and signer");
    }
    return {
      name: "source release attestation",
      command,
      cwd,
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      stdoutTail: `${params.tag} -> ${params.tagCommit}`,
    };
  } catch (error) {
    return {
      name: "source release attestation",
      command,
      cwd,
      durationMs: Date.now() - startedAt,
      exitCode: 1,
      stderrTail: String(error),
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

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

export async function finalizeUpdateTransaction(transaction?: UpdateTransaction): Promise<void> {
  if (!transaction) {
    return;
  }
  await safeRemove(transaction.backupRoot);
}

export async function rollbackUpdateTransaction(transaction?: UpdateTransaction): Promise<void> {
  if (!transaction) {
    return;
  }

  const failedRoot = `${transaction.packageRoot}.failed-${Date.now()}`;
  await fs.rename(transaction.packageRoot, failedRoot);
  try {
    await fs.rename(transaction.backupRoot, transaction.packageRoot);
  } catch (error) {
    await fs.rename(failedRoot, transaction.packageRoot).catch(() => undefined);
    throw error;
  }
  await safeRemove(failedRoot);
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
  let retainBackup = false;

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

    if (!(await controlUiBuildMatches(artifactRoot, params.expectedVersion))) {
      steps.push({
        name: "artifact UI version check",
        command: `verify dashboard build v${params.expectedVersion}`,
        cwd: artifactRoot,
        durationMs: 0,
        exitCode: 1,
        stderrTail: `expected dashboard v${params.expectedVersion}, found ${
          (await readControlUiBuildVersion(artifactRoot)) ?? "unknown"
        }`,
      });
      return {
        kind: "error",
        steps,
        reason: "artifact dashboard version mismatch",
        afterVersion: await readPackageVersion(params.pkgRoot),
      };
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
    retainBackup = true;
    return {
      kind: "updated",
      steps,
      afterVersion,
      reason: "package artifact swap",
      transaction: {
        kind: "package-root-swap",
        packageRoot: params.pkgRoot,
        backupRoot,
      },
    };
  } finally {
    if (backupRoot && !retainBackup) {
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

async function seedHostedDependencyLayerFromCurrent(params: {
  pkgRoot: string;
  dependencyRoot: string;
  dependencyHash: string;
}): Promise<boolean> {
  const currentMetadata = await readHostedRuntimeMetadata(params.pkgRoot);
  if (currentMetadata?.dependencyHash !== params.dependencyHash) {
    return false;
  }

  const currentModules = path.join(params.pkgRoot, "node_modules");
  const dependencyModules = path.join(params.dependencyRoot, "node_modules");
  let currentStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    currentStat = await fs.lstat(currentModules);
  } catch {
    return false;
  }

  if (currentStat.isSymbolicLink()) {
    try {
      const currentModulesReal = await fs.realpath(currentModules);
      if (currentModulesReal === (await fs.realpath(dependencyModules).catch(() => ""))) {
        return true;
      }
      const legacyDependencyRoot = path.dirname(currentModulesReal);
      const legacyDependencyParent = path.dirname(legacyDependencyRoot);
      const recognizedLegacyLayer =
        path.basename(currentModulesReal) === "node_modules" &&
        path.basename(legacyDependencyRoot) === params.dependencyHash &&
        path.basename(legacyDependencyParent) === ".fased-dependencies";
      if (!recognizedLegacyLayer) {
        return false;
      }

      const nextLink = path.join(params.pkgRoot, `.node_modules-link-${process.pid}-${Date.now()}`);
      const previousLink = path.join(
        params.pkgRoot,
        `.node_modules-previous-${process.pid}-${Date.now()}`,
      );
      let layerMoved = false;
      let linkReplaced = false;
      await fs.mkdir(path.dirname(params.dependencyRoot), { recursive: true });
      try {
        await fs.symlink(dependencyModules, nextLink, "dir");
        await fs.rename(legacyDependencyRoot, params.dependencyRoot);
        layerMoved = true;
        await fs.rename(currentModules, previousLink);
        await fs.rename(nextLink, currentModules);
        linkReplaced = true;
        await safeRemove(previousLink);
        return true;
      } catch (error) {
        if (linkReplaced) {
          await safeRemove(currentModules);
        }
        if (await pathExists(previousLink)) {
          await fs.rename(previousLink, currentModules).catch(() => undefined);
        }
        if (layerMoved) {
          await fs.rename(params.dependencyRoot, legacyDependencyRoot).catch(() => undefined);
        }
        await safeRemove(nextLink);
        throw error;
      }
    } catch {
      return false;
    }
  }
  if (!currentStat.isDirectory()) {
    return false;
  }

  const dependencyParent = path.dirname(params.dependencyRoot);
  const stagingRoot = `${params.dependencyRoot}.staging-${process.pid}-${Date.now()}`;
  const linkPath = path.join(params.pkgRoot, `.node_modules-link-${process.pid}-${Date.now()}`);
  let modulesMoved = false;
  let layerActivated = false;
  await fs.mkdir(dependencyParent, { recursive: true });
  if (await pathExists(params.dependencyRoot)) {
    await safeRemove(params.dependencyRoot);
  }

  try {
    await fs.symlink(dependencyModules, linkPath, "dir");
    await fs.mkdir(stagingRoot, { recursive: true });
    await fs.rename(currentModules, path.join(stagingRoot, "node_modules"));
    modulesMoved = true;
    await fs.rename(stagingRoot, params.dependencyRoot);
    layerActivated = true;
    await fs.rename(linkPath, currentModules);
    return true;
  } catch (error) {
    await safeRemove(linkPath);
    if (!(await pathExists(currentModules))) {
      const rollbackSource = path.join(
        layerActivated ? params.dependencyRoot : stagingRoot,
        "node_modules",
      );
      if (modulesMoved && (await pathExists(rollbackSource))) {
        await fs.rename(rollbackSource, currentModules).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    await safeRemove(stagingRoot);
  }
}

async function runHostedLayeredArtifactUpdate(params: {
  fetchImpl: typeof fetch;
  baseUrl?: string;
  pkgRoot: string;
  dependencyCacheRoot: string;
  expectedVersion: string;
  runCommand: CommandRunner;
  timeoutMs: number;
  progress?: UpdateStepProgress;
}): Promise<HostedArtifactUpdateResult> {
  const packageParent = path.dirname(params.pkgRoot);
  const tempRoot = await fs.mkdtemp(path.join(packageParent, ".fased-layered-update-"));
  const steps: UpdateStepResult[] = [];
  let backupRoot: string | null = null;
  let retainBackup = false;
  const record = async <T>(name: string, command: string, run: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    const info: UpdateStepInfo = {
      name,
      command,
      cwd: params.pkgRoot,
      index: steps.length,
      total: 6,
    };
    params.progress?.onStepStart?.(info);
    try {
      const result = await run();
      const step = {
        name,
        command,
        cwd: params.pkgRoot,
        durationMs: Date.now() - startedAt,
        exitCode: 0,
      } satisfies UpdateStepResult;
      steps.push(step);
      params.progress?.onStepComplete?.({ ...info, durationMs: step.durationMs, exitCode: 0 });
      return result;
    } catch (error) {
      const step = {
        name,
        command,
        cwd: params.pkgRoot,
        durationMs: Date.now() - startedAt,
        exitCode: 1,
        stderrTail: String(error),
      } satisfies UpdateStepResult;
      steps.push(step);
      params.progress?.onStepComplete?.({
        ...info,
        durationMs: step.durationMs,
        exitCode: 1,
        stderrTail: step.stderrTail,
      });
      throw error;
    }
  };

  try {
    const appDescriptor = resolveHostedRuntimeAppArtifact({
      version: params.expectedVersion,
      baseUrl: params.baseUrl,
    });
    const appDownload = await record(
      "hosted app download",
      `download hosted app v${params.expectedVersion}`,
      async () =>
        await downloadHostedRuntimeDescriptor({
          descriptor: appDescriptor,
          destinationDir: tempRoot,
          fetchImpl: params.fetchImpl,
        }),
    );
    if (appDownload.kind === "unavailable") {
      return { kind: "fallback", steps, reason: appDownload.reason };
    }
    if (appDownload.kind === "error") {
      return {
        kind: "error",
        steps,
        reason: appDownload.reason,
        afterVersion: await readPackageVersion(params.pkgRoot),
      };
    }

    const extractRoot = path.join(tempRoot, "app");
    await fs.mkdir(extractRoot, { recursive: true });
    await record("hosted app extract", `extract ${appDownload.descriptor.assetName}`, async () => {
      await tar.x({ file: appDownload.archivePath, cwd: extractRoot });
    });
    const artifactRoot = path.join(extractRoot, "package");
    const metadata = await readHostedRuntimeMetadata(artifactRoot);
    if (!metadata) {
      return { kind: "fallback", steps, reason: "hosted app dependency metadata missing" };
    }

    const dependencyParent = path.join(params.dependencyCacheRoot, "hosted-dependencies");
    const dependencyRoot = path.join(dependencyParent, metadata.dependencyHash);
    const dependencyModules = path.join(dependencyRoot, "node_modules");
    if (!(await pathExists(dependencyModules))) {
      const currentMetadata = await readHostedRuntimeMetadata(params.pkgRoot);
      if (currentMetadata?.dependencyHash === metadata.dependencyHash) {
        await record(
          "hosted dependency seed",
          `reuse current dependency layer ${metadata.dependencyHash.slice(0, 12)}`,
          async () =>
            await seedHostedDependencyLayerFromCurrent({
              pkgRoot: params.pkgRoot,
              dependencyRoot,
              dependencyHash: metadata.dependencyHash,
            }),
        );
      }
    }
    if (!(await pathExists(dependencyModules))) {
      const dependencyDescriptor = resolveHostedRuntimeDependencyArtifact({
        version: params.expectedVersion,
        dependencyHash: metadata.dependencyHash,
        baseUrl: params.baseUrl,
      });
      const dependencyDownload = await record(
        "hosted dependency download",
        `download dependency layer ${metadata.dependencyHash.slice(0, 12)}`,
        async () =>
          await downloadHostedRuntimeDescriptor({
            descriptor: dependencyDescriptor,
            destinationDir: tempRoot,
            fetchImpl: params.fetchImpl,
          }),
      );
      if (dependencyDownload.kind !== "downloaded") {
        return {
          kind: dependencyDownload.kind === "error" ? "error" : "fallback",
          steps,
          reason: dependencyDownload.reason,
          ...(dependencyDownload.kind === "error"
            ? { afterVersion: await readPackageVersion(params.pkgRoot) }
            : {}),
        } as HostedArtifactUpdateResult;
      }
      await fs.mkdir(dependencyParent, { recursive: true });
      const dependencyStaging = `${dependencyRoot}.staging-${process.pid}-${Date.now()}`;
      await fs.mkdir(dependencyStaging, { recursive: true });
      try {
        await record(
          "hosted dependency extract",
          `extract ${dependencyDownload.descriptor.assetName}`,
          async () => {
            await tar.x({ file: dependencyDownload.archivePath, cwd: dependencyStaging });
          },
        );
        if (!(await pathExists(path.join(dependencyStaging, "node_modules")))) {
          throw new Error("dependency layer did not contain node_modules");
        }
        await fs.rename(dependencyStaging, dependencyRoot).catch(async (error) => {
          if (!(await pathExists(dependencyModules))) {
            throw error;
          }
        });
      } finally {
        await safeRemove(dependencyStaging);
      }
    } else {
      steps.push({
        name: "hosted dependency reuse",
        command: `reuse ${metadata.dependencyHash}`,
        cwd: params.pkgRoot,
        durationMs: 0,
        exitCode: 0,
      });
    }

    await fs.symlink(dependencyModules, path.join(artifactRoot, "node_modules"), "dir");
    const artifactVersion = await readPackageVersion(artifactRoot);
    const runtimeShapeReady =
      compareSemverStrings(artifactVersion, params.expectedVersion) === 0 &&
      (await pathExists(path.join(artifactRoot, "fased.mjs"))) &&
      (await pathExists(path.join(artifactRoot, "node_modules"))) &&
      (await controlUiBuildMatches(artifactRoot, params.expectedVersion));
    if (!runtimeShapeReady) {
      return {
        kind: "error",
        steps,
        reason: "layered hosted runtime is incomplete",
        afterVersion: await readPackageVersion(params.pkgRoot),
      };
    }

    await record(
      "hosted layered verify",
      `verify checksummed v${params.expectedVersion} runtime shape`,
      async () => undefined,
    );

    await record("hosted app swap", `replace ${params.pkgRoot}`, async () => {
      const swapped = await swapPackageRoot({ pkgRoot: params.pkgRoot, artifactRoot });
      backupRoot = swapped.backupRoot;
    });
    if (!backupRoot) {
      throw new Error("hosted app swap did not retain a rollback runtime");
    }
    retainBackup = true;
    return {
      kind: "updated",
      steps,
      afterVersion: await readPackageVersion(params.pkgRoot),
      reason: "verified layered hosted runtime",
      transaction: {
        kind: "package-root-swap",
        packageRoot: params.pkgRoot,
        backupRoot,
      },
    };
  } catch (error) {
    return {
      kind: "error",
      steps,
      reason: `layered hosted update failed: ${String(error)}`,
      afterVersion: await readPackageVersion(params.pkgRoot),
    };
  } finally {
    if (backupRoot && !retainBackup) {
      await safeRemove(backupRoot);
    }
    await safeRemove(tempRoot);
  }
}

async function runHostedReleaseArtifactUpdate(params: {
  fetchImpl: typeof fetch;
  baseUrl?: string;
  pkgRoot: string;
  dependencyCacheRoot: string;
  expectedVersion: string;
  runCommand: CommandRunner;
  timeoutMs: number;
  progress?: UpdateStepProgress;
}): Promise<HostedArtifactUpdateResult> {
  const layeredResult = await runHostedLayeredArtifactUpdate(params);
  if (layeredResult.kind !== "fallback") {
    return layeredResult;
  }
  const packageParent = path.dirname(params.pkgRoot);
  const tempRoot = await fs.mkdtemp(path.join(packageParent, ".fased-release-update-"));
  const steps: UpdateStepResult[] = [...layeredResult.steps];
  let backupRoot: string | null = null;
  let retainBackup = false;
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
    const controlUiVersion = await readControlUiBuildVersion(artifactRoot);
    const runtimeShapeReady =
      compareSemverStrings(artifactVersion, params.expectedVersion) === 0 &&
      (await pathExists(path.join(artifactRoot, "fased.mjs"))) &&
      (await pathExists(path.join(artifactRoot, "node_modules"))) &&
      compareSemverStrings(controlUiVersion, params.expectedVersion) === 0;
    const verifyCommand = `verify checksummed v${params.expectedVersion} runtime shape`;
    const verifyInfo = startProgress("hosted artifact verify", verifyCommand, artifactRoot);
    const verifyStarted = Date.now();
    const runtimeReady = runtimeShapeReady;
    const verifyFailure = !runtimeShapeReady
      ? `expected complete v${params.expectedVersion}, found runtime ${artifactVersion ?? "unknown"} and dashboard ${controlUiVersion ?? "unknown"}`
      : "hosted runtime shape verification failed";
    completeProgress(verifyInfo, {
      name: "hosted artifact verify",
      command: verifyCommand,
      cwd: artifactRoot,
      durationMs: Date.now() - verifyStarted,
      exitCode: runtimeReady ? 0 : 1,
      ...(runtimeReady
        ? { stdoutTail: `checksummed v${params.expectedVersion} runtime shape passed` }
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

    retainBackup = true;
    return {
      kind: "updated",
      steps,
      afterVersion: await readPackageVersion(params.pkgRoot),
      reason: "verified self-contained hosted runtime",
      transaction: {
        kind: "package-root-swap",
        packageRoot: params.pkgRoot,
        backupRoot,
      },
    };
  } finally {
    if (backupRoot && !retainBackup) {
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

      const tagCommitStep = await runStep(
        step(
          `git rev-parse ${tag}^{commit}`,
          ["git", "-C", gitRoot, "rev-parse", `${tag}^{commit}`],
          gitRoot,
        ),
      );
      steps.push(tagCommitStep);
      const tagCommit = tagCommitStep.stdoutTail?.trim() ?? "";
      if (tagCommitStep.exitCode !== 0 || !/^[a-f0-9]{40}$/u.test(tagCommit)) {
        return buildGitErrorResult("release-tag-identity-failed");
      }
      const attestationStep = await verifyAttestedSourceRelease({
        tag,
        tagCommit,
        timeoutMs,
        runCommand,
        fetchImpl: opts.hostedReleaseFetch ?? fetch,
        baseUrl: opts.hostedReleaseBaseUrl,
      });
      steps.push(attestationStep);
      if (attestationStep.exitCode !== 0) {
        return buildGitErrorResult("source-release-attestation-failed");
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
          dependencyCacheRoot: hostedTarget.cacheRoot,
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
              reason: releaseResult.reason,
            },
            root: pkgRoot,
            before: { version: beforeVersion },
            after: { version: releaseResult.afterVersion },
            transaction: releaseResult.transaction,
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
          transaction: artifactResult.transaction,
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
