import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateManagedUpdaterGeneration,
  installManagedUpdaterCompatibilityFiles,
  restoreManagedUpdaterGeneration,
  stageManagedUpdaterGeneration,
  writeManagedUpdaterReleaseDescriptor,
} from "./managed-updater-bundle.mjs";

const FILES = [
  "fased-managed-updater.mjs",
  "hosted-release-manifest.mjs",
  "lifecycle-trust-crypto.mjs",
  "lifecycle-trust-policy.mjs",
  "lifecycle-trust-root.mjs",
  "lifecycle-trust-runtime.mjs",
  "managed-runtime-layout.mjs",
  "managed-updater-bundle.mjs",
  "managed-updater-bundle.v1.json",
  "fased-managed-launcher.sh",
  "fased-managed-service.sh",
];

const FILE_RECORDS = FILES.map((name) => ({
  name,
  type:
    name === "fased-managed-updater.mjs"
      ? "entrypoint"
      : name === "managed-updater-bundle.v1.json"
        ? "manifest"
        : name.endsWith(".sh")
          ? "launcher"
          : "support",
  mode: name.endsWith(".json") ? "0644" : "0755",
}));

async function writeRuntime(root: string, revision: string): Promise<void> {
  const scriptsDir = path.join(root, "scripts");
  await fs.mkdir(scriptsDir, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "@fased/fased", version: "0.1.76-rc.22" })}\n`,
  );
  await Promise.all(
    FILES.filter((name) => name !== "managed-updater-bundle.v1.json").map((name) =>
      fs.writeFile(path.join(scriptsDir, name), `// ${name} ${revision}\n`, {
        mode: 0o755,
      }),
    ),
  );
  await fs.writeFile(
    path.join(scriptsDir, "managed-updater-bundle.v1.json"),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        entrypoint: "fased-managed-updater.mjs",
        minimumSupervisorProtocol: 1,
        files: FILE_RECORDS,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function makeProductionRuntime(root: string): Promise<void> {
  await fs.writeFile(
    path.join(root, ".fased-hosted-runtime.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      version: "0.1.76-rc.22",
      commit: "a".repeat(40),
      dependencyHash: "b".repeat(64),
    })}\n`,
  );
  await writeManagedUpdaterReleaseDescriptor({
    runtimeRoot: root,
    architecture: process.arch,
  });
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
      activate: false,
    });
    await expect(fs.lstat(path.join(updaterDir, "current"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await activateManagedUpdaterGeneration({
      updaterDir,
      generationDir: first.generationDir,
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
    await expect(
      fs.stat(path.join(first.generationDir, "managed-updater-generation.v1.json")),
    ).resolves.toMatchObject({ mode: expect.any(Number) });

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
    await restoreManagedUpdaterGeneration({
      updaterDir,
      generationDir: first.generationDir,
      durable: true,
    });
    expect(await fs.realpath(path.join(updaterDir, "current"))).toBe(first.generationDir);
    await restoreManagedUpdaterGeneration({
      updaterDir,
      generationDir: null,
      durable: true,
    });
    await expect(fs.lstat(path.join(updaterDir, "current"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires the exact target-bound descriptor for a production runtime", async () => {
    const { updaterDir, firstRuntime } = await fixture();
    await makeProductionRuntime(firstRuntime);
    const staged = await stageManagedUpdaterGeneration({
      updaterDir,
      runtimeRoot: firstRuntime,
      durable: true,
      activate: false,
    });
    expect(staged.release).toMatchObject({
      version: "0.1.76-rc.22",
      commit: "a".repeat(40),
      development: false,
    });

    const descriptorPath = path.join(firstRuntime, ".fased-managed-updater-bundle.json");
    const descriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8"));
    descriptor.files[0].sha256 = "0".repeat(64);
    await fs.writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o644 });
    await expect(
      stageManagedUpdaterGeneration({
        updaterDir: path.join(path.dirname(updaterDir), "tampered-updater"),
        runtimeRoot: firstRuntime,
      }),
    ).rejects.toThrow("release descriptor is mismatched");
  });

  it("rejects an existing generation with extra, wrong-mode, or changed files", async () => {
    const { updaterDir, firstRuntime } = await fixture();
    const first = await stageManagedUpdaterGeneration({
      updaterDir,
      runtimeRoot: firstRuntime,
    });
    await fs.writeFile(path.join(first.generationDir, "unexpected.txt"), "unsafe\n");
    await expect(
      stageManagedUpdaterGeneration({
        updaterDir,
        runtimeRoot: firstRuntime,
      }),
    ).rejects.toThrow(/inventory is invalid/u);
    await fs.rm(path.join(first.generationDir, "unexpected.txt"));
    await fs.chmod(path.join(first.generationDir, "fased-managed-updater.mjs"), 0o644);
    await expect(
      stageManagedUpdaterGeneration({
        updaterDir,
        runtimeRoot: firstRuntime,
      }),
    ).rejects.toThrow(/identity is invalid/u);
  });

  it("does not change current when target bundle validation fails", async () => {
    const { updaterDir, firstRuntime, secondRuntime } = await fixture();
    const first = await stageManagedUpdaterGeneration({
      updaterDir,
      runtimeRoot: firstRuntime,
    });
    const manifestPath = path.join(secondRuntime, "scripts", "managed-updater-bundle.v1.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      files: Array<{ name: string; type: string; mode: string }>;
    };
    manifest.files.push({
      name: "missing-support.mjs",
      type: "support",
      mode: "0755",
    });
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
