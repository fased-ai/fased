import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRE_V2_HOSTING_MIGRATION_MESSAGE,
  PROTECTED_LOCAL_CONTROLLER_UNAVAILABLE_MESSAGE,
  __testing,
  hostingBootstrapCommand,
  legacyHostingBootstrapMessage,
} from "./fased-managed-updater-core.mjs";

const TRANSACTION_ID = "11111111-1111-4111-8111-111111111111";

function signerRelease(version = "1.2.3") {
  return {
    version,
    commit: "a".repeat(40),
    buildInputDigest: `sha256:${"b".repeat(64)}`,
    development: false,
  };
}

async function writeManagedRuntime(root: string, version: string) {
  await Promise.all([
    fsp.mkdir(path.join(root, "node_modules"), { recursive: true }),
    fsp.mkdir(path.join(root, "scripts"), { recursive: true }),
    fsp.mkdir(path.join(root, "dist", "control-ui"), { recursive: true }),
  ]);
  await Promise.all([
    fsp.writeFile(path.join(root, "package.json"), `${JSON.stringify({ version })}\n`),
    fsp.writeFile(path.join(root, "fased.mjs"), "#!/usr/bin/env node\n"),
    fsp.writeFile(path.join(root, "scripts", "start-managed.sh"), "#!/bin/sh\n"),
    fsp.writeFile(
      path.join(root, "scripts", "protected-local-bootstrap.mjs"),
      "#!/usr/bin/env node\n",
    ),
    fsp.writeFile(
      path.join(root, "dist", "control-ui", "version.json"),
      `${JSON.stringify({ version })}\n`,
    ),
  ]);
}

async function withUnixServer(handler: (socket: net.Socket) => void) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-managed-updater-test-"));
  const socketPath = path.join(root, "request.sock");
  const server = net.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await fsp.chmod(socketPath, 0o660);
  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

function transaction(phase = "prepared") {
  return {
    schemaVersion: 1,
    transactionId: TRANSACTION_ID,
    targetVersion: "1.2.3",
    previousVersion: "1.2.2",
    targetRoot: "/managed/releases/1.2.3",
    previousRoot: "/managed/releases/1.2.2",
    nextManifest: { profile: "hosting", runtime: { activeVersion: "1.2.3" } },
    previousManifest: { profile: "hosting", runtime: { activeVersion: "1.2.2" } },
    phase,
  };
}

function transactionOperations(events: string[], overrides: Record<string, unknown> = {}) {
  return {
    activateApplication: async () => events.push("activate-app"),
    restoreApplication: async () => events.push("restore-app"),
    quiesceGateway: async () => events.push("quiesce-gateway"),
    signerRequest: async (operation: string) => events.push(`signer:${operation}`),
    verifyGateway: async () => events.push("verify-gateway"),
    refreshPrevious: async () => events.push("refresh-previous"),
    finalizeApplication: async () => events.push("finalize-app"),
    writePhase: async (journal: ReturnType<typeof transaction>, phase: string) => {
      events.push(`write:${phase}`);
      return { ...journal, phase };
    },
    removeJournal: async () => events.push("remove-journal"),
    ...overrides,
  };
}

describe("stable managed updater", () => {
  it("accepts only the exact root-owned Hosting predecessor release boundary", () => {
    const paths = { releasesDir: "/home/app/.fased/runtime/releases" };
    const journal = {
      ...transaction(),
      targetRoot: "/home/app/.fased/runtime/releases/1.2.3",
      previousRoot: "/opt/fased/host-application/releases/1.2.2",
      nextManifest: {
        profile: "hosting",
        runtime: { activeVersion: "1.2.3" },
      },
      previousManifest: {
        profile: "hosting",
        runtime: {
          activeVersion: "1.2.2",
          releasesDir: "/opt/fased/host-application/releases",
        },
      },
    };

    expect(__testing.validateHostedTransactionJournal(paths, journal)).toMatchObject({
      targetRoot: "/home/app/.fased/runtime/releases/1.2.3",
      previousRoot: "/opt/fased/host-application/releases/1.2.2",
    });
    expect(() =>
      __testing.validateHostedTransactionJournal(paths, {
        ...journal,
        previousRoot: "/opt/fased/host-application/escaped/1.2.2",
      }),
    ).toThrow("previousRoot is outside the managed releases directories");
  });

  it("reports the exact published-updater bridge boundary for Linux Local installs", () => {
    expect(
      __testing.protectedLocalMigrationRequirement({
        manifest: { profile: "local" },
        currentRoot: "/home/operator/.fased/runtime/current",
        platform: "linux",
        systemdActive: true,
        bridgeAssetsAvailable: true,
      }),
    ).toEqual({
      required: true,
      supported: true,
      reason: "target_controller_required",
    });
    expect(
      __testing.protectedLocalMigrationRequirement({
        manifest: { profile: "protected-local" },
        currentRoot: "/home/operator/.fased/runtime/current",
        platform: "linux",
        systemdActive: true,
        bridgeAssetsAvailable: true,
      }),
    ).toEqual({
      required: false,
      supported: false,
      reason: "profile_not_local",
    });
    expect(
      __testing.protectedLocalMigrationRequirement({
        manifest: { profile: "local" },
        currentRoot: "/home/operator/.fased/runtime/current",
        platform: "darwin",
        systemdActive: false,
        bridgeAssetsAvailable: true,
      }),
    ).toEqual({
      required: false,
      supported: false,
      reason: "not_linux",
    });
  });

  it("builds one fixed verified root migration invocation without shell evaluation", () => {
    const invocation = __testing.buildProtectedLocalMigrationInvocation({
      installerPath: "/tmp/verified/install.sh",
      targetRoot: "/home/operator/.fased/runtime/releases/1.2.3",
      targetVersion: "1.2.3",
      channel: "stable",
      paths: { stateDir: "/home/operator/.fased" },
      operator: {
        username: "operator",
        uid: 1000,
        gid: 1000,
        homedir: "/home/operator",
      },
      gatewayPort: 18789,
      profile: "default",
      timeoutMs: 60_000,
      sudoPath: "/usr/bin/sudo",
      bashPath: "/bin/bash",
      nodePath: "/usr/bin/node",
    });
    expect(invocation.command).toBe("/usr/bin/sudo");
    expect(invocation.args).toEqual([
      "--",
      "/bin/bash",
      "/tmp/verified/install.sh",
      "--protected-local-root-bootstrap",
      "--release",
      "1.2.3",
      "--update-channel",
      "stable",
      "--protected-local-operator-user",
      "operator",
      "--protected-local-operator-uid",
      "1000",
      "--protected-local-operator-gid",
      "1000",
      "--protected-local-operator-home",
      "/home/operator",
      "--protected-local-state-dir",
      "/home/operator/.fased",
      "--protected-local-runtime-dir",
      "/home/operator/.fased/runtime/releases/1.2.3",
      "--protected-local-node-binary",
      "/usr/bin/node",
      "--protected-local-profile",
      "default",
      "--protected-local-gateway-port",
      "18789",
      "--protected-local-gateway-mode",
      "activate",
      "--protected-local-gateway-health-timeout-ms",
      "30000",
    ]);
    expect(() =>
      __testing.buildProtectedLocalMigrationInvocation({
        installerPath: "/tmp/verified/install.sh",
        targetRoot: "/home/operator/.fased/runtime/releases/1.2.3",
        targetVersion: "1.2.3\n--unsafe",
        channel: "stable",
        paths: { stateDir: "/home/operator/.fased" },
        operator: {
          username: "operator",
          uid: 1000,
          gid: 1000,
          homedir: "/home/operator",
        },
        gatewayPort: 18789,
        profile: "default",
        sudoPath: "/usr/bin/sudo",
        bashPath: "/bin/bash",
        nodePath: "/usr/bin/node",
      }),
    ).toThrow("invalid release version");
  });

  it("hands a previous Local runtime to the exact target controller and target runtime", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-target-first-migration-"));
    const stateDir = path.join(root, "home", ".fased");
    const currentRoot = path.join(stateDir, "runtime", "releases", "1.2.2");
    const targetRoot = path.join(stateDir, "runtime", "releases", "1.2.3");
    const manifestPath = path.join(stateDir, "install.json");
    const configPath = path.join(stateDir, "fased.json");
    const currentLink = path.join(stateDir, "runtime", "current");
    const previousLink = path.join(stateDir, "runtime", "previous");
    const compatibilityPackageRoot = path.join(
      stateDir,
      "install-cache",
      "npm-global",
      "lib",
      "node_modules",
      "@fased",
      "fased",
    );
    const instanceId = "0123456789abcdef";
    const protectedEnvKeys = [
      "FASED_HOST_PROFILE",
      "FASED_PROTECTED_LOCAL",
      "FASED_PROTECTED_LOCAL_INSTANCE",
      "FASED_WALLET_LOCAL_SIGNER_LIFECYCLE",
      "FASED_WALLET_LOCAL_SIGNER_BIN",
      "FASED_WALLET_LOCAL_SIGNER_SOCKET",
      "FASED_HOST_UPDATER_SOCKET",
      "FASED_HOST_UPDATERCTL_STATE",
    ];
    const priorEnv = new Map(protectedEnvKeys.map((key) => [key, process.env[key]]));
    await Promise.all([
      writeManagedRuntime(currentRoot, "1.2.2"),
      writeManagedRuntime(targetRoot, "1.2.3"),
    ]);
    await fsp.symlink(currentRoot, currentLink, "dir");
    const existingManifest = {
      schemaVersion: 2,
      profile: "local",
      stateDir,
      configPath,
      runtime: { activeVersion: "1.2.2" },
      service: { name: "fased-gateway.service", scope: "user" },
      updater: { version: "1.2.2" },
    };
    const nextManifest = {
      ...existingManifest,
      runtime: { activeVersion: "1.2.3", previousVersion: "1.2.2" },
      updater: { version: "1.2.3" },
    };
    await fsp.writeFile(manifestPath, `${JSON.stringify(existingManifest, null, 2)}\n`, {
      mode: 0o600,
    });
    await fsp.writeFile(
      configPath,
      `${JSON.stringify({ gateway: { port: 18789 }, env: { vars: {} } })}\n`,
      { mode: 0o600 },
    );
    let preparedVersion = "";
    let invocation: { command: string; args: string[] } | null = null;
    try {
      await expect(
        __testing.migrateManagedLocalToProtected(
          {
            paths: {
              stateDir,
              manifestPath,
              runtimeDir: path.join(stateDir, "runtime"),
              currentLink,
              previousLink,
              compatibilityPackageRoot,
            },
            existingManifest,
            currentRoot,
            currentVersion: "1.2.2",
            targetRoot,
            targetVersion: "1.2.3",
            nextManifest,
            channel: "stable",
            timeoutMs: 5_000,
          },
          {
            prepareInstaller: async ({
              releaseVersion,
              destinationDir,
            }: {
              releaseVersion: string;
              destinationDir: string;
            }) => {
              preparedVersion = releaseVersion;
              const installerPath = path.join(destinationDir, "install.sh");
              await fsp.writeFile(installerPath, "#!/bin/bash\n", { mode: 0o500 });
              return installerPath;
            },
            rootExecutable: (candidates: string[]) => candidates[0],
            userInfo: () => ({
              username: "operator",
              uid: 1000,
              gid: 1000,
              homedir: path.join(root, "home"),
              shell: "/bin/bash",
            }),
            runAdministrator: async (command: string, args: string[]) => {
              invocation = { command, args };
              expect(await fsp.realpath(currentLink)).toBe(targetRoot);
              expect(JSON.parse(await fsp.readFile(manifestPath, "utf8"))).toMatchObject({
                runtime: { activeVersion: "1.2.3" },
                updater: { version: "1.2.3" },
              });
              const protectedVariables = {
                FASED_HOST_PROFILE: "local",
                FASED_PROTECTED_LOCAL: "1",
                FASED_PROTECTED_LOCAL_INSTANCE: instanceId,
                FASED_WALLET_LOCAL_SIGNER_LIFECYCLE: "external",
                FASED_WALLET_LOCAL_SIGNER_BIN: `/opt/fased/local/${instanceId}/signer/fased-signerd`,
                FASED_WALLET_LOCAL_SIGNER_SOCKET: `/run/fased-local/${instanceId}/application/app.sock`,
                FASED_HOST_UPDATER_SOCKET: `/run/fased-local-controller/${instanceId}/request.sock`,
                FASED_HOST_UPDATERCTL_STATE: path.join(
                  stateDir,
                  "protected-local-controller-transaction.json",
                ),
              };
              await fsp.writeFile(
                configPath,
                `${JSON.stringify({ gateway: { port: 18789 }, env: { vars: protectedVariables } })}\n`,
                { mode: 0o660 },
              );
              await fsp.writeFile(
                manifestPath,
                `${JSON.stringify({
                  ...nextManifest,
                  profile: "protected-local",
                  service: {
                    name: `fased-gateway-${instanceId}.service`,
                    scope: "system",
                  },
                })}\n`,
                { mode: 0o660 },
              );
              return { ok: true, stdout: '{"profile":"protected-local"}\n', stderr: "" };
            },
          },
        ),
      ).resolves.toMatchObject({
        migrated: true,
        manifest: {
          profile: "protected-local",
          runtime: { activeVersion: "1.2.3" },
        },
      });
      expect(preparedVersion).toBe("1.2.3");
      expect(invocation?.args).toEqual(
        expect.arrayContaining(["--release", "1.2.3", "--protected-local-runtime-dir", targetRoot]),
      );
      expect(await fsp.realpath(previousLink)).toBe(currentRoot);
      await expect(
        fsp.access(path.join(stateDir, "protected-local-migration-transaction.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      for (const [key, value] of priorEnv) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("migrates an existing managed Local install and reloads its exact protected identity", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-protected-migration-"));
    const stateDir = path.join(root, "home", ".fased");
    const currentRoot = path.join(stateDir, "runtime", "releases", "1.2.3");
    const manifestPath = path.join(stateDir, "install.json");
    const configPath = path.join(stateDir, "fased.json");
    const instanceId = "0123456789abcdef";
    const priorEnv = new Map(
      [
        "FASED_HOST_PROFILE",
        "FASED_PROTECTED_LOCAL",
        "FASED_PROTECTED_LOCAL_INSTANCE",
        "FASED_WALLET_LOCAL_SIGNER_LIFECYCLE",
        "FASED_WALLET_LOCAL_SIGNER_BIN",
        "FASED_WALLET_LOCAL_SIGNER_SOCKET",
        "FASED_HOST_UPDATER_SOCKET",
        "FASED_HOST_UPDATERCTL_STATE",
      ].map((key) => [key, process.env[key]]),
    );
    await Promise.all([
      fsp.mkdir(path.join(currentRoot, "node_modules"), { recursive: true }),
      fsp.mkdir(path.join(currentRoot, "scripts"), { recursive: true }),
      fsp.mkdir(path.join(currentRoot, "dist", "control-ui"), { recursive: true }),
    ]);
    await Promise.all([
      fsp.writeFile(
        path.join(currentRoot, "package.json"),
        `${JSON.stringify({ version: "1.2.3" })}\n`,
      ),
      fsp.writeFile(path.join(currentRoot, "fased.mjs"), "#!/usr/bin/env node\n"),
      fsp.writeFile(path.join(currentRoot, "scripts", "start-managed.sh"), "#!/bin/sh\n"),
      fsp.writeFile(
        path.join(currentRoot, "scripts", "protected-local-bootstrap.mjs"),
        "#!/usr/bin/env node\n",
      ),
      fsp.writeFile(
        path.join(currentRoot, "dist", "control-ui", "version.json"),
        `${JSON.stringify({ version: "1.2.3" })}\n`,
      ),
    ]);
    const existingManifest = {
      schemaVersion: 2,
      profile: "local",
      stateDir,
      configPath,
      runtime: { activeVersion: "1.2.3" },
      service: { name: "fased-gateway.service", scope: "user" },
      updater: { version: "1.2.3" },
    };
    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.writeFile(manifestPath, `${JSON.stringify(existingManifest)}\n`, { mode: 0o600 });
    await fsp.writeFile(
      configPath,
      `${JSON.stringify({ gateway: { port: 18789 }, env: { vars: {} } })}\n`,
      { mode: 0o600 },
    );
    let invocation: { command: string; args: string[] } | null = null;
    try {
      const result = await __testing.migrateManagedLocalToProtected(
        {
          paths: {
            stateDir,
            manifestPath,
            runtimeDir: path.join(stateDir, "runtime"),
            currentLink: path.join(stateDir, "runtime", "current"),
            previousLink: path.join(stateDir, "runtime", "previous"),
            compatibilityPackageRoot: path.join(
              stateDir,
              "install-cache",
              "npm-global",
              "lib",
              "node_modules",
              "@fased",
              "fased",
            ),
          },
          existingManifest,
          currentRoot,
          currentVersion: "1.2.3",
          targetRoot: currentRoot,
          targetVersion: "1.2.3",
          nextManifest: existingManifest,
          channel: "stable",
          timeoutMs: 5_000,
        },
        {
          prepareInstaller: async ({ destinationDir }: { destinationDir: string }) => {
            const installerPath = path.join(destinationDir, "install.sh");
            await fsp.writeFile(installerPath, "#!/bin/bash\n", { mode: 0o500 });
            return installerPath;
          },
          rootExecutable: (candidates: string[]) => candidates[0],
          userInfo: () => ({
            username: "operator",
            uid: 1000,
            gid: 1000,
            homedir: path.join(root, "home"),
            shell: "/bin/bash",
          }),
          runAdministrator: async (command: string, args: string[]) => {
            invocation = { command, args };
            const protectedVariables = {
              FASED_HOST_PROFILE: "local",
              FASED_PROTECTED_LOCAL: "1",
              FASED_PROTECTED_LOCAL_INSTANCE: instanceId,
              FASED_WALLET_LOCAL_SIGNER_LIFECYCLE: "external",
              FASED_WALLET_LOCAL_SIGNER_BIN: `/opt/fased/local/${instanceId}/signer/fased-signerd`,
              FASED_WALLET_LOCAL_SIGNER_SOCKET: `/run/fased-local/${instanceId}/application/app.sock`,
              FASED_HOST_UPDATER_SOCKET: `/run/fased-local-controller/${instanceId}/request.sock`,
              FASED_HOST_UPDATERCTL_STATE: path.join(
                stateDir,
                "protected-local-controller-transaction.json",
              ),
            };
            await fsp.writeFile(
              configPath,
              `${JSON.stringify({
                gateway: { port: 18789 },
                env: { vars: protectedVariables },
              })}\n`,
              { mode: 0o660 },
            );
            await fsp.writeFile(
              manifestPath,
              `${JSON.stringify({
                ...existingManifest,
                profile: "protected-local",
                service: {
                  name: `fased-gateway-${instanceId}.service`,
                  scope: "system",
                },
              })}\n`,
              { mode: 0o660 },
            );
            return { ok: true, stdout: '{"profile":"protected-local"}\n', stderr: "" };
          },
        },
      );
      expect(result.migrated).toBe(true);
      expect(result.manifest.profile).toBe("protected-local");
      expect(invocation?.command).toBe("/usr/bin/sudo");
      expect(invocation?.args).toContain("--protected-local-root-bootstrap");
      expect(process.env.FASED_PROTECTED_LOCAL_INSTANCE).toBe(instanceId);
      expect(process.env.FASED_HOST_UPDATER_SOCKET).toBe(
        `/run/fased-local-controller/${instanceId}/request.sock`,
      );
    } finally {
      for (const [key, value] of priorEnv) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a failed bridge unless the prior Local manifest is restored byte-for-byte", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-protected-migration-"));
    const stateDir = path.join(root, "home", ".fased");
    const currentRoot = path.join(stateDir, "runtime", "releases", "1.2.3");
    const targetRoot = path.join(stateDir, "runtime", "releases", "1.2.4");
    const manifestPath = path.join(stateDir, "install.json");
    const configPath = path.join(stateDir, "fased.json");
    await Promise.all([
      writeManagedRuntime(currentRoot, "1.2.3"),
      writeManagedRuntime(targetRoot, "1.2.4"),
    ]);
    const existingManifest = {
      schemaVersion: 2,
      profile: "local",
      stateDir,
      configPath,
      runtime: { activeVersion: "1.2.3" },
      service: { name: "fased-gateway.service", scope: "user" },
      updater: { version: "1.2.3" },
    };
    const manifestBytes = `${JSON.stringify(existingManifest, null, 2)}\n`;
    const nextManifest = {
      ...existingManifest,
      runtime: { activeVersion: "1.2.4", previousVersion: "1.2.3" },
      updater: { version: "1.2.4" },
    };
    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.writeFile(manifestPath, manifestBytes, { mode: 0o600 });
    await fsp.writeFile(configPath, `${JSON.stringify({ gateway: { port: 18789 } })}\n`);
    await fsp.symlink(currentRoot, path.join(stateDir, "runtime", "current"), "dir");
    try {
      await expect(
        __testing.migrateManagedLocalToProtected(
          {
            paths: {
              stateDir,
              manifestPath,
              runtimeDir: path.join(stateDir, "runtime"),
              currentLink: path.join(stateDir, "runtime", "current"),
              previousLink: path.join(stateDir, "runtime", "previous"),
              compatibilityPackageRoot: path.join(
                stateDir,
                "install-cache",
                "npm-global",
                "lib",
                "node_modules",
                "@fased",
                "fased",
              ),
            },
            existingManifest,
            currentRoot,
            currentVersion: "1.2.3",
            targetRoot,
            targetVersion: "1.2.4",
            nextManifest,
            channel: "stable",
            timeoutMs: 5_000,
          },
          {
            prepareInstaller: async ({ destinationDir }: { destinationDir: string }) => {
              const installerPath = path.join(destinationDir, "install.sh");
              await fsp.writeFile(installerPath, "#!/bin/bash\n", { mode: 0o500 });
              return installerPath;
            },
            rootExecutable: (candidates: string[]) => candidates[0],
            userInfo: () => ({
              username: "operator",
              uid: 1000,
              gid: 1000,
              homedir: path.join(root, "home"),
              shell: "/bin/bash",
            }),
            runAdministrator: async () => ({
              ok: false,
              stdout: "",
              stderr: "injected activation failure",
            }),
          },
        ),
      ).rejects.toThrow(
        "Protected Local migration failed and restored the prior Local installation",
      );
      expect(await fsp.readFile(manifestPath, "utf8")).toBe(manifestBytes);
      expect(await fsp.realpath(path.join(stateDir, "runtime", "current"))).toBe(currentRoot);
      await expect(
        fsp.access(path.join(stateDir, "protected-local-migration-transaction.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("verifies a bundled release attestation without GitHub authentication", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-attestation-test-"));
    const gh = path.join(root, "gh");
    const asset = path.join(root, "fased-signerd-linux-amd64");
    const bundle = path.join(root, "fased-signerd-release.attestation.json");
    const log = path.join(root, "gh-call.json");
    await fsp.writeFile(asset, "release asset\n", { mode: 0o600 });
    await fsp.writeFile(bundle, "{}\n", { mode: 0o600 });
    await fsp.writeFile(
      gh,
      `#!/usr/bin/env node
const fs = require("node:fs");
if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_CONFIG_DIR) process.exit(71);
if (process.env.GH_PROMPT_DISABLED !== "1") process.exit(72);
if (!process.argv.includes("--bundle")) process.exit(73);
fs.writeFileSync(process.env.FASED_TEST_GH_LOG, JSON.stringify(process.argv.slice(2)));
`,
      { mode: 0o700 },
    );
    const prior = {
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
      FASED_TEST_GH_LOG: process.env.FASED_TEST_GH_LOG,
    };
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_CONFIG_DIR;
    process.env.FASED_TEST_GH_LOG = log;
    try {
      await expect(
        __testing.verifyOfficialAsset(asset, "0.1.70", 5_000, bundle, gh),
      ).resolves.toBeUndefined();
      expect(JSON.parse(await fsp.readFile(log, "utf8"))).toEqual(
        expect.arrayContaining([
          "attestation",
          "verify",
          asset,
          "--bundle",
          bundle,
          "--source-ref",
          "refs/tags/v0.1.70",
        ]),
      );
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("handles status and ordinary managed update commands", () => {
    expect(__testing.parseArgs(["update", "status", "--json"])).toMatchObject({
      delegate: false,
      options: { status: true, json: true, channel: null },
    });
    expect(__testing.parseArgs(["update", "--channel", "stable"])).toMatchObject({
      delegate: false,
      options: { status: false, channel: "stable" },
    });
    expect(__testing.parseArgs(["update", "--dry-run"])).toMatchObject({
      delegate: false,
      options: { dryRun: true },
    });
    expect(__testing.parseArgs(["update", "--verbose"])).toMatchObject({
      delegate: false,
      options: { verbose: true },
    });
  });

  it("delegates dev and non-transactional update subcommands to the active runtime", () => {
    expect(__testing.parseArgs(["update", "--channel", "dev"]).delegate).toBe(true);
    expect(__testing.parseArgs(["update", "wizard"]).delegate).toBe(true);
  });

  it("compares semantic versions without lexical ordering mistakes", () => {
    expect(__testing.compareVersions("0.1.9", "0.1.10")).toBe(-1);
    expect(__testing.compareVersions("0.1.59", "0.1.59")).toBe(0);
    expect(__testing.compareVersions("0.2.0", "0.1.59")).toBe(1);
    expect(__testing.compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(__testing.compareVersions("1.0.0-beta.10", "1.0.0")).toBe(-1);
    expect(__testing.compareVersions("1.0.0", "1.0.0-beta.10")).toBe(1);
  });

  it("removes a bounded historical updater backup only after official identity converges", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-historical-updater-"));
    const runtimeRoot = path.join(root, "runtime");
    const updaterDir = path.join(root, "updater");
    const binDir = path.join(root, "bin");
    const runtimeScripts = path.join(runtimeRoot, "scripts");
    const updaterPath = path.join(updaterDir, "fased-managed-updater.mjs");
    const launcherPath = path.join(binDir, "fased");
    const backupPath = path.join(updaterDir, "q0-managed-updater-backup.json");
    const updater = Buffer.from("official updater\n");
    const launcher = Buffer.from("official launcher\n");
    const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    try {
      await Promise.all([
        fsp.mkdir(runtimeScripts, { recursive: true }),
        fsp.mkdir(updaterDir, { recursive: true }),
        fsp.mkdir(binDir, { recursive: true }),
      ]);
      await Promise.all([
        fsp.writeFile(path.join(runtimeScripts, "fased-managed-updater.mjs"), updater),
        fsp.writeFile(path.join(runtimeScripts, "fased-managed-launcher.sh"), launcher),
        fsp.writeFile(updaterPath, updater),
        fsp.writeFile(launcherPath, launcher),
      ]);
      await fsp.writeFile(
        backupPath,
        `${JSON.stringify({
          schemaVersion: 2,
          updater: {
            originalBase64: Buffer.from("old updater\n").toString("base64"),
            originalSha256: digest(Buffer.from("old updater\n")),
            candidateSha256: digest(Buffer.from("candidate updater\n")),
            mode: 0o700,
          },
          launcher: {
            originalBase64: Buffer.from("old launcher\n").toString("base64"),
            originalSha256: digest(Buffer.from("old launcher\n")),
            candidateSha256: digest(Buffer.from("candidate launcher\n")),
            mode: 0o700,
          },
        })}\n`,
        { mode: 0o600 },
      );
      await expect(
        __testing.cleanupHistoricalManagedCandidateResidue(
          { updaterDir, updaterPath, launcherPath },
          runtimeRoot,
        ),
      ).resolves.toEqual({ changed: true });
      await expect(fsp.lstat(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fsp.readFile(updaterPath)).resolves.toEqual(updater);
      await expect(fsp.readFile(launcherPath)).resolves.toEqual(launcher);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses unsafe historical updater residue without changing it", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-historical-updater-"));
    const updaterDir = path.join(root, "updater");
    const target = path.join(root, "target.json");
    const backupPath = path.join(updaterDir, "q0-managed-updater-backup.json");
    try {
      await fsp.mkdir(updaterDir, { recursive: true });
      await fsp.writeFile(target, "{}\n");
      await fsp.symlink(target, backupPath);
      await expect(
        __testing.cleanupHistoricalManagedCandidateResidue(
          {
            updaterDir,
            updaterPath: path.join(root, "unused-updater"),
            launcherPath: path.join(root, "unused-launcher"),
          },
          path.join(root, "unused-runtime"),
        ),
      ).rejects.toThrow("historical managed candidate backup is unsafe");
      await expect(fsp.lstat(backupPath)).resolves.toMatchObject({});
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("classifies a same-version Local signer mismatch as repair-required", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-managed-consistency-"));
    const binaryPath = path.join(root, "bin", "fased-signerd");
    await fsp.mkdir(path.dirname(binaryPath), { recursive: true });
    await fsp.writeFile(
      binaryPath,
      `#!/bin/sh\nprintf '%s\\n' 'fased-signerd 1.2.2 commit=${"c".repeat(40)} buildInputDigest=sha256:${"d".repeat(64)} development=false'\n`,
      { mode: 0o700 },
    );
    const manifest = {
      profile: "local",
      runtime: { activeVersion: "1.2.3" },
      updater: { version: "1.2.3" },
      signer: { release: signerRelease("1.2.2") },
    };
    try {
      await expect(
        __testing.inspectLocalManagedConsistency({ stateDir: root }, manifest, "1.2.3"),
      ).resolves.toMatchObject({
        consistent: false,
        reasons: expect.arrayContaining(["signer_version_mismatch", "signer_manifest_mismatch"]),
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("accepts one exact Local application, updater, signer, and success identity", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-managed-consistency-"));
    const binaryPath = path.join(root, "bin", "fased-signerd");
    const release = signerRelease();
    await fsp.mkdir(path.dirname(binaryPath), { recursive: true });
    await fsp.writeFile(
      binaryPath,
      `#!/bin/sh\nprintf '%s\\n' 'fased-signerd ${release.version} commit=${release.commit} buildInputDigest=${release.buildInputDigest} development=false'\n`,
      { mode: 0o700 },
    );
    await fsp.writeFile(
      path.join(root, "last-update-success.json"),
      `${JSON.stringify({ mode: "managed", version: release.version })}\n`,
      { mode: 0o600 },
    );
    const manifest = {
      profile: "local",
      runtime: { activeVersion: release.version },
      updater: { version: release.version },
      signer: { release },
    };
    try {
      await expect(
        __testing.inspectLocalManagedConsistency({ stateDir: root }, manifest, release.version),
      ).resolves.toEqual({ consistent: true, reasons: [] });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("requires same-version repair when an earlier Protected Local service still uses operator files", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-protected-consistency-"));
    const instanceId = "0123456789abcdef";
    const stateDir = path.join(root, "home", "operator", ".fased");
    const installRoot = path.join(root, "opt", "fased", "local");
    const systemdRoot = path.join(root, "etc", "systemd", "system");
    const installDir = path.join(installRoot, instanceId);
    const applicationCurrent = path.join(installDir, "application", "current");
    const applicationRelease = path.join(installDir, "application", "releases", "v1.2.3");
    const configPath = path.join(stateDir, "fased.json");
    const manifest = {
      profile: "protected-local",
      configPath,
      runtime: { activeVersion: "1.2.3" },
    };
    try {
      await Promise.all([
        fsp.mkdir(stateDir, { recursive: true }),
        fsp.mkdir(applicationRelease, { recursive: true }),
        fsp.mkdir(systemdRoot, { recursive: true }),
        fsp.mkdir(installDir, { recursive: true }),
      ]);
      await fsp.writeFile(
        configPath,
        `${JSON.stringify({
          env: {
            vars: {
              FASED_PROTECTED_LOCAL: "1",
              FASED_PROTECTED_LOCAL_INSTANCE: instanceId,
            },
          },
        })}\n`,
      );
      await Promise.all([
        fsp.writeFile(
          path.join(systemdRoot, `fased-gateway-${instanceId}.service`),
          `WorkingDirectory=${stateDir}/runtime/releases/1.2.3\n`,
        ),
        fsp.writeFile(
          path.join(installDir, "gateway-launch"),
          `exec /bin/bash "${stateDir}/runtime/releases/1.2.3/scripts/start-managed.sh"\n`,
        ),
      ]);
      await expect(
        __testing.inspectLocalManagedConsistency({ stateDir }, manifest, "1.2.3", {
          installRoot,
          systemdRoot,
        }),
      ).resolves.toMatchObject({
        consistent: false,
        reasons: expect.arrayContaining(["protected_application_boundary_missing"]),
      });

      await fsp.symlink(applicationRelease, applicationCurrent);
      await Promise.all([
        fsp.writeFile(
          path.join(systemdRoot, `fased-gateway-${instanceId}.service`),
          [
            `WorkingDirectory=${applicationCurrent}`,
            `Environment=FASED_CONFIG_DIR=${stateDir}`,
            `Environment=FASED_MANAGED_RUNTIME_ROOT=${applicationCurrent}`,
            "Environment=FASED_NODE_BIN=/usr/bin/node",
            "Environment=PATH=/usr/local/bin:/usr/bin:/bin",
            "Environment=FASED_RUNTIME_SOURCE=managed-package", // pragma: allowlist secret
            "",
          ].join("\n"),
        ),
        fsp.writeFile(
          path.join(installDir, "gateway-launch"),
          [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            `gateway_entry="${applicationCurrent}/dist/entry.js"`,
            'exec /usr/bin/node "$gateway_entry" gateway --allow-unconfigured --force --bind loopback --port 18789',
            "",
          ].join("\n"),
        ),
      ]);
      await expect(
        __testing.inspectLocalManagedConsistency({ stateDir }, manifest, "1.2.3", {
          installRoot,
          systemdRoot,
        }),
      ).resolves.toEqual({ consistent: true, reasons: [] });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects release archive paths that can escape the approved root", () => {
    expect(__testing.archiveEntryIsSafe("package/", "package")).toBe(true);
    expect(__testing.archiveEntryIsSafe("package/dist/entry.js", "package")).toBe(true);
    expect(__testing.archiveEntryIsSafe("package/../escape", "package")).toBe(false);
    expect(__testing.archiveEntryIsSafe("package/./dist/entry.js", "package")).toBe(false);
    expect(__testing.archiveEntryIsSafe("package//dist/entry.js", "package")).toBe(false);
    expect(__testing.archiveEntryIsSafe("/package/dist/entry.js", "package")).toBe(false);
    expect(__testing.archiveEntryIsSafe("package\\..\\escape", "package")).toBe(false);
    expect(__testing.archiveEntryIsSafe("other/dist/entry.js", "package")).toBe(false);
  });

  it("parses the generated Local signer environment without executing its command", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-signer-env-test-"));
    const signerEnvPath = path.join(root, "signer.env");
    await fsp.writeFile(
      signerEnvPath,
      [
        `export FASED_WALLET_LOCAL_SIGNER_SOCKET="${path.join(root, "app.sock")}"`,
        `export FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET="${path.join(root, "control.sock")}"`,
        `export FASED_WALLET_LOCAL_SIGNER_STATE_DB="${path.join(root, "state.db")}"`,
        `export FASED_WALLET_LOCAL_SIGNER_MASTER_KEY="${path.join(root, "master.key")}"`,
        'export FASED_WALLET_CHAINS="solana"',
        'export FASED_WALLET_WEBAUTHN_RP_ID="localhost"',
        'export FASED_WALLET_WEBAUTHN_ORIGINS="http://localhost:18789,http://localhost:18791"',
        'export FASED_SAT_PROGRAM_ID="11111111111111111111111111111111"',
        `export FASED_SAT_RUNTIME_MANIFEST_PATH="${path.join(root, "sat-runtime.json")}"`,
        'export FASED_SAT_RUNTIME_MANIFEST_SHA256="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
        `export FASED_SAT_RUNTIME_MANIFEST_SIGNATURE_PATH="${path.join(root, "sat-runtime.sig")}"`,
        '"/verified/fased-signerd" --socket "$FASED_WALLET_LOCAL_SIGNER_SOCKET" --control-socket "$FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET" --state-db "$FASED_WALLET_LOCAL_SIGNER_STATE_DB" --master-key "$FASED_WALLET_LOCAL_SIGNER_MASTER_KEY"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    try {
      await expect(__testing.loadSignerEnvironment({ signerEnvPath })).resolves.toMatchObject({
        FASED_WALLET_CHAINS: "solana",
        FASED_WALLET_WEBAUTHN_RP_ID: "localhost",
        FASED_WALLET_WEBAUTHN_ORIGINS: "http://localhost:18789,http://localhost:18791",
        FASED_SAT_PROGRAM_ID: "11111111111111111111111111111111",
        FASED_SAT_RUNTIME_MANIFEST_PATH: path.join(root, "sat-runtime.json"),
        FASED_SAT_RUNTIME_MANIFEST_SHA256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        FASED_SAT_RUNTIME_MANIFEST_SIGNATURE_PATH: path.join(root, "sat-runtime.sig"),
      });
      await fsp.appendFile(
        signerEnvPath,
        'export FASED_WALLET_PRIVATE_KEY="forbidden"\n', // pragma: allowlist secret
      );
      await expect(__testing.loadSignerEnvironment({ signerEnvPath })).rejects.toThrow(
        "unsupported key FASED_WALLET_PRIVATE_KEY",
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("activates the app and signer as one ordered transaction", async () => {
    const events: string[] = [];
    await expect(
      __testing.coordinateHostedReleaseTransaction(transaction(), transactionOperations(events)),
    ).resolves.toMatchObject({ action: "committed" });
    expect(events).toEqual([
      "write:quiescing",
      "quiesce-gateway",
      "activate-app",
      "write:app-active",
      "signer:activateRelease",
      "write:signer-active",
      "signer:authorizeGatewayRelease",
      "verify-gateway",
      "write:gateway-verified",
      "signer:commitRelease",
      "finalize-app",
      "remove-journal",
    ]);
  });

  it("verifies the target Gateway without restarting it inside the active root transaction", async () => {
    const calls: unknown[][] = [];
    const operations = __testing.hostedTransactionOperations(
      {
        stateDir: "/state",
        configPath: "/state/fased.json",
      },
      30_000,
      {
        controllerSocketPath: "/run/controller.sock",
        refreshGateway: async (...args: unknown[]) => {
          calls.push(args);
        },
      },
    );
    await operations.verifyGateway({
      targetRoot: "/runtime/target",
      nextManifest: {
        profile: "protected-local",
        runtime: { activeVersion: "1.2.3" },
      },
      signerRelease: signerRelease("1.2.3"),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[5]).toBe(true);
  });

  it("rolls back a root prepare that returned a mismatched release identity", async () => {
    const events: string[] = [];
    const error = new Error("release identity mismatch") as Error & {
      hostUpdaterPrepared: boolean;
    };
    error.hostUpdaterPrepared = true;
    const recovered = await __testing.recoverFailedHostedPreparation(
      transaction(),
      {
        signerRequest: async (operation: string) => {
          events.push(`signer:${operation}`);
        },
        removeJournal: async () => {
          events.push("remove-journal");
        },
      },
      error,
    );

    expect(recovered).toBe(true);
    expect(events).toEqual(["signer:rollbackRelease", "remove-journal"]);
  });

  it("restores the app, then signer, then previous Gateway when target health fails", async () => {
    const events: string[] = [];
    const operations = transactionOperations(events, {
      verifyGateway: async () => {
        events.push("verify-gateway");
        throw new Error("target unhealthy");
      },
    });
    await expect(
      __testing.coordinateHostedReleaseTransaction(transaction(), operations),
    ).rejects.toMatchObject({ code: "HOSTED_UPDATE_ROLLED_BACK" });
    expect(events).toEqual([
      "write:quiescing",
      "quiesce-gateway",
      "activate-app",
      "write:app-active",
      "signer:activateRelease",
      "write:signer-active",
      "signer:authorizeGatewayRelease",
      "verify-gateway",
      "write:rolling-back",
      "quiesce-gateway",
      "signer:gateGatewayRelease",
      "restore-app",
      "signer:rollbackRelease",
      "write:rollback-ready",
      "refresh-previous",
      "remove-journal",
    ]);
  });

  it("resumes rollback-ready recovery without replaying the closed root transaction", async () => {
    const events: string[] = [];
    await expect(
      __testing.rollbackHostedReleaseTransaction(
        transaction("rollback-ready"),
        transactionOperations(events),
      ),
    ).resolves.toMatchObject({ action: "rolled-back" });
    expect(events).toEqual(["refresh-previous", "remove-journal"]);
  });

  it("resumes rolling-back recovery through the idempotent root rollback operation", async () => {
    const events: string[] = [];
    await expect(
      __testing.rollbackHostedReleaseTransaction(
        transaction("rolling-back"),
        transactionOperations(events),
      ),
    ).resolves.toMatchObject({ action: "rolled-back" });
    expect(events).toEqual([
      "signer:rollbackRelease",
      "restore-app",
      "write:rollback-ready",
      "refresh-previous",
      "remove-journal",
    ]);
  });

  it("never rolls back after the durable health commit decision", async () => {
    const events: string[] = [];
    const operations = transactionOperations(events, {
      signerRequest: async (operation: string) => {
        events.push(`signer:${operation}`);
        if (operation === "commitRelease") {
          throw new Error("response lost");
        }
      },
    });
    await expect(
      __testing.coordinateHostedReleaseTransaction(transaction(), operations),
    ).rejects.toMatchObject({ code: "HOSTED_COMMIT_PENDING" });
    expect(events).toEqual([
      "write:quiescing",
      "quiesce-gateway",
      "activate-app",
      "write:app-active",
      "signer:activateRelease",
      "write:signer-active",
      "signer:authorizeGatewayRelease",
      "verify-gateway",
      "write:gateway-verified",
      "signer:commitRelease",
    ]);
  });

  it("resumes a repair whose signer was preactivated while the Gateway stayed gated", async () => {
    const events: string[] = [];
    await expect(
      __testing.coordinateHostedReleaseTransaction(
        transaction("signer-preactivated"),
        transactionOperations(events),
      ),
    ).resolves.toMatchObject({ action: "committed" });
    expect(events).toEqual([
      "quiesce-gateway",
      "activate-app",
      "write:signer-active",
      "signer:authorizeGatewayRelease",
      "verify-gateway",
      "write:gateway-verified",
      "signer:commitRelease",
      "finalize-app",
      "remove-journal",
    ]);
  });

  it("translates an old root updater rejection into one-time migration guidance", () => {
    expect(
      __testing.hostedUpdaterError(new Error("request contains unsupported fields"), false).message,
    ).toBe(PRE_V2_HOSTING_MIGRATION_MESSAGE);
    expect(
      __testing.hostedUpdaterError(
        new Error("request contains unsupported fields"),
        false,
        false,
        "1.2.3-rc.4",
      ).message,
    ).toBe(legacyHostingBootstrapMessage("1.2.3-rc.4"));
    expect(hostingBootstrapCommand()).toBe(
      "curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh | bash -s -- --hosting",
    );
    expect(hostingBootstrapCommand("1.2.3")).toContain(
      "https://github.com/fased-ai/fased/releases/download/v1.2.3/install.sh",
    );
    expect(hostingBootstrapCommand("1.2.3")).toContain(
      "--hosting --release v1.2.3 --update-channel stable",
    );
    expect(hostingBootstrapCommand("v1.2.3-rc.4")).toContain(
      "--hosting --release v1.2.3-rc.4 --update-channel beta",
    );
    expect(PRE_V2_HOSTING_MIGRATION_MESSAGE).not.toContain("--repair-hosting");
    expect(
      __testing.hostedUpdaterError(
        new Error("connect ENOENT /run/fased-host-updater/request.sock"),
        false,
        false,
        "1.2.3",
      ).message,
    ).toContain("--hosting --release v1.2.3 --update-channel stable");
    expect(
      __testing.hostedUpdaterError(new Error("refusing signer release below rollback floor"), false)
        .message,
    ).toContain("rollback floor");
    expect(
      __testing.hostedUpdaterError(new Error("request contains unsupported fields"), false)
        .hostUpdaterAmbiguous,
    ).toBe(false);
    expect(
      __testing.hostedUpdaterError(
        new Error("connect ENOENT /run/fased-local-controller/example/request.sock"),
        false,
        true,
      ).message,
    ).toBe(PROTECTED_LOCAL_CONTROLLER_UNAVAILABLE_MESSAGE);
  });

  it("derives the Protected Local controller socket from install.json without app config", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-protected-controller-socket-"));
    const stateDir = path.join(root, ".fased");
    const manifestPath = path.join(stateDir, "install.json");
    const instanceId = "0123456789abcdef";
    await fsp.mkdir(stateDir, { recursive: true });
    const configPath = path.join(stateDir, "fased.json");
    await fsp.writeFile(configPath, "{not-json\n", { mode: 0o000 });
    const manifest = {
      profile: "protected-local",
      stateDir,
      configPath,
      service: {
        name: `fased-gateway-${instanceId}.service`,
        scope: "system",
        launcher: `/opt/fased/local/${instanceId}/gateway-launch`,
      },
    };
    await fsp.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    const previous = process.env.FASED_HOST_UPDATER_SOCKET;
    delete process.env.FASED_HOST_UPDATER_SOCKET;
    try {
      expect(
        __testing.resolveManagedControllerDescriptor({ manifestPath, stateDir }, manifest),
      ).toEqual({
        profile: "protected-local",
        socketPath: `/run/fased-local-controller/${instanceId}/request.sock`,
        instanceId,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.FASED_HOST_UPDATER_SOCKET;
      } else {
        process.env.FASED_HOST_UPDATER_SOCKET = previous;
      }
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes Hosting through the same managed controller contract", () => {
    const stateDir = "/home/app/.fased";
    expect(
      __testing.resolveManagedControllerDescriptor(
        { stateDir, manifestPath: path.join(stateDir, "install.json") },
        {
          profile: "hosting",
          stateDir,
          configPath: path.join(stateDir, "fased.json"),
          service: {
            name: "fased-gateway.service",
            scope: "system",
            launcher: "/usr/local/libexec/fased-gateway-launch",
          },
        },
      ),
    ).toEqual({
      profile: "hosting",
      socketPath: "/run/fased-host-updater/request.sock",
      instanceId: null,
    });
  });

  it("derives signer health endpoints from the normalized controller identity", () => {
    expect(__testing.rootManagedSignerEndpoint("protected-local", "0123456789abcdef")).toEqual({
      signerBinary: "/opt/fased/local/0123456789abcdef/signer/fased-signerd",
      operatorSocket: "/run/fased-local/0123456789abcdef/operator/operator.sock",
    });
    expect(__testing.rootManagedSignerEndpoint("hosting", null)).toEqual({
      signerBinary: "/opt/fased/signer/fased-signerd",
      operatorSocket: "/run/fased-signerd/operator.sock",
    });
    expect(() => __testing.rootManagedSignerEndpoint("protected-local", null)).toThrow(
      "Protected Local signer instance identity is unavailable",
    );
  });

  it("rejects manifest-controlled controller socket redirection", () => {
    const stateDir = "/home/operator/.fased";
    const instanceId = "0123456789abcdef";
    const manifest = {
      profile: "protected-local",
      stateDir,
      configPath: path.join(stateDir, "fased.json"),
      service: {
        name: `fased-gateway-${instanceId}.service`,
        scope: "system",
        launcher: "/tmp/attacker-controlled-launcher",
      },
    };
    expect(() =>
      __testing.resolveManagedControllerDescriptor(
        { stateDir, manifestPath: path.join(stateDir, "install.json") },
        manifest,
      ),
    ).toThrow(/controller identity/u);
  });

  it("resolves update channels without application configuration", () => {
    expect(
      __testing.resolveConfiguredChannel(
        { channelExplicit: true, channel: "beta" },
        { update: { channel: "stable" } },
      ),
    ).toBe("beta");
    expect(
      __testing.resolveConfiguredChannel(
        { channelExplicit: false, channel: "stable" },
        { update: { channel: "beta" } },
      ),
    ).toBe("beta");
    expect(
      __testing.resolveConfiguredChannel({ channelExplicit: false, channel: "stable" }, {}),
    ).toBe("stable");
  });

  it("hands a root-managed release to one target-controller transaction and performs no phase calls", async () => {
    const operations: string[] = [];
    let handoffAccepted = false;
    await expect(
      __testing.handoffTargetOwnedRelease({
        transactionId: TRANSACTION_ID,
        targetVersion: "1.2.3",
        timeoutMs: 1000,
        socketPath: "/run/fased-host-updater/request.sock",
        expectedSignerRelease: signerRelease(),
        ensureController: async () => {
          operations.push("updateController");
        },
        onHandoff: () => {
          handoffAccepted = true;
        },
        applyRelease: async () => {
          operations.push("applyRelease");
          return {
            ok: true,
            transactionId: TRANSACTION_ID,
            version: "1.2.3",
            phase: "committed",
            release: signerRelease(),
          };
        },
      }),
    ).resolves.toMatchObject({ phase: "committed", release: signerRelease() });
    expect(handoffAccepted).toBe(true);
    expect(operations).toEqual(["updateController", "applyRelease"]);
  });

  it("lets the selected target own all root-managed product mutation", async () => {
    const operations: string[] = [];
    const targetRoot = "/opt/fased/application/releases/1.2.3";
    const paths = {
      manifestPath: "/home/operator/.fased/install.json",
      currentLink: "/home/operator/.fased/runtime/current",
      stateDir: "/home/operator/.fased",
    };
    await expect(
      __testing.convergeRootManagedTarget(
        {
          paths,
          existingManifest: { profile: "protected-local" },
          currentVersion: "1.2.2",
          targetVersion: "1.2.3",
          timeoutMs: 1000,
          onHandoff: () => operations.push("boundary-crossed"),
        },
        {
          randomTransactionId: () => TRANSACTION_ID,
          resolveControllerSocket: () => "/run/fased-local-controller/fixture/request.sock",
          handoff: async (request: Record<string, unknown>) => {
            operations.push("supervisor-transaction");
            (request.onHandoff as () => void)();
            return {
              ok: true,
              transactionId: TRANSACTION_ID,
              version: "1.2.3",
              phase: "committed",
              changed: true,
              release: signerRelease(),
            };
          },
          readManifest: () => ({
            profile: "protected-local",
            runtime: { activeVersion: "1.2.3" },
          }),
          resolveCurrentRoot: async () => targetRoot,
          readVersion: async () => "1.2.3",
          removeLegacyJournal: async () => operations.push("retire-legacy-hint"),
        },
      ),
    ).resolves.toMatchObject({
      transactionId: TRANSACTION_ID,
      previousVersion: "1.2.2",
      currentRoot: targetRoot,
    });
    expect(operations).toEqual([
      "supervisor-transaction",
      "boundary-crossed",
      "retire-legacy-hint",
    ]);
  });

  it("distinguishes a definitive pre-v2 rejection from an ambiguous post-send disconnect", async () => {
    const rejected = await withUnixServer((socket) => {
      socket.once("data", () => {
        socket.end(`${JSON.stringify({ ok: false, error: "unsupported updater schema" })}\n`);
      });
    });
    try {
      await expect(
        __testing.requestHostedSignerTransaction(
          "prepareRelease",
          TRANSACTION_ID,
          "1.2.3",
          1000,
          rejected.socketPath,
        ),
      ).rejects.toMatchObject({
        hostUpdaterAmbiguous: false,
        message: expect.stringContaining("--hosting --release v1.2.3 --update-channel stable"),
      });
    } finally {
      await rejected.close();
    }

    const disconnected = await withUnixServer((socket) => {
      socket.once("data", () => socket.destroy());
    });
    try {
      await expect(
        __testing.requestHostedSignerTransaction(
          "prepareRelease",
          TRANSACTION_ID,
          "1.2.3",
          1000,
          disconnected.socketPath,
        ),
      ).rejects.toMatchObject({ hostUpdaterAmbiguous: true });
    } finally {
      await disconnected.close();
    }
  });

  it("routes a missing Hosting root controller to the same verified one-command bridge", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-missing-root-controller-"));
    const socketPath = path.join(root, "missing", "request.sock");
    try {
      await expect(
        __testing.requestHostedSignerTransaction(
          "prepareRelease",
          TRANSACTION_ID,
          "1.2.3-rc.4",
          1000,
          socketPath,
        ),
      ).rejects.toMatchObject({
        hostUpdaterAmbiguous: false,
        message: expect.stringContaining("--hosting --release v1.2.3-rc.4 --update-channel beta"),
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("routes Gateway transaction operations through the selected root controller socket", async () => {
    const operations: string[] = [];
    const server = await withUnixServer((socket) => {
      socket.once("data", (chunk) => {
        const request = JSON.parse(String(chunk).trim()) as {
          op: string;
          transactionId: string;
          version: string;
        };
        operations.push(request.op);
        socket.end(
          `${JSON.stringify({
            ok: true,
            transactionId: request.transactionId,
            version: request.version,
          })}\n`,
        );
      });
    });
    try {
      await expect(
        __testing.quiesceHostedGateway(TRANSACTION_ID, "1.2.3", 1000, server.socketPath),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        __testing.restartHostedGateway("1.2.3", 1000, server.socketPath),
      ).resolves.toMatchObject({ ok: true });
      expect(operations).toEqual(["gateGatewayRelease", "restartGateway"]);
    } finally {
      await server.close();
    }
  });

  it("never reuses a same-version runtime with a different release identity", () => {
    const metadata = {
      schemaVersion: 2,
      version: "1.2.3",
      commit: "a".repeat(40),
      dependencyHash: "b".repeat(64),
    };
    const release = {
      manifestDigest: `sha256:${"c".repeat(64)}`,
      version: "1.2.3",
      commit: "a".repeat(40),
      appArtifactDigest: `sha256:${"d".repeat(64)}`,
    };
    expect(
      __testing.managedRuntimeReleaseIdentitiesEqual(metadata, { ...metadata }, release, {
        ...release,
      }),
    ).toBe(true);
    expect(
      __testing.managedRuntimeReleaseIdentitiesEqual(
        metadata,
        { ...metadata, commit: "e".repeat(40) },
        release,
        { ...release, commit: "e".repeat(40) },
      ),
    ).toBe(false);
    expect(
      __testing.managedRuntimeReleaseIdentitiesEqual(metadata, { ...metadata }, release, {
        ...release,
        appArtifactDigest: `sha256:${"f".repeat(64)}`,
      }),
    ).toBe(false);
  });

  it("requires the root updater to return an exact production signer identity", async () => {
    const server = await withUnixServer((socket) => {
      socket.once("data", () => {
        socket.end(
          `${JSON.stringify({
            ok: true,
            transactionId: TRANSACTION_ID,
            version: "1.2.3",
            release: signerRelease(),
          })}\n`,
        );
      });
    });
    try {
      await expect(
        __testing.requestHostedSignerTransaction(
          "prepareRelease",
          TRANSACTION_ID,
          "1.2.3",
          1000,
          server.socketPath,
        ),
      ).resolves.toMatchObject({ release: signerRelease() });
    } finally {
      await server.close();
    }
  });

  it("requires an exact process identity from controller-update responses", async () => {
    const server = await withUnixServer((socket) => {
      socket.once("data", () => {
        socket.end(
          `${JSON.stringify({
            ok: true,
            transactionId: TRANSACTION_ID,
            version: "1.2.3",
            controllerChanged: false,
            controllerInstanceId: "22222222-2222-4222-8222-222222222222",
          })}\n`,
        );
      });
    });
    try {
      await expect(
        __testing.requestHostedSignerTransaction(
          "updateController",
          TRANSACTION_ID,
          "1.2.3",
          1000,
          server.socketPath,
        ),
      ).resolves.toMatchObject({
        controllerChanged: false,
        controllerInstanceId: "22222222-2222-4222-8222-222222222222",
      });
    } finally {
      await server.close();
    }
  });

  it("waits for a different verified controller process before signer work", async () => {
    const instances = [
      {
        controllerChanged: true,
        controllerInstanceId: "22222222-2222-4222-8222-222222222222",
      },
      new Error("service restarting"),
      {
        controllerChanged: false,
        controllerInstanceId: "22222222-2222-4222-8222-222222222222",
      },
      {
        controllerChanged: false,
        controllerInstanceId: "33333333-3333-4333-8333-333333333333",
      },
    ];
    let waits = 0;
    await expect(
      __testing.ensureHostedControllerRelease(TRANSACTION_ID, "1.2.3", 1000, undefined, {
        request: async () => {
          const next = instances.shift();
          if (next instanceof Error) {
            throw next;
          }
          return next;
        },
        wait: async () => {
          waits += 1;
        },
      }),
    ).resolves.toMatchObject({
      controllerChanged: false,
      controllerInstanceId: "33333333-3333-4333-8333-333333333333",
    });
    expect(waits).toBe(3);
    expect(instances).toHaveLength(0);
  });

  it("requires app-account protocol-v2 features and valid signer policy hashes", async () => {
    const features = [
      "failClosedPolicies",
      "policyHashes",
      "durableCaps",
      "atomicIdempotency",
      "ambiguousBroadcastReconciliation",
      "signerOwnedKeys",
      "typedSolanaTransactions",
      "atomicMultiAssetCaps",
      "signerControlledNativeFeeCaps",
    ];
    const serveHealth = async (featureList: string[], nativeFeeReservationLamports = 5_000_000) =>
      await withUnixServer((socket) => {
        socket.once("data", () => {
          socket.end(
            `${JSON.stringify({
              ok: true,
              result: {
                ready: true,
                keystoreType: "signer-owned-v2",
                release: signerRelease(),
                capabilities: {
                  protocol: { current: 2, min: 2, max: 2 },
                  features: featureList,
                  nativeFeeReservationLamports,
                },
                policies: [
                  {
                    walletId: "agent",
                    version: 1,
                    hash: `sha256:${"a".repeat(64)}`,
                  },
                ],
              },
            })}\n`,
          );
        });
      });
    const healthy = await serveHealth(features);
    try {
      await expect(
        __testing.probeHostedSignerCompatibility(
          healthy.socketPath,
          1000,
          signerRelease(),
          "1.2.3",
        ),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      await healthy.close();
    }
    const incomplete = await serveHealth(features.slice(1));
    try {
      await expect(
        __testing.probeHostedSignerCompatibility(incomplete.socketPath, 1000),
      ).rejects.toThrow("missing failClosedPolicies");
    } finally {
      await incomplete.close();
    }
    const wrongFeeReservation = await serveHealth(features, 4_999_999);
    try {
      await expect(
        __testing.probeHostedSignerCompatibility(wrongFeeReservation.socketPath, 1000),
      ).rejects.toThrow("invalid native fee reservation");
    } finally {
      await wrongFeeReservation.close();
    }
    const wrongIdentity = await serveHealth(features);
    try {
      await expect(
        __testing.probeHostedSignerCompatibility(
          wrongIdentity.socketPath,
          1000,
          { ...signerRelease(), commit: "c".repeat(40) },
          "1.2.3",
        ),
      ).rejects.toThrow("signer release identity mismatch");
    } finally {
      await wrongIdentity.close();
    }
  });
});
