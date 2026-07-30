import { generateKeyPairSync, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  __testing,
  parseLifecycleTrustMetadata,
  parseSupervisorConfiguration,
  parseSupervisorRequest,
  stageTrustedController,
} from "./fased-lifecycle-supervisor.mjs";
import {
  OFFICIAL_GITHUB_RELEASE_AUTHORITY,
  ed25519PublicKeyRecord,
  lifecycleTrustKeyId,
  signTrustEnvelope,
  trustMetadataDigest,
} from "./lifecycle-trust-policy.mjs";

const version = "1.2.3";
const issuedAt = "2026-07-28T00:00:00.000Z";
const expiresAt = "2027-07-28T00:00:00.000Z";
const now = Date.parse("2026-07-30T00:00:00.000Z");
const digest = (character: string) => character.repeat(64);

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    role: "fased-lifecycle-targets",
    rootPolicy: __testing.INITIAL_LIFECYCLE_ROOT_ENVELOPE,
    release: { version, tag: `v${version}`, commit: "a".repeat(40) },
    validity: { issuedAt, expiresAt },
    policy: {
      channels: ["beta", "stable"],
      platforms: ["linux-arm64", "linux-x64"],
      supervisorProtocol: 1,
      controllerProtocol: 2,
    },
    targets: {
      bootstrap: { asset: "install.sh", sha256: digest("d") },
      supervisor: { asset: "fased-lifecycle-supervisor.mjs", sha256: digest("a") },
      controllerServer: { asset: "fased-host-updater.mjs", sha256: digest("b") },
      controllerClient: { asset: "fased-host-updaterctl.mjs", sha256: digest("c") },
      evidenceVerifier: {
        asset: "fased-privileged-release-evidence.mjs",
        sha256: digest("e"),
      },
    },
    evidence: {
      provenance: {
        asset: "fased-privileged-provenance-v1.intoto.json",
        sha256: digest("f"),
      },
      sbom: { asset: "fased-privileged-sbom-v1.spdx.json", sha256: digest("1") },
      vex: { asset: "fased-privileged-vex-v1.openvex.json", sha256: digest("2") },
    },
    ...overrides,
  };
}

function request(op = "updateController") {
  return parseSupervisorRequest({
    schemaVersion: 2,
    op,
    transactionId: randomUUID(),
    version,
  });
}

function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-supervisor-"));
  return {
    root,
    paths: {
      publicSocketPath: path.join(root, "run", "request.sock"),
      privateSocketPath: path.join(root, "run", "controller.sock"),
      stateDir: path.join(root, "state"),
      supervisorStateDir: path.join(root, "state", "supervisor"),
      releasesDir: path.join(root, "controller", "releases"),
      currentLink: path.join(root, "controller", "current"),
      controllerVersionPath: path.join(root, "state", "controller-version.json"),
      rollbackFloorPath: path.join(root, "state", "rollback-floor"),
      trustedRootPath: path.join(root, "state", "supervisor", "trusted-root.json"),
      trustStatePath: path.join(root, "state", "supervisor", "trust-state.json"),
      supervisorTransactionPath: path.join(
        root,
        "state",
        "supervisor",
        "controller-transaction.json",
      ),
      channelPath: path.join(root, "channel"),
      supervisorPath: path.join(root, "supervisor.mjs"),
      controllerUnit: "fixed-controller.service",
      supervisorUnit: "fixed-supervisor.service",
    },
  };
}

function fixtureKey() {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = ed25519PublicKeyRecord(pair.publicKey);
  return {
    keyId: lifecycleTrustKeyId(publicKey),
    privateKey: pair.privateKey,
    publicKey,
  };
}

type FixtureKey = ReturnType<typeof fixtureKey>;

function rootEnvelope({
  rootVersion,
  roots,
  oldRoots = [],
}: {
  rootVersion: number;
  roots: FixtureKey[];
  oldRoots?: FixtureKey[];
}) {
  const signed = {
    schemaVersion: 1,
    type: "fased-lifecycle-root",
    version: rootVersion,
    issuedAt,
    expiresAt: "2030-07-28T00:00:00.000Z",
    keys: Object.fromEntries(
      roots
        .map((root) => [root.keyId, root.publicKey] as const)
        .toSorted(([left], [right]) => left.localeCompare(right)),
    ),
    root: {
      keyIds: roots.map(({ keyId }) => keyId).toSorted(),
      threshold: 2,
    },
    releaseAuthority: OFFICIAL_GITHUB_RELEASE_AUTHORITY,
    revocations: { releaseVersions: [], targetDigests: [] },
  };
  const signingKeys = [...oldRoots.slice(0, 2), ...roots.slice(0, 2)].filter(
    (key, index, all) => all.findIndex(({ keyId }) => keyId === key.keyId) === index,
  );
  return signTrustEnvelope(signed, signingKeys);
}

function embeddedTrust() {
  const state = __testing.initialLifecycleTrustState();
  return {
    persisted: false,
    envelope: __testing.INITIAL_LIFECYCLE_ROOT_ENVELOPE,
    root: __testing.EMBEDDED_LIFECYCLE_ROOT,
    state,
  };
}

describe("stable lifecycle supervisor contract", () => {
  it("restores execute permission on private directories under the service umask", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-supervisor-private-"));
    const directory = path.join(root, "transaction");
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    try {
      const created = await __testing.privateMkdtemp(`${directory}-`, uid, gid, {
        ...fsp,
        mkdtemp: async () => {
          await fsp.mkdir(directory, { mode: 0o600 });
          return directory;
        },
      });
      expect(created).toBe(directory);
      expect(await fsp.stat(directory)).toMatchObject({ uid, gid });
      expect((await fsp.stat(directory)).mode & 0o777).toBe(0o700);
      await expect(fsp.writeFile(path.join(directory, "metadata.json"), "{}\n")).resolves.toBe(
        undefined,
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("tightens the public socket before transferring ownership", async () => {
    const operations: Array<["chmod" | "chown", string, number, number?]> = [];
    const socketPath = "/run/fased-local-controller/0123456789abcdef/request.sock";
    await __testing.authorizePublicSocket(socketPath, 1000, 2000, {
      chmod: async (target: string, mode: number) => {
        operations.push(["chmod", target, mode]);
      },
      chown: async (target: string, uid: number, gid: number) => {
        operations.push(["chown", target, uid, gid]);
      },
    });
    expect(operations).toEqual([
      ["chmod", socketPath, 0o600],
      ["chown", socketPath, 1000, 2000],
    ]);
  });

  it("accepts only fixed profile selectors and a typed operation allowlist", () => {
    expect(
      parseSupervisorConfiguration([
        "--profile",
        "protected-local",
        "--protected-local-instance",
        "0123456789abcdef",
        "--operator-uid",
        "1000",
        "--operator-gid",
        "1000",
      ]),
    ).toMatchObject({
      profile: "protected-local",
      instanceId: "0123456789abcdef",
      operatorUid: 1000,
      operatorGid: 1000,
    });
    expect(request("applyRelease").op).toBe("applyRelease");
    for (const injected of [
      { command: "/bin/sh" },
      { path: "/tmp/controller" },
      { url: "https://attacker.invalid" },
      { env: { LD_PRELOAD: "/tmp/x" } },
      { unit: "attacker.service" },
      { owner: "root:root" },
    ]) {
      expect(() =>
        parseSupervisorRequest({
          schemaVersion: 2,
          op: "updateController",
          transactionId: randomUUID(),
          version,
          ...injected,
        }),
      ).toThrow("unsupported or missing fields");
    }
    expect(() =>
      parseSupervisorConfiguration([
        "--profile",
        "hosting",
        "--operator-uid",
        "1000",
        "--operator-gid",
        "1000",
        "--controller-path",
        "/tmp/controller",
      ]),
    ).toThrow("unsupported lifecycle supervisor argument");
  });

  it("records one durable target-controller receipt and replays it without a second mutation", async () => {
    const { paths } = tempPaths();
    await fsp.mkdir(paths.supervisorStateDir, { recursive: true });
    const transaction = request("applyRelease");
    const release = {
      version,
      commit: "a".repeat(40),
      buildInputDigest: `sha256:${"b".repeat(64)}`,
      development: false,
    };
    const forward = vi.fn(async () => ({
      ok: true,
      transactionId: transaction.transactionId,
      version,
      phase: "committed",
      changed: true,
      release,
    }));
    const context = __testing.createContext(
      {
        profile: "hosting",
        operatorUid: 1000,
        operatorGid: 1000,
        paths,
      },
      { requestController: forward },
    );
    const state = { controllerInstanceId: randomUUID() };

    await expect(
      __testing.handleSupervisorRequest(transaction, context, state),
    ).resolves.toMatchObject({ ok: true, phase: "committed", release });
    await expect(
      __testing.handleSupervisorRequest(transaction, context, state),
    ).resolves.toMatchObject({
      ok: true,
      phase: "committed",
      changed: false,
      replayed: true,
      release,
    });
    expect(forward).toHaveBeenCalledOnce();
    expect(await fsp.readFile(paths.rollbackFloorPath, "utf8")).toBe(`${version}\n`);
  });

  it("keeps the replaceable controller outside supervisor code, state, and unit files", () => {
    const { paths } = tempPaths();
    const operator = fs
      .readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .map((line) => line.split(":"))
      .find(
        (fields) =>
          Number(fields[2]) > 0 &&
          /^[A-Za-z_][A-Za-z0-9_.-]{0,30}$/u.test(fields[0] ?? "") &&
          path.isAbsolute(fields[5] ?? ""),
      );
    expect(operator).toBeDefined();
    const units = __testing.renderBoundaryUnits(
      {
        profile: "hosting",
        instanceId: null,
        operatorUid: Number(operator?.[2]),
        operatorGid: Number(operator?.[3]),
        paths,
      },
      "/usr/bin/node",
    );
    expect(units.controller.content).toContain(
      "ReadOnlyPaths=/opt/fased/host-controller/supervisor /var/lib/fased-host-updater/supervisor /etc/systemd/system/fixed-supervisor.service",
    );
    expect(units.supervisor.content).toContain(
      "CapabilityBoundingSet=CAP_CHOWN\nAmbientCapabilities=",
    );
  });

  it("requires unexpired, architecture-bound, channel-bound immutable metadata", () => {
    expect(
      parseLifecycleTrustMetadata(metadata(), {
        expectedVersion: version,
        channel: "stable",
        platform: "linux-x64",
        now,
      }),
    ).toMatchObject({ role: "fased-lifecycle-targets" });
    expect(() =>
      parseLifecycleTrustMetadata(metadata(), {
        expectedVersion: version,
        channel: "stable",
        platform: "linux-x64",
        now: Date.parse("2028-01-01T00:00:00.000Z"),
      }),
    ).toThrow("stale, incompatible, or mismatched");
    expect(() =>
      parseLifecycleTrustMetadata(metadata(), {
        expectedVersion: version,
        channel: "stable",
        platform: "linux-riscv64",
        now,
      }),
    ).toThrow("stale, incompatible, or mismatched");
    expect(() =>
      parseLifecycleTrustMetadata(
        metadata({
          policy: {
            channels: ["beta"],
            platforms: ["linux-x64"],
            supervisorProtocol: 1,
            controllerProtocol: 2,
          },
        }),
        {
          expectedVersion: version,
          channel: "stable",
          platform: "linux-x64",
          now,
        },
      ),
    ).toThrow("stale, incompatible, or mismatched");
    expect(() =>
      parseLifecycleTrustMetadata(
        metadata({
          validity: {
            issuedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2027-12-31T00:00:00.000Z",
          },
        }),
        {
          expectedVersion: version,
          channel: "stable",
          platform: "linux-x64",
          now,
        },
      ),
    ).toThrow("stale, incompatible, or mismatched");
  });

  it("promotes only metadata-bound controller bytes and records an immutable generation", async () => {
    const { root, paths } = tempPaths();
    await fsp.mkdir(path.dirname(paths.channelPath), { recursive: true });
    await fsp.writeFile(paths.channelPath, "beta\n");
    await fsp.writeFile(paths.supervisorPath, "stable-supervisor\n");
    const supervisorSha = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update("stable-supervisor\n").digest("hex"),
    );
    const server = "verified-server\n";
    const client = "verified-client\n";
    const createHash = (await import("node:crypto")).createHash;
    const serverSha = createHash("sha256").update(server).digest("hex");
    const clientSha = createHash("sha256").update(client).digest("hex");
    const verifier = "verified-evidence-verifier\n";
    const verifierSha = createHash("sha256").update(verifier).digest("hex");
    const trust = metadata({
      targets: {
        bootstrap: { asset: "install.sh", sha256: digest("d") },
        supervisor: { asset: "fased-lifecycle-supervisor.mjs", sha256: supervisorSha },
        controllerServer: { asset: "fased-host-updater.mjs", sha256: serverSha },
        controllerClient: { asset: "fased-host-updaterctl.mjs", sha256: clientSha },
        evidenceVerifier: {
          asset: "fased-privileged-release-evidence.mjs",
          sha256: verifierSha,
        },
      },
    });
    const downloads = new Map([
      ["fased-lifecycle-trust-v1.json", `${JSON.stringify(trust)}\n`],
      ["fased-lifecycle-trust-v1.json.attestation.json", "{}\n"],
      ["fased-host-updater.mjs", server],
      ["fased-host-updaterctl.mjs", client],
      ["fased-privileged-release-evidence.mjs", verifier],
      ["fased-hosted-release-v2.json", "{}\n"],
      ["fased-privileged-provenance-v1.intoto.json", "{}\n"],
      ["fased-privileged-provenance-v1.intoto.json.attestation.json", "{}\n"],
      ["fased-privileged-sbom-v1.spdx.json", "{}\n"],
      ["fased-privileged-vex-v1.openvex.json", "{}\n"],
    ]);
    const configuration = {
      profile: "hosting",
      operatorUid: process.getuid?.() ?? 1000,
      operatorGid: process.getgid?.() ?? 1000,
      paths,
    };
    const verifyMetadata = vi.fn(async (artifactPath: string) => {
      await fsp.chmod(artifactPath, 0o000);
    });
    const context = __testing.createContext(configuration, {
      rootUid: process.getuid?.() ?? 0,
      rootGid: process.getgid?.() ?? 0,
      platform: "linux-x64",
      now: () => now,
      verifyMetadata,
      verifyReleaseEvidence: async () => undefined,
      selfCheckController: async () => undefined,
      download: async (url: string, destination: string) => {
        const name = url.slice(url.lastIndexOf("/") + 1);
        const body = downloads.get(name);
        if (body === undefined) {
          throw new Error(`unexpected asset ${name}`);
        }
        await fsp.writeFile(destination, body);
        await fsp.chmod(destination, 0o000);
      },
    });
    const staged = await stageTrustedController(request(), context);
    expect(staged.changed).toBe(true);
    expect(staged.trustChanged).toBe(true);
    await expect(fsp.lstat(paths.currentLink)).rejects.toMatchObject({ code: "ENOENT" });
    await __testing.activateStagedController(paths, staged);
    await __testing.commitLifecycleTrust(paths, staged);
    expect(await fsp.realpath(paths.currentLink)).toBe(path.join(paths.releasesDir, `v${version}`));
    expect(JSON.parse(await fsp.readFile(paths.controllerVersionPath, "utf8"))).toMatchObject({
      version,
      serverSha256: serverSha,
      clientSha256: clientSha,
    });
    expect(verifyMetadata).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await fsp.readFile(paths.trustStatePath, "utf8"))).toMatchObject({
      rootVersion: 1,
      targetsVersion: version,
      targetsCommit: "a".repeat(40),
    });
    await expect(
      fsp.lstat(path.join(root, "controller", "releases", `v${version}`)),
    ).resolves.toMatchObject({ uid: process.getuid?.() ?? 0 });
  });

  it("restores the prior controller selection when worker restart fails", async () => {
    const { paths } = tempPaths();
    await fsp.mkdir(paths.supervisorStateDir, { recursive: true });
    const restore = vi.fn(async () => undefined);
    const restoreTrust = vi.fn(async () => undefined);
    const begin = vi.fn(async () => undefined);
    const activate = vi.fn(async () => undefined);
    const clear = vi.fn(async () => undefined);
    const restart = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("worker failed"))
      .mockResolvedValueOnce(undefined);
    const context = __testing.createContext(
      {
        profile: "hosting",
        operatorUid: 1000,
        operatorGid: 1000,
        paths,
      },
      {
        stageTrustedController: async () => ({
          changed: true,
          identity: {
            schemaVersion: 1,
            version,
            serverSha256: digest("a"),
            clientSha256: digest("b"),
          },
          generationRoot: "/fixed/next",
          previousGeneration: "/fixed/previous",
          previousIdentity: {
            schemaVersion: 1,
            version: "1.2.2",
            serverSha256: digest("c"),
            clientSha256: digest("d"),
          },
          trusted: embeddedTrust(),
          candidateRoot: __testing.EMBEDDED_LIFECYCLE_ROOT,
          trustState: __testing.initialLifecycleTrustState(),
          trustChanged: false,
        }),
        beginSupervisorTransaction: begin,
        activateStagedController: activate,
        restoreControllerSelection: restore,
        restoreLifecycleTrust: restoreTrust,
        clearSupervisorTransaction: clear,
        restartController: restart,
        waitForController: async () => undefined,
      },
    );
    await expect(
      __testing.handleSupervisorRequest(request(), context, {
        controllerInstanceId: randomUUID(),
      }),
    ).rejects.toThrow("promotion failed and was restored");
    expect(begin).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
    expect(restoreTrust).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("commits controller selection and trust state in one ordered transaction", async () => {
    const { paths } = tempPaths();
    await fsp.mkdir(paths.supervisorStateDir, { recursive: true });
    const calls: string[] = [];
    const trusted = embeddedTrust();
    const context = __testing.createContext(
      {
        profile: "hosting",
        operatorUid: 1000,
        operatorGid: 1000,
        paths,
      },
      {
        stageTrustedController: async () => ({
          changed: true,
          identity: {
            schemaVersion: 1,
            version,
            serverSha256: digest("a"),
            clientSha256: digest("b"),
          },
          generationRoot: "/fixed/next",
          previousGeneration: "/fixed/previous",
          previousIdentity: {
            schemaVersion: 1,
            version: "1.2.2",
            serverSha256: digest("c"),
            clientSha256: digest("d"),
          },
          trusted,
          candidateRoot: trusted.root,
          trustState: __testing.advanceLifecycleTrustState(trusted, trusted.root, metadata()),
          trustChanged: true,
        }),
        beginSupervisorTransaction: async () => {
          calls.push("journal");
        },
        activateStagedController: async () => {
          calls.push("activate");
        },
        restartController: async () => {
          calls.push("restart");
        },
        waitForController: async () => {
          calls.push("wait");
        },
        probeControllerIdentity: async () => {
          calls.push("probe");
          return randomUUID();
        },
        commitLifecycleTrust: async () => {
          calls.push("trust");
        },
        clearSupervisorTransaction: async () => {
          calls.push("clear");
        },
      },
    );

    await expect(
      __testing.handleSupervisorRequest(request(), context, {
        controllerInstanceId: randomUUID(),
      }),
    ).resolves.toMatchObject({ ok: true, controllerChanged: true });
    expect(calls).toEqual(["journal", "activate", "restart", "wait", "probe", "trust", "clear"]);
  });

  it("removes an unactivated first controller selection when no prior generation exists", async () => {
    const { paths } = tempPaths();
    const selected = path.join(paths.releasesDir, `v${version}`);
    await fsp.mkdir(selected, { recursive: true });
    await fsp.symlink(selected, paths.currentLink, "dir");
    await fsp.mkdir(path.dirname(paths.controllerVersionPath), { recursive: true });
    await fsp.writeFile(paths.controllerVersionPath, `${JSON.stringify({ version })}\n`);

    await __testing.restoreControllerSelection(paths, {
      previousGeneration: null,
      previousIdentity: null,
    });

    await expect(fsp.lstat(paths.currentLink)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.lstat(paths.controllerVersionPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restarts an already-selected generation when the running worker identity is stale", async () => {
    const { paths } = tempPaths();
    await fsp.mkdir(paths.supervisorStateDir, { recursive: true });
    const activeInstance = randomUUID();
    const restart = vi.fn(async () => undefined);
    const probe = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("stale worker"))
      .mockResolvedValueOnce(activeInstance);
    const context = __testing.createContext(
      {
        profile: "hosting",
        operatorUid: 1000,
        operatorGid: 1000,
        paths,
      },
      {
        stageTrustedController: async () => ({
          changed: false,
          identity: {
            schemaVersion: 1,
            version,
            serverSha256: digest("a"),
            clientSha256: digest("b"),
          },
        }),
        probeControllerIdentity: probe,
        restartController: restart,
        waitForController: async () => undefined,
      },
    );
    const result = await __testing.handleSupervisorRequest(request(), context, {
      controllerInstanceId: randomUUID(),
    });

    expect(result).toMatchObject({
      ok: true,
      version,
      controllerChanged: true,
    });
    expect(restart).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("requires old and new 2-of-3 thresholds for an exact next root", () => {
    const currentRoots = [fixtureKey(), fixtureKey(), fixtureKey()];
    const nextRoots = [fixtureKey(), fixtureKey(), fixtureKey()];
    const current = rootEnvelope({ rootVersion: 1, roots: currentRoots });
    const next = rootEnvelope({
      rootVersion: 2,
      roots: nextRoots,
      oldRoots: currentRoots,
    });
    const previousState = {
      schemaVersion: 1,
      rootVersion: 1,
      rootSha256: trustMetadataDigest(current),
      targetsVersion: null,
      targetsCommit: null,
      targetsSha256: null,
    };

    expect(
      __testing.verifyLifecycleRootTransition(current, next, {
        previousState,
        now,
      }),
    ).toMatchObject({ version: 2, digest: trustMetadataDigest(next) });

    const missingOldThreshold = rootEnvelope({ rootVersion: 2, roots: nextRoots });
    expect(() =>
      __testing.verifyLifecycleRootTransition(current, missingOldThreshold, {
        previousState,
        now,
      }),
    ).toThrow("signature threshold");

    const skipped = rootEnvelope({
      rootVersion: 3,
      roots: nextRoots,
      oldRoots: currentRoots,
    });
    expect(() =>
      __testing.verifyLifecycleRootTransition(current, skipped, {
        previousState,
        now,
      }),
    ).toThrow("advance exactly one version");
  });

  it("rejects target rollback and same-version equivocation", () => {
    const trusted = embeddedTrust();
    const acceptedMetadata = metadata();
    const acceptedState = __testing.advanceLifecycleTrustState(
      trusted,
      trusted.root,
      acceptedMetadata,
    );
    const persisted = { ...trusted, persisted: true, state: acceptedState };

    expect(__testing.advanceLifecycleTrustState(persisted, trusted.root, acceptedMetadata)).toEqual(
      acceptedState,
    );
    expect(() =>
      __testing.advanceLifecycleTrustState(
        persisted,
        trusted.root,
        metadata({
          release: {
            version: "1.2.2",
            tag: "v1.2.2",
            commit: "a".repeat(40),
          },
        }),
      ),
    ).toThrow("below its trusted release floor");
    expect(() =>
      __testing.advanceLifecycleTrustState(
        persisted,
        trusted.root,
        metadata({
          release: {
            version,
            tag: `v${version}`,
            commit: "b".repeat(40),
          },
        }),
      ),
    ).toThrow("changed without advancing");
  });

  it("recovers controller and trust state after a crash between activation and commit", async () => {
    const { paths } = tempPaths();
    const priorVersion = "1.2.2";
    const priorGeneration = path.join(paths.releasesDir, `v${priorVersion}`);
    const nextGeneration = path.join(paths.releasesDir, `v${version}`);
    await Promise.all([
      fsp.mkdir(priorGeneration, { recursive: true }),
      fsp.mkdir(nextGeneration, { recursive: true }),
      fsp.mkdir(paths.supervisorStateDir, { recursive: true }),
    ]);
    await fsp.mkdir(path.dirname(paths.currentLink), { recursive: true });
    await fsp.symlink(priorGeneration, paths.currentLink, "dir");
    const previousIdentity = {
      schemaVersion: 1,
      version: priorVersion,
      serverSha256: digest("a"),
      clientSha256: digest("b"),
    };
    await fsp.writeFile(
      paths.controllerVersionPath,
      `${JSON.stringify(previousIdentity, null, 2)}\n`,
      { mode: 0o600 },
    );
    const trusted = embeddedTrust();
    const staged = {
      changed: true,
      identity: {
        schemaVersion: 1,
        version,
        serverSha256: digest("c"),
        clientSha256: digest("d"),
      },
      generationRoot: nextGeneration,
      previousGeneration: priorGeneration,
      previousIdentity,
      trusted,
      candidateRoot: trusted.root,
      trustState: __testing.advanceLifecycleTrustState(trusted, trusted.root, metadata()),
      trustChanged: true,
    };
    const transaction = request();
    await __testing.beginSupervisorTransaction(paths, transaction, staged);
    await __testing.activateStagedController(paths, staged);
    await __testing.commitLifecycleTrust(paths, staged);

    expect(await fsp.realpath(paths.currentLink)).toBe(nextGeneration);
    await expect(fsp.lstat(paths.supervisorTransactionPath)).resolves.toMatchObject({
      mode: expect.any(Number),
    });
    await expect(fsp.lstat(paths.trustStatePath)).resolves.toMatchObject({
      mode: expect.any(Number),
    });

    const restart = vi.fn(async () => undefined);
    const wait = vi.fn(async () => undefined);
    const context = __testing.createContext(
      {
        profile: "hosting",
        operatorUid: 1000,
        operatorGid: 1000,
        paths,
      },
      {
        rootUid: process.getuid?.() ?? 0,
        restartController: restart,
        waitForController: wait,
      },
    );
    await expect(__testing.recoverSupervisorTransaction(context)).resolves.toBe(true);

    expect(await fsp.realpath(paths.currentLink)).toBe(priorGeneration);
    expect(JSON.parse(await fsp.readFile(paths.controllerVersionPath, "utf8"))).toEqual(
      previousIdentity,
    );
    await expect(fsp.lstat(paths.trustedRootPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.lstat(paths.trustStatePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.lstat(paths.supervisorTransactionPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(restart).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
  });
});
