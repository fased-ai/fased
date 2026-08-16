import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isManagedLifecycleRuntime } from "../../infra/managed-runtime-authority.js";
import { checkUpdateStatus } from "../../infra/update-check.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { runDaemonRestart } from "../daemon-cli.js";
import { parseTimeoutMsOrExit, resolveUpdateRoot, type UpdateCommandOptions } from "./shared.js";

const MANAGED_RUNTIME_SOURCES = new Set(["go-lifecycle", "managed-package", "packaged-runtime"]);
const DEFAULT_SOURCE_TIMEOUT_MS = 20 * 60_000;

async function runSourceStep(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  verbose: boolean,
): Promise<string> {
  if (verbose) {
    defaultRuntime.log(`$ ${argv.join(" ")}`);
  }
  const result = await runCommandWithTimeout(argv, { cwd, timeoutMs });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-5).join("\n");
    throw new Error(`${argv.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function refuse(message: string): void {
  defaultRuntime.error(message);
  defaultRuntime.exit(1);
}

export async function runDeveloperSourceUpdate(opts: UpdateCommandOptions = {}): Promise<void> {
  if (
    MANAGED_RUNTIME_SOURCES.has(process.env.FASED_RUNTIME_SOURCE ?? "") ||
    isManagedLifecycleRuntime()
  ) {
    refuse(
      "Developer source update is unavailable in a managed installation; run fased update from the owner shell.",
    );
    return;
  }
  if ((opts.channel && opts.channel !== "dev") || opts.tag || opts.safeFallback) {
    refuse(
      "Developer source update supports only the dev channel; managed stable, beta, and exact releases use fased update.",
    );
    return;
  }

  const parsedTimeout = parseTimeoutMsOrExit(opts.timeout);
  if (parsedTimeout === null) {
    return;
  }
  const timeoutMs = parsedTimeout ?? DEFAULT_SOURCE_TIMEOUT_MS;
  const root = await resolveUpdateRoot();
  const status = await checkUpdateStatus({
    root,
    timeoutMs: Math.min(timeoutMs, 3500),
    fetchGit: false,
    includeRegistry: false,
  });
  if (status.installKind !== "git") {
    refuse(
      "fased dev update-source requires a Git source checkout; package and managed installs must use the verified installer or fased update.",
    );
    return;
  }
  if (opts.dryRun) {
    const result = {
      status: "dry-run",
      root,
      channel: "dev",
      actions: [
        "fetch origin main",
        "preflight in a detached worktree",
        "fast-forward main",
        "pnpm install --frozen-lockfile",
        "pnpm build",
      ],
    };
    defaultRuntime.log(
      opts.json ? JSON.stringify(result) : `Developer source update dry-run: ${root}`,
    );
    return;
  }

  try {
    const branch = await runSourceStep(
      ["git", "-C", root, "branch", "--show-current"],
      root,
      timeoutMs,
      Boolean(opts.verbose),
    );
    if (branch !== "main") {
      throw new Error(
        `developer source update requires branch main (current: ${branch || "detached"})`,
      );
    }
    const dirty = await runSourceStep(
      ["git", "-C", root, "status", "--porcelain"],
      root,
      timeoutMs,
      Boolean(opts.verbose),
    );
    if (dirty) {
      throw new Error("developer source checkout has uncommitted changes");
    }
    const before = await runSourceStep(
      ["git", "-C", root, "rev-parse", "HEAD"],
      root,
      timeoutMs,
      Boolean(opts.verbose),
    );
    await runSourceStep(
      ["git", "-C", root, "fetch", "origin", "main", "--prune", "--tags"],
      root,
      timeoutMs,
      Boolean(opts.verbose),
    );
    const target = await runSourceStep(
      ["git", "-C", root, "rev-parse", "origin/main"],
      root,
      timeoutMs,
      Boolean(opts.verbose),
    );
    if (before === target) {
      defaultRuntime.log(
        opts.json
          ? JSON.stringify({ status: "current", sha: before })
          : `Already current: ${before.slice(0, 12)}`,
      );
      return;
    }
    await runSourceStep(
      ["git", "-C", root, "merge-base", "--is-ancestor", before, target],
      root,
      timeoutMs,
      Boolean(opts.verbose),
    );

    const preflightRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fased-source-update-"));
    const worktree = path.join(preflightRoot, "worktree");
    try {
      await runSourceStep(
        ["git", "-C", root, "worktree", "add", "--detach", worktree, target],
        root,
        timeoutMs,
        Boolean(opts.verbose),
      );
      await runSourceStep(
        ["pnpm", "install", "--frozen-lockfile"],
        worktree,
        timeoutMs,
        Boolean(opts.verbose),
      );
      await runSourceStep(["pnpm", "build"], worktree, timeoutMs, Boolean(opts.verbose));
    } finally {
      await runCommandWithTimeout(["git", "-C", root, "worktree", "remove", "--force", worktree], {
        cwd: root,
        timeoutMs,
      }).catch(() => undefined);
      await fs.rm(preflightRoot, { recursive: true, force: true });
    }

    await runSourceStep(
      ["git", "-C", root, "merge", "--ff-only", target],
      root,
      timeoutMs,
      Boolean(opts.verbose),
    );
    await runSourceStep(
      ["pnpm", "install", "--frozen-lockfile"],
      root,
      timeoutMs,
      Boolean(opts.verbose),
    );
    await runSourceStep(["pnpm", "build"], root, timeoutMs, Boolean(opts.verbose));
    if (opts.restart !== false && !(await runDaemonRestart())) {
      throw new Error("source update completed, but the developer Gateway did not restart");
    }
    defaultRuntime.log(
      opts.json
        ? JSON.stringify({ status: "updated", before, after: target })
        : `Developer source updated: ${before.slice(0, 12)} -> ${target.slice(0, 12)}`,
    );
  } catch (error) {
    refuse(String(error));
  }
}
