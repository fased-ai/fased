import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installManagedUpdaterCompatibilityFiles,
  stageManagedUpdaterGeneration,
} from "./managed-updater-bundle.mjs";

const FILES = [
  "fased-managed-updater.mjs",
  "hosted-release-manifest.mjs",
  "lifecycle-trust-crypto.mjs",
  "lifecycle-trust-policy.mjs",
  "lifecycle-trust-root.mjs",
  "lifecycle-trust-runtime.mjs",
  "managed-runtime-layout.mjs",
];

async function writeRuntime(root: string, revision: string): Promise<void> {
  const scriptsDir = path.join(root, "scripts");
  await fs.mkdir(scriptsDir, { recursive: true });
  await Promise.all(
    FILES.map((name) =>
      fs.writeFile(path.join(scriptsDir, name), `// ${name} ${revision}\n`, {
        mode: 0o755,
      }),
    ),
  );
  await fs.writeFile(
    path.join(scriptsDir, "managed-updater-bundle.v1.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        entrypoint: "fased-managed-updater.mjs",
        files: FILES,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function copyExecutable(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp`;
  await fs.copyFile(source, temporary);
  await fs.chmod(temporary, 0o755);
  await fs.rename(temporary, destination);
}

describe("managed updater content-addressed bundle", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  async function fixture(): Promise<{
    root: string;
    updaterDir: string;
    firstRuntime: string;
    secondRuntime: string;
  }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-updater-bundle-"));
    tempDirs.push(root);
    const updaterDir = path.join(root, "state", "updater");
    const firstRuntime = path.join(root, "runtime-a");
    const secondRuntime = path.join(root, "runtime-b");
    await writeRuntime(firstRuntime, "a");
    await writeRuntime(secondRuntime, "b");
    return { root, updaterDir, firstRuntime, secondRuntime };
  }

  it("stages complete generations and switches one atomic current pointer", async () => {
    const { updaterDir, firstRuntime, secondRuntime } = await fixture();
    const first = await stageManagedUpdaterGeneration({
      updaterDir,
      runtimeRoot: firstRuntime,
      durable: true,
    });
    await installManagedUpdaterCompatibilityFiles({
      updaterDir,
      generation: first,
      copyExecutable,
      durable: true,
    });

    expect(await fs.realpath(path.join(updaterDir, "current"))).toBe(first.generationDir);
    expect(await fs.readFile(path.join(updaterDir, "fased-managed-updater.mjs"), "utf8")).toContain(
      "a",
    );
    for (const name of FILES) {
      await expect(fs.stat(path.join(first.generationDir, name))).resolves.toMatchObject({
        size: expect.any(Number),
      });
    }

    const second = await stageManagedUpdaterGeneration({
      updaterDir,
      runtimeRoot: secondRuntime,
      durable: true,
    });
    expect(second.bundleDigest).not.toBe(first.bundleDigest);
    expect(await fs.realpath(path.join(updaterDir, "current"))).toBe(second.generationDir);
    await expect(fs.stat(first.generationDir)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });

  it("does not change current when target bundle validation fails", async () => {
    const { updaterDir, firstRuntime, secondRuntime } = await fixture();
    const first = await stageManagedUpdaterGeneration({
      updaterDir,
      runtimeRoot: firstRuntime,
    });
    const manifestPath = path.join(secondRuntime, "scripts", "managed-updater-bundle.v1.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      files: string[];
    };
    manifest.files.push("missing-support.mjs");
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

    await expect(
      stageManagedUpdaterGeneration({
        updaterDir,
        runtimeRoot: secondRuntime,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.realpath(path.join(updaterDir, "current"))).toBe(first.generationDir);
  });

  it("copies compatibility support before activating the flat entrypoint", async () => {
    const { updaterDir, firstRuntime } = await fixture();
    const generation = await stageManagedUpdaterGeneration({
      updaterDir,
      runtimeRoot: firstRuntime,
    });
    const order: string[] = [];
    const copier = vi.fn(async (source: string, destination: string) => {
      order.push(path.basename(destination));
      await copyExecutable(source, destination);
    });

    await installManagedUpdaterCompatibilityFiles({
      updaterDir,
      generation,
      copyExecutable: copier,
    });

    expect(order).toEqual([
      "hosted-release-manifest.mjs",
      "managed-runtime-layout.mjs",
      "fased-managed-updater.mjs",
    ]);
  });

  it("continues from a frozen pre-manifest flat updater into a complete generation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-updater-frozen-"));
    tempDirs.push(root);
    const sourceRoot = path.resolve(import.meta.dirname, "..");
    const updaterDir = path.join(root, "state", "updater");
    const fixture = JSON.parse(
      await fs.readFile(
        path.join(import.meta.dirname, "fixtures", "managed-updater-pre-manifest.json"),
        "utf8",
      ),
    ) as {
      entrypoint: string;
      supportFiles: string[];
    };
    await fs.mkdir(updaterDir, { recursive: true });
    for (const name of [...fixture.supportFiles, fixture.entrypoint]) {
      await copyExecutable(path.join(sourceRoot, "scripts", name), path.join(updaterDir, name));
    }

    const imported = await import(
      `${pathToFileURL(path.join(updaterDir, fixture.entrypoint)).href}?frozen=${Date.now()}`
    );
    const paths = {
      updaterDir,
      updaterPath: path.join(updaterDir, fixture.entrypoint),
      launcherPath: path.join(root, "state", "bin", "fased"),
      serviceLauncherPath: path.join(root, "state", "bin", "fased-service"),
    };
    await imported.__testing.updateStableComponents(paths, sourceRoot, true);

    const generationDir = await fs.realpath(path.join(updaterDir, "current"));
    for (const name of FILES) {
      await expect(fs.stat(path.join(generationDir, name))).resolves.toMatchObject({
        size: expect.any(Number),
      });
    }
    await expect(
      import(`${pathToFileURL(paths.updaterPath).href}?converged=${Date.now()}`),
    ).resolves.toHaveProperty("__testing");
  });
});
