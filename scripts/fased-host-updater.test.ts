import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRE_V2_HOSTING_MIGRATION_MESSAGE,
  __testing,
  assertLifecycleBootstrapBinding,
  hostingBootstrapCommand,
  installProtectedLocalApplicationRuntime,
  isMainModule,
  legacyHostingBootstrapMessage,
  parseReleaseVersion,
  parseUpdateRequest,
} from "./fased-host-updater.mjs";
import { __testing as managedUpdaterTesting } from "./fased-managed-updater.mjs";
import { capabilitiesDigest } from "./hosted-release-manifest.mjs";

const cleanupRoots: string[] = [];
const TRANSACTION_ONE = "11111111-1111-4111-8111-111111111111";
const TRANSACTION_TWO = "22222222-2222-4222-8222-222222222222";

function signerRelease(version: string) {
  return {
    version,
    commit: "a".repeat(40),
    buildInputDigest: `sha256:${"b".repeat(64)}`,
    development: false,
  };
}

async function writeProtectedApplicationFixture({
  root,
  version,
  commit,
  dependencyHash,
}: {
  root: string;
  version: string;
  commit: string;
  dependencyHash: string;
}) {
  await Promise.all([
    fsp.mkdir(path.join(root, "dist"), { recursive: true }),
    fsp.mkdir(path.join(root, "scripts"), { recursive: true }),
    fsp.mkdir(path.join(root, "node_modules"), { recursive: true }),
  ]);
  await Promise.all([
    fsp.writeFile(path.join(root, "package.json"), `${JSON.stringify({ version })}\n`),
    fsp.writeFile(
      path.join(root, "dist", "build-info.json"),
      `${JSON.stringify({ version, commit })}\n`,
    ),
    fsp.writeFile(
      path.join(root, ".fased-hosted-runtime.json"),
      `${JSON.stringify({ schemaVersion: 2, version, commit, dependencyHash })}\n`,
    ),
    fsp.writeFile(path.join(root, "fased.mjs"), "#!/usr/bin/env node\n"),
    fsp.writeFile(path.join(root, "scripts", "start-managed.sh"), "#!/bin/bash\n"),
    fsp.writeFile(path.join(root, "scripts", "fased-managed-launcher.sh"), "#!/bin/bash\n"),
    fsp.writeFile(path.join(root, "scripts", "fased-managed-service.sh"), "#!/bin/bash\n"),
    fsp.writeFile(path.join(root, "scripts", "fased-managed-updater.mjs"), "export {};\n"),
    ...[
      "hosted-release-manifest.mjs",
      "lifecycle-trust-crypto.mjs",
      "lifecycle-trust-policy.mjs",
      "lifecycle-trust-root.mjs",
      "lifecycle-trust-runtime.mjs",
      "managed-runtime-layout.mjs",
    ].map((name) => fsp.writeFile(path.join(root, "scripts", name), "export {};\n")),
  ]);
}

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

async function createFixture(
  options: {
    protectedApplication?: boolean;
    protectedService?: boolean;
    missingPreviousApplication?: boolean;
    managedApplication?: boolean;
    emptyManagedApplication?: boolean;
    managedInstallSchema?: 1 | 2;
  } = {},
) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-host-updater-"));
  cleanupRoots.push(root);
  const stateDir = path.join(root, "updater-state");
  const signerPath = path.join(root, "opt", "fased", "signer", "fased-signerd");
  const signerStateDBPath = path.join(root, "signer-state", "state.db");
  const signerUnitPath = path.join(root, "systemd", "fased-signerd.service");
  const paths = {
    stateDir,
    controllerReleasesDir: path.join(root, "controller", "releases"),
    controllerCurrentLink: path.join(root, "controller", "current"),
    controllerVersionPath: path.join(stateDir, "controller-version.json"),
    signerPath,
    signerStateDBPath,
    signerUnitPath,
    versionPath: path.join(stateDir, "signer-version"),
    channelPath: path.join(root, "host-updater-channel"),
    journalPath: path.join(stateDir, "active-signer-transaction.json"),
    rollbackFloorPath: path.join(stateDir, "rollback-floor"),
    gatewayGatePath: path.join(stateDir, "gateway-update-gate"),
    signerGatePath: path.join(root, "signer-update-gate", "active"),
    transactionsDir: path.join(stateDir, "transactions"),
    socketPath: path.join(root, "request.sock"),
    ...(options.protectedApplication || options.managedApplication
      ? {
          applicationReleasesDir: path.join(root, "application", "releases"),
          applicationCurrentLink: path.join(root, "application", "current"),
        }
      : {}),
    ...(options.protectedService
      ? {
          gatewayUnitPath: path.join(root, "systemd", "fased-gateway.service"),
          gatewayLauncherPath: path.join(root, "opt", "fased", "gateway-launch"),
        }
      : {}),
  };
  await Promise.all([
    fsp.mkdir(path.dirname(signerPath), { recursive: true }),
    fsp.mkdir(path.dirname(signerStateDBPath), { recursive: true }),
    fsp.mkdir(path.dirname(signerUnitPath), { recursive: true }),
    fsp.mkdir(stateDir, { recursive: true }),
  ]);
  await fsp.writeFile(signerPath, "old-signer\n", { mode: 0o755 });
  await fsp.writeFile(signerStateDBPath, "old-db\n", { mode: 0o600 });
  await fsp.writeFile(signerUnitPath, "ExecStart=old-signer\n", { mode: 0o644 });
  await fsp.writeFile(paths.versionPath, "1.2.2\n", { mode: 0o600 });
  if (options.emptyManagedApplication) {
    await Promise.all([
      fsp.rm(signerPath, { force: true }),
      fsp.rm(signerStateDBPath, { force: true }),
      fsp.rm(paths.versionPath, { force: true }),
    ]);
  }
  if (options.protectedApplication || options.managedApplication) {
    await Promise.all([
      fsp.mkdir(path.join(paths.applicationReleasesDir!, "v1.2.2"), {
        recursive: true,
        mode: 0o755,
      }),
      fsp.mkdir(path.join(paths.applicationReleasesDir!, "v1.2.3"), {
        recursive: true,
        mode: 0o755,
      }),
    ]);
    if (!options.missingPreviousApplication) {
      await fsp.symlink(
        path.join(paths.applicationReleasesDir!, "v1.2.2"),
        paths.applicationCurrentLink!,
      );
    }
    if (options.managedApplication) {
      await Promise.all([
        writeProtectedApplicationFixture({
          root: path.join(paths.applicationReleasesDir!, "v1.2.2"),
          version: "1.2.2",
          commit: "a".repeat(40),
          dependencyHash: "2".repeat(64),
        }),
        writeProtectedApplicationFixture({
          root: path.join(paths.applicationReleasesDir!, "v1.2.3"),
          version: "1.2.3",
          commit: "a".repeat(40),
          dependencyHash: "3".repeat(64),
        }),
      ]);
    }
  }
  if (options.protectedService) {
    const instanceId = "0123456789abcdef";
    const protectedNodeBinary = path.join(root, "bin", "node");
    await Promise.all([
      fsp.mkdir(path.dirname(paths.gatewayUnitPath!), { recursive: true }),
      fsp.mkdir(path.dirname(paths.gatewayLauncherPath!), { recursive: true }),
      fsp.mkdir(path.dirname(protectedNodeBinary), { recursive: true }),
    ]);
    await Promise.all([
      fsp.writeFile(protectedNodeBinary, "#!/bin/sh\nexit 0\n", { mode: 0o755 }),
      fsp.writeFile(
        paths.gatewayUnitPath!,
        `[Service]
User=fsgw-${instanceId}
WorkingDirectory=/home/operator/.fased/runtime/releases/1.2.2
Environment=FASED_STATE_DIR=/home/operator/.fased
Environment=FASED_GATEWAY_PORT=18789
Environment=FASED_PROTECTED_LOCAL_INSTANCE=${instanceId}
ProtectSystem=strict
`,
        { mode: 0o644 },
      ),
      fsp.writeFile(
        paths.gatewayLauncherPath!,
        `#!/usr/bin/env bash
set -euo pipefail
while [[ ! -s "/home/operator/.fased/fased.json" ]]; do
  sleep 1
done
exec /bin/bash "/home/operator/.fased/runtime/releases/1.2.2/scripts/start-managed.sh"
`,
        { mode: 0o755 },
      ),
    ]);
  }
  if (options.managedApplication) {
    const managedStateDir = path.join(root, "operator", ".fased");
    const runtimeDir = path.join(managedStateDir, "runtime");
    const currentLink = path.join(runtimeDir, "current");
    const previousLink = path.join(runtimeDir, "previous");
    const prefix = path.join(managedStateDir, "install-cache", "npm-global");
    const compatibilityRoot = path.join(prefix, "lib", "node_modules", "@fased", "fased");
    await fsp.mkdir(managedStateDir, { recursive: true });
    await fsp.writeFile(path.join(managedStateDir, "fased.json"), "{}\n");
    if (!options.emptyManagedApplication) {
      await Promise.all([
        fsp.mkdir(runtimeDir, { recursive: true }),
        fsp.mkdir(path.dirname(compatibilityRoot), { recursive: true }),
        fsp.mkdir(path.join(managedStateDir, "updater"), { recursive: true }),
      ]);
      await Promise.all([
        fsp.symlink(path.join(paths.applicationReleasesDir!, "v1.2.2"), currentLink),
        fsp.symlink(path.join(paths.applicationReleasesDir!, "v1.2.2"), previousLink),
        fsp.symlink(currentLink, compatibilityRoot),
        fsp.writeFile(
          path.join(managedStateDir, "install.json"),
          `${JSON.stringify({
            schemaVersion: options.managedInstallSchema ?? 2,
            profile: "protected-local",
            source: "managed-artifact",
            stateDir: managedStateDir,
            configPath: path.join(managedStateDir, "fased.json"),
            runtime: {
              activeVersion: "1.2.2",
              previousVersion: null,
              currentLink,
              previousLink,
              releasesDir: paths.applicationReleasesDir,
            },
            package: { prefix, compatibilityRoot },
            service: {
              name: "fased-gateway-0123456789abcdef.service",
              scope: "system",
              launcher: path.join(root, "gateway-launch"),
            },
            updater: {
              version: "1.2.2",
              path: path.join(managedStateDir, "updater", "fased-managed-updater.mjs"),
            },
            update: { channel: "stable" },
            release: null,
          })}\n`,
        ),
      ]);
    }
  }
  const events: string[] = [];
  let activeSignerVersion = "1.2.2";
  const fixtureTopology = {
    schemaVersion: 1,
    profile: options.managedApplication ? "protected-local" : "hosting",
    managedApplication: options.managedApplication === true,
    instanceId: options.managedApplication ? "0123456789abcdef" : null,
    stateDir: path.join(root, "operator", ".fased"),
    configPath: path.join(root, "operator", ".fased", "fased.json"),
    gatewayLauncherPath: options.managedApplication ? path.join(root, "gateway-launch") : undefined,
    operator: {
      name: "operator",
      uid: process.getuid(),
      gid: process.getgid(),
      home: path.join(root, "operator"),
    },
    gateway: {
      user: options.managedApplication ? "fsgw-0123456789abcdef" : "fased-gateway",
      uid: process.getuid(),
      gid: process.getgid(),
      unitPath: paths.gatewayUnitPath ?? path.join(root, "systemd", "fased-gateway.service"),
    },
    configGroup: {
      name: options.managedApplication ? "fscf-0123456789abcdef" : "fased-config",
      gid: process.getgid(),
    },
    services: {
      gateway: options.managedApplication
        ? "fased-gateway-0123456789abcdef.service"
        : "fased-gateway.service",
      signer: options.managedApplication
        ? "fased-signerd-0123456789abcdef.service"
        : "fased-signerd.service",
    },
    capabilities: {
      lifecycleControllerProtocol: 2,
      signerProtocol: { current: 2, min: 2, max: 2 },
      declaredStateRegistry: 1,
    },
    stateSchemas: {
      managedInstall:
        options.managedApplication && !options.emptyManagedApplication
          ? (options.managedInstallSchema ?? 2)
          : null,
      walletRegistry: null,
      signer: 2,
      mining: 1,
      federation: 2,
    },
  };
  const context = __testing.createTransactionContext({
    paths,
    historicalQ0TestStateDir: path.join(root, "historical-q0-test-state"),
    ...(options.protectedService ? { protectedLocalInstanceId: "0123456789abcdef" } : {}),
    ...(options.protectedService ? { protectedNodeBinary: path.join(root, "bin", "node") } : {}),
    assertReleaseAllowed: async () => undefined,
    stageControllerRelease: async () => ({ changed: false }),
    stageCandidate: async (version: string, candidatePath: string) => {
      events.push(`stage:${version}`);
      await fsp.writeFile(candidatePath, `signer-${version}\n`, { mode: 0o755 });
      return {
        release: signerRelease(version),
        binding: {
          manifestDigest: `sha256:${"1".repeat(64)}`,
          signerArtifactDigest: `sha256:${"2".repeat(64)}`,
          capabilitiesDigest: `sha256:${"3".repeat(64)}`,
          releaseCommit: signerRelease(version).commit,
        },
        ...(options.protectedApplication || options.managedApplication
          ? {
              application: {
                targetRoot: path.join(paths.applicationReleasesDir!, `v${version}`),
                previousRoot:
                  options.missingPreviousApplication || options.emptyManagedApplication
                    ? null
                    : path.join(paths.applicationReleasesDir!, "v1.2.2"),
                changed: version !== "1.2.2",
              },
              ...(options.managedApplication
                ? {
                    applicationRelease: {
                      version,
                      commit: signerRelease(version).commit,
                      manifestDigest: `sha256:${"1".repeat(64)}`,
                      artifact: {
                        asset: `fased-hosted-app-v2-linux-x64-v${version}.tar.gz`,
                        sha256: "4".repeat(64),
                      },
                      dependencies: {
                        asset: `fased-hosted-deps-linux-x64-${"3".repeat(64)}.tar.gz`,
                        sha256: "5".repeat(64),
                        dependencyHash: "3".repeat(64),
                      },
                      signer: signerRelease(version),
                      capabilities: { protocol: { current: 2, min: 2, max: 2 } },
                      capabilitiesDigest: `sha256:${"6".repeat(64)}`,
                    },
                  }
                : {}),
            }
          : {}),
      };
    },
    discoverApplicationTopology: async () => fixtureTopology,
    inventoryApplicationState: async () => null,
    reconcileApplicationState: async () => ({ changed: false, reconciled: false }),
    restoreApplicationState: async () => ({ restored: true }),
    verifyApplicationState: async () => ({
      ok: true,
      preservationHash: null,
      preservationHashes: {},
    }),
    probeApplicationHealth: async () => ({
      wallet: { ok: true, evidenceDigest: `sha256:${"1".repeat(64)}` },
      mining: { ok: true, evidenceDigest: `sha256:${"2".repeat(64)}` },
      network: { ok: true, evidenceDigest: `sha256:${"3".repeat(64)}` },
      plugins: { ok: true, evidenceDigest: `sha256:${"4".repeat(64)}` },
      signerIsolation: { ok: true, evidenceDigest: `sha256:${"5".repeat(64)}` },
    }),
    stopSigner: async () => {
      events.push("stop");
    },
    startSignerV2: async ({
      expectedRelease,
    }: {
      expectedRelease: ReturnType<typeof signerRelease>;
    }) => {
      events.push("start-v2");
      expect(expectedRelease).toEqual(signerRelease(expectedRelease.version));
      activeSignerVersion = expectedRelease.version;
      await fsp.writeFile(signerStateDBPath, "new-db\n", { mode: 0o600 });
      return { release: expectedRelease, invariant: "preserved-signer-state" };
    },
    startPreviousSigner: async () => {
      events.push("start-previous");
      activeSignerVersion = "1.2.2";
    },
    reloadUnits: async () => {
      events.push("daemon-reload");
    },
    startGateway: async () => {
      events.push("start-gateway");
    },
    stopGateway: async () => undefined,
    restartGateway: async () => undefined,
    probeSigner: async () => signerRelease(activeSignerVersion),
    probeSignerState: async () => ({
      release: signerRelease("1.2.2"),
      invariant: "preserved-signer-state",
    }),
  });
  return { context, events, paths };
}

function request(op: string, transactionId: string, version: string) {
  return parseUpdateRequest({ schemaVersion: 2, op, transactionId, version });
}

function managedTransaction(phase = "signer-preactivated") {
  return {
    schemaVersion: 1,
    transactionId: TRANSACTION_ONE,
    targetVersion: "1.2.3",
    previousVersion: "1.2.2",
    targetRoot: "/managed/releases/1.2.3",
    previousRoot: "/managed/releases/1.2.2",
    nextManifest: { profile: "hosting", runtime: { activeVersion: "1.2.3" } },
    previousManifest: { profile: "hosting", runtime: { activeVersion: "1.2.2" } },
    phase,
  };
}

describe("root-owned hosted updater protocol", () => {
  it("derives exact shared-state identities for Protected Local and Hosting", () => {
    const protectedLocalInstanceId = "0123456789abcdef";
    expect(
      __testing.rootManagedApplicationIdentity(
        {
          instanceId: protectedLocalInstanceId,
          paths: {
            gatewayUnitPath: `/etc/systemd/system/fased-gateway-${protectedLocalInstanceId}.service`,
          },
        },
        [
          `[Service]`,
          `User=fsgw-${protectedLocalInstanceId}`,
          `SupplementaryGroups=fscf-${protectedLocalInstanceId}`,
          `Environment=FASED_STATE_DIR=/home/operator/.fased`,
          "",
        ].join("\n"),
      ),
    ).toEqual({
      configGroup: `fscf-${protectedLocalInstanceId}`,
      gatewayUnitPath: `/etc/systemd/system/fased-gateway-${protectedLocalInstanceId}.service`,
      gatewayUser: `fsgw-${protectedLocalInstanceId}`,
      protectedLocal: true,
      stateDir: "/home/operator/.fased",
    });

    expect(
      __testing.rootManagedApplicationIdentity(
        { instanceId: null, paths: {} },
        [
          `[Service]`,
          `User=fased-gateway`,
          `SupplementaryGroups=fased-config`,
          `Environment=HOME=/home/app`,
          `Environment=FASED_HOST_PROFILE=hosting`,
          "",
        ].join("\n"),
      ),
    ).toEqual({
      configGroup: "fased-config",
      gatewayUnitPath: "/etc/systemd/system/fased-gateway.service",
      gatewayUser: "fased-gateway",
      protectedLocal: false,
      stateDir: "/home/app/.fased",
    });
  });

  it("defines one version-neutral topology registry for every lifecycle state class", () => {
    const topology = {
      profile: "protected-local",
      operator: { name: "operator" },
      gateway: { user: "gateway", unitPath: "/unit" },
      configGroup: { name: "config" },
    };
    const registry = __testing.declaredStateRegistry(topology, {
      paths: {
        applicationReleasesDir: "/application/releases",
        applicationCurrentLink: "/application/current",
        controllerReleasesDir: "/controller/releases",
        controllerCurrentLink: "/controller/current",
        stateDir: "/controller/state",
        signerStateDBPath: "/signer/state.db",
        signerPath: "/signer/bin",
        signerUnitPath: "/signer/unit",
      },
    });
    expect(new Set(registry.map((entry: { stateClass: string }) => entry.stateClass))).toEqual(
      new Set([
        "application-runtime",
        "dependency-runtime",
        "updater-controller",
        "signer-private-state",
        "wallet",
        "mining",
        "device-identity",
        "federation-network",
        "gateway-config-auth",
        "provider-credentials",
        "agent-session-channel-plugin",
        "profile-access",
      ]),
    );
    for (const entry of registry) {
      expect(entry).toMatchObject({
        schemaOwner: expect.any(String),
        currentSchema: expect.any(Number),
        readers: expect.any(Array),
        writers: expect.any(Array),
        symlinkPolicy: expect.any(String),
        migration: expect.any(String),
        rollback: expect.any(String),
        preservation: expect.any(String),
        health: expect.any(String),
        paths: expect.any(Array),
      });
    }
  });

  it("selects migration only from topology, capabilities, and state schemas", () => {
    const topology = {
      schemaVersion: 1,
      profile: "protected-local",
      managedApplication: true,
      capabilities: {
        lifecycleControllerProtocol: 2,
        signerProtocol: { current: 2, min: 2, max: 2 },
        declaredStateRegistry: 1,
      },
      stateSchemas: {
        managedInstall: 1,
        walletRegistry: 1,
        signer: 2,
        mining: 1,
        federation: 2,
      },
      targetRelease: {
        version: "1.2.3",
        commit: "a".repeat(40),
        artifactDigest: `sha256:${"b".repeat(64)}`,
      },
    };
    const first = __testing.selectLifecycleMigration(topology, 2);
    const second = __testing.selectLifecycleMigration(
      {
        ...topology,
        targetRelease: {
          version: "9.8.7",
          commit: "c".repeat(40),
          artifactDigest: `sha256:${"d".repeat(64)}`,
        },
      },
      2,
    );

    expect(first).toEqual(second);
    expect(first.adapters).toMatchObject({
      application: "managed-install-v1-to-v2",
      controller: "controller-protocol-v2",
      signer: "signer-schema-v2",
      wallet: "wallet-registry-v1",
      sharedState: "declared-state-registry-v1",
      profileAccess: "protected-local-system-v1",
    });
    expect(JSON.stringify(first)).not.toContain("1.2.3");
    expect(JSON.stringify(first)).not.toContain("9.8.7");
  });

  it("changes migration selection for state schema, never for release identity", () => {
    const topology = {
      schemaVersion: 1,
      profile: "protected-local",
      managedApplication: true,
      capabilities: {
        lifecycleControllerProtocol: 2,
        signerProtocol: { current: 2, min: 2, max: 2 },
        declaredStateRegistry: 1,
      },
      stateSchemas: {
        managedInstall: 1,
        walletRegistry: 1,
        signer: 2,
        mining: 1,
        federation: 2,
      },
    };
    const legacy = __testing.selectLifecycleMigration(topology, 2);
    const current = __testing.selectLifecycleMigration(
      {
        ...topology,
        stateSchemas: { ...topology.stateSchemas, managedInstall: 2 },
      },
      2,
    );

    expect(legacy.adapters.application).toBe("managed-install-v1-to-v2");
    expect(current.adapters.application).toBe("managed-install-v2");
    expect(legacy.selectionDigest).not.toBe(current.selectionDigest);
  });

  it("uses one deterministic controller-owned catalog for every state-schema adapter", () => {
    const schemaComponents = [
      "application",
      "signer",
      "wallet",
      "mining",
      "federation",
      "sharedState",
    ] as const;
    const compatibilityAdapters = schemaComponents.flatMap((component) =>
      Object.values(__testing.LIFECYCLE_COMPATIBILITY_ADAPTERS[component]),
    );
    expect(new Set(Object.keys(__testing.LIFECYCLE_SCHEMA_MIGRATIONS))).toEqual(
      new Set(compatibilityAdapters),
    );

    const selection = __testing.selectLifecycleMigration(
      {
        schemaVersion: 1,
        profile: "protected-local",
        managedApplication: true,
        capabilities: {
          lifecycleControllerProtocol: 2,
          signerProtocol: { current: 2, min: 2, max: 2 },
          declaredStateRegistry: 1,
        },
        stateSchemas: {
          managedInstall: 1,
          walletRegistry: 1,
          signer: 2,
          mining: 1,
          federation: 2,
        },
      },
      2,
    );
    const first = __testing.lifecycleSchemaMigrationPlan(selection);
    const second = __testing.lifecycleSchemaMigrationPlan(selection);

    expect(first).toEqual(second);
    expect(first.steps.map((step: { component: string }) => step.component)).toEqual(
      schemaComponents,
    );
    expect(first.steps.map((step: { adapter: string }) => step.adapter)).toEqual([
      "managed-install-v1-to-v2",
      "signer-schema-v2",
      "wallet-registry-v1",
      "mining-schema-v1",
      "federation-schema-v2",
      "declared-state-registry-v1",
    ]);
    expect(first).toMatchObject({
      schemaVersion: 1,
      selectionDigest: selection.selectionDigest,
      planDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      preparedAdapters: [],
      appliedAdapters: [],
    });
  });

  it("persists release identity and migration selection as independent transaction fields", async () => {
    const fixture = await createFixture();
    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_ONE, "1.2.3"),
      fixture.context,
    );

    const journal = await __testing.readJournal(fixture.context);
    expect(journal).toMatchObject({
      schemaVersion: 5,
      version: "1.2.3",
      release: signerRelease("1.2.3"),
      migrationSelection: {
        schemaVersion: 1,
        inventory: {
          profile: "hosting",
          managedApplication: false,
          updaterProtocol: 2,
          controllerProtocol: 2,
          stateSchemas: {
            managedInstall: null,
            walletRegistry: null,
            signer: 2,
            mining: 1,
            federation: 2,
          },
        },
        adapters: {
          application: "managed-install-absent",
          profileAccess: "hosting-system-v1",
        },
        selectionDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
      schemaMigration: {
        schemaVersion: 1,
        selectionDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        planDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        preparedAdapters: [],
        appliedAdapters: [],
        steps: expect.arrayContaining([
          expect.objectContaining({
            order: 1,
            stateClass: "application-runtime",
            adapter: "managed-install-absent",
            fromSchema: null,
            toSchema: 2,
            applicable: false,
          }),
          expect.objectContaining({
            stateClass: "signer-private-state",
            schemaOwner: "fased-signerd",
            adapter: "signer-schema-v2",
          }),
        ]),
      },
    });
    expect(JSON.stringify(journal.migrationSelection)).not.toContain("1.2.3");
    expect(JSON.stringify(journal.schemaMigration)).not.toContain("1.2.3");
  });

  it("derives and promotes an interrupted journal schema 4 migration plan deterministically", async () => {
    const fixture = await createFixture();
    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_ONE, "1.2.3"),
      fixture.context,
    );
    const legacy = JSON.parse(await fsp.readFile(fixture.paths.journalPath, "utf8"));
    legacy.schemaVersion = 4;
    delete legacy.schemaMigration;
    await fsp.writeFile(fixture.paths.journalPath, `${JSON.stringify(legacy, null, 2)}\n`);

    const recovered = await __testing.readJournal(fixture.context);
    expect(recovered).toMatchObject({
      schemaVersion: 4,
      phase: "prepared",
      schemaMigration: {
        selectionDigest: recovered.migrationSelection.selectionDigest,
        preparedAdapters: [],
        appliedAdapters: [],
      },
    });
    const promoted = await __testing.writeJournal(fixture.context, recovered);
    expect(promoted).toMatchObject({
      schemaVersion: 5,
      schemaMigration: recovered.schemaMigration,
    });
  });

  it("fails closed when the installed migration tuple changes after preparation", async () => {
    const fixture = await createFixture();
    const topology = await fixture.context.discoverApplicationTopology();
    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_ONE, "1.2.3"),
      fixture.context,
    );
    fixture.context.discoverApplicationTopology = async () => ({
      ...topology,
      stateSchemas: { ...topology.stateSchemas, walletRegistry: 1 },
    });

    await expect(
      __testing.gateGatewayRelease(
        request("gateGatewayRelease", TRANSACTION_ONE, "1.2.3"),
        fixture.context,
      ),
    ).rejects.toThrow("installed lifecycle topology changed after migration selection");
  });

  it("rejects an unsupported migration tuple before staging release artifacts", async () => {
    const fixture = await createFixture();
    const topology = await fixture.context.discoverApplicationTopology();
    fixture.context.discoverApplicationTopology = async () => ({
      ...topology,
      stateSchemas: { ...topology.stateSchemas, mining: 2 },
    });

    await expect(
      __testing.prepareSignerRelease(
        request("prepareRelease", TRANSACTION_ONE, "1.2.3"),
        fixture.context,
      ),
    ).rejects.toThrow("installed lifecycle state schemas are unsupported");
    expect(fixture.events).toEqual([]);
  });

  it("discovers topology without mutating application state during preparation", async () => {
    const { context, events } = await createFixture();
    const discover = context.discoverApplicationTopology;
    context.discoverApplicationTopology = async () => {
      events.push("discover-application-topology");
      return await discover();
    };
    context.reconcileApplicationState = async () => {
      events.push("reconcile-application-state");
      return { changed: true };
    };
    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    expect(events).toEqual(["discover-application-topology", "stage:1.2.3"]);
  });

  it("journals declared state before its first mutation and restores it on rollback", async () => {
    const fixture = await createFixture();
    const stateDir = path.join(path.dirname(fixture.paths.stateDir), "operator", ".fased");
    await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(path.join(stateDir, "fased.json"), "{}\n", { mode: 0o600 });
    const topology = {
      schemaVersion: 1,
      profile: "hosting",
      managedApplication: false,
      stateDir,
      configPath: path.join(stateDir, "fased.json"),
      operator: {
        name: "operator",
        uid: process.getuid(),
        gid: process.getgid(),
        home: path.dirname(stateDir),
      },
      gateway: {
        user: "fased-gateway",
        uid: process.getuid(),
        unitPath: "/unit",
      },
      configGroup: { name: "fased-config", gid: process.getgid() },
      services: { gateway: "gateway", signer: "signer" },
      capabilities: {
        lifecycleControllerProtocol: 2,
        signerProtocol: { current: 2, min: 2, max: 2 },
        declaredStateRegistry: 1,
      },
      stateSchemas: {
        managedInstall: null,
        walletRegistry: null,
        signer: 2,
        mining: 1,
        federation: 2,
      },
    };
    fixture.context.discoverApplicationTopology = async () => topology;
    fixture.context.inventoryApplicationState = async () =>
      await __testing.inventoryDeclaredApplicationState(topology, fixture.context);
    const order: string[] = [];
    fixture.context.reconcileApplicationState = async (transaction: unknown) => {
      order.push("reconcile");
      return await __testing.reconcileDeclaredApplicationState(transaction);
    };
    fixture.context.restoreApplicationState = async (transaction: unknown) =>
      await __testing.restoreDeclaredApplicationState(transaction);
    fixture.context.onDurablePhase = async (phase: string) => {
      if (
        phase === "state-reconciling" ||
        phase === "state-reconciled" ||
        phase === "schema-ready"
      ) {
        order.push(phase);
      }
    };

    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_ONE, "1.2.3"),
      fixture.context,
    );
    expect((await fsp.stat(stateDir)).mode & 0o7777).toBe(0o700);
    await __testing.gateGatewayRelease(
      request("gateGatewayRelease", TRANSACTION_ONE, "1.2.3"),
      fixture.context,
    );
    expect(order).toEqual(["state-reconciling", "reconcile", "state-reconciled", "schema-ready"]);
    expect((await fsp.stat(stateDir)).mode & 0o7777).toBe(0o2770);
    expect(await __testing.readJournal(fixture.context)).toMatchObject({
      phase: "schema-ready",
      declaredState: {
        reconciled: true,
        preservationHash: expect.stringMatching(/^sha256:/u),
      },
      schemaMigration: {
        preparedAdapters: [
          "managed-install-absent",
          "signer-schema-v2",
          "wallet-registry-absent",
          "mining-schema-v1",
          "federation-schema-v2",
          "declared-state-registry-v1",
        ],
        appliedAdapters: [
          "managed-install-absent",
          "signer-schema-v2",
          "wallet-registry-absent",
          "mining-schema-v1",
          "federation-schema-v2",
          "declared-state-registry-v1",
        ],
      },
    });

    await __testing.rollbackSignerRelease(
      request("rollbackRelease", TRANSACTION_ONE, "1.2.3"),
      fixture.context,
    );
    expect((await fsp.stat(stateDir)).mode & 0o7777).toBe(0o700);
  });

  it("stages managed schema 1 centrally, applies schema 2 atomically, and restores schema 1", async () => {
    const fixture = await createFixture({
      managedApplication: true,
      managedInstallSchema: 1,
    });
    const managedStateDir = path.join(fixture.paths.stateDir, "..", "operator", ".fased");
    const manifestPath = path.join(managedStateDir, "install.json");

    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_ONE, "1.2.3"),
      fixture.context,
    );
    await __testing.gateGatewayRelease(
      request("gateGatewayRelease", TRANSACTION_ONE, "1.2.3"),
      fixture.context,
    );
    const staged = await __testing.readJournal(fixture.context);
    expect(staged).toMatchObject({
      phase: "schema-ready",
      schemaMigration: {
        preparedAdapters: expect.arrayContaining(["managed-install-v1-to-v2"]),
      },
    });
    expect(staged.schemaMigration.appliedAdapters).not.toContain("managed-install-v1-to-v2");
    expect(JSON.parse(await fsp.readFile(manifestPath, "utf8")).schemaVersion).toBe(1);

    await __testing.activateSignerRelease(
      request("activateRelease", TRANSACTION_ONE, "1.2.3"),
      fixture.context,
    );
    await __testing.authorizeGatewayRelease(
      request("authorizeGatewayRelease", TRANSACTION_ONE, "1.2.3"),
      fixture.context,
    );
    const activated = await __testing.readJournal(fixture.context);
    expect(activated).toMatchObject({
      phase: "gateway-authorized",
      schemaMigration: {
        appliedAdapters: activated.schemaMigration.steps.map(
          (step: { adapter: string }) => step.adapter,
        ),
      },
    });
    expect(JSON.parse(await fsp.readFile(manifestPath, "utf8"))).toMatchObject({
      schemaVersion: 2,
      runtime: { activeVersion: "1.2.3", previousVersion: "1.2.2" },
    });

    await __testing.rollbackSignerRelease(
      request("rollbackRelease", TRANSACTION_ONE, "1.2.3"),
      fixture.context,
    );
    expect(JSON.parse(await fsp.readFile(manifestPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      runtime: { activeVersion: "1.2.2" },
    });
  });

  it("recovers a crash after managed schema activation and retries the same transaction once", async () => {
    const fixture = await createFixture({
      managedApplication: true,
      managedInstallSchema: 1,
    });
    const manifestPath = path.join(
      fixture.paths.stateDir,
      "..",
      "operator",
      ".fased",
      "install.json",
    );
    fixture.context.verifyGateway = async () => ({
      version: "1.2.3",
      runtimeSource: "managed-package",
    });
    let gatewayAuthorizedWrites = 0;
    fixture.context.onDurablePhase = async (phase: string) => {
      if (phase === "gateway-authorized") {
        gatewayAuthorizedWrites += 1;
        if (gatewayAuthorizedWrites === 2) {
          const error = new Error(
            "deterministic crash after managed schema activation",
          ) as Error & {
            code?: string;
          };
          error.code = "FASED_TEST_CRASH";
          throw error;
        }
      }
    };

    await expect(
      __testing.applyReleaseTransaction(
        request("applyRelease", TRANSACTION_ONE, "1.2.3"),
        fixture.context,
      ),
    ).rejects.toMatchObject({ code: "FASED_TEST_CRASH" });
    expect(await __testing.readJournal(fixture.context)).toMatchObject({
      phase: "gateway-authorized",
      schemaMigration: { appliedAdapters: expect.arrayContaining(["managed-install-v1-to-v2"]) },
    });
    expect(JSON.parse(await fsp.readFile(manifestPath, "utf8")).schemaVersion).toBe(1);

    fixture.context.onDurablePhase = undefined;
    await expect(__testing.recoverInterruptedTransaction(fixture.context)).resolves.toMatchObject({
      recovered: true,
      action: "rolled-back",
    });
    expect(JSON.parse(await fsp.readFile(manifestPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      runtime: { activeVersion: "1.2.2" },
    });

    await expect(
      __testing.applyReleaseTransaction(
        request("applyRelease", TRANSACTION_ONE, "1.2.3"),
        fixture.context,
      ),
    ).resolves.toMatchObject({
      phase: "committed",
      schemaMigration: { applied: true },
    });
    expect(JSON.parse(await fsp.readFile(manifestPath, "utf8"))).toMatchObject({
      schemaVersion: 2,
      runtime: { activeVersion: "1.2.3" },
    });
  });

  it("commits a fresh empty application and signer topology through the shared lifecycle", async () => {
    const fixture = await createFixture({
      managedApplication: true,
      emptyManagedApplication: true,
    });
    const managedStateDir = path.join(fixture.paths.stateDir, "..", "operator", ".fased");
    fixture.context.verifyGateway = async () => ({
      version: "1.2.3",
      runtimeSource: "managed-package",
    });

    await expect(
      __testing.applyReleaseTransaction(
        request("applyRelease", TRANSACTION_ONE, "1.2.3"),
        fixture.context,
      ),
    ).resolves.toMatchObject({
      phase: "committed",
      migration: {
        profile: "protected-local",
        adapters: { application: "managed-install-absent" },
      },
    });

    expect(
      JSON.parse(await fsp.readFile(path.join(managedStateDir, "install.json"), "utf8")),
    ).toMatchObject({
      schemaVersion: 2,
      profile: "protected-local",
      runtime: { activeVersion: "1.2.3", previousVersion: null },
    });
    expect(await fsp.realpath(path.join(managedStateDir, "runtime", "current"))).toBe(
      path.join(fixture.paths.applicationReleasesDir!, "v1.2.3"),
    );
    for (const candidate of [
      path.join(managedStateDir, "bin", "fased"),
      path.join(managedStateDir, "bin", "fased-service"),
      path.join(managedStateDir, "updater", "fased-managed-updater.mjs"),
      path.join(managedStateDir, "install-cache", "npm-global", "bin", "fased"),
    ]) {
      expect(fs.existsSync(candidate)).toBe(true);
    }
    expect(await fsp.readFile(fixture.paths.signerPath, "utf8")).toBe("signer-1.2.3\n");
  });

  it("removes an uncommitted fresh topology and succeeds on the same-command retry", async () => {
    const fixture = await createFixture({
      managedApplication: true,
      emptyManagedApplication: true,
    });
    const managedStateDir = path.join(fixture.paths.stateDir, "..", "operator", ".fased");
    fixture.context.verifyGateway = async () => {
      throw new Error("deterministic fresh Gateway health failure");
    };

    let failure: (Error & { code?: string }) | undefined;
    try {
      await __testing.applyReleaseTransaction(
        request("applyRelease", TRANSACTION_ONE, "1.2.3"),
        fixture.context,
      );
    } catch (error) {
      failure = error as Error & { code?: string };
    }
    expect(failure?.code, failure?.stack).toBe("TARGET_RELEASE_ROLLED_BACK");

    for (const candidate of [
      path.join(managedStateDir, "install.json"),
      path.join(managedStateDir, "runtime"),
      path.join(managedStateDir, "bin"),
      path.join(managedStateDir, "updater"),
      path.join(managedStateDir, "install-cache"),
      path.join(managedStateDir, "identity"),
      path.join(managedStateDir, "wallet"),
      path.join(managedStateDir, "federation"),
      path.join(managedStateDir, "extensions"),
      fixture.paths.signerPath,
      fixture.paths.signerStateDBPath,
      fixture.paths.versionPath,
      fixture.paths.journalPath,
      fixture.paths.gatewayGatePath,
      fixture.paths.signerGatePath,
    ]) {
      expect(fs.existsSync(candidate)).toBe(false);
    }

    fixture.context.verifyGateway = async () => ({
      version: "1.2.3",
      runtimeSource: "managed-package",
    });
    await expect(
      __testing.applyReleaseTransaction(
        request("applyRelease", TRANSACTION_ONE, "1.2.3"),
        fixture.context,
      ),
    ).resolves.toMatchObject({ phase: "committed" });
  });

  it("rejects declared user-state content changes before commit", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-preservation-"));
    cleanupRoots.push(root);
    const stateDir = path.join(root, ".fased");
    await fsp.mkdir(stateDir);
    const configPath = path.join(stateDir, "fased.json");
    await fsp.writeFile(configPath, '{"gateway":{}}\n');
    const topology = {
      profile: "hosting",
      stateDir,
      operator: {
        name: "operator",
        uid: process.getuid(),
        gid: process.getgid(),
        home: root,
      },
      gateway: { user: "gateway", uid: process.getuid(), unitPath: "/unit" },
      configGroup: { name: "config", gid: process.getgid() },
    };
    const transaction = await __testing.inventoryDeclaredApplicationState(topology, {
      paths: {},
    });
    await fsp.writeFile(configPath, '{"gateway":{"port":1}}\n');
    await expect(__testing.verifyDeclaredStatePreservation(transaction)).rejects.toThrow(
      "declared user state changed",
    );
  });

  it("records independent durable Wallet, Mining, Network, identity, and config hashes", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-state-classes-"));
    cleanupRoots.push(root);
    const stateDir = path.join(root, ".fased");
    const walletDir = path.join(stateDir, "wallet");
    const networkDir = path.join(stateDir, "federation");
    const miningDir = path.join(stateDir, "sat-mining", "wallets", "mining");
    await Promise.all([
      fsp.mkdir(path.join(stateDir, "identity"), { recursive: true }),
      fsp.mkdir(walletDir, { recursive: true }),
      fsp.mkdir(networkDir, { recursive: true }),
      fsp.mkdir(miningDir, { recursive: true }),
    ]);
    await Promise.all([
      fsp.writeFile(path.join(stateDir, "fased.json"), "{}\n"),
      fsp.writeFile(path.join(stateDir, "identity", "device.json"), '{"id":"device"}\n'),
      fsp.writeFile(path.join(walletDir, "provider-registry.v1.json"), '{"version":1}\n'),
      fsp.writeFile(path.join(networkDir, "peer-replay-v2.json"), '{"entries":[]}\n'),
      fsp.writeFile(path.join(miningDir, "audit-store.json"), '{"records":[]}\n'),
    ]);
    const topology = {
      profile: "hosting",
      stateDir,
      operator: { name: "operator", uid: process.getuid(), gid: process.getgid(), home: root },
      gateway: { user: "gateway", uid: process.getuid(), unitPath: "/unit" },
      configGroup: { name: "config", gid: process.getgid() },
    };

    const transaction = await __testing.inventoryDeclaredApplicationState(topology, { paths: {} });
    expect(Object.keys(transaction.preservationHashes).toSorted()).toEqual([
      "device-identity",
      "federation-network",
      "gateway-config-auth",
      "mining",
      "wallet",
    ]);
    await expect(__testing.verifyDeclaredStatePreservation(transaction)).resolves.toMatchObject({
      ok: true,
      preservationHashes: transaction.preservationHashes,
    });

    await fsp.writeFile(path.join(miningDir, "audit-store.json"), '{"records":[1]}\n');
    await expect(__testing.verifyDeclaredStatePreservation(transaction)).rejects.toThrow(
      "declared user state changed",
    );
  });

  it("runs prerequisite health concurrently before product probes and persists redacted evidence", async () => {
    const { context } = await createFixture();
    let started = 0;
    let productStarted = false;
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const start = async <T>(result: T): Promise<T> => {
      started += 1;
      if (started === 3) {
        releaseBarrier?.();
      }
      await barrier;
      return result;
    };
    context.verifyGateway = async () =>
      await start({ version: "1.2.3", runtimeSource: "managed-package" });
    context.probeSigner = async (expectedRelease) => {
      expect(expectedRelease).toEqual(signerRelease("1.2.3"));
      return await start(signerRelease("1.2.3"));
    };
    context.verifyApplicationState = async () =>
      await start({
        ok: true,
        preservationHash: `sha256:${"a".repeat(64)}`,
        preservationHashes: { wallet: `sha256:${"b".repeat(64)}` },
      });
    context.probeApplicationHealth = async () => {
      expect(started).toBe(3);
      productStarted = true;
      return {
        wallet: { ok: true, evidenceDigest: `sha256:${"1".repeat(64)}` },
        mining: { ok: true, evidenceDigest: `sha256:${"2".repeat(64)}` },
        network: { ok: true, evidenceDigest: `sha256:${"3".repeat(64)}` },
        plugins: { ok: true, evidenceDigest: `sha256:${"4".repeat(64)}` },
        signerIsolation: { ok: true, evidenceDigest: `sha256:${"5".repeat(64)}` },
      };
    };

    const receipt = await __testing.verifyCrossProductHealth(context, {
      version: "1.2.3",
      release: signerRelease("1.2.3"),
      declaredState: null,
      application: null,
    });
    expect(started).toBe(3);
    expect(productStarted).toBe(true);
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      checks: {
        gateway: { ok: true },
        signer: { ok: true },
        wallet: { ok: true },
        mining: { ok: true },
        network: { ok: true },
        plugins: { ok: true },
        state: { ok: true },
      },
    });
    expect(JSON.stringify(receipt)).not.toContain("secret");
    expect(JSON.stringify(receipt)).not.toContain("preserved-signer-state");
  });

  it("binds Wallet, Mining, Network, plugin, and signer-isolation health to canonical state", () => {
    const readiness = (params: {
      walletId: string;
      publicKey: string;
      role: "agent" | "vault";
      operationLane: "agent-reviewed-and-autonomous" | "vault-reviewed-only";
    }) => ({
      ...params,
      baselineVersion: 1,
      policyVersion: 1,
      policyHash: `sha256:${"a".repeat(64)}`,
      networkVersion: 1,
      networkHash: `hmac-sha256:${"b".repeat(64)}`,
      keyReady: true,
      policyReady: true,
      networkReady: true,
      ready: true,
    });
    const agentAddress = "11111111111111111111111111111111";
    const vaultAddress = "So11111111111111111111111111111111111111112";
    const evidence = {
      topology: { profile: "protected-local" },
      walletStatus: {
        ok: true,
        status: {
          mode: "protected-local-operator",
          defaultWalletId: "agent",
          assignments: { main: "agent" },
          wallets: [
            {
              id: "agent",
              name: "Agent",
              handle: "@wallet:agent",
              publicAddress: agentAddress,
              role: "agent",
              signer: readiness({
                walletId: "agent",
                publicKey: agentAddress,
                role: "agent",
                operationLane: "agent-reviewed-and-autonomous",
              }),
            },
            {
              id: "vault",
              name: "Vault",
              handle: "@wallet:vault",
              publicAddress: vaultAddress,
              role: "vault",
              signer: readiness({
                walletId: "vault",
                publicKey: vaultAddress,
                role: "vault",
                operationLane: "vault-reviewed-only",
              }),
            },
          ],
        },
      },
      walletDoctor: { ok: true, checks: [] },
      mining: { ok: true, payload: { entries: [] } },
      network: {
        configured: true,
        autoConnectEnabled: true,
        tokenPresent: true,
        handle: "@fased-agent",
        managedToken: { present: true },
      },
      bond: { walletId: "vault", walletAddress: vaultAddress },
      plugins: { ok: true, errors: [], diagnostics: [] },
      signerIsolation: { operatorDenied: true, controlDenied: true },
    };

    expect(__testing.validateCrossProductApplicationEvidence(evidence)).toMatchObject({
      wallet: { ok: true },
      mining: { ok: true },
      network: { ok: true },
      plugins: { ok: true },
      signerIsolation: { ok: true },
    });

    const wrongHandle = structuredClone(evidence);
    wrongHandle.walletStatus.status.wallets[0].handle = "@wallet:wrong";
    expect(() => __testing.validateCrossProductApplicationEvidence(wrongHandle)).toThrow(
      "registry and signer identity",
    );

    const agentBond = structuredClone(evidence);
    agentBond.bond = { walletId: "agent", walletAddress: agentAddress };
    expect(() => __testing.validateCrossProductApplicationEvidence(agentBond)).toThrow(
      "canonical Vault Wallet",
    );

    const reachableControl = structuredClone(evidence);
    reachableControl.signerIsolation.controlDenied = false;
    expect(() => __testing.validateCrossProductApplicationEvidence(reachableControl)).toThrow(
      "privileged signer socket",
    );
  });

  it("parses one bounded JSON health document after plugin preload messages", () => {
    expect(
      __testing.parseBoundedJsonOutput(
        '[plugins] memory-core native preload 1ms\n{"ok":true,"errors":[]}',
        "plugins",
      ),
    ).toEqual({ ok: true, errors: [] });
    expect(() => __testing.parseBoundedJsonOutput("[plugins] no json", "plugins")).toThrow(
      "not valid JSON",
    );
  });

  it("uses verified Gateway configuration for Mining health without exposing credentials", () => {
    const args = __testing.targetMiningHealthArgs();
    expect(args).toEqual(["mining", "history", "--timeout", "5000", "--json"]);
    expect(args).not.toContain("--url");
    expect(args).not.toContain("--token");
    expect(args).not.toContain("--password");
  });

  it("bounds product health to one application process at a time", async () => {
    const labels: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const results = [
      { ok: true, status: { wallets: [] } },
      { ok: true, checks: [] },
      { ok: true, payload: { entries: [] } },
      { configured: false },
      { walletId: null },
      { ok: true, errors: [], diagnostics: [] },
    ];

    const evidence = await __testing.collectCrossProductApplicationHealthEvidence(
      async (_args, label) => {
        labels.push(label);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return results[labels.length - 1];
      },
      async () => {
        expect(active).toBe(0);
        labels.push("signer isolation");
        return { operatorDenied: true, controlDenied: true };
      },
    );

    expect(maximumActive).toBe(1);
    expect(labels).toEqual([
      "Wallet",
      "Wallet signer",
      "Mining",
      "Fased Network",
      "Fased Network bond",
      "plugins",
      "signer isolation",
    ]);
    expect(evidence).toMatchObject({
      plugins: { ok: true },
      signerIsolation: { operatorDenied: true, controlDenied: true },
    });
  });

  it("creates every canonical shared application directory under root control", async () => {
    if (process.platform === "win32") {
      return;
    }
    const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-shared-state-"));
    cleanupRoots.push(stateDir);
    const uid = process.getuid();
    const gid = process.getgid();

    await __testing.ensureRootManagedSharedApplicationDirectories(stateDir, uid, gid);
    await __testing.ensureRootManagedSharedApplicationDirectories(stateDir, uid, gid);

    for (const name of ["identity", "wallet", "federation", "extensions"]) {
      const info = await fsp.lstat(path.join(stateDir, name));
      expect(info.isDirectory()).toBe(true);
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.uid).toBe(uid);
      expect(info.gid).toBe(gid);
      expect(info.mode & 0o2777).toBe(0o2770);
    }
  });

  it("reconciles only declared application state and restores its original metadata", async () => {
    if (process.platform === "win32" || typeof process.getuid !== "function") {
      return;
    }
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-declared-state-"));
    cleanupRoots.push(root);
    const stateDir = path.join(root, ".fased");
    const uid = process.getuid();
    const gid = process.getgid();
    await fsp.mkdir(stateDir);
    await __testing.ensureRootManagedSharedApplicationDirectories(stateDir, uid, gid);
    const configPath = path.join(stateDir, "fased.json");
    const unknownPath = path.join(stateDir, "unknown-user-state.txt");
    await Promise.all([
      fsp.writeFile(configPath, "{}\n", { mode: 0o600 }),
      fsp.writeFile(unknownPath, "preserve\n", { mode: 0o600 }),
    ]);
    const topology = {
      schemaVersion: 1,
      profile: "protected-local",
      managedApplication: true,
      stateDir,
      operator: { name: "operator", uid, gid, home: root },
      gateway: { user: "gateway", uid, unitPath: "/unit" },
      configGroup: { name: "config", gid },
    };
    const transaction = await __testing.inventoryDeclaredApplicationState(topology, {
      paths: {},
    });
    const result = await __testing.reconcileDeclaredApplicationState(transaction);
    expect(result.changedEntries).toContain("fased.json");
    expect((await fsp.stat(configPath)).mode & 0o777).toBe(0o660);
    expect((await fsp.stat(unknownPath)).mode & 0o777).toBe(0o600);
    await __testing.restoreDeclaredApplicationState(transaction);
    expect((await fsp.stat(configPath)).mode & 0o777).toBe(0o600);
    expect(await __testing.verifyDeclaredStatePreservation(transaction)).toMatchObject({
      ok: true,
      preservationHash: transaction.preservationHash,
    });
  });

  it("rejects a symlink in a canonical shared application directory", async () => {
    if (process.platform === "win32") {
      return;
    }
    const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-shared-state-link-"));
    cleanupRoots.push(stateDir);
    await fsp.mkdir(path.join(stateDir, "outside"));
    await fsp.symlink(path.join(stateDir, "outside"), path.join(stateDir, "identity"));

    await expect(
      __testing.ensureRootManagedSharedApplicationDirectories(
        stateDir,
        process.getuid(),
        process.getgid(),
      ),
    ).rejects.toThrow();
  });

  it("defers shared-state reconciliation while an interrupted bootstrap recreates state", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-host-state-retry-"));
    cleanupRoots.push(root);
    const instanceId = "0123456789abcdef";
    const stateDir = path.join(root, "operator", ".fased");
    const gatewayUnitPath = path.join(root, "systemd", "fased-gateway.service");
    await fsp.mkdir(path.dirname(gatewayUnitPath), { recursive: true });
    await fsp.writeFile(
      gatewayUnitPath,
      [
        "[Service]",
        `User=fsgw-${instanceId}`,
        `SupplementaryGroups=fscf-${instanceId}`,
        `Environment=FASED_STATE_DIR=${stateDir}`,
        "",
      ].join("\n"),
      { mode: 0o644 },
    );

    const result = await __testing.discoverProtectedApplicationTopology({
      instanceId,
      rootUid: process.geteuid(),
      paths: { gatewayUnitPath },
    });

    expect(result).toEqual({
      schemaVersion: 1,
      pendingStateDir: true,
      profile: "protected-local",
      stateDir,
    });
  });

  it("installs a protected application outside the operator home and selects it atomically", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-protected-app-"));
    cleanupRoots.push(root);
    const sourceRoot = path.join(root, "verified-source");
    const dependencyRoot = path.join(root, "verified-dependencies", "node_modules");
    const applicationRoot = path.join(root, "root-controlled", "application");
    await Promise.all([
      fsp.mkdir(path.join(sourceRoot, "dist"), { recursive: true }),
      fsp.mkdir(path.join(sourceRoot, "scripts"), { recursive: true }),
      fsp.mkdir(path.join(dependencyRoot, "fixture"), { recursive: true }),
      fsp.mkdir(path.dirname(applicationRoot), { recursive: true }),
    ]);
    await fsp.mkdir(applicationRoot, { mode: 0o640 });
    await Promise.all([
      fsp.writeFile(
        path.join(sourceRoot, "package.json"),
        `${JSON.stringify({ version: "1.2.3" })}\n`,
      ),
      fsp.writeFile(
        path.join(sourceRoot, "dist", "build-info.json"),
        `${JSON.stringify({ version: "1.2.3", commit: "a".repeat(40) })}\n`,
      ),
      fsp.writeFile(
        path.join(sourceRoot, ".fased-hosted-runtime.json"),
        `${JSON.stringify({
          version: "1.2.3",
          commit: "a".repeat(40),
          dependencyHash: "b".repeat(64),
        })}\n`,
      ),
      fsp.writeFile(path.join(sourceRoot, "fased.mjs"), "#!/usr/bin/env node\n"),
      fsp.writeFile(path.join(sourceRoot, "scripts", "start-managed.sh"), "#!/bin/bash\n"),
      fsp.writeFile(path.join(dependencyRoot, "fixture", "index.js"), "export {};\n"),
    ]);

    const previousUmask = process.umask(0o117);
    let result: Awaited<ReturnType<typeof installProtectedLocalApplicationRuntime>>;
    try {
      result = await installProtectedLocalApplicationRuntime({
        sourceRoot,
        dependencyRoot,
        version: "1.2.3",
        commit: "a".repeat(40),
        paths: {
          applicationReleasesDir: path.join(applicationRoot, "releases"),
          applicationCurrentLink: path.join(applicationRoot, "current"),
        },
      });
    } finally {
      process.umask(previousUmask);
    }

    expect(result.releaseRoot).toBe(path.join(applicationRoot, "releases", "v1.2.3"));
    expect(await fsp.realpath(path.join(applicationRoot, "current"))).toBe(result.releaseRoot);
    expect(result.releaseRoot.startsWith(path.join(root, "root-controlled"))).toBe(true);
    expect((await fsp.lstat(result.releaseRoot)).mode & 0o777).toBe(0o755);
    expect((await fsp.lstat(applicationRoot)).mode & 0o777).toBe(0o755);
    expect((await fsp.lstat(path.join(applicationRoot, "releases"))).mode & 0o777).toBe(0o755);
  });

  it("switches the protected application with the signer and restores it when Gateway start fails", async () => {
    const prepared = await createFixture({ protectedApplication: true });
    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_ONE, "1.2.3"),
      prepared.context,
    );
    await __testing.activateSignerRelease(
      request("activateRelease", TRANSACTION_ONE, "1.2.3"),
      prepared.context,
    );
    await __testing.authorizeGatewayRelease(
      request("authorizeGatewayRelease", TRANSACTION_ONE, "1.2.3"),
      prepared.context,
    );
    expect(await fsp.realpath(prepared.paths.applicationCurrentLink!)).toBe(
      path.join(prepared.paths.applicationReleasesDir!, "v1.2.3"),
    );

    const failing = await createFixture({ protectedApplication: true });
    failing.context.startGateway = async () => {
      throw new Error("injected Gateway start failure");
    };
    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_TWO, "1.2.3"),
      failing.context,
    );
    await __testing.activateSignerRelease(
      request("activateRelease", TRANSACTION_TWO, "1.2.3"),
      failing.context,
    );
    await expect(
      __testing.authorizeGatewayRelease(
        request("authorizeGatewayRelease", TRANSACTION_TWO, "1.2.3"),
        failing.context,
      ),
    ).rejects.toThrow("injected Gateway start failure");
    expect(await fsp.realpath(failing.paths.applicationCurrentLink!)).toBe(
      path.join(failing.paths.applicationReleasesDir!, "v1.2.2"),
    );
  });

  it("upgrades an earlier protected service boundary and restores it with a missing prior root", async () => {
    const prepared = await createFixture({
      protectedApplication: true,
      protectedService: true,
      missingPreviousApplication: true,
    });
    const previousUnit = await fsp.readFile(prepared.paths.gatewayUnitPath!, "utf8");
    const previousLauncher = await fsp.readFile(prepared.paths.gatewayLauncherPath!, "utf8");
    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_ONE, "1.2.3"),
      prepared.context,
    );
    expect(await __testing.readJournal(prepared.context)).toMatchObject({
      application: { previousRoot: null },
      serviceBoundary: { changed: true },
    });
    await __testing.activateSignerRelease(
      request("activateRelease", TRANSACTION_ONE, "1.2.3"),
      prepared.context,
    );
    await __testing.authorizeGatewayRelease(
      request("authorizeGatewayRelease", TRANSACTION_ONE, "1.2.3"),
      prepared.context,
    );
    const nextUnit = await fsp.readFile(prepared.paths.gatewayUnitPath!, "utf8");
    const nextLauncher = await fsp.readFile(prepared.paths.gatewayLauncherPath!, "utf8");
    expect(nextUnit).toContain(`WorkingDirectory=${prepared.paths.applicationCurrentLink!}`);
    expect(nextUnit).toContain(
      `Environment=FASED_MANAGED_RUNTIME_ROOT=${prepared.paths.applicationCurrentLink!}`,
    );
    expect(nextUnit).toContain("Environment=FASED_CONFIG_DIR=/home/operator/.fased");
    expect(nextLauncher).toContain(`${prepared.paths.applicationCurrentLink!}'/dist/entry.js`);
    expect(nextLauncher).toContain(
      `'${path.join(path.dirname(prepared.paths.stateDir), "bin", "node")}'`,
    );
    expect(nextLauncher).toContain(
      "\"$gateway_entry\" gateway --allow-unconfigured --force --bind loopback --port '18789'",
    );
    expect(nextLauncher).toContain('export FASED_VERSION="$runtime_version"');
    expect(nextLauncher).toContain(
      "protected Local Gateway release identity is unavailable or inconsistent",
    );
    expect(nextLauncher).not.toContain("scripts/start-managed.sh");
    expect(await fsp.realpath(prepared.paths.applicationCurrentLink!)).toBe(
      path.join(prepared.paths.applicationReleasesDir!, "v1.2.3"),
    );
    await __testing.commitSignerRelease(
      request("commitRelease", TRANSACTION_ONE, "1.2.3"),
      prepared.context,
    );

    const failing = await createFixture({
      protectedApplication: true,
      protectedService: true,
      missingPreviousApplication: true,
    });
    let gatewayStarts = 0;
    failing.context.startGateway = async () => {
      gatewayStarts += 1;
      if (gatewayStarts === 1) {
        throw new Error("injected migrated Gateway start failure");
      }
    };
    const failingUnit = await fsp.readFile(failing.paths.gatewayUnitPath!, "utf8");
    const failingLauncher = await fsp.readFile(failing.paths.gatewayLauncherPath!, "utf8");
    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_TWO, "1.2.3"),
      failing.context,
    );
    await __testing.activateSignerRelease(
      request("activateRelease", TRANSACTION_TWO, "1.2.3"),
      failing.context,
    );
    await expect(
      __testing.authorizeGatewayRelease(
        request("authorizeGatewayRelease", TRANSACTION_TWO, "1.2.3"),
        failing.context,
      ),
    ).rejects.toThrow("injected migrated Gateway start failure");
    expect(fs.existsSync(failing.paths.applicationCurrentLink!)).toBe(false);
    expect(await fsp.readFile(failing.paths.gatewayUnitPath!, "utf8")).toBe(failingUnit);
    expect(await fsp.readFile(failing.paths.gatewayLauncherPath!, "utf8")).toBe(failingLauncher);
    await __testing.rollbackSignerRelease(
      request("rollbackRelease", TRANSACTION_TWO, "1.2.3"),
      failing.context,
    );

    expect(gatewayStarts).toBe(1);
    expect(previousUnit).toBe(failingUnit);
    expect(previousLauncher).toBe(failingLauncher);
  });

  it("recognizes the systemd entrypoint through the immutable current symlink", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-host-controller-entrypoint-"));
    cleanupRoots.push(root);
    const generationRoot = path.join(root, "releases", "v1.2.3");
    const serverPath = path.join(generationRoot, "fased-host-updater.mjs");
    const currentLink = path.join(root, "current");
    await fsp.mkdir(generationRoot, { recursive: true });
    await fsp.writeFile(serverPath, "export {};\n");
    await fsp.symlink(generationRoot, currentLink, "dir");

    expect(isMainModule(path.join(currentLink, "fased-host-updater.mjs"), serverPath)).toBe(true);
    expect(isMainModule(path.join(currentLink, "missing.mjs"), serverPath)).toBe(false);
  });

  it("removes the legacy set-ID restriction before a protected controller accepts requests", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-controller-policy-"));
    cleanupRoots.push(root);
    const instanceId = "0123456789abcdef";
    const controllerCurrentLink = path.join(root, "controller", "current");
    const controllerUnitPath = path.join(root, `fased-local-controller-${instanceId}.service`);
    await fsp.writeFile(
      controllerUnitPath,
      [
        "[Service]",
        "User=root",
        "Group=root",
        `ExecStart=/usr/bin/node ${controllerCurrentLink}/fased-host-updater.mjs --protected-local-instance ${instanceId} --socket-uid 1000 --socket-gid 1000`,
        "NoNewPrivileges=true",
        "ProtectSystem=strict",
        `ReadWritePaths=${root} /etc/systemd/system`,
        "RestrictSUIDSGID=true",
        "",
      ].join("\n"),
      { mode: 0o644 },
    );
    let reloads = 0;
    const context = __testing.createTransactionContext({
      paths: { controllerCurrentLink, controllerUnitPath },
      protectedLocalInstanceId: instanceId,
      rootUid: process.geteuid(),
      reloadUnits: async () => {
        reloads += 1;
      },
    });

    await expect(__testing.ensureProtectedLocalControllerServicePolicy(context)).resolves.toBe(
      true,
    );
    expect(await fsp.readFile(controllerUnitPath, "utf8")).not.toContain("RestrictSUIDSGID=");
    expect(reloads).toBe(1);
    await expect(__testing.ensureProtectedLocalControllerServicePolicy(context)).resolves.toBe(
      false,
    );
    expect(reloads).toBe(1);
  });

  it("restarts a corrected protected controller before opening its request socket", async () => {
    let recovered = false;
    const result = await __testing.prepareControllerServerContext({
      ensureControllerServicePolicy: async () => true,
      recoverInterruptedTransaction: async () => {
        recovered = true;
      },
    });

    expect(result).toEqual({ restartRequired: true });
    expect(recovered).toBe(false);
  });

  it("hands an unsupervised controller to the stable boundary before recovery or requests", async () => {
    let policyChecked = false;
    let recovered = false;
    const result = await __testing.prepareControllerServerContext({
      supervised: false,
      ensureStableSupervisorBoundary: async () => true,
      ensureControllerServicePolicy: async () => {
        policyChecked = true;
        return false;
      },
      recoverInterruptedTransaction: async () => {
        recovered = true;
      },
    });

    expect(result).toEqual({ restartRequired: true });
    expect(policyChecked).toBe(false);
    expect(recovered).toBe(false);
  });

  it("reports the exact running worker identity only on the supervised private boundary", async () => {
    const context = __testing.createTransactionContext({
      supervised: true,
      runningControllerVersion: "1.2.3",
      controllerInstanceId: TRANSACTION_TWO,
    });
    await expect(
      __testing.dispatchUpdateRequest(
        request("controllerStatus", TRANSACTION_ONE, "1.2.3"),
        context,
      ),
    ).resolves.toEqual({
      transactionId: TRANSACTION_ONE,
      version: "1.2.3",
      controllerVersion: "1.2.3",
      controllerInstanceId: TRANSACTION_TWO,
    });
    await expect(
      __testing.dispatchUpdateRequest(
        request("controllerStatus", TRANSACTION_ONE, "1.2.4"),
        context,
      ),
    ).rejects.toThrow("running target lifecycle controller identity is mismatched");
  });

  it("accepts only the fixed root-only worker socket under stable supervision", () => {
    expect(
      __testing.parseServerConfiguration([
        "--protected-local-instance",
        "0123456789abcdef",
        "--supervised",
        "--socket-path",
        "/run/fased-local-controller-worker/0123456789abcdef/controller.sock",
        "--socket-uid",
        "0",
        "--socket-gid",
        "0",
      ]),
    ).toMatchObject({
      profile: "protected-local",
      instanceId: "0123456789abcdef",
      supervised: true,
      socketUid: 0,
      socketGid: 0,
    });
    expect(() =>
      __testing.parseServerConfiguration([
        "--protected-local-instance",
        "0123456789abcdef",
        "--supervised",
        "--socket-path",
        "/tmp/controller.sock",
        "--socket-uid",
        "0",
        "--socket-gid",
        "0",
      ]),
    ).toThrow("exact root-only private socket");
  });

  it("binds a supervisor bootstrap to the already verified controller generation", () => {
    const identity = {
      serverSha256: "a".repeat(64),
      clientSha256: "b".repeat(64),
    };
    const metadata = {
      targets: {
        supervisor: { sha256: "c".repeat(64) },
        controllerServer: { sha256: identity.serverSha256 },
        controllerClient: { sha256: identity.clientSha256 },
      },
    };
    expect(() =>
      assertLifecycleBootstrapBinding(identity, metadata, metadata.targets.supervisor.sha256),
    ).not.toThrow();
    expect(() =>
      assertLifecycleBootstrapBinding(
        identity,
        {
          targets: {
            ...metadata.targets,
            controllerServer: { sha256: "d".repeat(64) },
          },
        },
        metadata.targets.supervisor.sha256,
      ),
    ).toThrow("active lifecycle controller is not bound");
  });

  it("promotes an offline-attested controller generation atomically for future updates", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-host-controller-stage-"));
    cleanupRoots.push(root);
    const stateDir = path.join(root, "state");
    const controllerReleasesDir = path.join(root, "controller", "releases");
    const controllerCurrentLink = path.join(root, "controller", "current");
    const controllerVersionPath = path.join(stateDir, "controller-version.json");
    const serverBytes = await fsp.readFile(
      path.join(import.meta.dirname, "fased-host-updater.mjs"),
    );
    const clientBytes = await fsp.readFile(
      path.join(import.meta.dirname, "fased-host-updaterctl.mjs"),
    );
    const downloads: string[] = [];
    const verifications: Array<{ asset: string; bundle: string }> = [];
    const selfChecks: Array<{ asset: string; role: string }> = [];
    const context = __testing.createTransactionContext({
      paths: {
        stateDir,
        controllerReleasesDir,
        controllerCurrentLink,
        controllerVersionPath,
      },
      downloadReleaseAsset: async (url: string, destination: string) => {
        const name = path.basename(url);
        downloads.push(name);
        const contents =
          name === "fased-host-updater.mjs"
            ? serverBytes
            : name === "fased-host-updaterctl.mjs"
              ? clientBytes
              : Buffer.from("offline attestation bundle\n");
        await fsp.writeFile(destination, contents, { mode: 0o600 });
      },
      verifyReleaseAsset: async (
        assetPath: string,
        version: string,
        verificationStateDir: string,
        bundlePath: string,
      ) => {
        expect(new Set(["1.2.3", "1.2.4"]).has(version)).toBe(true);
        expect(verificationStateDir).toBe(stateDir);
        verifications.push({ asset: path.basename(assetPath), bundle: path.basename(bundlePath) });
      },
      selfCheckControllerAsset: async (assetPath: string, role: string) => {
        selfChecks.push({ asset: path.basename(assetPath), role });
      },
    });

    const first = await __testing.stageOfficialControllerRelease("1.2.3", context);

    expect(first.changed).toBe(true);
    expect(downloads).toEqual(
      expect.arrayContaining([
        "fased-host-updater.mjs",
        "fased-host-updater.mjs.attestation.json",
        "fased-host-updaterctl.mjs",
        "fased-host-updaterctl.mjs.attestation.json",
      ]),
    );
    expect(verifications).toEqual([
      {
        asset: "fased-host-updater.mjs",
        bundle: "fased-host-updater.mjs.attestation.json",
      },
      {
        asset: "fased-host-updaterctl.mjs",
        bundle: "fased-host-updaterctl.mjs.attestation.json",
      },
    ]);
    expect(selfChecks).toEqual([
      { asset: "fased-host-updater.mjs", role: "server" },
      { asset: "fased-host-updaterctl.mjs", role: "client" },
    ]);
    expect(await fsp.realpath(controllerCurrentLink)).toBe(
      path.join(controllerReleasesDir, "v1.2.3"),
    );
    expect(await fsp.readFile(path.join(controllerCurrentLink, "fased-host-updater.mjs"))).toEqual(
      serverBytes,
    );
    expect(
      await fsp.readFile(path.join(controllerCurrentLink, "fased-host-updaterctl.mjs")),
    ).toEqual(clientBytes);
    expect(JSON.parse(await fsp.readFile(controllerVersionPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      version: "1.2.3",
      serverSha256: createHash("sha256").update(serverBytes).digest("hex"),
      clientSha256: createHash("sha256").update(clientBytes).digest("hex"),
    });

    const second = await __testing.stageOfficialControllerRelease("1.2.3", context);
    expect(second.changed).toBe(false);
    expect(downloads).toHaveLength(4);

    const upgraded = await __testing.stageOfficialControllerRelease("1.2.4", context);
    expect(upgraded.changed).toBe(true);
    expect(await fsp.realpath(controllerCurrentLink)).toBe(
      path.join(controllerReleasesDir, "v1.2.4"),
    );
    expect(fs.existsSync(path.join(controllerReleasesDir, "v1.2.3"))).toBe(true);
    expect(downloads).toHaveLength(8);
    expect(selfChecks).toHaveLength(4);

    const current = await __testing.stageOfficialControllerRelease("1.2.4", context);
    expect(current.changed).toBe(false);
    expect(downloads).toHaveLength(8);
    await expect(__testing.stageOfficialControllerRelease("1.2.3", context)).rejects.toThrow(
      "refusing host updater controller downgrade",
    );
    expect(downloads).toHaveLength(8);
  });

  it("leaves the active controller untouched when a replacement is not verified", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-host-controller-reject-"));
    cleanupRoots.push(root);
    const stateDir = path.join(root, "state");
    const controllerReleasesDir = path.join(root, "controller", "releases");
    const controllerCurrentLink = path.join(root, "controller", "current");
    const controllerVersionPath = path.join(stateDir, "controller-version.json");
    const previousRoot = path.join(controllerReleasesDir, "v1.2.2");
    await fsp.mkdir(previousRoot, { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(previousRoot, "fased-host-updater.mjs"), "old-server\n"),
      fsp.writeFile(path.join(previousRoot, "fased-host-updaterctl.mjs"), "old-client\n"),
      fsp.mkdir(stateDir, { recursive: true }),
    ]);
    await fsp.symlink(previousRoot, controllerCurrentLink, "dir");
    await fsp.writeFile(
      controllerVersionPath,
      `${JSON.stringify({
        schemaVersion: 1,
        version: "1.2.2",
        serverSha256: createHash("sha256").update("old-server\n").digest("hex"),
        clientSha256: createHash("sha256").update("old-client\n").digest("hex"),
      })}\n`,
    );
    const context = __testing.createTransactionContext({
      paths: {
        stateDir,
        controllerReleasesDir,
        controllerCurrentLink,
        controllerVersionPath,
      },
      downloadReleaseAsset: async (_url: string, destination: string) => {
        await fsp.writeFile(destination, "untrusted replacement\n");
      },
      verifyReleaseAsset: async () => {
        throw new Error("attestation rejected");
      },
      selfCheckControllerAsset: async () => undefined,
    });

    await expect(__testing.stageOfficialControllerRelease("1.2.3", context)).rejects.toThrow(
      "attestation rejected",
    );
    expect(await fsp.realpath(controllerCurrentLink)).toBe(previousRoot);
    expect(JSON.parse(await fsp.readFile(controllerVersionPath, "utf8"))).toMatchObject({
      version: "1.2.2",
    });
    expect(fs.existsSync(path.join(controllerReleasesDir, "v1.2.3"))).toBe(false);
    expect(
      (await fsp.readdir(stateDir)).some((entry) => entry.startsWith(".controller-download-")),
    ).toBe(false);
  });

  it("stages official signer releases through published offline attestation bundles", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-host-stage-"));
    cleanupRoots.push(root);
    const stateDir = path.join(root, "state");
    const candidatePath = path.join(root, "candidate", "fased-signerd");
    const platform = `linux-${__testing.releaseArchitecture()}`;
    const assetName = `fased-signerd-${platform}`;
    const signerBytes = Buffer.from("verified signer fixture\n");
    const evidenceVerifierBytes = Buffer.from("verified evidence fixture\n");
    const capabilities = { protocol: { current: 2, min: 2, max: 2 } };
    const manifest = {
      schemaVersion: 2,
      release: { version: "1.2.3", tag: "v1.2.3", commit: "a".repeat(40) },
      application: {
        linux: Object.fromEntries(
          ["x64", "arm64"].map((architecture) => [
            architecture,
            {
              artifact: {
                asset: `fased-hosted-app-v2-linux-${architecture}-v1.2.3.tar.gz`,
                sha256: "b".repeat(64),
              },
              dependencies: {
                asset: `fased-hosted-deps-linux-${architecture}-${"c".repeat(64)}.tar.gz`,
                sha256: "d".repeat(64),
                dependencyHash: "c".repeat(64),
              },
            },
          ]),
        ),
      },
      signer: {
        release: signerRelease("1.2.3"),
        capabilities,
        capabilitiesDigest: capabilitiesDigest(capabilities),
        platforms: {
          [platform]: {
            asset: assetName,
            sha256: createHash("sha256").update(signerBytes).digest("hex"),
          },
        },
      },
    };
    const lifecycleMetadata = {
      release: { version: "1.2.3", commit: "a".repeat(40) },
      targets: {
        evidenceVerifier: {
          asset: "fased-privileged-release-evidence.mjs",
          sha256: createHash("sha256").update(evidenceVerifierBytes).digest("hex"),
        },
      },
    };
    const downloads: string[] = [];
    const verifications: Array<{ asset: string; bundle: string }> = [];
    const context = __testing.createTransactionContext({
      paths: { stateDir },
      downloadReleaseAsset: async (url: string, destination: string) => {
        downloads.push(path.basename(url));
        let contents: string | Buffer = "offline attestation bundle\n";
        if (url.endsWith("/fased-hosted-release-v2.json")) {
          contents = `${JSON.stringify(manifest)}\n`;
        } else if (url.endsWith("/fased-lifecycle-trust-v1.json")) {
          contents = `${JSON.stringify(lifecycleMetadata)}\n`;
        } else if (url.endsWith("/fased-privileged-release-evidence.mjs")) {
          contents = evidenceVerifierBytes;
        } else if (url.endsWith(`/${assetName}`)) {
          contents = signerBytes;
        }
        await fsp.writeFile(destination, contents, { mode: 0o600 });
      },
      verifyReleaseAsset: async (
        assetPath: string,
        version: string,
        verificationStateDir: string,
        bundlePath: string,
      ) => {
        expect(version).toBe("1.2.3");
        expect(verificationStateDir).toBe(stateDir);
        expect(await fsp.readFile(bundlePath, "utf8")).toBe("offline attestation bundle\n");
        verifications.push({ asset: path.basename(assetPath), bundle: path.basename(bundlePath) });
      },
      verifyPrivilegedReleaseEvidence: async () => undefined,
    });

    const staged = await __testing.stageOfficialCandidate("1.2.3", candidatePath, context);

    expect(downloads).toEqual(
      expect.arrayContaining([
        "fased-hosted-release-v2.json",
        "fased-hosted-release-v2.json.attestation.json",
        assetName,
        "fased-signerd-release.attestation.json",
      ]),
    );
    expect(verifications).toEqual(
      expect.arrayContaining([
        {
          asset: "fased-hosted-release-v2.json",
          bundle: "fased-hosted-release-v2.json.attestation.json",
        },
        {
          asset: "fased-lifecycle-trust-v1.json",
          bundle: "fased-lifecycle-trust-v1.json.attestation.json",
        },
        {
          asset: "fased-privileged-provenance-v1.intoto.json",
          bundle: "fased-privileged-provenance-v1.intoto.json.attestation.json",
        },
        { asset: assetName, bundle: "fased-signerd-release.attestation.json" },
      ]),
    );
    expect(await fsp.readFile(candidatePath)).toEqual(signerBytes);
    expect(staged.release).toEqual(signerRelease("1.2.3"));
  });

  it("ignores ambient historical authorization and still requires official controller assets", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-official-controller-"));
    cleanupRoots.push(root);
    const stateDir = path.join(root, "state");
    const releasesDir = path.join(root, "controller", "releases");
    const currentLink = path.join(root, "controller", "current");
    const versionPath = path.join(stateDir, "controller-version.json");
    const historicalDir = path.join(root, "testing");
    const candidateRoot = path.join(releasesDir, `v1.2.3.q0.${"a".repeat(12)}`);
    await Promise.all([
      fsp.mkdir(candidateRoot, { recursive: true }),
      fsp.mkdir(stateDir, { recursive: true }),
      fsp.mkdir(historicalDir, { recursive: true }),
    ]);
    await Promise.all([
      fsp.writeFile(path.join(candidateRoot, "fased-host-updater.mjs"), "candidate server\n"),
      fsp.writeFile(path.join(candidateRoot, "fased-host-updaterctl.mjs"), "candidate client\n"),
      fsp.writeFile(
        path.join(historicalDir, "protected-local-artifact-source.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          baseUrl: "http://127.0.0.1:39091",
          protectedLocalInstance: "0123456789abcdef",
          releaseVersion: "1.2.3",
          releaseCommit: "b".repeat(40),
          forceSameVersionRepair: true,
        })}\n`,
        { mode: 0o600 },
      ),
    ]);
    await fsp.symlink(candidateRoot, currentLink, "dir");
    await fsp.writeFile(
      versionPath,
      `${JSON.stringify({
        schemaVersion: 1,
        version: "1.2.3",
        serverSha256: createHash("sha256").update("candidate server\n").digest("hex"),
        clientSha256: createHash("sha256").update("candidate client\n").digest("hex"),
      })}\n`,
    );
    const context = __testing.createTransactionContext({
      paths: {
        stateDir,
        controllerReleasesDir: releasesDir,
        controllerCurrentLink: currentLink,
        controllerVersionPath: versionPath,
      },
      protectedLocalInstanceId: "0123456789abcdef",
      historicalQ0TestStateDir: historicalDir,
      downloadReleaseAsset: async () => {
        throw new Error("official download attempted");
      },
    });

    await expect(__testing.stageOfficialControllerRelease("1.2.3", context)).rejects.toThrow(
      "official download attempted",
    );
    expect(await fsp.realpath(currentLink)).toBe(candidateRoot);
  });

  it("refuses unsafe historical authorization residue without changing it", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-unsafe-historical-cleanup-"));
    cleanupRoots.push(root);
    const stateDir = path.join(root, "state");
    const controllerReleasesDir = path.join(root, "controller", "releases");
    const historicalDir = path.join(root, "testing");
    const target = path.join(root, "authorization-target.json");
    const authorizationPath = path.join(historicalDir, "protected-local-artifact-source.json");
    await Promise.all([
      fsp.mkdir(stateDir, { recursive: true }),
      fsp.mkdir(controllerReleasesDir, { recursive: true }),
      fsp.mkdir(historicalDir, { recursive: true }),
      fsp.writeFile(target, "{}\n"),
    ]);
    await fsp.symlink(target, authorizationPath);
    const context = __testing.createTransactionContext({
      paths: {
        stateDir,
        controllerReleasesDir,
      },
      protectedLocalInstanceId: "0123456789abcdef",
      rootUid: process.geteuid(),
      historicalQ0TestStateDir: historicalDir,
    });

    await expect(
      __testing.cleanupHistoricalQ0Residue(context, { version: "1.2.3" }),
    ).rejects.toThrow("historical Protected Local artifact authorization is unsafe");
    await expect(fsp.lstat(authorizationPath)).resolves.toMatchObject({});
    await expect(fsp.readFile(target, "utf8")).resolves.toBe("{}\n");
  });

  it("refuses unknown historical test-state entries before removing residue", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-unknown-historical-cleanup-"));
    cleanupRoots.push(root);
    const stateDir = path.join(root, "state");
    const controllerReleasesDir = path.join(root, "controller", "releases");
    const historicalDir = path.join(root, "testing");
    const unknownPath = path.join(historicalDir, "owner-data.json");
    await Promise.all([
      fsp.mkdir(stateDir, { recursive: true }),
      fsp.mkdir(controllerReleasesDir, { recursive: true }),
      fsp.mkdir(historicalDir, { recursive: true }),
    ]);
    await fsp.writeFile(unknownPath, "{}\n");
    const context = __testing.createTransactionContext({
      paths: {
        stateDir,
        controllerReleasesDir,
      },
      protectedLocalInstanceId: "0123456789abcdef",
      rootUid: process.geteuid(),
      historicalQ0TestStateDir: historicalDir,
    });

    await expect(
      __testing.cleanupHistoricalQ0Residue(context, { version: "1.2.3" }),
    ).rejects.toThrow(
      "historical Protected Local test state directory contains unknown entry owner-data.json",
    );
    await expect(fsp.readFile(unknownPath, "utf8")).resolves.toBe("{}\n");
  });

  it("tolerates validated historical residue disappearing after exact official convergence", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-historical-cleanup-"));
    cleanupRoots.push(root);
    const stateDir = path.join(root, "state");
    const controllerReleasesDir = path.join(root, "controller", "releases");
    const controllerCurrentLink = path.join(root, "controller", "current");
    const controllerVersionPath = path.join(stateDir, "controller-version.json");
    const applicationReleasesDir = path.join(root, "application", "releases");
    const applicationCurrentLink = path.join(root, "application", "current");
    const historicalDir = path.join(root, "testing");
    const authorizationPath = path.join(historicalDir, "protected-local-artifact-source.json");
    const targetVersion = "1.2.3";
    const targetCommit = "a".repeat(40);
    const oldVersion = "1.2.2";
    const oldCommit = "b".repeat(40);
    const controllerTarget = path.join(controllerReleasesDir, `v${targetVersion}`);
    const controllerOld = path.join(controllerReleasesDir, `v${oldVersion}`);
    const controllerCandidate = path.join(
      controllerReleasesDir,
      `v${oldVersion}.q0.${"c".repeat(12)}`,
    );
    const applicationTarget = path.join(applicationReleasesDir, `v${targetVersion}`);
    const applicationOld = path.join(applicationReleasesDir, `v${oldVersion}`);
    const applicationCandidate = path.join(
      applicationReleasesDir,
      `v${oldVersion}.q0-app.${"d".repeat(12)}`,
    );
    for (const directory of [
      controllerTarget,
      controllerOld,
      controllerCandidate,
      applicationCandidate,
      stateDir,
      historicalDir,
    ]) {
      await fsp.mkdir(directory, { recursive: true });
    }
    const controllerBytes = {
      targetServer: Buffer.from("target server\n"),
      targetClient: Buffer.from("target client\n"),
      oldServer: Buffer.from("old server\n"),
      oldClient: Buffer.from("old client\n"),
    };
    await Promise.all([
      fsp.writeFile(
        path.join(controllerTarget, "fased-host-updater.mjs"),
        controllerBytes.targetServer,
      ),
      fsp.writeFile(
        path.join(controllerTarget, "fased-host-updaterctl.mjs"),
        controllerBytes.targetClient,
      ),
      fsp.writeFile(path.join(controllerOld, "fased-host-updater.mjs"), controllerBytes.oldServer),
      fsp.writeFile(
        path.join(controllerOld, "fased-host-updaterctl.mjs"),
        controllerBytes.oldClient,
      ),
      fsp.writeFile(path.join(controllerCandidate, "fased-host-updater.mjs"), "candidate server\n"),
      fsp.writeFile(
        path.join(controllerCandidate, "fased-host-updaterctl.mjs"),
        "candidate client\n",
      ),
      writeProtectedApplicationFixture({
        root: applicationTarget,
        version: targetVersion,
        commit: targetCommit,
        dependencyHash: "1".repeat(64),
      }),
      writeProtectedApplicationFixture({
        root: applicationOld,
        version: oldVersion,
        commit: oldCommit,
        dependencyHash: "2".repeat(64),
      }),
    ]);
    await Promise.all([
      fsp.symlink(controllerTarget, controllerCurrentLink, "dir"),
      fsp.symlink(applicationTarget, applicationCurrentLink, "dir"),
    ]);
    const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    const targetIdentity = {
      schemaVersion: 1,
      version: targetVersion,
      serverSha256: digest(controllerBytes.targetServer),
      clientSha256: digest(controllerBytes.targetClient),
    };
    const oldIdentity = {
      schemaVersion: 1,
      version: oldVersion,
      serverSha256: digest(controllerBytes.oldServer),
      clientSha256: digest(controllerBytes.oldClient),
    };
    await Promise.all([
      fsp.writeFile(controllerVersionPath, `${JSON.stringify(targetIdentity)}\n`, {
        mode: 0o600,
      }),
      fsp.writeFile(
        path.join(stateDir, "q0-controller-candidate.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          originalRoot: controllerOld,
          candidateRoot: controllerCandidate,
          identityBase64: Buffer.from(`${JSON.stringify(oldIdentity)}\n`).toString("base64"),
          identityMode: 0o600,
        })}\n`,
        { mode: 0o600 },
      ),
      fsp.writeFile(
        path.join(stateDir, "q0-application-candidate.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          originalRoot: applicationOld,
          candidateRoot: applicationCandidate,
          version: oldVersion,
          commit: oldCommit,
          linkOwner: { uid: process.geteuid(), gid: process.getegid() },
        })}\n`,
        { mode: 0o600 },
      ),
      fsp.writeFile(
        authorizationPath,
        `${JSON.stringify({
          schemaVersion: 1,
          baseUrl: "http://127.0.0.1:39091",
          protectedLocalInstance: "0123456789abcdef",
          releaseVersion: oldVersion,
          releaseCommit: oldCommit,
          forceSameVersionRepair: true,
        })}\n`,
        { mode: 0o600 },
      ),
      fsp.writeFile(
        path.join(historicalDir, "q0-protected-local-artifact-source-backup.json"),
        `${JSON.stringify({ schemaVersion: 1, previous: { exists: false } })}\n`,
        { mode: 0o600 },
      ),
    ]);
    const context = __testing.createTransactionContext({
      paths: {
        stateDir,
        controllerReleasesDir,
        controllerCurrentLink,
        controllerVersionPath,
        applicationReleasesDir,
        applicationCurrentLink,
      },
      protectedLocalInstanceId: "0123456789abcdef",
      rootUid: process.geteuid(),
      historicalQ0TestStateDir: historicalDir,
      beforeHistoricalResidueRemoval: async () => {
        await fsp.rm(authorizationPath, { force: true });
      },
    });

    const result = await __testing.cleanupHistoricalQ0Residue(context, {
      version: targetVersion,
      application: { targetRoot: applicationTarget },
      releaseBinding: { releaseCommit: targetCommit },
    });

    expect(result.changed).toBe(true);
    expect(await fsp.realpath(controllerCurrentLink)).toBe(controllerTarget);
    expect(await fsp.realpath(applicationCurrentLink)).toBe(applicationTarget);
    for (const removed of [
      controllerCandidate,
      applicationCandidate,
      path.join(stateDir, "q0-controller-candidate.json"),
      path.join(stateDir, "q0-application-candidate.json"),
      authorizationPath,
      path.join(historicalDir, "q0-protected-local-artifact-source-backup.json"),
    ]) {
      expect(fs.existsSync(removed)).toBe(false);
    }
    expect(fs.existsSync(historicalDir)).toBe(false);
    expect(fs.existsSync(controllerOld)).toBe(true);
    expect(fs.existsSync(applicationOld)).toBe(true);
    expect(result.removed).not.toContain(authorizationPath);

    await fsp.mkdir(historicalDir);
    const emptyDirectoryResult = await __testing.cleanupHistoricalQ0Residue(context, {
      version: targetVersion,
      application: { targetRoot: applicationTarget },
      releaseBinding: { releaseCommit: targetCommit },
    });
    expect(emptyDirectoryResult).toEqual({ changed: true, removed: [historicalDir] });
    expect(fs.existsSync(historicalDir)).toBe(false);
  });

  it("always passes an offline bundle to GitHub attestation verification", () => {
    const args = __testing.releaseAttestationVerifyArgs("/tmp/asset", "1.2.3", "/tmp/bundle.json");
    expect(args).toContain("--bundle");
    expect(args[args.indexOf("--bundle") + 1]).toBe("/tmp/bundle.json");
    expect(args).toContain("refs/tags/v1.2.3");
    expect(() => __testing.releaseAttestationVerifyArgs("/tmp/asset", "1.2.3", "")).toThrow(
      "offline release attestation bundle is required",
    );
  });

  it("wires repair-hosting prepare, activation, app verification, and commit in order", () => {
    const installer = fs.readFileSync(path.join(import.meta.dirname, "..", "install.sh"), "utf8");
    const prepare = installer.indexOf('"$version" --prepare-only');
    const unitWrite = installer.indexOf("cat >/etc/systemd/system/fased-signerd.service", prepare);
    const activate = installer.indexOf('"$version" --activate-only', unitWrite);
    const child = installer.indexOf("re-executing installer as");
    const finalize = installer.indexOf("hosted-transaction finalize", child);
    const commit = installer.indexOf('"$HOST_SIGNER_TRANSACTION_VERSION" --commit-only', finalize);
    const rootFlow = installer.indexOf('if [[ "$(id -u)" -eq 0 ]]');
    const installCall = installer.indexOf("install_host_signer_and_updater_services", rootFlow);
    const migrationCall = installer.indexOf("migrate_legacy_hosted_signer_if_needed", installCall);
    const reexecCall = installer.indexOf("reexec_as_app_user", migrationCall);
    expect(prepare).toBeGreaterThan(0);
    expect(unitWrite).toBeGreaterThan(prepare);
    expect(activate).toBeGreaterThan(unitWrite);
    expect(finalize).toBeGreaterThan(child);
    expect(commit).toBeGreaterThan(finalize);
    expect(installCall).toBeGreaterThan(rootFlow);
    expect(migrationCall).toBeGreaterThan(installCall);
    expect(reexecCall).toBeGreaterThan(migrationCall);
    expect(installer).not.toContain("FASED_DEFER_LEGACY_QUARANTINE");
    expect(installer).toContain(
      "ConditionPathExists=!/var/lib/fased-host-updater/gateway-update-gate",
    );
    expect(installer).toContain("-update-gate /var/lib/fased-signer-update-gate/active");
  });

  it("accepts only an exact release version", () => {
    expect(parseReleaseVersion("v1.2.3")).toBe("1.2.3");
    expect(parseReleaseVersion("1.2.3-beta.1")).toBe("1.2.3-beta.1");
    for (const value of ["latest", "main", "1.2", "1.2.3+local", "1.2.3/../../tmp", ""]) {
      expect(() => parseReleaseVersion(value)).toThrow();
    }
  });

  it("rejects pre-v2 clients before any release action with the one-time migration command", () => {
    expect(() =>
      parseUpdateRequest({ schemaVersion: 1, op: "prepareRelease", version: "1.2.3" }),
    ).toThrow(legacyHostingBootstrapMessage("1.2.3"));
    expect(() =>
      parseUpdateRequest({ schemaVersion: 1, op: "prepareRelease", version: "1.2.3-rc.4" }),
    ).toThrow(legacyHostingBootstrapMessage("1.2.3-rc.4"));
    expect(hostingBootstrapCommand("1.2.3")).toContain(
      "--hosting --release v1.2.3 --update-channel stable",
    );
    expect(hostingBootstrapCommand("1.2.3")).toContain(
      "https://github.com/fased-ai/fased/releases/download/v1.2.3/install.sh",
    );
    expect(hostingBootstrapCommand("v1.2.3-rc.4")).toContain(
      "--hosting --release v1.2.3-rc.4 --update-channel beta",
    );
    expect(PRE_V2_HOSTING_MIGRATION_MESSAGE).toContain("curl -fsSL");
    expect(PRE_V2_HOSTING_MIGRATION_MESSAGE).not.toContain("--repair-hosting");
    expect(PRE_V2_HOSTING_MIGRATION_MESSAGE).toContain("Never run /home/app/fased/install.sh");
    expect(PRE_V2_HOSTING_MIGRATION_MESSAGE).toContain("left unchanged");
    expect(() =>
      parseUpdateRequest({
        schemaVersion: 1,
        op: "prepareRelease",
        version: "1.2.3",
        url: "https://evil.invalid",
      }),
    ).toThrow("unsupported updater request");
    expect(() =>
      parseUpdateRequest({ schemaVersion: 1, op: "rollbackRelease", version: "1.2.3" }),
    ).toThrow("unsupported updater request");
  });

  it("accepts only exact protocol-v2 transaction requests", () => {
    for (const op of [
      "updateController",
      "applyRelease",
      "prepareRelease",
      "activateRelease",
      "authorizeGatewayRelease",
      "gateGatewayRelease",
      "restartGateway",
      "commitRelease",
      "rollbackRelease",
    ]) {
      expect(
        parseUpdateRequest({
          schemaVersion: 2,
          op,
          transactionId: TRANSACTION_ONE,
          version: "1.2.3",
        }),
      ).toEqual({
        schemaVersion: 2,
        op,
        transactionId: TRANSACTION_ONE,
        version: "1.2.3",
      });
    }
    expect(() =>
      parseUpdateRequest({
        schemaVersion: 2,
        op: "prepareRelease",
        transactionId: TRANSACTION_ONE,
        version: "1.2.3",
        url: "https://evil.invalid",
      }),
    ).toThrow("unsupported fields");
    expect(() =>
      parseUpdateRequest({
        schemaVersion: 2,
        op: "prepareRelease",
        transactionId: "not-a-uuid",
        version: "1.2.3",
      }),
    ).toThrow("UUIDv4");
  });

  it("keeps hosted Gateway process control inside the root controller", async () => {
    const { context } = await createFixture();
    let stopped = 0;
    let restarted = 0;
    context.stopGateway = async () => {
      stopped += 1;
    };
    context.restartGateway = async () => {
      restarted += 1;
    };
    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    await __testing.gateGatewayRelease(
      request("gateGatewayRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    expect(stopped).toBe(1);
    await __testing.rollbackSignerRelease(
      request("rollbackRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    await expect(
      __testing.restartGatewayService(request("restartGateway", TRANSACTION_TWO, "1.2.2"), context),
    ).resolves.toMatchObject({ phase: "restarted" });
    expect(restarted).toBe(1);
    await expect(
      __testing.restartGatewayService(request("restartGateway", TRANSACTION_TWO, "1.2.3"), context),
    ).rejects.toThrow("does not match installed signer");
  });

  it("accepts the redundant legacy restart only after the target Gateway is authorized", async () => {
    const { context, paths } = await createFixture();
    let restarted = 0;
    context.restartGateway = async () => {
      restarted += 1;
    };

    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    await expect(
      __testing.restartGatewayService(request("restartGateway", TRANSACTION_TWO, "1.2.3"), context),
    ).rejects.toThrow("cannot restart the Gateway while a hosted release transaction is active");

    await __testing.activateSignerRelease(
      request("activateRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    await __testing.authorizeGatewayRelease(
      request("authorizeGatewayRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    expect(fs.existsSync(paths.gatewayGatePath)).toBe(false);

    await expect(
      __testing.restartGatewayService(request("restartGateway", TRANSACTION_TWO, "1.2.3"), context),
    ).resolves.toEqual({
      transactionId: TRANSACTION_TWO,
      version: "1.2.3",
      phase: "gateway-authorized",
      changed: false,
    });
    expect(restarted).toBe(0);

    await expect(
      __testing.restartGatewayService(request("restartGateway", TRANSACTION_TWO, "1.2.4"), context),
    ).rejects.toThrow("cannot restart the Gateway while a hosted release transaction is active");

    const failed = await createFixture();
    failed.context.startGateway = async () => {
      throw new Error("injected target start failure");
    };
    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_ONE, "1.2.3"),
      failed.context,
    );
    await __testing.activateSignerRelease(
      request("activateRelease", TRANSACTION_ONE, "1.2.3"),
      failed.context,
    );
    await expect(
      __testing.authorizeGatewayRelease(
        request("authorizeGatewayRelease", TRANSACTION_ONE, "1.2.3"),
        failed.context,
      ),
    ).rejects.toThrow("injected target start failure");
    expect(fs.existsSync(failed.paths.gatewayGatePath)).toBe(true);
    await expect(
      __testing.restartGatewayService(
        request("restartGateway", TRANSACTION_TWO, "1.2.3"),
        failed.context,
      ),
    ).rejects.toThrow("cannot restart the Gateway while a hosted release transaction is active");
  });

  it("keeps a verified forward controller after the signer transaction rolls back", async () => {
    const { context } = await createFixture();
    context.stageControllerRelease = async () => {
      context.controllerRestartRequired = true;
      return { changed: true };
    };
    await expect(
      __testing.prepareSignerRelease(request("prepareRelease", TRANSACTION_ONE, "1.2.3"), context),
    ).resolves.toMatchObject({ phase: "prepared", controllerChanged: true });

    await __testing.rollbackSignerRelease(
      request("rollbackRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    expect(context.controllerRestartRequired).toBe(true);
    expect(fs.existsSync(context.paths.journalPath)).toBe(false);
  });

  it("reports the exact controller process that must restart before signer preparation", async () => {
    const { context } = await createFixture();
    context.controllerInstanceId = TRANSACTION_TWO;
    context.stageControllerRelease = async () => {
      context.controllerRestartRequired = true;
      return { changed: true };
    };

    await expect(
      __testing.updateControllerRelease(
        request("updateController", TRANSACTION_ONE, "1.2.3"),
        context,
      ),
    ).resolves.toEqual({
      transactionId: TRANSACTION_ONE,
      version: "1.2.3",
      controllerChanged: true,
      controllerInstanceId: TRANSACTION_TWO,
    });
    expect(context.controllerRestartRequired).toBe(true);
  });

  it("prepares without live mutation, restores binary and database on rollback, and commits durably", async () => {
    const { context, events, paths } = await createFixture();
    const prepare = request("prepareRelease", TRANSACTION_ONE, "1.2.3");
    const prepared = await __testing.prepareSignerRelease(prepare, context);
    expect(prepared).toMatchObject({ phase: "prepared", changed: true });
    expect(await fsp.readFile(paths.signerPath, "utf8")).toBe("old-signer\n");
    expect(await fsp.readFile(paths.signerStateDBPath, "utf8")).toBe("old-db\n");
    expect(await fsp.readFile(paths.versionPath, "utf8")).toBe("1.2.2\n");
    expect(await fsp.readFile(paths.signerUnitPath, "utf8")).toBe("ExecStart=old-signer\n");
    expect(fs.existsSync(paths.gatewayGatePath)).toBe(true);
    expect(fs.existsSync(paths.signerGatePath)).toBe(true);
    expect((await fsp.stat(path.dirname(paths.signerGatePath))).mode & 0o777).toBe(0o755);
    expect(events).toEqual(["stage:1.2.3"]);

    await __testing.activateSignerRelease(
      request("activateRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    const transactionPaths = __testing.transactionPaths(paths, TRANSACTION_ONE);
    expect(await fsp.readFile(paths.signerPath, "utf8")).toBe("signer-1.2.3\n");
    expect(await fsp.readFile(paths.signerStateDBPath, "utf8")).toBe("new-db\n");
    expect(await fsp.readFile(transactionPaths.previousBinaryPath, "utf8")).toBe("old-signer\n");
    expect(await fsp.readFile(transactionPaths.stateDBSnapshotPath, "utf8")).toBe("old-db\n");
    expect(await fsp.readFile(transactionPaths.signerUnitSnapshotPath, "utf8")).toBe(
      "ExecStart=old-signer\n",
    );
    expect(fs.existsSync(paths.gatewayGatePath)).toBe(true);
    expect(fs.existsSync(paths.signerGatePath)).toBe(true);

    await fsp.writeFile(paths.signerUnitPath, "ExecStart=new-signer-v2\n", { mode: 0o644 });

    await __testing.rollbackSignerRelease(
      request("rollbackRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    expect(await fsp.readFile(paths.signerPath, "utf8")).toBe("old-signer\n");
    expect(await fsp.readFile(paths.signerStateDBPath, "utf8")).toBe("old-db\n");
    expect(await fsp.readFile(paths.versionPath, "utf8")).toBe("1.2.2\n");
    expect(await fsp.readFile(paths.signerUnitPath, "utf8")).toBe("ExecStart=old-signer\n");
    expect(fs.existsSync(paths.journalPath)).toBe(false);
    expect(fs.existsSync(transactionPaths.transactionDir)).toBe(false);
    expect(fs.existsSync(paths.gatewayGatePath)).toBe(false);
    expect(fs.existsSync(paths.signerGatePath)).toBe(false);

    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_TWO, "1.2.4"),
      context,
    );
    await __testing.activateSignerRelease(
      request("activateRelease", TRANSACTION_TWO, "1.2.4"),
      context,
    );
    await __testing.authorizeGatewayRelease(
      request("authorizeGatewayRelease", TRANSACTION_TWO, "1.2.4"),
      context,
    );
    expect(fs.existsSync(paths.gatewayGatePath)).toBe(false);
    expect(fs.existsSync(paths.signerGatePath)).toBe(true);
    await __testing.commitSignerRelease(
      request("commitRelease", TRANSACTION_TWO, "1.2.4"),
      context,
    );
    expect(await fsp.readFile(paths.signerPath, "utf8")).toBe("signer-1.2.4\n");
    expect(await fsp.readFile(paths.versionPath, "utf8")).toBe("1.2.4\n");
    expect(await fsp.readFile(paths.rollbackFloorPath, "utf8")).toBe("1.2.4\n");
    expect(fs.existsSync(paths.journalPath)).toBe(false);
    expect(fs.existsSync(paths.signerGatePath)).toBe(false);
    await expect(
      __testing.prepareSignerRelease(request("prepareRelease", TRANSACTION_ONE, "1.2.3"), context),
    ).rejects.toThrow("rollback floor is v1.2.4");
    await fsp.writeFile(paths.rollbackFloorPath, "corrupt\n", { mode: 0o600 });
    await expect(
      __testing.prepareSignerRelease(request("prepareRelease", TRANSACTION_ONE, "1.2.5"), context),
    ).rejects.toThrow("rollback floor is invalid");
  });

  it("rolls back when activation changes any signer-owned policy, network, or WebAuthn state", async () => {
    const { context, events, paths } = await createFixture();
    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    context.startSignerV2 = async () => {
      events.push("start-v2-mismatched-state");
      await fsp.writeFile(paths.signerStateDBPath, "mutated-db\n", { mode: 0o600 });
      return {
        release: signerRelease("1.2.3"),
        invariant: "changed-signer-state",
      };
    };

    await expect(
      __testing.activateSignerRelease(
        request("activateRelease", TRANSACTION_ONE, "1.2.3"),
        context,
      ),
    ).rejects.toThrow("did not preserve exact wallet, policy, network, and WebAuthn state");
    expect(await fsp.readFile(paths.signerPath, "utf8")).toBe("old-signer\n");
    expect(await fsp.readFile(paths.signerStateDBPath, "utf8")).toBe("old-db\n");
    expect(await fsp.readFile(paths.versionPath, "utf8")).toBe("1.2.2\n");
    expect(fs.existsSync(paths.journalPath)).toBe(false);
    expect(fs.existsSync(paths.gatewayGatePath)).toBe(true);
    expect(fs.existsSync(paths.signerGatePath)).toBe(true);
  });

  it("recovers interrupted prepare conservatively without stopping the live signer", async () => {
    const { context, events, paths } = await createFixture();
    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    const recovered = await __testing.recoverInterruptedTransaction(context);
    expect(recovered).toMatchObject({ recovered: true, action: "rolled-back" });
    expect(events).toEqual([
      "stage:1.2.3",
      "stop",
      "daemon-reload",
      "start-previous",
      "start-gateway",
    ]);
    expect(await fsp.readFile(paths.signerPath, "utf8")).toBe("old-signer\n");
    expect(fs.existsSync(paths.journalPath)).toBe(false);
    expect(fs.existsSync(paths.gatewayGatePath)).toBe(false);
    expect(fs.existsSync(paths.signerGatePath)).toBe(false);
  });

  it("finishes a durable commit decision and rolls back an interrupted activation", async () => {
    const first = await createFixture();
    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_ONE, "1.2.3"),
      first.context,
    );
    await __testing.activateSignerRelease(
      request("activateRelease", TRANSACTION_ONE, "1.2.3"),
      first.context,
    );
    const committing = await __testing.readJournal(first.context);
    await __testing.writeJournal(first.context, { ...committing, phase: "committing" });
    await expect(__testing.recoverInterruptedTransaction(first.context)).resolves.toMatchObject({
      recovered: true,
      action: "committed",
    });
    expect(await fsp.readFile(first.paths.rollbackFloorPath, "utf8")).toBe("1.2.3\n");

    const second = await createFixture();
    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_TWO, "1.2.3"),
      second.context,
    );
    await __testing.activateSignerRelease(
      request("activateRelease", TRANSACTION_TWO, "1.2.3"),
      second.context,
    );
    const active = await __testing.readJournal(second.context);
    await __testing.writeJournal(second.context, { ...active, phase: "activating" });
    await expect(__testing.recoverInterruptedTransaction(second.context)).resolves.toMatchObject({
      recovered: true,
      action: "rolled-back",
    });
    expect(await fsp.readFile(second.paths.signerPath, "utf8")).toBe("old-signer\n");
    expect(await fsp.readFile(second.paths.signerStateDBPath, "utf8")).toBe("old-db\n");
    expect(await fsp.readFile(second.paths.versionPath, "utf8")).toBe("1.2.2\n");
  });

  it("rolls back pre-verification signer decisions across a cold service restart", async () => {
    const { context, paths } = await createFixture();
    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    await __testing.activateSignerRelease(
      request("activateRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    await expect(__testing.recoverInterruptedTransaction(context)).resolves.toMatchObject({
      recovered: true,
      action: "rolled-back",
    });
    expect(fs.existsSync(paths.gatewayGatePath)).toBe(false);
    expect(fs.existsSync(paths.signerGatePath)).toBe(false);

    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    await __testing.activateSignerRelease(
      request("activateRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    await __testing.authorizeGatewayRelease(
      request("authorizeGatewayRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    await expect(__testing.recoverInterruptedTransaction(context)).resolves.toMatchObject({
      recovered: true,
      action: "rolled-back",
    });
    expect(fs.existsSync(paths.gatewayGatePath)).toBe(false);
    expect(fs.existsSync(paths.signerGatePath)).toBe(false);
  });

  it.each([
    ["prepared", "rolled-back"],
    ["state-reconciling", "rolled-back"],
    ["state-reconciled", "rolled-back"],
    ["schema-ready", "rolled-back"],
    ["snapshotting", "rolled-back"],
    ["activating", "rolled-back"],
    ["active", "rolled-back"],
    ["gateway-authorized", "rolled-back"],
    ["gateway-verified", "committed"],
    ["committing", "committed"],
  ])(
    "recovers a deterministic target-controller crash after durable %s by going fully %s",
    async (crashPhase, expectedAction) => {
      const { context, paths } = await createFixture();
      context.verifyGateway = async () => ({ version: "1.2.3", runtimeSource: "managed-package" });
      context.probeSigner = async () => signerRelease("1.2.3");
      let injected = false;
      context.onDurablePhase = async (phase: string) => {
        if (!injected && phase === crashPhase) {
          injected = true;
          const error = new Error(`deterministic crash after ${phase}`) as Error & {
            code?: string;
          };
          error.code = "FASED_TEST_CRASH";
          throw error;
        }
      };

      await expect(
        __testing.applyReleaseTransaction(
          request("applyRelease", TRANSACTION_ONE, "1.2.3"),
          context,
        ),
      ).rejects.toMatchObject({ code: "FASED_TEST_CRASH" });
      expect(injected).toBe(true);

      context.onDurablePhase = undefined;
      await expect(__testing.recoverInterruptedTransaction(context)).resolves.toMatchObject({
        recovered: true,
        action: expectedAction,
      });
      expect(fs.existsSync(paths.journalPath)).toBe(false);
      expect(fs.existsSync(paths.gatewayGatePath)).toBe(false);
      expect(fs.existsSync(paths.signerGatePath)).toBe(false);
      expect(await fsp.readFile(paths.versionPath, "utf8")).toBe(
        expectedAction === "committed" ? "1.2.3\n" : "1.2.2\n",
      );
      expect(await fsp.readFile(paths.signerPath, "utf8")).toBe(
        expectedAction === "committed" ? "signer-1.2.3\n" : "old-signer\n",
      );
    },
  );

  it.each(["rolling-back", "restored"])(
    "recovers a deterministic target-controller crash after durable %s rollback state",
    async (crashPhase) => {
      const { context, paths } = await createFixture({ managedApplication: true });
      context.verifyGateway = async () => {
        throw new Error("deterministic target health failure");
      };
      context.probeSigner = async () => signerRelease("1.2.3");
      let injected = false;
      context.onDurablePhase = async (phase: string) => {
        if (!injected && phase === crashPhase) {
          injected = true;
          const error = new Error(`deterministic crash after ${phase}`) as Error & {
            code?: string;
          };
          error.code = "FASED_TEST_CRASH";
          throw error;
        }
      };

      await expect(
        __testing.applyReleaseTransaction(
          request("applyRelease", TRANSACTION_ONE, "1.2.3"),
          context,
        ),
      ).rejects.toMatchObject({ code: "TARGET_ROLLBACK_INCOMPLETE" });
      expect(injected).toBe(true);
      expect(fs.existsSync(paths.journalPath)).toBe(true);

      context.onDurablePhase = undefined;
      await expect(__testing.recoverInterruptedTransaction(context)).resolves.toMatchObject({
        recovered: true,
        action: "rolled-back",
      });
      expect(fs.existsSync(paths.journalPath)).toBe(false);
      expect(fs.existsSync(paths.gatewayGatePath)).toBe(false);
      expect(fs.existsSync(paths.signerGatePath)).toBe(false);
      expect(await fsp.readFile(paths.versionPath, "utf8")).toBe("1.2.2\n");
      expect(await fsp.readFile(paths.signerPath, "utf8")).toBe("old-signer\n");
    },
  );

  it.each([
    "artifact network loss",
    "artifact checksum rejection",
    "artifact staging disk exhaustion",
    "service-boundary permission denial",
    "signer process crash",
    "Gateway process crash",
    "cross-product health timeout",
  ])("rolls back %s and succeeds on the same-command retry", async (failureClass) => {
    const { context, paths } = await createFixture();
    const original = {
      stageCandidate: context.stageCandidate,
      applyServiceBoundary: context.applyServiceBoundary,
      startSignerV2: context.startSignerV2,
      startGateway: context.startGateway,
      verifyGateway: context.verifyGateway,
    };
    context.verifyGateway = async () => ({
      version: "1.2.3",
      runtimeSource: "managed-package",
    });
    context.probeSigner = async () => signerRelease("1.2.3");

    const injectedError = (message: string, code: string) => {
      const error = new Error(message) as Error & { code?: string };
      error.code = code;
      throw error;
    };
    switch (failureClass) {
      case "artifact network loss":
        context.stageCandidate = async () =>
          injectedError("injected artifact network loss", "ECONNRESET");
        break;
      case "artifact checksum rejection":
        context.stageCandidate = async () =>
          injectedError("injected artifact checksum mismatch", "EBADMSG");
        break;
      case "artifact staging disk exhaustion":
        context.stageCandidate = async () =>
          injectedError("injected artifact staging disk exhaustion", "ENOSPC");
        break;
      case "service-boundary permission denial":
        context.applyServiceBoundary = async () =>
          injectedError("injected service-boundary permission denial", "EACCES");
        break;
      case "signer process crash":
        context.startSignerV2 = async () =>
          injectedError("injected signer process crash", "ECONNRESET");
        break;
      case "Gateway process crash":
        context.startGateway = async () =>
          injectedError("injected Gateway process crash", "ECONNRESET");
        break;
      case "cross-product health timeout":
        context.verifyGateway = async () =>
          injectedError("injected cross-product health timeout", "ETIMEDOUT");
        break;
      default:
        throw new Error(`unsupported deterministic failure class: ${failureClass}`);
    }

    await expect(
      __testing.applyReleaseTransaction(request("applyRelease", TRANSACTION_ONE, "1.2.3"), context),
    ).rejects.toBeInstanceOf(Error);
    expect(fs.existsSync(paths.journalPath)).toBe(false);
    expect(fs.existsSync(paths.gatewayGatePath)).toBe(false);
    expect(fs.existsSync(paths.signerGatePath)).toBe(false);
    expect(await fsp.readFile(paths.versionPath, "utf8")).toBe("1.2.2\n");
    expect(await fsp.readFile(paths.signerPath, "utf8")).toBe("old-signer\n");
    expect(await fsp.readFile(paths.signerStateDBPath, "utf8")).toBe("old-db\n");

    Object.assign(context, original);
    context.verifyGateway = async () => ({
      version: "1.2.3",
      runtimeSource: "managed-package",
    });
    await expect(
      __testing.applyReleaseTransaction(request("applyRelease", TRANSACTION_ONE, "1.2.3"), context),
    ).resolves.toMatchObject({
      transactionId: TRANSACTION_ONE,
      version: "1.2.3",
      phase: "committed",
    });
    await expect(
      __testing.applyReleaseTransaction(request("applyRelease", TRANSACTION_ONE, "1.2.3"), context),
    ).resolves.toMatchObject({
      phase: "committed",
      changed: false,
    });
  });

  it("rejects a different request without mutating the active target-owned transaction", async () => {
    const { context, paths } = await createFixture();
    context.verifyGateway = async () => ({ version: "1.2.3", runtimeSource: "managed-package" });
    context.probeSigner = async () => signerRelease("1.2.3");
    context.onDurablePhase = async (phase: string) => {
      if (phase === "prepared") {
        const error = new Error("deterministic crash after prepared") as Error & {
          code?: string;
        };
        error.code = "FASED_TEST_CRASH";
        throw error;
      }
    };
    await expect(
      __testing.applyReleaseTransaction(request("applyRelease", TRANSACTION_ONE, "1.2.3"), context),
    ).rejects.toMatchObject({ code: "FASED_TEST_CRASH" });
    const active = await __testing.readJournal(context);

    context.onDurablePhase = undefined;
    await expect(
      __testing.applyReleaseTransaction(request("applyRelease", TRANSACTION_TWO, "1.2.3"), context),
    ).rejects.toThrow(`another hosted signer transaction is active (${TRANSACTION_ONE}, v1.2.3)`);
    expect(await __testing.readJournal(context)).toEqual(active);
    expect(fs.existsSync(paths.gatewayGatePath)).toBe(false);

    await expect(__testing.recoverInterruptedTransaction(context)).resolves.toMatchObject({
      recovered: true,
      action: "rolled-back",
    });
    expect(fs.existsSync(paths.journalPath)).toBe(false);
  });

  it("runs one target-owned transaction and makes committed retries idempotent", async () => {
    const { context, events, paths } = await createFixture();
    let healthChecks = 0;
    context.verifyGateway = async () => {
      healthChecks += 1;
      return { version: "1.2.3", runtimeSource: "managed-package" };
    };
    context.probeSigner = async () => signerRelease("1.2.3");

    await expect(
      __testing.applyReleaseTransaction(request("applyRelease", TRANSACTION_ONE, "1.2.3"), context),
    ).resolves.toMatchObject({
      transactionId: TRANSACTION_ONE,
      version: "1.2.3",
      phase: "committed",
      release: signerRelease("1.2.3"),
    });
    await expect(
      __testing.applyReleaseTransaction(request("applyRelease", TRANSACTION_ONE, "1.2.3"), context),
    ).resolves.toMatchObject({
      transactionId: TRANSACTION_ONE,
      version: "1.2.3",
      phase: "committed",
      changed: false,
    });

    expect(events.filter((event) => event === "start-v2")).toHaveLength(1);
    expect(events.filter((event) => event === "start-gateway")).toHaveLength(1);
    expect(healthChecks).toBe(2);
    expect(fs.existsSync(paths.journalPath)).toBe(false);
  });

  it("commits or restores application, signer, service gate, and manifest as one transaction", async () => {
    const committed = await createFixture({ managedApplication: true });
    committed.context.verifyGateway = async () => ({
      version: "1.2.3",
      runtimeSource: "managed-package",
    });
    await __testing.applyReleaseTransaction(
      request("applyRelease", TRANSACTION_ONE, "1.2.3"),
      committed.context,
    );
    const committedState = path.join(committed.paths.stateDir, "..", "operator", ".fased");
    expect(await fsp.realpath(path.join(committedState, "runtime", "current"))).toBe(
      path.join(committed.paths.applicationReleasesDir!, "v1.2.3"),
    );
    expect(
      JSON.parse(await fsp.readFile(path.join(committedState, "install.json"), "utf8")).runtime
        .activeVersion,
    ).toBe("1.2.3");
    expect(
      JSON.parse(await fsp.readFile(path.join(committedState, "last-update-success.json"), "utf8"))
        .schemaMigration,
    ).toMatchObject({
      schemaVersion: 1,
      applied: true,
      planDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(await fsp.readFile(committed.paths.signerPath, "utf8")).toBe("signer-1.2.3\n");

    const rolledBack = await createFixture({ managedApplication: true });
    rolledBack.context.verifyGateway = async () => {
      throw new Error("deterministic target health failure");
    };
    await expect(
      __testing.applyReleaseTransaction(
        request("applyRelease", TRANSACTION_TWO, "1.2.3"),
        rolledBack.context,
      ),
    ).rejects.toMatchObject({ code: "TARGET_RELEASE_ROLLED_BACK" });
    const restoredState = path.join(rolledBack.paths.stateDir, "..", "operator", ".fased");
    expect(await fsp.realpath(path.join(restoredState, "runtime", "current"))).toBe(
      path.join(rolledBack.paths.applicationReleasesDir!, "v1.2.2"),
    );
    expect(
      JSON.parse(await fsp.readFile(path.join(restoredState, "install.json"), "utf8")).runtime
        .activeVersion,
    ).toBe("1.2.2");
    expect(await fsp.readFile(rolledBack.paths.signerPath, "utf8")).toBe("old-signer\n");
    expect(fs.existsSync(rolledBack.paths.journalPath)).toBe(false);
  });

  it("commits the preactivated repair only after the app-account health decision", async () => {
    const { context, paths } = await createFixture();
    let redundantRestarts = 0;
    context.restartGateway = async () => {
      redundantRestarts += 1;
    };
    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    await fsp.writeFile(paths.signerUnitPath, "ExecStart=new-signer-v2\n", { mode: 0o644 });
    await __testing.activateSignerRelease(
      request("activateRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    let application = "previous";
    const operations = {
      activateApplication: async () => {
        application = "target";
      },
      restoreApplication: async () => {
        application = "previous";
      },
      quiesceGateway: async () => undefined,
      signerRequest: async (operation: string) =>
        await __testing.dispatchUpdateRequest(
          request(operation, TRANSACTION_ONE, "1.2.3"),
          context,
        ),
      verifyGateway: async () => {
        await __testing.restartGatewayService(
          request("restartGateway", TRANSACTION_TWO, "1.2.3"),
          context,
        );
        expect(application).toBe("target");
        expect(fs.existsSync(paths.gatewayGatePath)).toBe(false);
        expect(fs.existsSync(paths.signerGatePath)).toBe(true);
        expect(await fsp.readFile(paths.signerPath, "utf8")).toBe("signer-1.2.3\n");
      },
      refreshPrevious: async () => undefined,
      finalizeApplication: async () => undefined,
      writePhase: async (journal: ReturnType<typeof managedTransaction>, phase: string) => ({
        ...journal,
        phase,
      }),
      removeJournal: async () => undefined,
    };
    await expect(
      managedUpdaterTesting.coordinateHostedReleaseTransaction(managedTransaction(), operations),
    ).resolves.toMatchObject({ action: "committed" });
    expect(application).toBe("target");
    expect(redundantRestarts).toBe(0);
    expect(await fsp.readFile(paths.rollbackFloorPath, "utf8")).toBe("1.2.3\n");
    expect(fs.existsSync(paths.journalPath)).toBe(false);
    expect(fs.existsSync(paths.signerGatePath)).toBe(false);
  });

  it("restores app, signer DB, binary, and prior unit together when repair health fails", async () => {
    const { context, paths } = await createFixture();
    await __testing.prepareSignerRelease(
      request("prepareRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    await fsp.writeFile(paths.signerUnitPath, "ExecStart=new-signer-v2\n", { mode: 0o644 });
    await __testing.activateSignerRelease(
      request("activateRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    let application = "previous";
    const operations = {
      activateApplication: async () => {
        application = "target";
      },
      restoreApplication: async () => {
        application = "previous";
      },
      quiesceGateway: async () => undefined,
      signerRequest: async (operation: string) =>
        await __testing.dispatchUpdateRequest(
          request(operation, TRANSACTION_ONE, "1.2.3"),
          context,
        ),
      verifyGateway: async () => {
        throw new Error("injected app-to-signer health failure");
      },
      refreshPrevious: async () => {
        expect(application).toBe("previous");
        expect(await fsp.readFile(paths.signerPath, "utf8")).toBe("old-signer\n");
      },
      finalizeApplication: async () => undefined,
      writePhase: async (journal: ReturnType<typeof managedTransaction>, phase: string) => ({
        ...journal,
        phase,
      }),
      removeJournal: async () => undefined,
    };
    await expect(
      managedUpdaterTesting.coordinateHostedReleaseTransaction(managedTransaction(), operations),
    ).rejects.toMatchObject({ code: "HOSTED_UPDATE_ROLLED_BACK" });
    expect(application).toBe("previous");
    expect(await fsp.readFile(paths.signerPath, "utf8")).toBe("old-signer\n");
    expect(await fsp.readFile(paths.signerStateDBPath, "utf8")).toBe("old-db\n");
    expect(await fsp.readFile(paths.signerUnitPath, "utf8")).toBe("ExecStart=old-signer\n");
    expect(fs.existsSync(paths.gatewayGatePath)).toBe(false);
    expect(fs.existsSync(paths.journalPath)).toBe(false);
  });

  it("orders release versions for downgrade prevention", () => {
    expect(__testing.compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(__testing.compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(__testing.compareVersions("1.2.4", "1.2.3")).toBe(1);
    expect(__testing.compareVersions("1.2.3-beta.1", "1.2.3")).toBe(-1);
  });

  it("requires an explicit root-selected beta channel for prereleases", () => {
    expect(__testing.releaseAllowedForChannel("1.2.3", "stable\n")).toBe(true);
    expect(__testing.releaseAllowedForChannel("1.2.3-beta.1", "stable\n")).toBe(false);
    expect(__testing.releaseAllowedForChannel("1.2.3-beta.1", "beta\n")).toBe(true);
  });

  it("accepts only ready signer-owned protocol-v2 health", () => {
    const health = {
      ok: true,
      result: {
        ready: true,
        keystoreType: "signer-owned-v2",
        release: signerRelease("1.2.3"),
        capabilities: { protocol: { current: 2, min: 2, max: 2 } },
        policies: [],
        network: { ready: true, wallets: [] },
        webAuthn: {
          configured: false,
          credentialCount: 0,
          credentialVersion: 0,
          ready: true,
        },
      },
    };
    expect(() => __testing.assertSignerV2Health(health, signerRelease("1.2.3"))).not.toThrow();
    expect(() =>
      __testing.assertSignerV2Health(
        {
          ...health,
          result: {
            ...health.result,
            policies: [
              {
                walletId: "agent",
                role: "agent",
                version: 1,
                hash: `sha256:${"a".repeat(64)}`,
              },
            ],
            network: {
              ready: true,
              wallets: [
                {
                  walletId: "agent",
                  configured: true,
                  version: 1,
                  hash: `hmac-sha256:${"b".repeat(64)}`,
                  ready: true,
                },
              ],
            },
          },
        },
        signerRelease("1.2.3"),
      ),
    ).not.toThrow();
    expect(() =>
      __testing.assertSignerV2Health(
        {
          ...health,
          result: {
            ...health.result,
            network: {
              ready: true,
              wallets: [
                {
                  walletId: "agent",
                  configured: true,
                  version: 1,
                  hash: `sha256:${"b".repeat(64)}`,
                  ready: true,
                },
              ],
            },
          },
        },
        signerRelease("1.2.3"),
      ),
    ).toThrow("state invariants");
    expect(() =>
      __testing.assertSignerV2Health(
        {
          ...health,
          result: {
            ...health.result,
            release: { ...signerRelease("1.2.3"), development: true },
          },
        },
        signerRelease("1.2.3"),
      ),
    ).toThrow("development");
    expect(() =>
      __testing.assertSignerV2Health(health, {
        ...signerRelease("1.2.3"),
        commit: "c".repeat(40),
      }),
    ).toThrow("attested release manifest");
    expect(() =>
      __testing.assertSignerV2Health({ ...health, result: { ...health.result, ready: false } }),
    ).toThrow("protocol v2");
    expect(() =>
      __testing.assertSignerV2Health({
        ...health,
        result: {
          ...health.result,
          capabilities: { protocol: { current: 1, min: 1, max: 1 } },
        },
      }),
    ).toThrow("protocol v2");
    expect(() =>
      __testing.assertSignerV2Health({
        ...health,
        result: { ...health.result, keystoreType: "legacy-node" },
      }),
    ).toThrow("signer-owned custody");
  });
});
