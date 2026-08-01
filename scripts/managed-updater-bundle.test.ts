import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveManagedUpdaterCore } from "./fased-managed-updater.mjs";
import {
  activateManagedUpdaterGeneration,
  installManagedUpdaterCompatibilityFiles,
  restoreManagedUpdaterGeneration,
  stageManagedUpdaterGeneration,
  writeManagedUpdaterReleaseDescriptor,
} from "./managed-updater-bundle.mjs";

const FILES = [
  "fased-managed-updater.mjs",
  "fased-managed-updater-core.mjs",
  "fased-host-updaterctl.mjs",
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

  it("normalizes the generation receipt mode under a restrictive installer umask", async () => {
    const { updaterDir, firstRuntime } = await fixture();
    const previousUmask = process.umask(0o077);
    try {
      const generation = await stageManagedUpdaterGeneration({
        updaterDir,
        runtimeRoot: firstRuntime,
        durable: true,
      });
      expect(
        (await fs.stat(path.join(generation.generationDir, "managed-updater-generation.v1.json")))
          .mode & 0o777,
      ).toBe(0o644);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("repairs rollback-restricted modes only after validating the complete generation", async () => {
    const { updaterDir, firstRuntime } = await fixture();
    const first = await stageManagedUpdaterGeneration({
      updaterDir,
      runtimeRoot: firstRuntime,
      durable: true,
    });
    await Promise.all(
      first.files.map((record) =>
        fs.chmod(path.join(first.generationDir, record.name), record.mode & 0o700),
      ),
    );
    await fs.chmod(path.join(first.generationDir, "managed-updater-generation.v1.json"), 0o600);

    const repaired = await stageManagedUpdaterGeneration({
      updaterDir,
      runtimeRoot: firstRuntime,
      durable: true,
    });

    expect(repaired.generationDir).toBe(first.generationDir);
    for (const record of repaired.files) {
      expect((await fs.stat(path.join(repaired.generationDir, record.name))).mode & 0o777).toBe(
        record.mode,
      );
    }
    expect(
      (await fs.stat(path.join(repaired.generationDir, "managed-updater-generation.v1.json")))
        .mode & 0o777,
    ).toBe(0o644);
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

  it("rejects an existing generation with extra or changed files", async () => {
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
    await fs.writeFile(
      path.join(first.generationDir, "fased-managed-updater.mjs"),
      "// changed updater bytes\n",
    );
    await expect(
      stageManagedUpdaterGeneration({
        updaterDir,
        runtimeRoot: firstRuntime,
      }),
    ).rejects.toThrow(/identity is invalid/u);
  });

  it("refuses a current generation whose core no longer matches its receipt", async () => {
    const { root, updaterDir, firstRuntime } = await fixture();
    const generation = await stageManagedUpdaterGeneration({
      updaterDir,
      runtimeRoot: firstRuntime,
    });
    await installManagedUpdaterCompatibilityFiles({
      updaterDir,
      generation,
      copyExecutable,
    });
    await fs.writeFile(
      path.join(generation.generationDir, "fased-managed-updater-core.mjs"),
      "// tampered core\n",
      { mode: 0o755 },
    );

    await expect(
      resolveManagedUpdaterCore({
        entrypointPath: path.join(updaterDir, "fased-managed-updater.mjs"),
        stateDir: path.join(root, "state"),
      }),
    ).rejects.toThrow("release file identity is invalid");
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
      sourceTag: string;
      entrypoint: string;
      files: Array<{ name: string; sha256: string }>;
    };
    await fs.mkdir(updaterDir, { recursive: true });
    for (const record of fixture.files) {
      const sourceReference = `${fixture.sourceTag}:scripts/${record.name}`;
      const extracted = spawnSync("git", ["show", sourceReference], {
        cwd: sourceRoot,
        encoding: "buffer",
        maxBuffer: 4 * 1024 * 1024,
      });
      if (extracted.status !== 0 || !Buffer.isBuffer(extracted.stdout)) {
        throw new Error(
          `frozen updater source ${sourceReference} is unavailable; fetch immutable release tags before running U1`,
        );
      }
      expect(createHash("sha256").update(extracted.stdout).digest("hex")).toBe(record.sha256);
      const destination = path.join(updaterDir, record.name);
      const fixtureBytes =
        record.name === fixture.entrypoint
          ? Buffer.concat([
              extracted.stdout,
              Buffer.from(
                "\nexport { updateStableComponents as __frozenUpdateStableComponents };\n",
              ),
            ])
          : extracted.stdout;
      await fs.writeFile(destination, fixtureBytes, { mode: 0o755 });
    }

    const imported = await import(
      `${pathToFileURL(path.join(updaterDir, fixture.entrypoint)).href}?frozen=${Date.now()}`
    );
    const targetRoot = path.join(root, "state", "runtime", "releases", "target");
    const targetScripts = path.join(targetRoot, "scripts");
    await fs.mkdir(targetScripts, { recursive: true });
    for (const name of FILES) {
      await copyExecutable(path.join(sourceRoot, "scripts", name), path.join(targetScripts, name));
    }
    await fs.writeFile(
      path.join(targetRoot, "package.json"),
      `${JSON.stringify({ name: "@fased/fased", version: "0.1.76-rc.22" })}\n`,
    );
    await fs.symlink(targetRoot, path.join(root, "state", "runtime", "current"), "dir");
    await fs.writeFile(
      path.join(root, "state", "install.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        profile: "source",
        runtime: { activeVersion: "0.1.76-rc.22" },
      })}\n`,
    );
    const paths = {
      updaterDir,
      updaterPath: path.join(updaterDir, fixture.entrypoint),
      launcherPath: path.join(root, "state", "bin", "fased"),
      serviceLauncherPath: path.join(root, "state", "bin", "fased-service"),
    };
    await imported.__frozenUpdateStableComponents(paths, targetRoot, true);

    const bootstrap = await import(
      `${pathToFileURL(paths.updaterPath).href}?bootstrap=${Date.now()}`
    );
    const selectedCore = await bootstrap.__testing.resolveManagedUpdaterCore({
      entrypointPath: paths.updaterPath,
      stateDir: path.join(root, "state"),
    });
    expect(selectedCore).toBe(path.join(targetScripts, "fased-managed-updater-core.mjs"));
    const target = await import(`${pathToFileURL(selectedCore).href}?target=${Date.now()}`);
    await target.__testing.updateStableComponents(paths, targetRoot, true);

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

  it("selects only the journal-bound verified target after application rollback", async () => {
    const { root, updaterDir, firstRuntime } = await fixture();
    await makeProductionRuntime(firstRuntime);
    const stateDir = path.join(root, "state");
    const releasesDir = path.join(stateDir, "runtime", "releases");
    const previousRoot = path.join(releasesDir, "0.1.76-rc.20");
    const targetRoot = path.join(releasesDir, "0.1.76-rc.22");
    await fs.mkdir(previousRoot, { recursive: true });
    await fs.cp(firstRuntime, targetRoot, { recursive: true });
    await fs.symlink(previousRoot, path.join(stateDir, "runtime", "current"), "dir");
    await fs.writeFile(
      path.join(stateDir, "install.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        profile: "protected-local",
        runtime: { activeVersion: "0.1.76-rc.20" },
      })}\n`,
    );
    await fs.writeFile(
      path.join(stateDir, "hosted-update-transaction.json"),
      `${JSON.stringify({ schemaVersion: 1, targetVersion: "0.1.76-rc.22" })}\n`,
    );
    await fs.mkdir(updaterDir, { recursive: true });
    const flatEntrypoint = path.join(updaterDir, "fased-managed-updater.mjs");
    await copyExecutable(
      path.join(targetRoot, "scripts", "fased-managed-updater.mjs"),
      flatEntrypoint,
    );

    await expect(
      resolveManagedUpdaterCore({
        entrypointPath: flatEntrypoint,
        stateDir,
      }),
    ).resolves.toBe(path.join(targetRoot, "scripts", "fased-managed-updater-core.mjs"));

    await fs.writeFile(
      path.join(stateDir, "hosted-update-transaction.json"),
      `${JSON.stringify({ schemaVersion: 1, targetVersion: "9.9.9" })}\n`,
    );
    await expect(
      resolveManagedUpdaterCore({
        entrypointPath: flatEntrypoint,
        stateDir,
      }),
    ).rejects.toThrow("could not locate a complete verified target updater generation");
  });
});
