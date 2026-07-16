import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installManagedRuntime, rollbackManagedRuntime } from "./install-managed-runtime.mjs";
import {
  readManagedInstallManifest,
  resolveManagedRuntimePaths,
} from "./managed-runtime-layout.mjs";

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
    path.join(packageRoot, "dist", "control-ui", "version.json"),
    `${JSON.stringify({ version })}\n`,
  );
  fs.writeFileSync(
    path.join(packageRoot, ".fased-hosted-runtime.json"),
    `${JSON.stringify({ schemaVersion: 1, dependencyHash: "a".repeat(64) })}\n`,
  );
  for (const script of [
    "fased-managed-launcher.sh",
    "fased-managed-service.sh",
    "fased-managed-updater.mjs",
    "managed-runtime-layout.mjs",
    "start-managed.sh",
  ]) {
    const source = path.join(import.meta.dirname, script);
    fs.copyFileSync(source, path.join(packageRoot, "scripts", script));
    fs.chmodSync(path.join(packageRoot, "scripts", script), 0o755);
  }
}

function createFixture(version: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-managed-layout-"));
  const stateDir = path.join(root, "home", ".fased");
  const prefix = path.join(stateDir, "install-cache", "npm-global");
  const paths = resolveManagedRuntimePaths({ stateDir, prefix });
  writeRuntime(paths.compatibilityPackageRoot, version);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "wallet-state-preserved"), "unchanged\n");
  return { root, stateDir, prefix, paths };
}

describe("managed runtime layout", () => {
  it("moves a package into a versioned release and installs stable launchers", async () => {
    const fixture = createFixture("1.2.3");
    await installManagedRuntime({
      packageRoot: fixture.paths.compatibilityPackageRoot,
      stateDir: fixture.stateDir,
      prefix: fixture.prefix,
      profile: "local",
    });

    const manifest = readManagedInstallManifest(fixture.paths.manifestPath);
    expect(manifest?.runtime.activeVersion).toBe("1.2.3");
    expect(manifest?.service.scope).toBe("user");
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
    writeRuntime(fixture.paths.compatibilityPackageRoot, "1.2.4");
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

  it("hands an existing hosting runtime to the prepared cross-user transaction", async () => {
    const fixture = createFixture("1.2.3");
    await installManagedRuntime({
      packageRoot: fixture.paths.compatibilityPackageRoot,
      stateDir: fixture.stateDir,
      prefix: fixture.prefix,
      profile: "hosting",
    });
    const previousRoot = fs.realpathSync(fixture.paths.currentLink);

    fs.unlinkSync(fixture.paths.compatibilityPackageRoot);
    writeRuntime(fixture.paths.compatibilityPackageRoot, "1.2.4");
    fs.appendFileSync(
      path.join(fixture.paths.compatibilityPackageRoot, "scripts", "fased-managed-updater.mjs"),
      "\n// transaction-target\n",
    );

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
    expect(stableUpdaterDuringHandoff).toContain("transaction-target");
    expect(transaction).toMatchObject({
      transactionId: "4f18fd75-a9ee-4dc3-a4e8-6a7e86ab3e4d",
      targetVersion: "1.2.4",
      previousVersion: "1.2.3",
      previousRoot,
    });
    expect(fs.realpathSync(fixture.paths.currentLink)).toBe(transaction.targetRoot);
  });

  it("leaves a fresh hosting install under the root installer's signer transaction", async () => {
    const fixture = createFixture("1.2.3");
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
        authorizePreactivatedHostedGateway: async () => undefined,
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
