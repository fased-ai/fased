import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPackageDir } from "./install-package-dir.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = path.join(os.tmpdir(), `fased-install-package-dir-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

async function writePackageSource(params: { dependencies?: Record<string, string> }) {
  const root = await makeTempDir();
  const sourceDir = path.join(root, "source");
  const targetDir = path.join(root, "target");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(
    path.join(sourceDir, "package.json"),
    JSON.stringify({
      name: "@fased/test-plugin",
      version: "0.0.1",
      ...(params.dependencies ? { dependencies: params.dependencies } : {}),
    }),
    "utf-8",
  );
  return { sourceDir, targetDir };
}

async function setupFakeNpm(params?: { exitCode?: number; stderr?: string }) {
  const root = await makeTempDir();
  const binDir = path.join(root, "bin");
  const argvLogPath = path.join(root, "npm-argv.json");
  await fs.mkdir(binDir, { recursive: true });
  const npmPath = path.join(binDir, "npm");
  await fs.writeFile(
    npmPath,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "if (process.env.FASED_TEST_NPM_ARGV_LOG) fs.writeFileSync(process.env.FASED_TEST_NPM_ARGV_LOG, JSON.stringify(process.argv.slice(2)));",
      `const stderr = ${JSON.stringify(params?.stderr ?? "")};`,
      "if (stderr) fs.writeSync(2, stderr);",
      `process.exit(${Number(params?.exitCode ?? 0)});`,
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.chmod(npmPath, 0o755);
  vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);
  vi.stubEnv("FASED_TEST_NPM_ARGV_LOG", argvLogPath);
  return { argvLogPath };
}

describe("installPackageDir", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("installs dependencies with npm error logging and scripts disabled", async () => {
    const { sourceDir, targetDir } = await writePackageSource({
      dependencies: { "left-pad": "1.3.0" },
    });
    const { argvLogPath } = await setupFakeNpm();

    const result = await installPackageDir({
      sourceDir,
      targetDir,
      mode: "install",
      timeoutMs: 1_000,
      copyErrorPrefix: "failed to copy plugin",
      hasDeps: true,
      depsLogMessage: "Installing plugin dependencies...",
    });

    expect(result).toEqual({ ok: true });
    await expect(fs.readFile(argvLogPath, "utf-8")).resolves.toBe(
      JSON.stringify(["install", "--omit=dev", "--loglevel=error", "--ignore-scripts"]),
    );
  });

  it("surfaces npm stderr when dependency install fails", async () => {
    const { sourceDir, targetDir } = await writePackageSource({
      dependencies: { bad: "workspace:^" },
    });
    await setupFakeNpm({
      exitCode: 1,
      stderr:
        'npm error code EUNSUPPORTEDPROTOCOL\nnpm error Unsupported URL Type "workspace:": workspace:^\n',
    });

    const result = await installPackageDir({
      sourceDir,
      targetDir,
      mode: "install",
      timeoutMs: 1_000,
      copyErrorPrefix: "failed to copy plugin",
      hasDeps: true,
      depsLogMessage: "Installing plugin dependencies...",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("npm install failed:");
    expect(result.error).toContain("EUNSUPPORTEDPROTOCOL");
    expect(result.error).toContain("workspace:");
  });
});
