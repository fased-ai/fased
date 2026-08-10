import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { installManagedRuntime, rollbackManagedRuntime } from "./install-managed-runtime.mjs";
import {
  inspectManagedInstallManifest,
  readManagedInstallManifest,
  resolveManagedRuntimePaths,
} from "./managed-runtime-layout.mjs";
import { MANAGED_UPDATER_COMPATIBILITY_FILES } from "./managed-updater-bundle.mjs";

const SUPPORT_FILES = [
  "fased-generation-updater-core.mjs",
  "generation-updater.mjs",
  "hosted-release-manifest.mjs",
  "lifecycle-trust-crypto.mjs",
  "lifecycle-trust-policy.mjs",
  "lifecycle-trust-root.mjs",
  "lifecycle-trust-runtime.mjs",
  "managed-runtime-layout.mjs",
] as const;

function writeRuntime(packageRoot: string, version: string) {
  fs.mkdirSync(path.join(packageRoot, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "dist", "control-ui"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@fased/fased", version })}\n`,
  );
  fs.writeFileSync(path.join(packageRoot, "fased.mjs"), "#!/usr/bin/env node\n");
  fs.writeFileSync(
    path.join(packageRoot, ".fased-hosted-runtime.json"),
    `${JSON.stringify({ schemaVersion: 1, dependencyHash: "a".repeat(64) })}\n`,
  );
  fs.writeFileSync(
    path.join(packageRoot, "dist", "control-ui", "version.json"),
    `${JSON.stringify({ version })}\n`,
  );
  for (const script of [
    "fased-managed-launcher.sh",
    "fased-managed-service.sh",
    "fased-managed-updater.mjs",
    ...SUPPORT_FILES,
    "managed-updater-bundle.mjs",
    "managed-updater-bundle.v1.json",
    "start-managed.sh",
  ]) {
    fs.copyFileSync(
      path.join(import.meta.dirname, script),
      path.join(packageRoot, "scripts", script),
    );
    fs.chmodSync(path.join(packageRoot, "scripts", script), 0o755);
  }
}

function fixture(version = "1.2.3") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-portable-layout-"));
  const stateDir = path.join(root, "home", ".fased");
  const prefix = path.join(stateDir, "install-cache", "npm-global");
  const paths = resolveManagedRuntimePaths({ stateDir, prefix });
  writeRuntime(paths.compatibilityPackageRoot, version);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "wallet-state-preserved"), "unchanged\n");
  return { stateDir, prefix, paths };
}

describe("portable managed runtime", () => {
  it("fails closed on unknown newer and symlinked manifests", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-portable-manifest-"));
    const manifest = path.join(root, "install.json");
    fs.writeFileSync(
      manifest,
      `${JSON.stringify({
        schemaVersion: 999,
        profile: "local",
        runtime: { activeVersion: "9.9.9" },
      })}\n`,
    );
    expect(inspectManagedInstallManifest(manifest)).toMatchObject({
      status: "unsupported-newer",
      schemaVersion: 999,
    });
    const target = path.join(root, "target.json");
    fs.renameSync(manifest, target);
    fs.symlinkSync(target, manifest);
    expect(inspectManagedInstallManifest(manifest)).toMatchObject({
      status: "invalid",
      reason: "unsafe_manifest_file",
    });
  });

  it.each(["hosting", "protected-local"])(
    "rejects the %s profile before creating runtime state",
    async (profile) => {
      const current = fixture();
      await expect(
        installManagedRuntime({
          packageRoot: current.paths.compatibilityPackageRoot,
          stateDir: current.stateDir,
          prefix: current.prefix,
          profile,
        }),
      ).rejects.toThrow(/verified Go lifecycle engine/u);
      expect(fs.existsSync(current.paths.manifestPath)).toBe(false);
      expect(fs.existsSync(current.paths.currentLink)).toBe(false);
      expect(fs.readFileSync(path.join(current.stateDir, "wallet-state-preserved"), "utf8")).toBe(
        "unchanged\n",
      );
    },
  );

  it("installs one portable Local runtime and stable updater generation", async () => {
    const current = fixture();
    await installManagedRuntime({
      packageRoot: current.paths.compatibilityPackageRoot,
      stateDir: current.stateDir,
      prefix: current.prefix,
      profile: "local",
      updateChannel: "beta",
    });
    const manifest = readManagedInstallManifest(current.paths.manifestPath);
    expect(manifest).toMatchObject({
      profile: "local",
      runtime: { activeVersion: "1.2.3" },
      update: { channel: "beta" },
    });
    expect(fs.realpathSync(current.paths.currentLink)).toBe(
      path.join(current.paths.releasesDir, "1.2.3"),
    );
    expect(fs.realpathSync(current.paths.compatibilityPackageRoot)).toBe(
      path.join(current.paths.releasesDir, "1.2.3"),
    );
    const updaterGeneration = fs.realpathSync(path.join(current.paths.updaterDir, "current"));
    for (const name of ["fased-managed-updater.mjs", ...SUPPORT_FILES]) {
      expect(fs.existsSync(path.join(updaterGeneration, name))).toBe(true);
    }
    for (const name of MANAGED_UPDATER_COMPATIBILITY_FILES) {
      expect(fs.existsSync(path.join(current.paths.updaterDir, name))).toBe(true);
    }
    const launcher = await import(`${pathToFileURL(current.paths.updaterPath).href}?installed=1`);
    await expect(
      launcher.resolveManagedUpdaterCore({
        entrypointPath: current.paths.updaterPath,
        stateDir: current.stateDir,
      }),
    ).resolves.toMatch(/fased-generation-updater-core\.mjs$/u);
  });

  it("updates, preserves state, and rolls back one portable generation", async () => {
    const current = fixture();
    await installManagedRuntime({
      packageRoot: current.paths.compatibilityPackageRoot,
      stateDir: current.stateDir,
      prefix: current.prefix,
      profile: "local",
    });
    fs.unlinkSync(current.paths.compatibilityPackageRoot);
    writeRuntime(current.paths.compatibilityPackageRoot, "1.2.4");
    await installManagedRuntime({
      packageRoot: current.paths.compatibilityPackageRoot,
      stateDir: current.stateDir,
      prefix: current.prefix,
      profile: "local",
    });
    expect(readManagedInstallManifest(current.paths.manifestPath)?.runtime).toMatchObject({
      activeVersion: "1.2.4",
      previousVersion: "1.2.3",
    });
    expect(fs.readFileSync(path.join(current.stateDir, "wallet-state-preserved"), "utf8")).toBe(
      "unchanged\n",
    );
    await rollbackManagedRuntime({ stateDir: current.stateDir, prefix: current.prefix });
    expect(readManagedInstallManifest(current.paths.manifestPath)?.runtime).toMatchObject({
      activeVersion: "1.2.3",
      previousVersion: "1.2.4",
    });
  });
});
