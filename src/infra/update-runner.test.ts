import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { pathExists } from "../utils.js";
import { runGatewayUpdate } from "./update-runner.js";

type CommandResponse = { stdout?: string; stderr?: string; code?: number | null };
type CommandResult = { stdout: string; stderr: string; code: number | null };

function createRunner(responses: Record<string, CommandResponse>) {
  const calls: string[] = [];
  const runner = async (argv: string[]) => {
    const key = argv.join(" ");
    calls.push(key);
    const res = responses[key] ?? {};
    return {
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      code: res.code ?? 0,
    };
  };
  return { runner, calls };
}

describe("runGatewayUpdate", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let tempDir: string;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fased-update-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    tempDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, "fased.mjs"), "export {};\n", "utf-8");
  });

  afterEach(async () => {
    // Shared fixtureRoot cleaned up in afterAll.
  });

  function createStableTagRunner(params: {
    stableTag: string;
    uiIndexPath: string;
    onDoctor?: () => Promise<void>;
    onUiBuild?: (count: number) => Promise<void>;
  }) {
    const calls: string[] = [];
    let uiBuildCount = 0;
    const doctorKey = `${process.execPath} ${path.join(tempDir, "fased.mjs")} doctor --non-interactive --fix`;

    const runCommand = async (argv: string[]) => {
      const key = argv.join(" ");
      calls.push(key);

      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return { stdout: tempDir, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return { stdout: "abc123", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} tag --list v* --sort=-v:refname`) {
        return { stdout: `${params.stableTag}\n`, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} checkout --detach ${params.stableTag}`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm install") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm build:app") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm ui:build") {
        uiBuildCount += 1;
        await params.onUiBuild?.(uiBuildCount);
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === doctorKey) {
        await params.onDoctor?.();
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    return {
      runCommand,
      calls,
      doctorKey,
      getUiBuildCount: () => uiBuildCount,
    };
  }

  async function setupGitCheckout(options?: { packageManager?: string }) {
    await fs.mkdir(path.join(tempDir, ".git"));
    const pkg: Record<string, string> = { name: "fased", version: "1.0.0" };
    if (options?.packageManager) {
      pkg.packageManager = options.packageManager;
    }
    await fs.writeFile(path.join(tempDir, "package.json"), JSON.stringify(pkg), "utf-8");
  }

  async function setupUiIndex() {
    const uiIndexPath = path.join(tempDir, "dist", "control-ui", "index.html");
    await fs.mkdir(path.dirname(uiIndexPath), { recursive: true });
    await fs.writeFile(uiIndexPath, "<html></html>", "utf-8");
    return uiIndexPath;
  }

  function buildStableTagResponses(
    stableTag: string,
    options?: { additionalTags?: string[] },
  ): Record<string, CommandResponse> {
    const tagOutput = [stableTag, ...(options?.additionalTags ?? [])].join("\n");
    return {
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
      [`git -C ${tempDir} rev-parse HEAD`]: { stdout: "abc123" },
      [`git -C ${tempDir} status --porcelain -- :!dist/control-ui/`]: { stdout: "" },
      [`git -C ${tempDir} fetch --all --prune --tags`]: { stdout: "" },
      [`git -C ${tempDir} tag --list v* --sort=-v:refname`]: { stdout: `${tagOutput}\n` },
      [`git -C ${tempDir} checkout --detach ${stableTag}`]: { stdout: "" },
    };
  }

  function buildGitWorktreeProbeResponses(options?: { status?: string; branch?: string }) {
    return {
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
      [`git -C ${tempDir} rev-parse HEAD`]: { stdout: "abc123" },
      [`git -C ${tempDir} rev-parse --abbrev-ref HEAD`]: { stdout: options?.branch ?? "main" },
      [`git -C ${tempDir} status --porcelain -- :!dist/control-ui/`]: {
        stdout: options?.status ?? "",
      },
    } satisfies Record<string, CommandResponse>;
  }

  async function removeControlUiAssets() {
    await fs.rm(path.join(tempDir, "dist", "control-ui"), { recursive: true, force: true });
  }

  async function runWithCommand(
    runCommand: (argv: string[]) => Promise<CommandResult>,
    options?: {
      channel?: "stable" | "beta" | "dev";
      tag?: string;
      cwd?: string;
      allowDevFallback?: boolean;
    },
  ) {
    return runGatewayUpdate({
      cwd: options?.cwd ?? tempDir,
      runCommand: async (argv, _runOptions) => runCommand(argv),
      timeoutMs: 5000,
      ...(options?.channel ? { channel: options.channel } : {}),
      ...(options?.tag ? { tag: options.tag } : {}),
      ...(options?.allowDevFallback ? { allowDevFallback: options.allowDevFallback } : {}),
    });
  }

  async function runWithRunner(
    runner: (argv: string[]) => Promise<CommandResult>,
    options?: {
      channel?: "stable" | "beta" | "dev";
      tag?: string;
      cwd?: string;
      allowDevFallback?: boolean;
    },
  ) {
    return runWithCommand(runner, options);
  }

  async function seedGlobalPackageRoot(pkgRoot: string, version = "1.0.0") {
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.writeFile(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name: "fased", version }),
      "utf-8",
    );
  }

  it("skips git update when worktree is dirty", async () => {
    await setupGitCheckout();
    const { runner, calls } = createRunner({
      ...buildGitWorktreeProbeResponses({ status: " M README.md" }),
    });

    const result = await runWithRunner(runner, { channel: "dev" });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("dirty");
    expect(calls.some((call) => call.includes("rebase"))).toBe(false);
  });

  it("defaults git updates to the latest stable tag instead of main", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    await setupUiIndex();
    const stableTag = "v1.0.1";
    const { runner, calls } = createRunner({
      ...buildStableTagResponses(stableTag),
      "pnpm install": { stdout: "" },
      "pnpm build:app": { stdout: "" },
      [`${process.execPath} ${path.join(tempDir, "fased.mjs")} doctor --non-interactive --fix`]: {
        stdout: "",
      },
      [`git -C ${tempDir} rev-parse HEAD (after)`]: { stdout: "after-sha" },
    });

    const result = await runWithRunner(runner);

    expect(result.status).toBe("ok");
    expect(calls).toContain(`git -C ${tempDir} checkout --detach ${stableTag}`);
    expect(calls.some((call) => call.includes("rev-list"))).toBe(false);
    expect(calls.some((call) => call.includes("rebase"))).toBe(false);
  });

  it("stops dev update when fetch fails before resolving upstream SHA", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    const fetchCommand = `git -C ${tempDir} fetch --all --prune --tags`;
    const { runner, calls } = createRunner({
      ...buildGitWorktreeProbeResponses(),
      [`git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`]: {
        stdout: "origin/main",
      },
      [fetchCommand]: {
        code: 1,
        stderr: "! [rejected] v2026.5.3 -> v2026.5.3 (would clobber existing tag)",
      },
    });

    const result = await runWithRunner(runner, { channel: "dev" });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("fetch-failed");
    expect(calls).toContain(fetchCommand);
    expect(calls.slice(calls.indexOf(fetchCommand) + 1)).toEqual([]);
  });

  it("skips dev preflight lint by default so lint-only failures do not block updates", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    await setupUiIndex();
    const upstreamSha = "upstream123";
    const { runner, calls } = createRunner({
      ...buildGitWorktreeProbeResponses(),
      [`git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`]: {
        stdout: "origin/main",
      },
      [`git -C ${tempDir} fetch --all --prune --tags`]: { stdout: "" },
      [`git -C ${tempDir} rev-parse @{upstream}`]: { stdout: upstreamSha },
      [`git -C ${tempDir} rev-list --max-count=1 ${upstreamSha}`]: {
        stdout: `${upstreamSha}\n`,
      },
      [`git -C ${tempDir} rebase ${upstreamSha}`]: { stdout: "" },
      "pnpm install": { stdout: "" },
      "pnpm build:app": { stdout: "" },
      "pnpm lint": { code: 1, stderr: "lint should not run by default" },
      "pnpm ui:build": { stdout: "" },
      [`${process.execPath} ${path.join(tempDir, "fased.mjs")} doctor --non-interactive --fix`]: {
        stdout: "",
      },
    });

    const result = await runWithRunner(runner, { channel: "dev" });

    expect(result.status).toBe("ok");
    expect(calls).not.toContain("pnpm lint");
    expect(calls).toContain(`git -C ${tempDir} rebase ${upstreamSha}`);
    expect(calls).toContain("pnpm build:app");
    expect(calls).not.toContain("pnpm ui:build");
  });

  it("runs dev preflight lint only when explicitly enabled", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    const upstreamSha = "upstream123";
    const { runner, calls } = createRunner({
      ...buildGitWorktreeProbeResponses(),
      [`git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`]: {
        stdout: "origin/main",
      },
      [`git -C ${tempDir} fetch --all --prune --tags`]: { stdout: "" },
      [`git -C ${tempDir} rev-parse @{upstream}`]: { stdout: upstreamSha },
      [`git -C ${tempDir} rev-list --max-count=1 ${upstreamSha}`]: {
        stdout: `${upstreamSha}\n`,
      },
      "pnpm install": { stdout: "" },
      "pnpm build:app": { stdout: "" },
      "pnpm lint": { code: 1, stderr: "intentional lint failure" },
    });

    const result = await withEnvAsync({ FASED_UPDATE_PREFLIGHT_LINT: "1" }, async () =>
      runWithRunner(runner, { channel: "dev" }),
    );

    expect(result.status).toBe("error");
    expect(result.reason).toBe("preflight-no-good-commit");
    expect(calls).toContain("pnpm lint");
    expect(calls.some((call) => call.includes("rebase"))).toBe(false);
  });

  it("tries older dev candidates only when safe fallback is enabled", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    await setupUiIndex();
    const newestSha = "newest123";
    const olderSha = "older456";
    const calls: string[] = [];
    let installCount = 0;
    const runner = async (argv: string[]) => {
      const key = argv.join(" ");
      calls.push(key);

      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return { stdout: tempDir, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return { stdout: "before-sha", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref HEAD`) {
        return { stdout: "main", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`) {
        return { stdout: "origin/main", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse @{upstream}`) {
        return { stdout: newestSha, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-list --max-count=10 ${newestSha}`) {
        return { stdout: `${newestSha}\n${olderSha}\n`, stderr: "", code: 0 };
      }
      if (key.includes(" worktree add --detach ")) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key.includes(` checkout --detach ${newestSha}`)) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key.includes(` checkout --detach ${olderSha}`)) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm install") {
        installCount += 1;
        return installCount === 1
          ? { stdout: "", stderr: "network blip", code: 1 }
          : { stdout: "", stderr: "", code: 0 };
      }
      if (key === "pnpm build:app") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key.includes(" worktree remove --force ")) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} worktree prune`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rebase ${olderSha}`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (
        key ===
        `${process.execPath} ${path.join(tempDir, "fased.mjs")} doctor --non-interactive --fix`
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return { stdout: olderSha, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runWithCommand(runner, {
      channel: "dev",
      allowDevFallback: true,
    });

    expect(result.status).toBe("ok");
    expect(calls).toContain(`git -C ${tempDir} rev-list --max-count=10 ${newestSha}`);
    expect(calls.some((call) => call.includes(`checkout --detach ${newestSha}`))).toBe(true);
    expect(calls.some((call) => call.includes(`checkout --detach ${olderSha}`))).toBe(true);
    expect(calls).toContain(`git -C ${tempDir} rebase ${olderSha}`);
  });

  it("aborts rebase on failure", async () => {
    await setupGitCheckout();
    const { runner, calls } = createRunner({
      ...buildGitWorktreeProbeResponses(),
      [`git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`]: {
        stdout: "origin/main",
      },
      [`git -C ${tempDir} fetch --all --prune --tags`]: { stdout: "" },
      [`git -C ${tempDir} rev-parse @{upstream}`]: { stdout: "upstream123" },
      [`git -C ${tempDir} rev-list --max-count=1 upstream123`]: { stdout: "upstream123\n" },
      [`git -C ${tempDir} rebase upstream123`]: { code: 1, stderr: "conflict" },
      [`git -C ${tempDir} rebase --abort`]: { stdout: "" },
    });

    const result = await runWithRunner(runner, { channel: "dev" });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("rebase-failed");
    expect(calls.some((call) => call.includes("rebase --abort"))).toBe(true);
  });

  it("returns error and stops early when deps install fails", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    const stableTag = "v1.0.1-1";
    const { runner, calls } = createRunner({
      ...buildStableTagResponses(stableTag),
      "pnpm install": { code: 1, stderr: "ERR_PNPM_NETWORK" },
    });

    const result = await runWithRunner(runner, { channel: "stable" });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("deps-install-failed");
    expect(calls.some((call) => call === "pnpm build:app")).toBe(false);
    expect(calls.some((call) => call === "pnpm ui:build")).toBe(false);
  });

  it("returns error and stops early when build fails", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    const stableTag = "v1.0.1-1";
    const { runner, calls } = createRunner({
      ...buildStableTagResponses(stableTag),
      "pnpm install": { stdout: "" },
      "pnpm build:app": { code: 1, stderr: "tsc: error TS2345" },
    });

    const result = await runWithRunner(runner, { channel: "stable" });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("build-app-failed");
    expect(calls.some((call) => call === "pnpm install")).toBe(true);
    expect(calls.some((call) => call === "pnpm ui:build")).toBe(false);
  });

  it("uses stable tag when beta tag is older than release", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    await setupUiIndex();
    const stableTag = "v1.0.1-1";
    const betaTag = "v1.0.0-beta.2";
    const { runner, calls } = createRunner({
      ...buildStableTagResponses(stableTag, { additionalTags: [betaTag] }),
      "pnpm install": { stdout: "" },
      "pnpm build:app": { stdout: "" },
      "pnpm ui:build": { stdout: "" },
      [`${process.execPath} ${path.join(tempDir, "fased.mjs")} doctor --non-interactive --fix`]: {
        stdout: "",
      },
    });

    const result = await runWithRunner(runner, { channel: "beta" });

    expect(result.status).toBe("ok");
    expect(calls).toContain(`git -C ${tempDir} checkout --detach ${stableTag}`);
    expect(calls).not.toContain(`git -C ${tempDir} checkout --detach ${betaTag}`);
  });

  it("skips update when no git root", async () => {
    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "fased", packageManager: "pnpm@8.0.0" }),
      "utf-8",
    );
    await fs.writeFile(path.join(tempDir, "pnpm-lock.yaml"), "", "utf-8");
    const { runner, calls } = createRunner({
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { code: 1 },
      "npm root -g": { code: 1 },
      "pnpm root -g": { code: 1 },
    });

    const result = await runWithRunner(runner);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("not-git-install");
    expect(calls.some((call) => call.startsWith("pnpm add -g"))).toBe(false);
    expect(calls.some((call) => call.startsWith("npm i -g"))).toBe(false);
  });

  async function runNpmGlobalUpdateCase(params: {
    expectedInstallCommand: string;
    channel?: "stable" | "beta";
    tag?: string;
  }): Promise<{ calls: string[]; result: Awaited<ReturnType<typeof runGatewayUpdate>> }> {
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "fased");
    await seedGlobalPackageRoot(pkgRoot);

    const { calls, runCommand } = createGlobalInstallHarness({
      pkgRoot,
      npmRootOutput: nodeModules,
      installCommand: params.expectedInstallCommand,
      onInstall: async () => {
        await fs.writeFile(
          path.join(pkgRoot, "package.json"),
          JSON.stringify({ name: "fased", version: "2.0.0" }),
          "utf-8",
        );
      },
    });

    const result = await runWithCommand(runCommand, {
      cwd: pkgRoot,
      channel: params.channel,
      tag: params.tag,
    });

    return { calls, result };
  }

  const createGlobalInstallHarness = (params: {
    pkgRoot: string;
    npmRootOutput?: string;
    installCommand: string;
    onInstall?: () => Promise<void>;
  }) => {
    const calls: string[] = [];
    const runCommand = async (argv: string[]) => {
      const key = argv.join(" ");
      calls.push(key);
      if (key === `git -C ${params.pkgRoot} rev-parse --show-toplevel`) {
        return { stdout: "", stderr: "not a git repository", code: 128 };
      }
      if (key === "npm root -g") {
        if (params.npmRootOutput) {
          return { stdout: params.npmRootOutput, stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 1 };
      }
      if (key === "pnpm root -g") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (key === params.installCommand) {
        await params.onInstall?.();
        return { stdout: "ok", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    return { calls, runCommand };
  };

  it.each([
    {
      title: "updates global npm installs when detected",
      expectedInstallCommand: "npm i -g fased@latest --no-fund --no-audit --loglevel=error",
    },
    {
      title: "uses update channel for global npm installs when tag is omitted",
      expectedInstallCommand: "npm i -g fased@beta --no-fund --no-audit --loglevel=error",
      channel: "beta" as const,
    },
    {
      title: "updates global npm installs with tag override",
      expectedInstallCommand: "npm i -g fased@beta --no-fund --no-audit --loglevel=error",
      tag: "beta",
    },
  ])("$title", async ({ expectedInstallCommand, channel, tag }) => {
    const { calls, result } = await runNpmGlobalUpdateCase({
      expectedInstallCommand,
      channel,
      tag,
    });

    expect(result.status).toBe("ok");
    expect(result.mode).toBe("npm");
    expect(result.before?.version).toBe("1.0.0");
    expect(result.after?.version).toBe("2.0.0");
    expect(calls.some((call) => call === expectedInstallCommand)).toBe(true);
  });

  it("cleans stale npm rename dirs before global update", async () => {
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "fased");
    const staleDir = path.join(nodeModules, ".fased-stale");
    await fs.mkdir(staleDir, { recursive: true });
    await seedGlobalPackageRoot(pkgRoot);

    let stalePresentAtInstall = true;
    const runCommand = async (argv: string[]) => {
      const key = argv.join(" ");
      if (key === `git -C ${pkgRoot} rev-parse --show-toplevel`) {
        return { stdout: "", stderr: "not a git repository", code: 128 };
      }
      if (key === "npm root -g") {
        return { stdout: nodeModules, stderr: "", code: 0 };
      }
      if (key === "pnpm root -g") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (key === "npm i -g fased@latest --no-fund --no-audit --loglevel=error") {
        stalePresentAtInstall = await pathExists(staleDir);
        return { stdout: "ok", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runWithCommand(runCommand, { cwd: pkgRoot });

    expect(result.status).toBe("ok");
    expect(stalePresentAtInstall).toBe(false);
    expect(await pathExists(staleDir)).toBe(false);
  });

  it("retries global npm update with --omit=optional when initial install fails", async () => {
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "fased");
    await seedGlobalPackageRoot(pkgRoot);

    let firstAttempt = true;
    const runCommand = async (argv: string[]) => {
      const key = argv.join(" ");
      if (key === `git -C ${pkgRoot} rev-parse --show-toplevel`) {
        return { stdout: "", stderr: "not a git repository", code: 128 };
      }
      if (key === "npm root -g") {
        return { stdout: nodeModules, stderr: "", code: 0 };
      }
      if (key === "pnpm root -g") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (key === "npm i -g fased@latest --no-fund --no-audit --loglevel=error") {
        firstAttempt = false;
        return { stdout: "", stderr: "node-gyp failed", code: 1 };
      }
      if (key === "npm i -g fased@latest --omit=optional --no-fund --no-audit --loglevel=error") {
        await fs.writeFile(
          path.join(pkgRoot, "package.json"),
          JSON.stringify({ name: "fased", version: "2.0.0" }),
          "utf-8",
        );
        return { stdout: "ok", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runWithCommand(runCommand, { cwd: pkgRoot });

    expect(firstAttempt).toBe(false);
    expect(result.status).toBe("ok");
    expect(result.mode).toBe("npm");
    expect(result.steps.map((s) => s.name)).toEqual([
      "global update",
      "global update (omit optional)",
    ]);
  });

  it("updates global bun installs when detected", async () => {
    const bunInstall = path.join(tempDir, "bun-install");
    await withEnvAsync({ BUN_INSTALL: bunInstall }, async () => {
      const bunGlobalRoot = path.join(bunInstall, "install", "global", "node_modules");
      const pkgRoot = path.join(bunGlobalRoot, "fased");
      await seedGlobalPackageRoot(pkgRoot);

      const { calls, runCommand } = createGlobalInstallHarness({
        pkgRoot,
        installCommand: "bun add -g fased@latest",
        onInstall: async () => {
          await fs.writeFile(
            path.join(pkgRoot, "package.json"),
            JSON.stringify({ name: "fased", version: "2.0.0" }),
            "utf-8",
          );
        },
      });

      const result = await runWithCommand(runCommand, { cwd: pkgRoot });

      expect(result.status).toBe("ok");
      expect(result.mode).toBe("bun");
      expect(result.before?.version).toBe("1.0.0");
      expect(result.after?.version).toBe("2.0.0");
      expect(calls.some((call) => call === "bun add -g fased@latest")).toBe(true);
    });
  });

  it("rejects git roots that are not a fased checkout", async () => {
    await fs.mkdir(path.join(tempDir, ".git"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
    const { runner, calls } = createRunner({
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
    });

    const result = await runWithRunner(runner);

    cwdSpy.mockRestore();

    expect(result.status).toBe("error");
    expect(result.reason).toBe("not-fased-root");
    expect(calls.some((call) => call.includes("status --porcelain"))).toBe(false);
  });

  it("fails with a clear reason when fased.mjs is missing", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    await fs.rm(path.join(tempDir, "fased.mjs"), { force: true });

    const stableTag = "v1.0.1-1";
    const { runner } = createRunner({
      ...buildStableTagResponses(stableTag),
      "pnpm install": { stdout: "" },
      "pnpm build:app": { stdout: "" },
      "pnpm ui:build": { stdout: "" },
    });

    const result = await runWithRunner(runner, { channel: "stable" });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("doctor-entry-missing");
    expect(result.steps.at(-1)?.name).toBe("fased doctor entry");
  });

  it("repairs UI assets when doctor run removes control-ui files", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    const uiIndexPath = await setupUiIndex();

    const stableTag = "v1.0.1-1";
    const { runCommand, calls, doctorKey, getUiBuildCount } = createStableTagRunner({
      stableTag,
      uiIndexPath,
      onUiBuild: async (count) => {
        await fs.mkdir(path.dirname(uiIndexPath), { recursive: true });
        await fs.writeFile(uiIndexPath, `<html>${count}</html>`, "utf-8");
      },
      onDoctor: removeControlUiAssets,
    });

    const result = await runWithCommand(runCommand, { channel: "stable" });

    expect(result.status).toBe("ok");
    expect(getUiBuildCount()).toBe(1);
    expect(await pathExists(uiIndexPath)).toBe(true);
    expect(calls).toContain(doctorKey);
  });

  it("fails when UI assets are still missing after post-doctor repair", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    const uiIndexPath = await setupUiIndex();

    const stableTag = "v1.0.1-1";
    const { runCommand } = createStableTagRunner({
      stableTag,
      uiIndexPath,
      onUiBuild: async () => {},
      onDoctor: removeControlUiAssets,
    });

    const result = await runWithCommand(runCommand, { channel: "stable" });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("ui-assets-missing");
  });
});
