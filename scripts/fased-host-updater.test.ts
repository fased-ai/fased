import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRE_V2_HOSTING_MIGRATION_MESSAGE,
  __testing,
  isMainModule,
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

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

async function createFixture() {
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
  const events: string[] = [];
  const context = __testing.createTransactionContext({
    paths,
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
      };
    },
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
      await fsp.writeFile(signerStateDBPath, "new-db\n", { mode: 0o600 });
      return { release: expectedRelease, invariant: "preserved-signer-state" };
    },
    startPreviousSigner: async () => {
      events.push("start-previous");
    },
    reloadUnits: async () => {
      events.push("daemon-reload");
    },
    startGateway: async () => {
      events.push("start-gateway");
    },
    probeSigner: async () => signerRelease("1.2.2"),
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
    const capabilities = { protocol: { current: 2, min: 2, max: 2 } };
    const manifest = {
      schemaVersion: 2,
      release: { version: "1.2.3", tag: "v1.2.3", commit: "a".repeat(40) },
      application: {},
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
    const downloads: string[] = [];
    const verifications: Array<{ asset: string; bundle: string }> = [];
    const context = __testing.createTransactionContext({
      paths: { stateDir },
      downloadReleaseAsset: async (url: string, destination: string) => {
        downloads.push(path.basename(url));
        let contents: string | Buffer = "offline attestation bundle\n";
        if (url.endsWith("/fased-hosted-release-v2.json")) {
          contents = `${JSON.stringify(manifest)}\n`;
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
    expect(verifications).toEqual([
      {
        asset: "fased-hosted-release-v2.json",
        bundle: "fased-hosted-release-v2.json.attestation.json",
      },
      { asset: assetName, bundle: "fased-signerd-release.attestation.json" },
    ]);
    expect(await fsp.readFile(candidatePath)).toEqual(signerBytes);
    expect(staged.release).toEqual(signerRelease("1.2.3"));
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
    ).toThrow(PRE_V2_HOSTING_MIGRATION_MESSAGE);
    expect(PRE_V2_HOSTING_MIGRATION_MESSAGE).toContain("gh attestation verify");
    expect(PRE_V2_HOSTING_MIGRATION_MESSAGE).toContain("--repair-hosting --release vX.Y.Z");
    expect(PRE_V2_HOSTING_MIGRATION_MESSAGE).not.toContain("curl -fsSL");
    expect(PRE_V2_HOSTING_MIGRATION_MESSAGE).toContain("Never run /home/app/fased/install.sh");
    expect(PRE_V2_HOSTING_MIGRATION_MESSAGE).toContain("left unchanged");
  });

  it("accepts only exact protocol-v2 transaction requests", () => {
    for (const op of [
      "updateController",
      "prepareRelease",
      "activateRelease",
      "authorizeGatewayRelease",
      "gateGatewayRelease",
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
    expect(events).toEqual(["stage:1.2.3", "stop", "daemon-reload", "start-previous"]);
    expect(await fsp.readFile(paths.signerPath, "utf8")).toBe("old-signer\n");
    expect(fs.existsSync(paths.journalPath)).toBe(false);
    expect(fs.existsSync(paths.gatewayGatePath)).toBe(true);
    expect(fs.existsSync(paths.signerGatePath)).toBe(true);
    await expect(
      __testing.gateGatewayRelease(
        request("gateGatewayRelease", TRANSACTION_ONE, "1.2.3"),
        context,
      ),
    ).resolves.toMatchObject({ phase: "rolled-back-gated" });
    await __testing.rollbackSignerRelease(
      request("rollbackRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
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

  it("preserves active and Gateway-authorized signer decisions across a cold service restart", async () => {
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
      action: "pending",
      phase: "active",
    });
    expect(fs.existsSync(paths.gatewayGatePath)).toBe(true);
    expect(fs.existsSync(paths.signerGatePath)).toBe(true);

    await __testing.authorizeGatewayRelease(
      request("authorizeGatewayRelease", TRANSACTION_ONE, "1.2.3"),
      context,
    );
    await expect(__testing.recoverInterruptedTransaction(context)).resolves.toMatchObject({
      recovered: true,
      action: "pending",
      phase: "gateway-authorized",
    });
    expect(fs.existsSync(paths.gatewayGatePath)).toBe(false);
    expect(fs.existsSync(paths.signerGatePath)).toBe(true);
  });

  it("commits the preactivated repair only after the app-account health decision", async () => {
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
