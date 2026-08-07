import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { MANAGED_UPDATER_SUPPORT_FILES } from "./fased-managed-updater-core.mjs";
import { capabilitiesDigest } from "./hosted-release-manifest.mjs";
import { installManagedRuntime, rollbackManagedRuntime } from "./install-managed-runtime.mjs";
import {
  buildManagedInstallManifest,
  inspectManagedInstallManifest,
  normalizeManagedProfile,
  readManagedInstallManifest,
  resolveManagedRuntimePaths,
} from "./managed-runtime-layout.mjs";
import { writeManagedUpdaterReleaseDescriptor } from "./managed-updater-bundle.mjs";
import { MANAGED_UPDATER_COMPATIBILITY_FILES } from "./managed-updater-bundle.mjs";

function writeRuntime(packageRoot: string, version: string, options: { attested?: boolean } = {}) {
  fs.mkdirSync(path.join(packageRoot, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "dist", "control-ui"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@fased/fased", version })}\n`,
  );
  fs.writeFileSync(path.join(packageRoot, "fased.mjs"), "#!/usr/bin/env node\n");
  fs.writeFileSync(
    path.join(packageRoot, "dist", "control-ui", "version.json"),
    `${JSON.stringify({ version })}\n`,
  );
  const dependencyHash = "a".repeat(64);
  const commit = "e".repeat(40);
  if (options.attested) {
    const capabilities = {
      protocol: { current: 2, min: 2, max: 2 },
      nativeFeeReservationLamports: 5_000_000,
      intentTypes: ["solana.nativeTransfer"],
      operationStates: ["reserved"],
      features: ["failClosedPolicies"],
    };
    const artifact = { asset: "app.tar.gz", sha256: "b".repeat(64) };
    const dependencies = {
      asset: "deps.tar.gz",
      sha256: "c".repeat(64),
      dependencyHash,
    };
    const platforms = Object.fromEntries(
      ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"].map((platform) => [
        platform,
        { asset: `fased-signerd-${platform}`, sha256: "d".repeat(64) },
      ]),
    );
    fs.writeFileSync(
      path.join(packageRoot, ".fased-hosted-runtime.json"),
      `${JSON.stringify({ schemaVersion: 2, version, commit, dependencyHash })}\n`,
    );
    fs.writeFileSync(
      path.join(packageRoot, ".fased-hosted-release-v2.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        release: { version, tag: `v${version}`, commit },
        application: {
          linux: {
            x64: { artifact, dependencies },
            arm64: { artifact: { ...artifact, asset: "app-arm64.tar.gz" }, dependencies },
          },
        },
        signer: {
          release: {
            version,
            commit,
            buildInputDigest: `sha256:${"f".repeat(64)}`,
            development: false,
          },
          capabilities,
          capabilitiesDigest: capabilitiesDigest(capabilities),
          platforms,
        },
      })}\n`,
    );
  } else {
    fs.writeFileSync(
      path.join(packageRoot, ".fased-hosted-runtime.json"),
      `${JSON.stringify({ schemaVersion: 1, dependencyHash })}\n`,
    );
  }
  for (const script of [
    "fased-managed-launcher.sh",
    "fased-managed-service.sh",
    "fased-managed-updater.mjs",
    ...MANAGED_UPDATER_SUPPORT_FILES,
    "managed-updater-bundle.mjs",
    "managed-updater-bundle.v1.json",
    "start-managed.sh",
  ]) {
    const source = path.join(import.meta.dirname, script);
    fs.copyFileSync(source, path.join(packageRoot, "scripts", script));
    fs.chmodSync(path.join(packageRoot, "scripts", script), 0o755);
  }
}

describe("managed installation manifest inspection", () => {
  it("fails closed on unknown newer schemas without normalizing them to Local", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-newer-manifest-"));
    const manifestPath = path.join(root, "install.json");
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 999,
        profile: "protected-local",
        runtime: { activeVersion: "9.9.9" },
      })}\n`,
    );
    expect(inspectManagedInstallManifest(manifestPath)).toEqual({
      status: "unsupported-newer",
      reason: "unsupported_newer_manifest_schema",
      schemaVersion: 999,
    });
    expect(readManagedInstallManifest(manifestPath)).toBeNull();
  });

  it("rejects a symlinked installation manifest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-symlink-manifest-"));
    const target = path.join(root, "target.json");
    const manifestPath = path.join(root, "install.json");
    fs.writeFileSync(
      target,
      `${JSON.stringify({
        schemaVersion: 2,
        profile: "local",
        runtime: { activeVersion: "1.2.3" },
      })}\n`,
    );
    fs.symlinkSync(target, manifestPath);
    expect(inspectManagedInstallManifest(manifestPath)).toEqual({
      status: "invalid",
      reason: "unsafe_manifest_file",
    });
  });
});

function createFixture(version: string, options: { attested?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-managed-layout-"));
  const stateDir = path.join(root, "home", ".fased");
  const prefix = path.join(stateDir, "install-cache", "npm-global");
  const paths = resolveManagedRuntimePaths({ stateDir, prefix });
  writeRuntime(paths.compatibilityPackageRoot, version, options);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "wallet-state-preserved"), "unchanged\n");
  return { root, stateDir, prefix, paths };
}

async function writeSchemaV2Metadata(packageRoot: string, version: string) {
  fs.writeFileSync(
    path.join(packageRoot, ".fased-hosted-runtime.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      version,
      commit: "e".repeat(40),
      dependencyHash: "a".repeat(64),
    })}\n`,
  );
  await writeManagedUpdaterReleaseDescriptor({
    runtimeRoot: packageRoot,
    architecture: process.arch,
  });
}

describe("managed runtime layout", () => {
  it("preserves the exact protected Local system service identity", () => {
    const fixture = createFixture("1.2.3");
    const service = {
      name: "fased-gateway-0123456789abcdef.service",
      scope: "system",
      launcher: "/opt/fased/local/0123456789abcdef/gateway-launch", // pragma: allowlist secret
    };
    expect(normalizeManagedProfile("protected-local")).toBe("protected-local");
    expect(
      buildManagedInstallManifest({
        paths: fixture.paths,
        profile: "protected-local",
        version: "1.2.3",
        dependencyHash: "a".repeat(64),
        previousVersion: null,
        service,
      }),
    ).toMatchObject({
      profile: "protected-local",
      service,
    });
  });

  it("moves a package into a versioned release and installs stable launchers", async () => {
    const fixture = createFixture("1.2.3");
    await installManagedRuntime({
      packageRoot: fixture.paths.compatibilityPackageRoot,
      stateDir: fixture.stateDir,
      prefix: fixture.prefix,
      profile: "local",
      updateChannel: "beta",
    });

    const manifest = readManagedInstallManifest(fixture.paths.manifestPath);
    expect(manifest?.runtime.activeVersion).toBe("1.2.3");
    expect(manifest?.service.scope).toBe("user");
    expect(manifest?.update?.channel).toBe("beta");
    expect(fs.realpathSync(fixture.paths.currentLink)).toBe(
      path.join(fixture.paths.releasesDir, "1.2.3"),
    );
    expect(fs.realpathSync(fixture.paths.compatibilityPackageRoot)).toBe(
      path.join(fixture.paths.releasesDir, "1.2.3"),
    );
    expect(fs.realpathSync(fixture.paths.prefixLauncherPath)).toBe(fixture.paths.launcherPath);
    expect(fs.readFileSync(path.join(fixture.stateDir, "wallet-state-preserved"), "utf8")).toBe(
      "unchanged\n",
    );
    const updaterGeneration = fs.realpathSync(path.join(fixture.paths.updaterDir, "current"));
    for (const name of ["fased-managed-updater.mjs", ...MANAGED_UPDATER_SUPPORT_FILES]) {
      expect(fs.existsSync(path.join(updaterGeneration, name))).toBe(true);
    }
    for (const name of MANAGED_UPDATER_COMPATIBILITY_FILES) {
      expect(fs.existsSync(path.join(fixture.paths.updaterDir, name))).toBe(true);
    }
    const bootstrap = await import(`${pathToFileURL(fixture.paths.updaterPath).href}?installed=1`);
    const selectedCore = await bootstrap.resolveManagedUpdaterCore({
      entrypointPath: fixture.paths.updaterPath,
      stateDir: fixture.stateDir,
    });
    await expect(
      import(`${pathToFileURL(selectedCore).href}?installed-core=1`),
    ).resolves.toMatchObject({
      MANAGED_UPDATER_SUPPORT_FILES,
    });
  });

  it("installs a schema-v2 app artifact locally without a Hosting release manifest", async () => {
    const fixture = createFixture("1.2.3");
    await writeSchemaV2Metadata(fixture.paths.compatibilityPackageRoot, "1.2.3");

    await installManagedRuntime({
      packageRoot: fixture.paths.compatibilityPackageRoot,
      stateDir: fixture.stateDir,
      prefix: fixture.prefix,
      profile: "local",
    });

    const manifest = readManagedInstallManifest(fixture.paths.manifestPath);
    expect(manifest?.profile).toBe("local");
    expect(manifest?.runtime.activeVersion).toBe("1.2.3");
    expect(manifest?.runtime.appCommit).toBeNull();
    expect(manifest?.release).toBeNull();

    fs.unlinkSync(fixture.paths.compatibilityPackageRoot);
    writeRuntime(fixture.paths.compatibilityPackageRoot, "1.2.4");
    await writeSchemaV2Metadata(fixture.paths.compatibilityPackageRoot, "1.2.4");
    await installManagedRuntime({
      packageRoot: fixture.paths.compatibilityPackageRoot,
      stateDir: fixture.stateDir,
      prefix: fixture.prefix,
      profile: "local",
    });
    expect(readManagedInstallManifest(fixture.paths.manifestPath)?.runtime.activeVersion).toBe(
      "1.2.4",
    );

    await rollbackManagedRuntime({ stateDir: fixture.stateDir, prefix: fixture.prefix });
    expect(readManagedInstallManifest(fixture.paths.manifestPath)?.runtime.activeVersion).toBe(
      "1.2.3",
    );
  });

  it("retains exactly one previous runtime when activating a later release", async () => {
    const fixture = createFixture("1.2.3");
    await installManagedRuntime({
      packageRoot: fixture.paths.compatibilityPackageRoot,
      stateDir: fixture.stateDir,
      prefix: fixture.prefix,
      profile: "hosting",
    });

    fs.unlinkSync(fixture.paths.compatibilityPackageRoot);
    writeRuntime(fixture.paths.compatibilityPackageRoot, "1.2.4", { attested: true });
    await writeManagedUpdaterReleaseDescriptor({
      runtimeRoot: fixture.paths.compatibilityPackageRoot,
      architecture: process.arch,
    });
    await installManagedRuntime({
      packageRoot: fixture.paths.compatibilityPackageRoot,
      stateDir: fixture.stateDir,
      prefix: fixture.prefix,
      profile: "hosting",
    });

    const manifest = readManagedInstallManifest(fixture.paths.manifestPath);
    expect(manifest?.runtime.activeVersion).toBe("1.2.4");
    expect(manifest?.runtime.previousVersion).toBe("1.2.3");
    expect(manifest?.service.scope).toBe("system");
    expect(fs.realpathSync(fixture.paths.currentLink)).toBe(
      path.join(fixture.paths.releasesDir, "1.2.4"),
    );
    expect(fs.realpathSync(fixture.paths.previousLink)).toBe(
      path.join(fixture.paths.releasesDir, "1.2.3"),
    );

    await rollbackManagedRuntime({ stateDir: fixture.stateDir, prefix: fixture.prefix });
    const rolledBack = readManagedInstallManifest(fixture.paths.manifestPath);
    expect(rolledBack?.runtime.activeVersion).toBe("1.2.3");
    expect(rolledBack?.runtime.previousVersion).toBe("1.2.4");
    expect(fs.realpathSync(fixture.paths.currentLink)).toBe(
      path.join(fixture.paths.releasesDir, "1.2.3"),
    );
  });

  it("keeps the newest stable updater when rolling back to a historical runtime", async () => {
    const fixture = createFixture("1.2.3");
    await installManagedRuntime({
      packageRoot: fixture.paths.compatibilityPackageRoot,
      stateDir: fixture.stateDir,
      prefix: fixture.prefix,
      profile: "local",
    });
    const historicalRoot = fs.realpathSync(fixture.paths.currentLink);
    fs.unlinkSync(path.join(historicalRoot, "scripts", "hosted-release-manifest.mjs"));

    fs.unlinkSync(fixture.paths.compatibilityPackageRoot);
    writeRuntime(fixture.paths.compatibilityPackageRoot, "1.2.4");
    fs.appendFileSync(
      path.join(fixture.paths.compatibilityPackageRoot, "scripts", "fased-managed-updater.mjs"),
      "\n// newest-stable-controller\n",
    );
    await installManagedRuntime({
      packageRoot: fixture.paths.compatibilityPackageRoot,
      stateDir: fixture.stateDir,
      prefix: fixture.prefix,
      profile: "local",
    });
    const stableUpdater = fs.readFileSync(fixture.paths.updaterPath, "utf8");

    await rollbackManagedRuntime({ stateDir: fixture.stateDir, prefix: fixture.prefix });

    expect(readManagedInstallManifest(fixture.paths.manifestPath)?.runtime.activeVersion).toBe(
      "1.2.3",
    );
    expect(fs.readFileSync(fixture.paths.updaterPath, "utf8")).toBe(stableUpdater);
    expect(fs.readFileSync(fixture.paths.updaterPath, "utf8")).toContain(
      "newest-stable-controller",
    );
  });

  it("hands an existing hosting runtime to the prepared cross-user transaction", async () => {
    const fixture = createFixture("1.2.3", { attested: true });
    await writeManagedUpdaterReleaseDescriptor({
      runtimeRoot: fixture.paths.compatibilityPackageRoot,
      architecture: process.arch,
    });
    await installManagedRuntime({
      packageRoot: fixture.paths.compatibilityPackageRoot,
      stateDir: fixture.stateDir,
      prefix: fixture.prefix,
      profile: "hosting",
    });
    const previousRoot = fs.realpathSync(fixture.paths.currentLink);

    fs.unlinkSync(fixture.paths.compatibilityPackageRoot);
    writeRuntime(fixture.paths.compatibilityPackageRoot, "1.2.4", { attested: true });
    fs.appendFileSync(
      path.join(fixture.paths.compatibilityPackageRoot, "scripts", "fased-managed-updater.mjs"),
      "\n// transaction-target\n",
    );
    await writeManagedUpdaterReleaseDescriptor({
      runtimeRoot: fixture.paths.compatibilityPackageRoot,
      architecture: process.arch,
    });

    let transaction;
    let activeRootDuringHandoff;
    let stableUpdaterDuringHandoff;
    const result = await installManagedRuntime(
      {
        packageRoot: fixture.paths.compatibilityPackageRoot,
        stateDir: fixture.stateDir,
        prefix: fixture.prefix,
        profile: "hosting",
        hostTransactionId: "4f18fd75-a9ee-4dc3-a4e8-6a7e86ab3e4d",
        hostTransactionVersion: "1.2.4",
      },
      {
        beginPreactivatedHostedTransaction: async (params) => {
          transaction = params;
          activeRootDuringHandoff = fs.realpathSync(params.paths.currentLink);
          stableUpdaterDuringHandoff = fs.readFileSync(params.paths.updaterPath, "utf8");
          fs.unlinkSync(params.paths.currentLink);
          fs.symlinkSync(params.targetRoot, params.paths.currentLink, "dir");
          fs.symlinkSync(params.paths.currentLink, params.paths.compatibilityPackageRoot, "dir");
          fs.writeFileSync(
            params.paths.manifestPath,
            `${JSON.stringify(params.nextManifest, null, 2)}\n`,
          );
        },
      },
    );

    expect(result.hostTransaction).toBe(true);
    expect(activeRootDuringHandoff).toBe(previousRoot);
    expect(stableUpdaterDuringHandoff).not.toContain("transaction-target");
    expect(
      fs.readFileSync(
        path.join(transaction.targetRoot, "scripts", "fased-managed-updater.mjs"),
        "utf8",
      ),
    ).toContain("transaction-target");
    expect(transaction).toMatchObject({
      transactionId: "4f18fd75-a9ee-4dc3-a4e8-6a7e86ab3e4d",
      targetVersion: "1.2.4",
      previousVersion: "1.2.3",
      previousRoot,
    });
    expect(fs.realpathSync(fixture.paths.currentLink)).toBe(transaction.targetRoot);
  });

  it("leaves a fresh hosting install under the root installer's signer transaction", async () => {
    const fixture = createFixture("1.2.3", { attested: true });
    await writeManagedUpdaterReleaseDescriptor({
      runtimeRoot: fixture.paths.compatibilityPackageRoot,
      architecture: process.arch,
    });
    let coordinated = false;
    const result = await installManagedRuntime(
      {
        packageRoot: fixture.paths.compatibilityPackageRoot,
        stateDir: fixture.stateDir,
        prefix: fixture.prefix,
        profile: "hosting",
        hostTransactionId: "0ca04df5-a044-45b0-856d-b28b10fc778f",
        hostTransactionVersion: "1.2.3",
      },
      {
        authorizePreactivatedHostedGateway: async () => ({
          release: {
            version: "1.2.3",
            commit: "e".repeat(40),
            buildInputDigest: `sha256:${"f".repeat(64)}`,
            development: false,
          },
        }),
        beginPreactivatedHostedTransaction: async () => {
          coordinated = true;
        },
      },
    );

    expect(result.hostTransaction).toBe(false);
    expect(coordinated).toBe(false);
    expect(fs.realpathSync(fixture.paths.currentLink)).toBe(
      path.join(fixture.paths.releasesDir, "1.2.3"),
    );
  });

  it("rehydrates the same version and keeps the displaced runtime for rollback", async () => {
    const fixture = createFixture("1.2.3");
    await installManagedRuntime({
      packageRoot: fixture.paths.compatibilityPackageRoot,
      stateDir: fixture.stateDir,
      prefix: fixture.prefix,
      profile: "local",
    });
    const originalRoot = fs.realpathSync(fixture.paths.currentLink);
    fs.writeFileSync(path.join(originalRoot, "release-marker"), "old\n");

    fs.unlinkSync(fixture.paths.compatibilityPackageRoot);
    writeRuntime(fixture.paths.compatibilityPackageRoot, "1.2.3");
    fs.writeFileSync(
      path.join(fixture.paths.compatibilityPackageRoot, "release-marker"),
      "repaired\n",
    );
    await installManagedRuntime({
      packageRoot: fixture.paths.compatibilityPackageRoot,
      stateDir: fixture.stateDir,
      prefix: fixture.prefix,
      profile: "local",
    });

    expect(fs.readFileSync(path.join(fixture.paths.currentLink, "release-marker"), "utf8")).toBe(
      "repaired\n",
    );
    expect(fs.readFileSync(path.join(fixture.paths.previousLink, "release-marker"), "utf8")).toBe(
      "old\n",
    );
    expect(readManagedInstallManifest(fixture.paths.manifestPath)?.runtime.previousVersion).toBe(
      "1.2.3",
    );

    await rollbackManagedRuntime({ stateDir: fixture.stateDir, prefix: fixture.prefix });
    expect(fs.readFileSync(path.join(fixture.paths.currentLink, "release-marker"), "utf8")).toBe(
      "old\n",
    );
  });
});
