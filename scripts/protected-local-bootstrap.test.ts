import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProtectedLocalBootstrapSpec,
  renderProtectedLocalOperatorEnvironment,
  renderProtectedLocalOwnerWrapper,
  __testing,
} from "./protected-local-bootstrap.mjs";
import { buildProtectedLocalLayout } from "./protected-local-layout.mjs";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-protected-local-bootstrap-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("protected Local bootstrap contract", () => {
  it("treats an absent controller generation as already stopped", async () => {
    const calls: string[] = [];
    await __testing.stopExistingSystemdServices(
      "/fixture/systemctl",
      ["fased-local-controller-legacy.service", "fased-local-controller-worker-new.service"],
      {
        unitLoadState: async (_systemctl: string, unit: string) => {
          calls.push(`show:${unit}`);
          return unit.includes("worker") ? "not-found" : "loaded";
        },
        stopService: async (_systemctl: string, unit: string) => {
          calls.push(`stop:${unit}`);
        },
      },
    );
    expect(calls).toEqual([
      "show:fased-local-controller-legacy.service",
      "stop:fased-local-controller-legacy.service",
      "show:fased-local-controller-worker-new.service",
    ]);
  });

  it("restores the operator-only supervisor retry hint after shared-state convergence", async () => {
    const root = temporaryRoot();
    const stateDir = path.join(root, ".fased");
    const hintPath = path.join(stateDir, "protected-local-controller-transaction.json");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(hintPath, '{"schemaVersion":1}\n', { mode: 0o660 });
    const spec = {
      stateDir,
      operatorUid: process.getuid?.() ?? 0,
      operatorGid: process.getgid?.() ?? 0,
    };

    await expect(__testing.hardenProtectedLocalClientHint(spec)).resolves.toBe(true);
    expect(
      __testing.isProtectedLocalOperatorOnlyState("protected-local-controller-transaction.json"),
    ).toBe(true);
    const info = fs.lstatSync(hintPath);
    expect(info.uid).toBe(process.getuid?.() ?? 0);
    expect(info.gid).toBe(process.getgid?.() ?? 0);
    expect(info.mode & 0o777).toBe(0o600);

    fs.rmSync(hintPath);
    fs.symlinkSync(path.join(root, "outside"), hintPath);
    await expect(__testing.hardenProtectedLocalClientHint(spec)).rejects.toThrow(
      /transaction hint is unsafe/u,
    );
  });

  it("normalizes the root-owned update-channel directory for service traversal", async () => {
    const root = temporaryRoot();
    const layout = buildProtectedLocalLayout("0123456789abcdef");
    const directory = path.join(root, layout.instanceId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

    await expect(
      __testing.prepareProtectedLocalChannelDirectory(layout, {
        root,
        expectedOwnerUid: process.getuid?.() ?? 0,
      }),
    ).resolves.toBe(directory);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o755);

    fs.rmSync(directory, { recursive: true });
    fs.symlinkSync(root, directory);
    await expect(
      __testing.prepareProtectedLocalChannelDirectory(layout, {
        root,
        expectedOwnerUid: process.getuid?.() ?? 0,
      }),
    ).rejects.toThrow(/update-channel directory is unsafe/u);
  });

  it("normalizes legacy control metadata before the supervisor transition", () => {
    const root = temporaryRoot();
    const stateDir = path.join(root, ".fased");
    const journalPath = path.join(stateDir, "hosted-update-transaction.json");
    const journal = '{"schemaVersion":1,"phase":"rolling-back"}\n';
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(journalPath, journal, { mode: 0o600 });
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "protected-local-bootstrap.mjs"),
      "utf8",
    );
    const normalization = source.indexOf(
      "controlNormalization = await normalizeExistingProtectedLocalControl(",
    );
    const lifecycle = source.indexOf("lifecycle = applyProtectedLocalLifecycle(spec, layout)");
    expect(normalization).toBeGreaterThan(-1);
    expect(normalization).toBeLessThan(lifecycle);
    expect(source.slice(normalization, lifecycle)).not.toContain(
      "importLegacyManagedUpdateAdoption(",
    );
    expect(fs.readFileSync(journalPath, "utf8")).toBe(journal);
  });

  it("converges a mixed protected Local control plane into one standard boundary", async () => {
    const root = temporaryRoot();
    const stateDir = path.join(root, ".fased");
    const layout = buildProtectedLocalLayout("0123456789abcdef", {
      runtimeRoot: path.join(root, "run"),
      stateRoot: path.join(root, "state"),
      installRoot: path.join(root, "install"),
    });
    fs.mkdirSync(layout.controllerStateDir, { recursive: true });
    fs.mkdirSync(path.join(stateDir, "wallets"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "install.json"),
      `${JSON.stringify({ schemaVersion: 2, runtime: { activeVersion: "1.2.2" } })}\n`,
      { mode: 0o600 },
    );
    const legacyTransactionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const legacyJournal = `${JSON.stringify({
      schemaVersion: 1,
      phase: "rolling-back",
      transactionId: legacyTransactionId,
    })}\n`;
    fs.writeFileSync(path.join(stateDir, "hosted-update-transaction.json"), legacyJournal, {
      mode: 0o600,
    });
    fs.writeFileSync(
      path.join(stateDir, "legacy-managed-update-adoption.v1.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        outcome: "rolled-back",
        rootVerificationPending: true,
        transactionId: legacyTransactionId,
      })}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(stateDir, "protected-local-controller-transaction.json"),
      `${JSON.stringify({ schemaVersion: 1, version: "1.2.1" })}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(layout.controllerStateDir, "active-signer-transaction.json"),
      `${JSON.stringify({ schemaVersion: 8, phase: "restored" })}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(stateDir, "wallets", "registry.json"), "wallet-state\n");
    const calls: string[] = [];
    const result = await __testing.normalizeExistingProtectedLocalControl(
      root,
      {
        stateDir,
        operatorUid: process.getuid?.() ?? 0,
        releaseVersion: "1.2.3",
      },
      layout,
      {
        expectedRootUid: process.getuid?.() ?? 0,
        expectedRootGid: process.getgid?.() ?? 0,
        expectedOperatorStateGid: process.getgid?.() ?? 0,
        systemctlPath: "/fixture/systemctl",
        stopServices: async (_systemctl: string, units: string[]) => {
          calls.push(`stop:${units.join(",")}`);
        },
        restartService: async (_systemctl: string, unit: string) => {
          calls.push(`restart:${unit}`);
        },
        transition: async (
          _sourceRoot: string,
          _spec: unknown,
          _layout: unknown,
          options: { onBoundaryCommitted?: () => Promise<unknown> } = {},
        ) => {
          calls.push("transition");
          await options.onBoundaryCommitted?.();
        },
      },
    );
    expect(result.strategy).toBe("UNIVERSAL_TAKEOVER");
    expect(result.receipt).toMatchObject({
      previousVersion: "1.2.2",
      targetVersion: "1.2.3",
      outcome: "committed",
    });
    expect(calls).toEqual([`stop:${layout.supervisorUnit},${layout.controllerUnit}`, "transition"]);
    expect(fs.existsSync(path.join(stateDir, "hosted-update-transaction.json"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "legacy-managed-update-adoption.v1.json"))).toBe(
      false,
    );
    expect(fs.statSync(layout.supervisorStateDir).mode & 0o777).toBe(0o700);
    expect(
      fs.existsSync(path.join(layout.controllerStateDir, "active-signer-transaction.json")),
    ).toBe(false);
    expect(fs.readFileSync(path.join(stateDir, "wallets", "registry.json"), "utf8")).toBe(
      "wallet-state\n",
    );
  });

  it("keeps the supervisor private and gives its client a separate executable boundary", async () => {
    const root = temporaryRoot();
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const layout = buildProtectedLocalLayout("0123456789abcdef", {
      runtimeRoot: path.join(root, "run"),
      stateRoot: path.join(root, "state"),
      installRoot: path.join(root, "install"),
    });
    const privateDirectory = path.dirname(layout.supervisorBinary);
    const clientDirectory = path.dirname(layout.supervisorClient);
    fs.mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });

    const snapshot = await __testing.captureProtectedLocalPrivateSupervisorDirectory(layout, {
      expectedUid: uid,
      expectedGid: gid,
    });
    expect(snapshot.mode).toBe(0o700);

    await expect(
      __testing.prepareProtectedLocalSupervisorClientDirectory(layout, {
        expectedUid: uid,
        expectedGid: gid,
      }),
    ).resolves.toMatchObject({ directory: clientDirectory, created: true });
    expect(fs.statSync(privateDirectory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(clientDirectory).mode & 0o777).toBe(0o755);

    const bootstrap = fs.readFileSync(
      path.join(process.cwd(), "scripts", "protected-local-bootstrap.mjs"),
      "utf8",
    );
    const transitionStart = bootstrap.indexOf(
      "async function transitionExistingSupervisorBoundary",
    );
    const transitionEnd = bootstrap.indexOf(
      "\nfunction validateProtectedLocalLifecycleResult",
      transitionStart,
    );
    const transition = bootstrap.slice(transitionStart, transitionEnd);
    expect(transition).not.toContain("setProtectedLocalSupervisorClientDirectoryMode");
    expect(transition).toContain("prepareProtectedLocalSupervisorClientDirectory(layout)");
    expect(transition).toContain("setProtectedLocalPrivateSupervisorDirectoryMode(");
    expect(transition).toContain("privateSupervisorDirectory, 0o700");
    expect(transition).toContain("fsp.rm(layout.legacySupervisorClient");

    const priorUnitSnapshots = new Map([
      [path.join("/etc/systemd/system", layout.supervisorUnit), { existed: true }],
      [path.join("/etc/systemd/system", layout.controllerUnit), { existed: true }],
    ]);
    expect(__testing.restorablePreviousSupervisorUnits(priorUnitSnapshots, layout)).toEqual([
      layout.supervisorUnit,
      layout.controllerUnit,
    ]);
    priorUnitSnapshots.set(path.join("/etc/systemd/system", layout.supervisorUnit), {
      existed: false,
    });
    expect(__testing.restorablePreviousSupervisorUnits(priorUnitSnapshots, layout)).toEqual([
      layout.controllerUnit,
    ]);

    fs.rmSync(privateDirectory, { recursive: true });
    fs.symlinkSync(root, privateDirectory);
    await expect(
      __testing.captureProtectedLocalPrivateSupervisorDirectory(layout, {
        expectedUid: uid,
        expectedGid: gid,
      }),
    ).rejects.toThrow(/private supervisor directory is unsafe/u);
  });

  it("accepts only one exact release and explicit Gateway phase", () => {
    const root = temporaryRoot();
    const home = path.join(root, "home", "operator");
    const stateDir = path.join(home, ".fased");
    const runtimeDir = path.join(stateDir, "runtime", "releases", "0.1.80");
    fs.mkdirSync(runtimeDir, { recursive: true });
    expect(
      buildProtectedLocalBootstrapSpec({
        operatorUser: "operator",
        operatorUid: 1000,
        operatorGid: 1000,
        operatorHome: home,
        stateDir,
        runtimeDir,
        nodeBinary: "/usr/bin/node",
        releaseVersion: "0.1.80",
        releaseCommit: "a".repeat(40),
        updateChannel: "stable",
        gatewayPort: 18789,
        gatewayMode: "prepare",
        profile: "default",
      }),
    ).toMatchObject({
      releaseVersion: "0.1.80",
      releaseCommit: "a".repeat(40),
      gatewayMode: "prepare",
    });
    expect(() =>
      buildProtectedLocalBootstrapSpec({
        operatorUser: "operator",
        operatorUid: 1000,
        operatorGid: 1000,
        operatorHome: home,
        stateDir,
        runtimeDir,
        nodeBinary: "/usr/bin/node",
        releaseVersion: "0.1.80",
        releaseCommit: "a".repeat(40),
        updateChannel: "stable",
        gatewayPort: 18789,
        gatewayMode: "skip",
      }),
    ).toThrow(/Gateway mode must be prepare, activate, or rollback/u);
    expect(
      buildProtectedLocalBootstrapSpec({
        operatorUser: "operator",
        operatorUid: 1000,
        operatorGid: 1000,
        operatorHome: home,
        stateDir,
        runtimeDir,
        nodeBinary: "/usr/bin/node",
        releaseVersion: "0.1.80",
        releaseCommit: "a".repeat(40),
        updateChannel: "stable",
        gatewayPort: 18789,
        gatewayMode: "rollback",
        profile: "default",
      }),
    ).toMatchObject({ gatewayMode: "rollback" });
  });

  it("binds all operator paths and owner commands to one random instance", () => {
    const layout = buildProtectedLocalLayout("0123456789abcdef");
    const environment = renderProtectedLocalOperatorEnvironment({
      layout,
      stateDir: "/home/operator/.fased",
    });
    expect(environment).toEqual({
      FASED_HOST_PROFILE: "local",
      FASED_PROTECTED_LOCAL: "1",
      FASED_PROTECTED_LOCAL_INSTANCE: "0123456789abcdef",
      FASED_WALLET_LOCAL_SIGNER_LIFECYCLE: "external",
      FASED_WALLET_LOCAL_SIGNER_BIN: "/opt/fased/local/0123456789abcdef/signer/fased-signerd",
      FASED_WALLET_LOCAL_SIGNER_SOCKET: "/run/fased-local/0123456789abcdef/application/app.sock",
      FASED_HOST_UPDATER_SOCKET: "/run/fased-local-controller/0123456789abcdef/request.sock",
      FASED_HOST_UPDATERCTL_STATE:
        "/home/operator/.fased/protected-local-controller-transaction.json",
    });
    const wrapper = renderProtectedLocalOwnerWrapper({
      layout,
      operatorUid: 1000,
      operatorGid: 1000,
      operatorUser: "operator",
    });
    expect(wrapper).toContain("FASED_SIGNER_USER=fssg-0123456789abcdef"); // pragma: allowlist secret
    expect(wrapper).toContain(
      "FASED_SIGNER_CONTROL_SOCKET=/run/fased-local/0123456789abcdef/control/control.sock",
    );
    expect(wrapper).toContain("FASED_SIGNER_OUTPUT_UID=1000");
    expect(wrapper).toContain("FASED_SIGNER_OUTPUT_GID=1000");
    expect(wrapper).toContain("FASED_SIGNER_OUTPUT_USER=operator");
    expect(wrapper).toContain("FASED_SIGNER_OWNER_LOCAL=1");
    expect(wrapper).toContain('exec /opt/fased/local/0123456789abcdef/signer-owner "$@"');
  });

  it("routes a fresh topology through one target-owned lifecycle apply transaction", () => {
    const root = temporaryRoot();
    const home = path.join(root, "home", "operator");
    const stateDir = path.join(home, ".fased");
    const runtimeDir = path.join(stateDir, "runtime", "current");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const spec = buildProtectedLocalBootstrapSpec({
      operatorUser: "operator",
      operatorUid: 1000,
      operatorGid: 1000,
      operatorHome: home,
      stateDir,
      runtimeDir,
      nodeBinary: "/usr/bin/node",
      releaseVersion: "0.1.80",
      releaseCommit: "a".repeat(40),
      updateChannel: "stable",
      gatewayPort: 18789,
      gatewayMode: "activate",
      profile: "default",
    });
    const layout = buildProtectedLocalLayout("0123456789abcdef");
    const command = __testing.buildProtectedLocalLifecycleApplyCommand(spec, layout, {
      runuserPath: "/usr/sbin/runuser",
    });

    expect(command).toEqual({
      executable: "/usr/sbin/runuser",
      args: [
        "-u",
        "operator",
        "--",
        "/usr/bin/env",
        "-i",
        `HOME=${home}`,
        "USER=operator",
        "LOGNAME=operator",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "FASED_HOST_UPDATER_SOCKET=/run/fased-local-controller/0123456789abcdef/request.sock",
        `FASED_HOST_UPDATERCTL_STATE=${path.join(
          stateDir,
          "protected-local-controller-transaction.json",
        )}`,
        "/usr/bin/node",
        "/opt/fased/local/0123456789abcdef/libexec/fased-host-updaterctl.mjs",
        "0.1.80",
        "--apply",
      ],
    });
  });

  it.each(["managed-install-absent", "managed-install-v1-to-v2", "managed-install-v2"])(
    "accepts the target-owned %s lifecycle transaction",
    (applicationAdapter) => {
      const spec = {
        releaseVersion: "0.1.80",
      };
      const result = {
        version: "0.1.80",
        phase: "committed",
        migration: {
          schemaVersion: 1,
          profile: "protected-local",
          serviceTopology: "protected-local-system-v1",
          adapters: {
            application: applicationAdapter,
          },
        },
      };

      expect(__testing.validateProtectedLocalLifecycleResult(result, spec)).toBe(result);
    },
  );

  it("rejects a lifecycle receipt outside the protected Local compatibility inventory", () => {
    expect(() =>
      __testing.validateProtectedLocalLifecycleResult(
        {
          version: "0.1.80",
          phase: "committed",
          migration: {
            schemaVersion: 1,
            profile: "hosting",
            serviceTopology: "hosting-system-v1",
            adapters: { application: "managed-install-v2" },
          },
        },
        { releaseVersion: "0.1.80" },
      ),
    ).toThrow("supported topology transaction");
  });

  it("normalizes registry IDs but preserves the registered public identity", () => {
    const root = temporaryRoot();
    const stateDir = path.join(root, ".fased");
    const walletDir = path.join(stateDir, "wallet");
    fs.mkdirSync(walletDir, { recursive: true });
    fs.writeFileSync(
      path.join(walletDir, "provider-registry.v1.json"),
      `${JSON.stringify({
        version: 1,
        wallets: [
          {
            id: "Agent-2",
            providerId: "local-socket-signer",
            addresses: { solana: "1".repeat(32) },
            metadata: { role: "agent" },
          },
          {
            id: "external",
            providerId: "wallet-standard",
            addresses: { solana: "2".repeat(32) },
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    expect(__testing.registeredSignerWallets({ stateDir })).toEqual([
      {
        walletID: "Agent-2",
        signerWalletID: "agent_2",
        publicKey: "1".repeat(32),
        role: "agent",
      },
    ]);
  });

  it("allows fresh prepare to grant inherited access before shared state directories exist", () => {
    const root = temporaryRoot();
    const stateDir = path.join(root, ".fased");
    fs.mkdirSync(stateDir, { recursive: true });

    expect(__testing.sharedApplicationStateDirectoriesForAclVerification({ stateDir })).toEqual([
      stateDir,
    ]);

    fs.mkdirSync(path.join(stateDir, "identity"));
    expect(__testing.sharedApplicationStateDirectoriesForAclVerification({ stateDir })).toEqual([
      stateDir,
      path.join(stateDir, "identity"),
    ]);

    fs.symlinkSync(root, path.join(stateDir, "wallet"));
    expect(() =>
      __testing.sharedApplicationStateDirectoriesForAclVerification({ stateDir }),
    ).toThrow(/shared application state is not a directory/u);
  });

  it("accepts only bounded plugin trees whose links stay inside the plugin root", async () => {
    const root = temporaryRoot();
    const stateDir = path.join(root, ".fased");
    const pluginRoot = path.join(stateDir, "extensions", "openai-runtime");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "index.js"), "export {};\n");
    fs.symlinkSync("index.js", path.join(pluginRoot, "entry.js"));

    await expect(
      __testing.inspectInstalledPluginTree(pluginRoot, { stateDir }),
    ).resolves.toMatchObject({ canonicalRoot: pluginRoot });

    fs.unlinkSync(path.join(pluginRoot, "entry.js"));
    fs.writeFileSync(path.join(stateDir, "outside.js"), "export {};\n");
    fs.symlinkSync("../../outside.js", path.join(pluginRoot, "entry.js"));
    await expect(__testing.inspectInstalledPluginTree(pluginRoot, { stateDir })).rejects.toThrow(
      /symlink escapes its root/u,
    );
  });

  it("records the exact installed controller generation identity", () => {
    const server = Buffer.from("controller-server");
    const client = Buffer.from("controller-client");
    expect(__testing.buildControllerIdentity("0.1.80", server, client)).toEqual({
      schemaVersion: 1,
      version: "0.1.80",
      serverSha256: crypto.createHash("sha256").update(server).digest("hex"),
      clientSha256: crypto.createHash("sha256").update(client).digest("hex"),
    });
  });

  it("accepts both managed application runtime identities for exact-version health", () => {
    for (const runtimeSource of ["managed-package", "packaged-runtime"]) {
      expect(
        __testing.protectedLocalGatewayHealthMatches(
          { version: "0.1.80", runtimeSource },
          200,
          "0.1.80",
          undefined,
        ),
      ).toBe(true);
    }
    expect(
      __testing.protectedLocalGatewayHealthMatches(
        { version: "0.1.79", runtimeSource: "managed-package" },
        200,
        "0.1.80",
        undefined,
      ),
    ).toBe(false);
    expect(
      __testing.protectedLocalGatewayHealthMatches(
        { version: "0.1.80", runtimeSource: "source-checkout" },
        200,
        "0.1.80",
        undefined,
      ),
    ).toBe(false);
    expect(
      __testing.protectedLocalGatewayHealthMatches(
        { version: "0.1.80", runtimeSource: "managed-package", pid: 4321 },
        200,
        "0.1.80",
        4321,
      ),
    ).toBe(true);
    expect(
      __testing.protectedLocalGatewayHealthMatches(
        { version: "0.1.80", runtimeSource: "managed-package", pid: 4322 },
        200,
        "0.1.80",
        4321,
      ),
    ).toBe(false);
  });

  it("waits through a transient legacy Gateway restart and accepts its exact release identity", async () => {
    const observed = [
      {
        ok: false,
        conflict: false,
        version: "",
        runtimeSource: "",
        detail: "connect ECONNREFUSED 127.0.0.1:18789",
      },
      {
        ok: false,
        conflict: true,
        version: "0.1.75",
        runtimeSource: "managed-package",
        detail: "status=200 version=0.1.75 runtimeSource=managed-package",
      },
    ];
    let probes = 0;
    const health = await __testing.waitForLegacyGatewayReleaseHealth(
      {},
      {
        probe: async () => observed[Math.min(probes++, observed.length - 1)],
        wait: async () => {},
        now: () => 0,
      },
    );
    expect(probes).toBe(2);
    expect(health).toMatchObject({
      version: "0.1.75",
      runtimeSource: "managed-package",
    });
  });

  it("preserves a healthy legacy Gateway across a transient systemd state", () => {
    const health = {
      ok: false,
      conflict: true,
      version: "0.1.75",
      runtimeSource: "managed-package",
      detail: "status=200 version=0.1.75 runtimeSource=managed-package",
    };
    expect(__testing.legacyGatewayWasServing({ ActiveState: "activating" }, health)).toBe(true);
    expect(__testing.legacyGatewayWasServing({ ActiveState: "inactive" }, health)).toBe(true);
    expect(() =>
      __testing.legacyGatewayWasServing(
        { ActiveState: "active" },
        {
          ok: false,
          conflict: false,
          version: "",
          runtimeSource: "",
          detail: "connect ECONNREFUSED 127.0.0.1:18789",
        },
      ),
    ).toThrow(/no exact healthy release identity/u);
  });

  it("binds rollback health to the exact previous managed release", () => {
    expect(
      __testing.previousLegacyGatewayVersion({
        manifestSnapshot: {
          existed: true,
          content: Buffer.from(JSON.stringify({ runtime: { activeVersion: "0.1.76-rc.7" } })),
        },
      }),
    ).toBe("0.1.76-rc.7");
    expect(() =>
      __testing.previousLegacyGatewayVersion({
        manifestSnapshot: {
          existed: true,
          content: Buffer.from(JSON.stringify({ runtime: { activeVersion: "latest" } })),
        },
      }),
    ).toThrow(/no exact previous release version/u);
  });

  it("binds rollback health to a stable user systemd Gateway listener", async () => {
    const observedVersions: Array<string | undefined> = [];
    let systemdProbe = 0;
    await __testing.waitForLegacyGatewayRestored(
      {
        spec: { gatewayPort: 18_789 },
        legacyGatewayState: { releaseVersion: "0.1.75" },
      },
      1_000,
      {
        systemctl: (_spec, args) => {
          if (args[0] === "list-jobs") {
            return "";
          }
          systemdProbe += 1;
          return [
            "ActiveState=active",
            "SubState=running",
            "Result=success",
            `MainPID=${systemdProbe === 1 ? 0 : 4242}`,
          ].join("\n");
        },
        probe: async (_spec, _expectedPid, _timeoutMs, expectedVersion) => {
          observedVersions.push(expectedVersion);
          return {
            ok: expectedVersion === "0.1.75",
            detail: `version=${expectedVersion}`,
          };
        },
        ownsListener: async (_spec, expectedPid) => expectedPid === 4242,
        wait: async () => {},
        now: (() => {
          let now = 0;
          return () => (now += 100);
        })(),
        stabilityMs: 200,
      },
    );

    expect(observedVersions).toEqual(["0.1.75", "0.1.75"]);
    expect(__testing.systemdMainPid({ MainPID: "4242" })).toBe(4242);
    expect(__testing.systemdMainPid({ MainPID: "0" })).toBeUndefined();
  });

  it("parses restrictive extended ACLs without discarding existing principals", () => {
    const original = __testing.parseDirectoryAcl(`
user::rwx
user:2001:rwx #effective:--x
group::---
mask::--x
other::---
default:user::rwx
default:group::---
default:other::---
`);
    expect(original).toEqual({
      entries: [
        "user::rwx",
        "user:2001:rwx",
        "group::---",
        "mask::--x",
        "other::---",
        "default:user::rwx",
        "default:group::---",
        "default:other::---",
      ],
    });
    expect(
      __testing.gatewayAclGrantState(
        original,
        __testing.parseDirectoryAcl(`
other::---
user:2002:--x
mask::--x
group::---
user:2001:rwx #effective:--x
user::rwx
default:user::rwx
default:group::---
default:other::---
`),
        2002,
      ),
    ).toBe("granted");
    expect(__testing.gatewayAclGrantState(original, original, 2002)).toBe("missing");
    expect(() =>
      __testing.gatewayAclGrantState(
        original,
        __testing.parseDirectoryAcl(`
user::rwx
user:2001:rwx
user:2002:--x
group::---
mask::r-x
other::---
default:user::rwx
default:group::---
default:other::---
`),
        2002,
      ),
    ).toThrow(/changed an existing entry/u);
    expect(() =>
      __testing.parseDirectoryAcl("user::rwx\nuser:operator:r-x\ngroup::---\nother::---\n"),
    ).toThrow(/unsupported access ACL/u);
  });

  it("allocates service identities without reusing operator-home ACL principals", () => {
    expect(__testing.protectedLocalSystemUidRange("SYS_UID_MIN 995\nSYS_UID_MAX 999\n")).toEqual({
      minimum: 995,
      maximum: 999,
    });
    const acl = __testing.parseDirectoryAcl(
      "user::rwx\nuser:998:--x\ngroup::---\nmask::--x\nother::---\n",
    );
    expect(__testing.namedUserAclUids(acl)).toEqual([998]);
    expect(
      __testing.selectProtectedLocalServiceUid({
        usedUids: [995, 996, 999],
        forbiddenUids: __testing.namedUserAclUids(acl),
        minimum: 995,
        maximum: 999,
      }),
    ).toBe(997);
  });

  it("starts the recoverable journal before mutation and publishes the registry last", () => {
    const bootstrap = fs.readFileSync(
      path.join(process.cwd(), "scripts", "protected-local-bootstrap.mjs"),
      "utf8",
    );
    const installStart = bootstrap.indexOf("async function installProtectedLocal(params)");
    const install = bootstrap.slice(installStart);
    const collisionCheck = install.indexOf("assertFreshAllocationUnclaimed(layout)");
    const journal = install.indexOf('persistBootstrapTransaction(transaction, "planned")');
    const rootMutation = install.indexOf("prepareProtectedLocalRootDirectories(layout)");
    const lifecycle = install.indexOf("applyProtectedLocalLifecycle(spec, layout)", rootMutation);
    const registryCommit = bootstrap.indexOf(
      "async function completeCommittedBootstrapTransaction",
    );
    expect(collisionCheck).toBeGreaterThan(-1);
    expect(collisionCheck).toBeLessThan(install.indexOf("try {", collisionCheck));
    expect(journal).toBeGreaterThan(collisionCheck);
    expect(journal).toBeLessThan(rootMutation);
    expect(rootMutation).toBeLessThan(lifecycle);
    expect(registryCommit).toBeGreaterThan(-1);
    expect(bootstrap.slice(registryCommit)).toContain("commitProtectedLocalInstance({");
    expect(bootstrap).not.toContain("loadOrAllocateProtectedLocalInstance");
  });

  it("treats absent legacy state as a valid fresh rollback boundary", async () => {
    await expect(
      __testing.restoreLegacyLocalStateBoundary({ spec: {}, legacy: null }),
    ).resolves.toBeUndefined();
  });

  it("requires an exact restorable legacy user-unit state", () => {
    for (const state of ["enabled", "disabled", "static", "indirect", "masked"]) {
      expect(__testing.isRestorableLegacyGatewayUnitFileState(state)).toBe(true);
    }
    for (const state of [
      "enabled-runtime",
      "linked",
      "linked-runtime",
      "masked-runtime",
      "generated",
      "transient",
      "alias",
      "",
    ]) {
      expect(__testing.isRestorableLegacyGatewayUnitFileState(state)).toBe(false);
    }
  });

  it("restores the exact captured legacy Gateway release before target metadata", () => {
    expect(
      __testing.previousLegacyGatewayVersion({
        legacyGatewayState: { releaseVersion: "0.1.75" },
        manifestSnapshot: {
          existed: true,
          content: Buffer.from(
            `${JSON.stringify({ runtime: { activeVersion: "0.1.76-rc.16" } })}\n`,
          ),
        },
      }),
    ).toBe("0.1.75");
  });

  it("recognizes a prior Local user Gateway from managed install metadata", () => {
    const root = temporaryRoot();
    const stateDir = path.join(root, ".fased");
    fs.mkdirSync(stateDir, { recursive: true });
    expect(__testing.legacyInstallReferencesUserGateway({ stateDir })).toBe(false);
    fs.writeFileSync(
      path.join(stateDir, "install.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        profile: "local",
        service: { name: "fased-gateway.service", scope: "user" },
      })}\n`,
    );
    expect(__testing.legacyInstallReferencesUserGateway({ stateDir })).toBe(true);
  });

  it("journals legacy Gateway state before every live fencing mutation", () => {
    const bootstrap = fs.readFileSync(
      path.join(process.cwd(), "scripts", "protected-local-bootstrap.mjs"),
      "utf8",
    );
    const prepared = bootstrap.slice(
      bootstrap.indexOf("async function activatePreparedBootstrapTransaction"),
      bootstrap.indexOf("async function installProtectedLocal"),
    );
    const install = bootstrap.slice(bootstrap.indexOf("async function installProtectedLocal"));
    for (const flow of [prepared, install]) {
      expect(
        flow.indexOf('persistBootstrapTransaction(transaction, "legacy-gateway-captured")'),
      ).toBeGreaterThan(flow.indexOf("captureLegacyGatewayState(spec, layout)"));
      expect(
        flow.indexOf("fenceLegacyGateway(spec, layout, transaction.legacyGatewayState)"),
      ).toBeGreaterThan(
        flow.indexOf('persistBootstrapTransaction(transaction, "legacy-gateway-captured")'),
      );
    }
    expect(bootstrap).toContain(
      'userSystemctl(spec, ["mask", "--runtime", "--force", "fased-gateway.service"])',
    );
    expect(bootstrap).not.toContain(
      'userSystemctl(spec, ["mask", "--runtime", "--now", "--force", "fased-gateway.service"])',
    );
    expect(bootstrap).toContain(
      'userSystemctl(spec, ["stop", "--no-block", "fased-gateway.service"])',
    );
  });

  it("treats missing legacy signer material as a clean fresh install", async () => {
    const root = temporaryRoot();
    const materialDir = path.join(root, "missing-wallet");
    await expect(
      __testing.removeLegacySignerMaterial({
        materialDir,
        stateDbPath: path.join(materialDir, "state.db"),
        masterKeyPath: path.join(materialDir, "master.key"),
        auditPath: path.join(materialDir, "audit.jsonl"),
        pidPath: path.join(materialDir, "signer.pid"),
        controlSocketPath: path.join(materialDir, "control.sock"),
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts only the exact published signer enrollment hardlink during migration", async () => {
    const root = temporaryRoot();
    const stateDir = path.join(root, ".fased");
    const binDir = path.join(stateDir, "bin");
    const binaryPath = path.join(binDir, "fased-signerd");
    const enrollmentPath = path.join(binDir, "fased-signer-enroll");
    const unexpectedPath = path.join(binDir, "unexpected-hardlink");
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(binaryPath, "verified signer bytes", { mode: 0o700 });
    fs.linkSync(binaryPath, enrollmentPath);
    const identity = fs.statSync(binaryPath);
    const spec = {
      stateDir,
      operatorUid: identity.uid,
      operatorGid: identity.gid,
    };

    const trusted = await __testing.resolveTrustedLegacyRuntimeHardlinks(spec);
    expect(trusted).toEqual(
      new Set([fs.realpathSync(binaryPath), fs.realpathSync(enrollmentPath)]),
    );
    await expect(
      __testing.hardenOperatorRuntime(binDir, spec, new Set(), trusted),
    ).resolves.toBeUndefined();

    fs.linkSync(binaryPath, unexpectedPath);
    await expect(__testing.resolveTrustedLegacyRuntimeHardlinks(spec)).resolves.toEqual(new Set());
    await expect(
      __testing.hardenOperatorRuntime(binDir, spec, new Set(), new Set()),
    ).rejects.toThrow(/unsafe entry/u);
  });

  it("restores private legacy state without corrupting immutable updater modes", async () => {
    const root = temporaryRoot();
    const stateDir = path.join(root, ".fased");
    const updaterDir = path.join(stateDir, "updater");
    const entrypoint = path.join(updaterDir, "fased-managed-updater.mjs");
    const receipt = path.join(updaterDir, "managed-updater-generation.v1.json");
    fs.mkdirSync(updaterDir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(entrypoint, "#!/usr/bin/env node\n", { mode: 0o755 });
    fs.writeFileSync(receipt, "{}\n", { mode: 0o644 });
    const identity = fs.statSync(stateDir);
    const spec = {
      stateDir,
      operatorUid: identity.uid,
      operatorGid: identity.gid,
    };

    fs.chmodSync(updaterDir, 0o700);
    fs.chmodSync(entrypoint, 0o700);
    fs.chmodSync(receipt, 0o600);
    await __testing.restoreLegacyOperatorRuntimeModes(spec);

    expect(fs.statSync(updaterDir).mode & 0o777).toBe(0o755);
    expect(fs.statSync(entrypoint).mode & 0o777).toBe(0o755);
    expect(fs.statSync(receipt).mode & 0o777).toBe(0o644);
  });

  it("packages one commit-before-onboarding protected Local lifecycle", () => {
    const installer = fs.readFileSync(path.join(process.cwd(), "install.sh"), "utf8");
    const bootstrap = fs.readFileSync(
      path.join(process.cwd(), "scripts", "protected-local-bootstrap.mjs"),
      "utf8",
    );
    const updater = fs.readFileSync(
      path.join(process.cwd(), "scripts", "fased-host-updater.mjs"),
      "utf8",
    );
    const packageMetadata = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { files: string[] };
    expect(packageMetadata.files).toContain("scripts/protected-local-bootstrap.mjs");
    expect(packageMetadata.files).toContain("scripts/lifecycle-control-normalizer.mjs");
    expect(bootstrap).toContain('"/opt/fased",\n    "/opt/fased/local"');
    expect(installer).toContain("--protected-local-root-bootstrap");
    expect(installer).toContain("bootstrap_protected_local_topology");
    expect(installer).toContain("--protected-local-gateway-mode");
    expect(installer).toContain("--protected-local-gateway-health-timeout-ms");
    expect(installer).toContain("--gateway-health-timeout-ms");
    expect(installer).toContain('>"$bootstrap_log" 2>&1');
    expect(installer).toContain("print_local_handoff_block");
    expect(installer).not.toContain('"$FASED_CLI_PATH" dashboard --no-open');
    expect(installer).toContain(
      "Protected Local services are committed and healthy, but onboarding did not complete.",
    );
    expect(installer).toContain("bootstrap_protected_local_topology activate");
    expect(installer).toContain("--resume-local-onboarding");
    expect(installer).not.toContain("bootstrap_protected_local_topology rollback");
    expect(installer).toContain("signer_sha256=");
    expect(installer).toContain("local -a apt_packages=(git curl ca-certificates jq acl)");
    expect(installer).toContain("need_cmd setpriv || apt_packages+=(util-linux)");
    expect(installer).toContain('apt-get install -y "${apt_packages[@]}"');
    expect(installer).toContain('missing+=("acl")');
    expect(installer).toContain(
      "pacman -Sy --needed --noconfirm git curl ca-certificates jq acl util-linux nodejs npm",
    );
    const sharedStateStart = bootstrap.indexOf("async function shareApplicationState(");
    const sharedStateEnd = bootstrap.indexOf(
      "\n\nconst PROTECTED_LOCAL_OPERATOR_ONLY_STATE",
      sharedStateStart,
    );
    const sharedStateAdapter = bootstrap.slice(sharedStateStart, sharedStateEnd);
    expect(sharedStateAdapter).not.toContain('path.join(spec.stateDir, "identity")');
    expect(sharedStateAdapter).not.toContain('path.join(spec.stateDir, "wallet")');
    expect(sharedStateAdapter).not.toContain('path.join(spec.stateDir, "federation")');
    expect(updater).toMatch(
      /relativePath: "identity",\s+stateClass: "device-identity",\s+create: true,\s+preserveContent: true,/u,
    );
    expect(updater).toMatch(
      /relativePath: "wallet",\s+stateClass: "wallet",\s+create: true,\s+preserveContent: true,/u,
    );
    expect(updater).toMatch(
      /relativePath: "federation",\s+stateClass: "federation-network",\s+create: true,\s+preserveContent: true,/u,
    );
  });

  it("repairs an already-protected Local topology through the root lifecycle controller", () => {
    const bootstrap = fs.readFileSync(
      path.join(process.cwd(), "scripts", "protected-local-bootstrap.mjs"),
      "utf8",
    );
    const branchStart = bootstrap.indexOf("if (!allocated.created) {");
    const branchEnd = bootstrap.indexOf(
      '\n    fail(\n      "protected Local instance exists without a recoverable bootstrap journal',
      branchStart,
    );
    const alreadyProtected = bootstrap.slice(branchStart, branchEnd);

    expect(alreadyProtected).toContain("await normalizeExistingProtectedLocalControl(");
    expect(alreadyProtected).toContain("lifecycle = applyProtectedLocalLifecycle(spec, layout)");
    expect(alreadyProtected.indexOf("await normalizeExistingProtectedLocalControl(")).toBeLessThan(
      alreadyProtected.indexOf("applyProtectedLocalLifecycle(spec, layout)"),
    );
    expect(alreadyProtected.indexOf("applyProtectedLocalLifecycle(spec, layout)")).toBeLessThan(
      alreadyProtected.indexOf("verifyGatewayHealth(spec, layout"),
    );
    expect(alreadyProtected).not.toContain("shareApplicationState(");
    expect(alreadyProtected).not.toContain("updateOperatorConfig(");
  });

  it("selects the fresh Local target by exact release and delegates trust to the root bundle", () => {
    const installer = fs.readFileSync(path.join(process.cwd(), "install.sh"), "utf8");
    const bootstrapStart = installer.indexOf("bootstrap_protected_local_topology() {");
    const bootstrapEnd = installer.indexOf("\n\nis_app_service_session() {", bootstrapStart);
    const bootstrap = installer.slice(bootstrapStart, bootstrapEnd);
    const bundleEntryStart = installer.indexOf("    enter_protected_local_bundle() {");
    const bundleEntryEnd = installer.indexOf("\n    }\n", bundleEntryStart);
    const bundleEntry = installer.slice(bundleEntryStart, bundleEntryEnd);

    expect(bootstrap).toContain('local release_source="$FASED_DIR"');
    expect(bootstrap).toContain('"$release_source/install.sh"');
    expect(bootstrap).toContain('"$release_source/package.json"');
    expect(bootstrap).toContain('"$release_version" != "$HOSTING_RELEASE"');
    expect(bootstrap).not.toContain("dist/build-info.json");
    expect(bootstrap).not.toContain("release_commit");
    expect(bootstrap).toContain("--protected-local-root-bootstrap");

    expect(installer).toContain(
      'if [[ "$hosting_bootstrap" -eq 1 || "$protected_local_bootstrap" -eq 1 ]]',
    );
    expect(installer).toContain('bootstrap_hosting_attested_bundle "$@"');
    expect(bundleEntry).toContain('"$selected_package_root/scripts/protected-local-bootstrap.mjs"');
    expect(bundleEntry).toContain('--source-root "$selected_package_root"');
    expect(bundleEntry).toContain(
      '--signer-binary "$selected_root_store/verified-assets/fased-signerd"',
    );

    const root = temporaryRoot();
    const sourceRoot = path.join(root, "release-source");
    const stateDir = path.join(root, "home", "operator", ".fased");
    const binDir = path.join(root, "bin");
    const capturePath = path.join(root, "sudo-args");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "install.sh"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(sourceRoot, "package.json"), '{"version":"9.9.9-test.1"}\n');
    fs.writeFileSync(
      path.join(binDir, "sudo"),
      `#!/bin/sh
set -eu
printf '%s\\n' "$*" >${JSON.stringify(capturePath)}
`,
      { mode: 0o700 },
    );
    fs.writeFileSync(path.join(binDir, "node"), "#!/bin/sh\nexit 127\n", { mode: 0o700 });
    const harnessPath = path.join(root, "fresh-release-handoff.sh");
    fs.writeFileSync(
      harnessPath,
      `#!/bin/bash
set -euo pipefail
protected_local_supported() { return 0; }
pass_args_value_after() { return 0; }
resolve_protected_local_system_node() { printf '%s\\n' ${JSON.stringify(process.execPath)}; }
spinner_start() { :; }
spinner_done() { :; }
spinner_failed() { :; }
install_log_path() { printf '%s\\n' ${JSON.stringify(path.join(root, "bootstrap.log"))}; }
read_protected_local_env() { PROTECTED_LOCAL_INSTANCE=fixture; return 0; }
${bootstrap}
FASED_DIR=${JSON.stringify(sourceRoot)}
FASED_CONFIG_DIR=${JSON.stringify(stateDir)}
HOSTING_RELEASE=9.9.9-test.1
UPDATE_CHANNEL=beta
FASED_PROFILE=default
INSTALL_VERBOSE=0
AUTO_INSTALL=0
PROTECTED_LOCAL_BOOTSTRAPPED=0
PROTECTED_LOCAL_LIFECYCLE_COMMITTED=0
PATH=${JSON.stringify(`${binDir}:/usr/bin:/bin`)}
bootstrap_protected_local_topology activate
`,
      { mode: 0o700 },
    );
    const result = spawnSync("/bin/bash", [harnessPath], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(sourceRoot, "dist", "build-info.json"))).toBe(false);
    expect(fs.readFileSync(capturePath, "utf8")).toContain(
      "--protected-local-root-bootstrap --release 9.9.9-test.1",
    );
  });

  it("selects a fixed system Node instead of the operator's active version-manager Node", () => {
    const installer = fs.readFileSync(path.join(process.cwd(), "install.sh"), "utf8");
    const resolverStart = installer.indexOf("resolve_protected_local_system_node() {");
    const resolverEnd = installer.indexOf("\n}\n", resolverStart);
    const resolver = installer.slice(resolverStart, resolverEnd);
    const bootstrapStart = installer.indexOf("bootstrap_protected_local_topology() {");
    const bootstrapEnd = installer.indexOf("\n}\n", bootstrapStart);
    const bootstrap = installer.slice(bootstrapStart, bootstrapEnd);

    expect(resolver).toContain("for candidate in /usr/bin/node /usr/local/bin/node");
    expect(resolver).toContain('node_runtime_ok_for "$candidate"');
    expect(resolver).toContain('readlink -f -- "$candidate"');
    expect(resolver).not.toContain("command -v node");
    expect(bootstrap).toContain("resolve_protected_local_system_node");
    expect(bootstrap).not.toContain('readlink -f "$(command -v node)"');
    expect(bootstrap).toContain('PATH="/usr/sbin:/usr/bin:/sbin:/bin"');
    expect(bootstrap).toContain("install_linux_system_dependencies 0");
  });

  it("restores the prior managed runtime after the shared root transaction rolls back", () => {
    const installer = fs.readFileSync(path.join(process.cwd(), "install.sh"), "utf8");
    const bootstrapCall = installer.lastIndexOf("if ! bootstrap_protected_local_topology activate");
    const failureEnd = installer.indexOf("\n    fi", bootstrapCall);
    const failureBranch = installer.slice(bootstrapCall, failureEnd);

    expect(failureBranch).toContain(
      "Protected Local lifecycle did not commit. Do not assume restoration succeeded unless the lifecycle output explicitly reports complete recovery.",
    );
    expect(failureBranch).toContain("rollback_managed_runtime_after_failed_install");
    expect(failureBranch.indexOf("rollback_managed_runtime_after_failed_install")).toBeLessThan(
      failureBranch.indexOf(
        "Protected Local lifecycle did not commit. Do not assume restoration succeeded unless the lifecycle output explicitly reports complete recovery.",
      ),
    );
  });
});
