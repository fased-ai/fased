import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { resolveStateDir } from "../config/paths.js";
import { runCommandWithTimeout } from "../process/exec.js";

const JOURNAL_SCHEMA_VERSION = 1;
const PHASES = new Set([
  "prepared",
  "app-active",
  "signer-active",
  "gateway-verified",
  "committing",
  "rolling-back",
] as const);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const CONTROLLER_FILES = [
  "fased-managed-updater.mjs",
  "hosted-release-manifest.mjs",
  "managed-runtime-layout.mjs",
] as const;

type LocalSourcePhase =
  | "prepared"
  | "app-active"
  | "signer-active"
  | "gateway-verified"
  | "committing"
  | "rolling-back";

type SourceRelease = {
  sha: string;
  version: string;
};

type SnapshotFile = {
  path: string;
  sha256: string;
  size: number;
};

export type LocalSourcePairedUpdateJournal = {
  schemaVersion: 1;
  kind: "source-checkout";
  transactionId: string;
  transactionDir: string;
  sourceRoot: string;
  controllerPath: string;
  phase: LocalSourcePhase;
  previous: SourceRelease & { branch: string | null };
  target: SourceRelease | null;
  distSnapshot: SnapshotFile;
  createdAt: string;
  updatedAt: string;
};

type SourcePairContext = {
  stateDir: string;
  updateRoot: string;
  transactionsDir: string;
  journalPath: string;
};

function resolveContext(env: NodeJS.ProcessEnv = process.env): SourcePairContext {
  const stateDir = path.resolve(resolveStateDir(env));
  const updateRoot = path.join(stateDir, "source-paired-update");
  return {
    stateDir,
    updateRoot,
    transactionsDir: path.join(updateRoot, "transactions"),
    journalPath: path.join(updateRoot, "transaction.json"),
  };
}

function pathIsInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function fsyncPath(target: string): Promise<void> {
  const handle = await fs.open(target, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function sha256File(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function validateRelease(value: unknown, label: string): SourceRelease {
  const release = value as Partial<SourceRelease> | null;
  if (
    !release ||
    !SHA_PATTERN.test(release.sha ?? "") ||
    !VERSION_PATTERN.test(release.version ?? "")
  ) {
    throw new Error(`Local source paired update has an invalid ${label} release identity`);
  }
  return { sha: release.sha!, version: release.version! };
}

function validateJournal(
  context: SourcePairContext,
  value: unknown,
): LocalSourcePairedUpdateJournal {
  const journal = value as Partial<LocalSourcePairedUpdateJournal> | null;
  if (
    !journal ||
    journal.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
    journal.kind !== "source-checkout" ||
    !UUID_PATTERN.test(journal.transactionId ?? "") ||
    !PHASES.has(journal.phase as LocalSourcePhase) ||
    typeof journal.sourceRoot !== "string" ||
    !path.isAbsolute(journal.sourceRoot) ||
    typeof journal.transactionDir !== "string" ||
    path.resolve(journal.transactionDir) !==
      path.join(context.transactionsDir, journal.transactionId ?? "") ||
    !pathIsInside(context.updateRoot, journal.transactionDir) ||
    path.resolve(journal.controllerPath ?? "") !==
      path.join(journal.transactionDir, "controller", "fased-managed-updater.mjs") ||
    (typeof journal.previous?.branch !== "string" && journal.previous?.branch !== null) ||
    (typeof journal.previous?.branch === "string" &&
      (!journal.previous.branch ||
        journal.previous.branch.includes("..") ||
        !/^[0-9A-Za-z._/-]+$/.test(journal.previous.branch))) ||
    typeof journal.distSnapshot?.path !== "string" ||
    path.resolve(journal.distSnapshot.path) !== path.join(journal.transactionDir, "dist.tar.gz") ||
    !/^[a-f0-9]{64}$/.test(journal.distSnapshot?.sha256 ?? "") ||
    !Number.isSafeInteger(journal.distSnapshot?.size) ||
    (journal.distSnapshot?.size ?? -1) <= 0
  ) {
    throw new Error("Local source paired update journal is invalid");
  }
  const previous = validateRelease(journal.previous, "previous");
  const needsTarget = new Set<LocalSourcePhase>([
    "app-active",
    "signer-active",
    "gateway-verified",
    "committing",
  ]).has(journal.phase!);
  const target = journal.target === null ? null : validateRelease(journal.target, "target");
  if (needsTarget && target === null) {
    throw new Error("Local source paired update journal is missing its target release identity");
  }
  return {
    ...(journal as LocalSourcePairedUpdateJournal),
    sourceRoot: path.resolve(journal.sourceRoot),
    previous: { ...previous, branch: journal.previous.branch },
    target,
  };
}

async function writeJournal(
  context: SourcePairContext,
  journal: LocalSourcePairedUpdateJournal,
  phase: LocalSourcePhase = journal.phase,
  exclusive = false,
): Promise<LocalSourcePairedUpdateJournal> {
  const next = validateJournal(context, {
    ...journal,
    phase,
    updatedAt: new Date().toISOString(),
  });
  await fs.mkdir(context.updateRoot, { recursive: true, mode: 0o700 });
  if (exclusive) {
    const handle = await fs.open(context.journalPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else {
    const temporary = `${context.journalPath}.tmp-${process.pid}-${Date.now()}`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, context.journalPath);
  }
  await fsyncPath(context.updateRoot);
  return next;
}

export async function readLocalSourcePairedUpdateJournal(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalSourcePairedUpdateJournal | null> {
  const context = resolveContext(env);
  try {
    return validateJournal(context, JSON.parse(await fs.readFile(context.journalPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function runExact(
  argv: string[],
  options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv; label: string },
): Promise<string> {
  const result = await runCommandWithTimeout(argv, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env: options.env,
  });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-5).join("\n");
    throw new Error(`${options.label} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

async function readGitHead(
  sourceRoot: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const sha = await runExact(["git", "-C", sourceRoot, "rev-parse", "HEAD"], {
    cwd: sourceRoot,
    timeoutMs,
    env,
    label: "git HEAD verification",
  });
  if (!SHA_PATTERN.test(sha)) {
    throw new Error("Source checkout did not report an exact Git commit");
  }
  return sha;
}

async function readPackageVersion(sourceRoot: string): Promise<string> {
  const parsed = JSON.parse(await fs.readFile(path.join(sourceRoot, "package.json"), "utf8")) as {
    version?: unknown;
  };
  const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
  if (!VERSION_PATTERN.test(version)) {
    throw new Error("Source checkout package.json has no exact release version");
  }
  return version;
}

async function copyController(sourceRoot: string, transactionDir: string): Promise<string> {
  const controllerDir = path.join(transactionDir, "controller");
  await fs.mkdir(controllerDir, { recursive: true, mode: 0o700 });
  for (const name of CONTROLLER_FILES) {
    const source = path.join(sourceRoot, "scripts", name);
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Source checkout is missing a safe signer transaction controller: ${source}`);
    }
    const destination = path.join(controllerDir, name);
    await fs.copyFile(source, destination);
    await fs.chmod(destination, name.endsWith("updater.mjs") ? 0o700 : 0o600);
    await fsyncPath(destination);
  }
  await fsyncPath(controllerDir);
  return path.join(controllerDir, "fased-managed-updater.mjs");
}

async function ensureControllerDependencyClosure(params: {
  journal: LocalSourcePairedUpdateJournal;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const controllerDir = path.dirname(params.journal.controllerPath);
  const releaseSha = params.journal.target?.sha ?? params.journal.previous.sha;
  for (const name of CONTROLLER_FILES) {
    const destination = path.join(controllerDir, name);
    const destinationStat = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (destinationStat) {
      if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
        throw new Error(`Local signer rollback controller dependency is unsafe: ${destination}`);
      }
      continue;
    }

    // v0.1.72 snapshots omitted hosted-release-manifest.mjs. Repair only from
    // bytes that are still exactly tracked by the transaction's release commit.
    const source = path.join(params.journal.sourceRoot, "scripts", name);
    const [trackedBlob, workingBlob] = await Promise.all([
      runExact(
        ["git", "-C", params.journal.sourceRoot, "rev-parse", `${releaseSha}:scripts/${name}`],
        {
          cwd: params.journal.sourceRoot,
          timeoutMs: params.timeoutMs,
          env: params.env,
          label: `trusted rollback controller ${name}`,
        },
      ),
      runExact(["git", "-C", params.journal.sourceRoot, "hash-object", source], {
        cwd: params.journal.sourceRoot,
        timeoutMs: params.timeoutMs,
        env: params.env,
        label: `working rollback controller ${name}`,
      }),
    ]);
    if (!/^[a-f0-9]{40}$/.test(trackedBlob) || workingBlob !== trackedBlob) {
      throw new Error(
        `Cannot safely repair Local signer rollback controller dependency ${name}: source bytes do not match ${releaseSha}`,
      );
    }
    const sourceStat = await fs.lstat(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`Local signer rollback controller dependency is unsafe: ${source}`);
    }
    await fs.copyFile(source, destination);
    await fs.chmod(destination, name === "fased-managed-updater.mjs" ? 0o700 : 0o600);
    await fsyncPath(destination);
  }
  await fsyncPath(controllerDir);
}

export async function isLocalSourceSignerConfigured(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const stateDir = resolveContext(env).stateDir;
  for (const candidate of [
    path.join(stateDir, "bin", "fased-signerd"),
    path.join(stateDir, "wallet", "signerd-v2.db"),
  ]) {
    const found = await fs
      .lstat(candidate)
      .then((stat) => stat.isFile() && !stat.isSymbolicLink())
      .catch(() => false);
    if (found) {
      return true;
    }
  }
  const walletDir = path.join(stateDir, "wallet");
  const legacyMaterial = await fs
    .readdir(walletDir, { withFileTypes: true })
    .then((entries) =>
      entries.some(
        (entry) =>
          entry.isFile() &&
          (entry.name === "wallet-keys.json" ||
            /^keystore-(?:solana|evm)(?:-[A-Za-z0-9_-]+)?\.v1\.enc$/u.test(entry.name)),
      ),
    )
    .catch(() => false);
  if (legacyMaterial) {
    return true;
  }
  try {
    const registry = JSON.parse(
      await fs.readFile(path.join(stateDir, "wallet", "provider-registry.v1.json"), "utf8"),
    ) as { wallets?: Array<{ providerId?: unknown }> };
    return (registry.wallets ?? []).some((wallet) => wallet?.providerId === "local-socket-signer");
  } catch {
    return false;
  }
}

export async function prepareLocalSourcePairedUpdate(params: {
  sourceRoot: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<LocalSourcePairedUpdateJournal> {
  const env = params.env ?? process.env;
  const context = resolveContext(env);
  if (await readLocalSourcePairedUpdateJournal(env)) {
    throw new Error("An unfinished Local source app/signer transaction must be recovered first");
  }
  const sourceRoot = path.resolve(params.sourceRoot);
  const previousSha = await readGitHead(sourceRoot, params.timeoutMs, env);
  const previousVersion = await readPackageVersion(sourceRoot);
  const branchResult = await runCommandWithTimeout(
    ["git", "-C", sourceRoot, "symbolic-ref", "--quiet", "--short", "HEAD"],
    { cwd: sourceRoot, timeoutMs: params.timeoutMs, env },
  );
  const branch =
    branchResult.code === 0 && branchResult.stdout.trim() ? branchResult.stdout.trim() : null;
  if (branch !== null && (branch.includes("..") || !/^[0-9A-Za-z._/-]+$/.test(branch))) {
    throw new Error("Source checkout branch name is unsafe for transactional rollback");
  }

  const transactionId = randomUUID();
  const transactionDir = path.join(context.transactionsDir, transactionId);
  await fs.mkdir(transactionDir, { recursive: true, mode: 0o700 });
  try {
    const distRoot = path.join(sourceRoot, "dist");
    const distStat = await fs.lstat(distRoot);
    if (!distStat.isDirectory() || distStat.isSymbolicLink()) {
      throw new Error("Source checkout has no safe built dist directory to snapshot");
    }
    const distSnapshotPath = path.join(transactionDir, "dist.tar.gz");
    await tar.c(
      { cwd: sourceRoot, file: distSnapshotPath, gzip: true, portable: true, noMtime: true },
      ["dist"],
    );
    await fs.chmod(distSnapshotPath, 0o600);
    await fsyncPath(distSnapshotPath);
    const distSnapshotStat = await fs.lstat(distSnapshotPath);
    const controllerPath = await copyController(sourceRoot, transactionDir);
    const now = new Date().toISOString();
    const journal: LocalSourcePairedUpdateJournal = {
      schemaVersion: 1,
      kind: "source-checkout",
      transactionId,
      transactionDir,
      sourceRoot,
      controllerPath,
      phase: "prepared",
      previous: { sha: previousSha, version: previousVersion, branch },
      target: null,
      distSnapshot: {
        path: distSnapshotPath,
        sha256: await sha256File(distSnapshotPath),
        size: distSnapshotStat.size,
      },
      createdAt: now,
      updatedAt: now,
    };
    await fsyncPath(transactionDir);
    return await writeJournal(context, journal, "prepared", true);
  } catch (error) {
    await fs.rm(transactionDir, { recursive: true, force: true });
    throw error;
  }
}

export async function markLocalSourceAppActive(params: {
  journal: LocalSourcePairedUpdateJournal;
  targetSha: string;
  targetVersion: string;
  env?: NodeJS.ProcessEnv;
}): Promise<LocalSourcePairedUpdateJournal> {
  if (params.journal.phase !== "prepared") {
    throw new Error(`Cannot activate source app from phase ${params.journal.phase}`);
  }
  const context = resolveContext(params.env ?? process.env);
  const target = validateRelease(
    { sha: params.targetSha, version: params.targetVersion },
    "target",
  );
  return await writeJournal(context, { ...params.journal, target }, "app-active");
}

async function runSignerController(params: {
  journal: LocalSourcePairedUpdateJournal;
  action: "verify" | "commit" | "rollback";
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  await ensureControllerDependencyClosure(params);
  const args = [params.journal.controllerPath, "local-signer", params.action];
  if (params.action === "verify") {
    if (!params.journal.target) {
      throw new Error("Cannot verify a Local signer without a target release");
    }
    args.push(
      "--version",
      params.journal.target.version,
      "--expected-commit",
      params.journal.target.sha,
      "--timeout",
      String(Math.ceil(params.timeoutMs / 1000)),
    );
  }
  await runExact([process.execPath, ...args], {
    cwd: path.dirname(params.journal.controllerPath),
    timeoutMs: params.timeoutMs,
    env: params.env,
    label: `Local signer ${params.action}`,
  });
}

export async function activateLocalSourceSigner(params: {
  journal: LocalSourcePairedUpdateJournal;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<LocalSourcePairedUpdateJournal> {
  if (params.journal.phase !== "app-active" || !params.journal.target) {
    throw new Error(`Cannot activate Local signer from phase ${params.journal.phase}`);
  }
  const env = params.env ?? process.env;
  const installer = path.join(params.journal.sourceRoot, "scripts", "install-fased-signerd.sh");
  const stat = await fs.lstat(installer);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Updated source checkout is missing its safe Local signer installer");
  }
  await runExact(
    [
      "bash",
      installer,
      "--version",
      params.journal.target.version,
      "--expected-commit",
      params.journal.target.sha,
      "--defer-commit",
    ],
    {
      cwd: params.journal.sourceRoot,
      timeoutMs: params.timeoutMs,
      env,
      label: "Local signer prepare and activation",
    },
  );
  return await writeJournal(resolveContext(env), params.journal, "signer-active");
}

export async function verifyLocalSourceSigner(params: {
  journal: LocalSourcePairedUpdateJournal;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (!new Set<LocalSourcePhase>(["signer-active", "gateway-verified"]).has(params.journal.phase)) {
    throw new Error(`Cannot verify Local signer from phase ${params.journal.phase}`);
  }
  await runSignerController({
    journal: params.journal,
    action: "verify",
    timeoutMs: params.timeoutMs,
    env: params.env ?? process.env,
  });
}

export async function markLocalSourceGatewayVerified(
  journal: LocalSourcePairedUpdateJournal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalSourcePairedUpdateJournal> {
  if (journal.phase !== "signer-active") {
    throw new Error(`Cannot record Gateway verification from phase ${journal.phase}`);
  }
  return await writeJournal(resolveContext(env), journal, "gateway-verified");
}

async function removeTransaction(
  journal: LocalSourcePairedUpdateJournal,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const context = resolveContext(env);
  await fs.rm(context.journalPath, { force: true });
  await fsyncPath(context.updateRoot);
  await fs.rm(journal.transactionDir, { recursive: true, force: true });
  await fsyncPath(context.transactionsDir);
}

export async function commitLocalSourcePairedUpdate(params: {
  journal: LocalSourcePairedUpdateJournal;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = params.env ?? process.env;
  let journal = params.journal;
  if (journal.phase !== "gateway-verified" && journal.phase !== "committing") {
    throw new Error(`Cannot commit Local source pair from phase ${journal.phase}`);
  }
  if (journal.phase !== "committing") {
    journal = await writeJournal(resolveContext(env), journal, "committing");
  }
  await runSignerController({
    journal,
    action: "commit",
    timeoutMs: params.timeoutMs,
    env,
  });
  await removeTransaction(journal, env);
}

async function restoreSourceApplication(params: {
  journal: LocalSourcePairedUpdateJournal;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const { journal, timeoutMs, env } = params;
  const snapshotStat = await fs.lstat(journal.distSnapshot.path);
  if (
    !snapshotStat.isFile() ||
    snapshotStat.isSymbolicLink() ||
    snapshotStat.size !== journal.distSnapshot.size ||
    (await sha256File(journal.distSnapshot.path)) !== journal.distSnapshot.sha256
  ) {
    throw new Error("Local source rollback dist snapshot failed integrity verification");
  }
  if (journal.previous.branch) {
    await runExact(["git", "-C", journal.sourceRoot, "checkout", journal.previous.branch], {
      cwd: journal.sourceRoot,
      timeoutMs,
      env,
      label: "source rollback branch checkout",
    });
    await runExact(["git", "-C", journal.sourceRoot, "reset", "--hard", journal.previous.sha], {
      cwd: journal.sourceRoot,
      timeoutMs,
      env,
      label: "source rollback commit restore",
    });
  } else {
    await runExact(
      ["git", "-C", journal.sourceRoot, "checkout", "--detach", journal.previous.sha],
      {
        cwd: journal.sourceRoot,
        timeoutMs,
        env,
        label: "source rollback detached commit restore",
      },
    );
  }
  await runExact(["pnpm", "install", "--offline", "--frozen-lockfile"], {
    cwd: journal.sourceRoot,
    timeoutMs,
    env,
    label: "offline source dependency rollback",
  });
  await fs.rm(path.join(journal.sourceRoot, "dist"), { recursive: true, force: true });
  await tar.x({
    cwd: journal.sourceRoot,
    file: journal.distSnapshot.path,
    strict: true,
    filter: (entryPath) => entryPath === "dist" || entryPath.startsWith("dist/"),
  });
  if ((await readGitHead(journal.sourceRoot, timeoutMs, env)) !== journal.previous.sha) {
    throw new Error("Local source rollback restored the wrong Git commit");
  }
  if ((await readPackageVersion(journal.sourceRoot)) !== journal.previous.version) {
    throw new Error("Local source rollback restored the wrong package version");
  }
}

export async function rollbackLocalSourcePairedUpdate(params: {
  journal: LocalSourcePairedUpdateJournal;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = params.env ?? process.env;
  let journal = params.journal;
  if (journal.phase !== "rolling-back") {
    journal = await writeJournal(resolveContext(env), journal, "rolling-back");
  }
  const failures: string[] = [];
  try {
    await runSignerController({
      journal,
      action: "rollback",
      timeoutMs: params.timeoutMs,
      env,
    });
  } catch (error) {
    failures.push(`signer: ${String(error)}`);
  }
  if (failures.length === 0) {
    try {
      await restoreSourceApplication({ journal, timeoutMs: params.timeoutMs, env });
    } catch (error) {
      failures.push(`application: ${String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Local source paired rollback is incomplete (${failures.join("; ")}). Re-run fased update after correcting the failure.`,
    );
  }
  await removeTransaction(journal, env);
}

export async function recoverLocalSourcePairedUpdate(params: {
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<"none" | "committed" | "rolled-back"> {
  const env = params.env ?? process.env;
  const journal = await readLocalSourcePairedUpdateJournal(env);
  if (!journal) {
    return "none";
  }
  if (journal.phase === "gateway-verified" || journal.phase === "committing") {
    await commitLocalSourcePairedUpdate({ journal, timeoutMs: params.timeoutMs, env });
    return "committed";
  }
  await rollbackLocalSourcePairedUpdate({ journal, timeoutMs: params.timeoutMs, env });
  return "rolled-back";
}

export async function assertLocalSourcePairedGatewayStartAllowed(params: {
  runtimeRoot: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = params.env ?? process.env;
  const journal = await readLocalSourcePairedUpdateJournal(env);
  if (!journal) {
    return;
  }
  if (
    journal.phase !== "signer-active" &&
    journal.phase !== "gateway-verified" &&
    journal.phase !== "committing"
  ) {
    throw new Error(
      `Gateway startup is blocked by an unfinished Local source app/signer update (${journal.phase}). Run fased update to recover it.`,
    );
  }
  if (!journal.target || path.resolve(params.runtimeRoot) !== journal.sourceRoot) {
    throw new Error(
      "Gateway startup is blocked because the source update target root does not match",
    );
  }
  const timeoutMs = params.timeoutMs ?? 5_000;
  const [sha, version] = await Promise.all([
    readGitHead(journal.sourceRoot, timeoutMs, env),
    readPackageVersion(journal.sourceRoot),
  ]);
  if (sha !== journal.target.sha || version !== journal.target.version) {
    throw new Error("Gateway startup is blocked because the source update target identity changed");
  }
}

export const __testing = {
  resolveContext,
  validateJournal,
};
