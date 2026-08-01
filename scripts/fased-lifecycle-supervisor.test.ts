import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
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
const sha256Text = (value: string) => createHash("sha256").update(value).digest("hex");

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
    schemaVersion: 3,
    op,
    transactionId: randomUUID(),
    nonce: randomUUID(),
    version,
    clientCapabilities: { protocolVersion: 2, requestSchema: 3 },
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
      rootTransactionPath: path.join(root, "state", "supervisor", "product-transaction.json"),
      productJournalPath: path.join(root, "state", "active-signer-transaction.json"),
      productVersionPath: path.join(root, "state", "signer-version"),
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

async function existingControllerTransitionFixture(
  paths: ReturnType<typeof tempPaths>["paths"],
  previousVersion: string,
) {
  await fsp.mkdir(path.dirname(paths.channelPath), { recursive: true });
  await fsp.mkdir(paths.releasesDir, { recursive: true });
  await fsp.writeFile(paths.channelPath, "beta\n");
  const previousSupervisor = "previous-stable-supervisor\n";
  const targetSupervisor = "target-stable-supervisor\n";
  await fsp.writeFile(paths.supervisorPath, previousSupervisor);

  const targetServer = "verified-target-server\n";
  const targetClient = "verified-target-client\n";
  const verifier = "verified-evidence-verifier\n";
  const targetServerSha = sha256Text(targetServer);
  const targetClientSha = sha256Text(targetClient);
  const trust = metadata({
    targets: {
      bootstrap: { asset: "install.sh", sha256: digest("d") },
      supervisor: {
        asset: "fased-lifecycle-supervisor.mjs",
        sha256: sha256Text(targetSupervisor),
      },
      controllerServer: { asset: "fased-host-updater.mjs", sha256: targetServerSha },
      controllerClient: { asset: "fased-host-updaterctl.mjs", sha256: targetClientSha },
      evidenceVerifier: {
        asset: "fased-privileged-release-evidence.mjs",
        sha256: sha256Text(verifier),
      },
    },
  });
  const downloads = new Map([
    ["fased-lifecycle-trust-v1.json", `${JSON.stringify(trust)}\n`],
    ["fased-lifecycle-trust-v1.json.attestation.json", "{}\n"],
    ["fased-lifecycle-supervisor.mjs", targetSupervisor],
    ["fased-host-updater.mjs", targetServer],
    ["fased-host-updaterctl.mjs", targetClient],
    ["fased-privileged-release-evidence.mjs", verifier],
    ["fased-hosted-release-v2.json", "{}\n"],
    ["fased-privileged-provenance-v1.intoto.json", "{}\n"],
    ["fased-privileged-provenance-v1.intoto.json.attestation.json", "{}\n"],
    ["fased-privileged-sbom-v1.spdx.json", "{}\n"],
    ["fased-privileged-vex-v1.openvex.json", "{}\n"],
  ]);

  const previousServer = "verified-previous-server\n";
  const previousClient = "verified-previous-client\n";
  const previousIdentity = {
    schemaVersion: 1,
    version: previousVersion,
    serverSha256: sha256Text(previousServer),
    clientSha256: sha256Text(previousClient),
  };
  const previousGeneration = path.join(paths.releasesDir, `v${previousVersion}`);
  await fsp.mkdir(previousGeneration, { recursive: true });
  await Promise.all([
    fsp.writeFile(path.join(previousGeneration, "fased-host-updater.mjs"), previousServer),
    fsp.writeFile(path.join(previousGeneration, "fased-host-updaterctl.mjs"), previousClient),
  ]);
  await fsp.symlink(previousGeneration, paths.currentLink, "dir");
  await fsp.mkdir(path.dirname(paths.controllerVersionPath), { recursive: true });
  await fsp.writeFile(
    paths.controllerVersionPath,
    `${JSON.stringify(previousIdentity, null, 2)}\n`,
  );

  const activeInstanceId = randomUUID();
  const restartController = vi.fn(async () => {
    if (restartController.mock.calls.length === 1) {
      throw new Error("injected target controller restart failure");
    }
  });
  const context = __testing.createContext(
    {
      profile: "protected-local",
      operatorUid: process.getuid?.() ?? 1000,
      operatorGid: process.getgid?.() ?? 1000,
      paths,
    },
    {
      rootUid: process.getuid?.() ?? 0,
      rootGid: process.getgid?.() ?? 0,
      platform: "linux-x64",
      now: () => now,
      verifyMetadata: async () => undefined,
      verifyReleaseEvidence: async () => undefined,
      selfCheckSupervisor: async () => undefined,
      selfCheckController: async () => undefined,
      runningSupervisorDigest: sha256Text(previousSupervisor),
      download: async (url: string, destination: string) => {
        const name = url.slice(url.lastIndexOf("/") + 1);
        const body = downloads.get(name);
        if (body === undefined) {
          throw new Error(`unexpected asset ${name}`);
        }
        await fsp.writeFile(destination, body);
      },
      restartController,
      waitForController: async () => undefined,
      verifyRecoveredProduct: async (
        transaction: { version: string },
        installedVersion: string | null,
      ) =>
        Object.freeze({
          action: installedVersion === transaction.version ? "committed" : "rolled-back",
          release: null,
          supporting: false,
        }),
      probeControllerIdentity: async (targetRequest: { version: string }) => {
        const selected = await fsp.realpath(paths.currentLink);
        const identity = JSON.parse(await fsp.readFile(paths.controllerVersionPath, "utf8"));
        if (
          selected !== path.join(paths.releasesDir, `v${targetRequest.version}`) ||
          identity.version !== targetRequest.version
        ) {
          throw new Error("running controller does not match the target selection");
        }
        return activeInstanceId;
      },
    },
  );
  return {
    context,
    previousGeneration,
    previousIdentity,
    restartController,
    targetServerSha,
    targetClientSha,
    previousSupervisor,
    targetSupervisor,
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

  it("writes durable receipts under the supervisor umask", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-supervisor-receipt-"));
    const receipt = path.join(root, "receipts", "transaction.json");
    const previousUmask = process.umask(__testing.PRIVATE_UMASK);
    try {
      await __testing.atomicWrite(receipt, '{"ok":true}\n');
      expect((await fsp.stat(path.dirname(receipt))).mode & 0o777).toBe(0o700);
      expect((await fsp.stat(receipt)).mode & 0o777).toBe(0o600);
      await expect(fsp.readFile(receipt, "utf8")).resolves.toBe('{"ok":true}\n');
    } finally {
      process.umask(previousUmask);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("removes only inactive validated historical controller candidates", async () => {
    const { root, paths } = tempPaths();
    const uid = process.getuid?.() ?? 0;
    const active = path.join(paths.releasesDir, `v${version}`);
    const candidate = path.join(paths.releasesDir, `v1.2.2.q0.${"a".repeat(12)}`);
    try {
      await Promise.all([
        fsp.mkdir(active, { recursive: true }),
        fsp.mkdir(candidate, { recursive: true }),
      ]);
      for (const generation of [active, candidate]) {
        await Promise.all([
          fsp.writeFile(path.join(generation, "fased-host-updater.mjs"), "server\n"),
          fsp.writeFile(path.join(generation, "fased-host-updaterctl.mjs"), "client\n"),
        ]);
      }
      await fsp.symlink(active, paths.currentLink, "dir");

      await expect(
        __testing.cleanupHistoricalControllerCandidates(paths, version, uid),
      ).resolves.toEqual([candidate]);
      await expect(fsp.realpath(paths.currentLink)).resolves.toBe(active);
      await expect(fsp.lstat(candidate)).rejects.toMatchObject({ code: "ENOENT" });
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
    expect(request("applyRelease")).toMatchObject({
      schemaVersion: 3,
      clientCapabilities: { protocolVersion: 2, requestSchema: 3 },
    });
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

  it("keeps root transaction identity immutable and the commit decision monotonic", () => {
    const transaction = request("applyRelease");
    const receipt = __testing.createControllerSelectionReceipt(
      transaction,
      {
        releaseCommit: "a".repeat(40),
        targetManifestSha256: digest("1"),
        trustPolicySha256: digest("0"),
        identity: { serverSha256: digest("2"), clientSha256: digest("3") },
      },
      randomUUID(),
    );
    const previous = __testing.rootProductTransactionRecord({
      request: transaction,
      phase: "gateway-verified",
      previousVersion: "1.2.2",
      targetControllerReceipt: receipt,
      selectionDigest: receipt.selectionDigest,
      durableCommitDecision: true,
      now,
    });
    const reversed = __testing.rootProductTransactionRecord({
      request: transaction,
      phase: "dispatching",
      previousVersion: "1.2.2",
      targetControllerReceipt: receipt,
      selectionDigest: receipt.selectionDigest,
      durableCommitDecision: false,
      createdAt: previous.createdAt,
      now,
    });
    expect(() => __testing.assertRootProductTransactionTransition(previous, reversed)).toThrow(
      "cannot reverse its durable commit decision",
    );
    const otherRequest = { ...transaction, transactionId: randomUUID() };
    const otherReceipt = __testing.createControllerSelectionReceipt(
      otherRequest,
      {
        releaseCommit: "a".repeat(40),
        targetManifestSha256: digest("1"),
        trustPolicySha256: digest("0"),
        identity: { serverSha256: digest("2"), clientSha256: digest("3") },
      },
      randomUUID(),
    );
    const other = __testing.rootProductTransactionRecord({
      request: otherRequest,
      phase: "gateway-verified",
      previousVersion: "1.2.2",
      targetControllerReceipt: otherReceipt,
      selectionDigest: otherReceipt.selectionDigest,
      durableCommitDecision: true,
      now,
    });
    expect(() => __testing.assertRootProductTransactionTransition(previous, other)).toThrow(
      "identity cannot change",
    );
    expect(() =>
      __testing.assertRootProductTransactionTransition(
        previous,
        __testing.advanceRootProductTransaction(previous, {
          phase: "rolling-back",
          now: now + 1,
        }),
      ),
    ).toThrow("cannot roll back after its durable commit decision");
    expect(() =>
      __testing.assertRootProductTransactionTransition(
        __testing.rootProductTransactionRecord({
          request: transaction,
          phase: "restored",
          previousVersion: "1.2.2",
          targetControllerReceipt: receipt,
          selectionDigest: receipt.selectionDigest,
          createdAt: previous.createdAt,
          now,
        }),
        __testing.rootProductTransactionRecord({
          request: transaction,
          phase: "dispatching",
          previousVersion: "1.2.2",
          targetControllerReceipt: receipt,
          selectionDigest: receipt.selectionDigest,
          createdAt: previous.createdAt,
          now: now + 1,
        }),
      ),
    ).toThrow("cannot advance from restored to dispatching");
  });

  it("accepts only the exact legacy and stable supervisor capability pairs", () => {
    const transaction = request("applyRelease");
    const record = __testing.rootProductTransactionRecord({
      request: transaction,
      phase: "selected",
      now,
    });
    expect(() =>
      __testing.parseRootProductTransaction({
        ...record,
        clientCapabilities: { protocolVersion: 1, requestSchema: 3 },
      }),
    ).toThrow("malformed");
    expect(() =>
      __testing.parseRootProductTransaction({
        ...record,
        clientCapabilities: { protocolVersion: 2, requestSchema: 2 },
      }),
    ).toThrow("malformed");
  });

  it("upgrades a legacy root-ledger record without changing transaction authority", () => {
    const transaction = parseSupervisorRequest({
      schemaVersion: 2,
      op: "applyRelease",
      transactionId: randomUUID(),
      version,
    });
    const current = __testing.rootProductTransactionRecord({
      request: transaction,
      phase: "prepared",
      previousVersion: "1.2.2",
      now,
    });
    const legacy = { ...current, schemaVersion: 1 } as Record<string, unknown>;
    delete legacy.protocolVersion;
    delete legacy.requestNonce;
    delete legacy.clientCapabilities;
    delete legacy.rollbackPointers;

    const parsed = __testing.parseRootProductTransaction(legacy);
    const advanced = __testing.advanceRootProductTransaction(parsed, {
      phase: "state-reconciling",
      now: now + 1,
    });

    expect(parsed).toMatchObject({
      schemaVersion: 1,
      requestNonce: transaction.transactionId,
      rollbackPointers: {
        controllerGenerationVersion: null,
        productVersion: "1.2.2",
      },
    });
    expect(advanced).toMatchObject({
      schemaVersion: 2,
      protocolVersion: 2,
      transactionId: transaction.transactionId,
      previousVersion: "1.2.2",
      phase: "state-reconciling",
    });
    expect(() => __testing.assertRootProductTransactionTransition(parsed, advanced)).not.toThrow();
  });

  it("binds controller selection to a nonce, validity window, and trust policy", () => {
    const transaction = request("updateController");
    const selectedAt = Date.parse("2026-07-28T00:00:00.000Z");
    const receipt = __testing.createControllerSelectionReceipt(
      transaction,
      {
        releaseCommit: "a".repeat(40),
        targetManifestSha256: digest("1"),
        trustPolicySha256: digest("0"),
        identity: { serverSha256: digest("2"), clientSha256: digest("3") },
      },
      randomUUID(),
      { now: selectedAt, nonce: "33333333-3333-4333-8333-333333333333" },
    );

    expect(receipt).toMatchObject({
      schemaVersion: 2,
      nonce: "33333333-3333-4333-8333-333333333333",
      selectedAt: "2026-07-28T00:00:00.000Z",
      expiresAt: "2026-07-29T00:00:00.000Z",
      trustPolicySha256: digest("0"),
    });
    expect(() =>
      __testing.assertControllerSelectionReceiptFresh(receipt, selectedAt + 1),
    ).not.toThrow();
    expect(() =>
      __testing.assertControllerSelectionReceiptFresh(
        receipt,
        selectedAt + 24 * 60 * 60 * 1000 + 1,
      ),
    ).toThrow("outside its validity window");
    expect(() =>
      __testing.parseControllerSelectionReceipt({
        ...receipt,
        trustPolicySha256: digest("f"),
      }),
    ).toThrow("malformed or mismatched");
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
    const selectionReceipt = __testing.createControllerSelectionReceipt(
      transaction,
      {
        releaseCommit: "a".repeat(40),
        targetManifestSha256: digest("1"),
        trustPolicySha256: digest("0"),
        identity: { serverSha256: digest("2"), clientSha256: digest("3") },
      },
      randomUUID(),
    );
    const context = __testing.createContext(
      {
        profile: "hosting",
        operatorUid: 1000,
        operatorGid: 1000,
        paths,
      },
      {
        requestController: forward,
        readControllerSelectionReceipt: async () => selectionReceipt,
      },
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

  it("replays rollback after restart recovery without using the stale process receipt", async () => {
    const { paths } = tempPaths();
    const rollback = request("rollbackRelease");
    const receiptsDir = path.join(paths.supervisorStateDir, "receipts");
    await fsp.mkdir(receiptsDir, { recursive: true });
    await fsp.writeFile(
      path.join(receiptsDir, `${rollback.transactionId}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        transactionId: rollback.transactionId,
        operation: "recoverRelease",
        version: rollback.version,
        outcome: "rolled-back",
        controllerChanged: false,
        phase: "rolled-back",
        release: null,
        recordedAt: new Date(now).toISOString(),
      })}\n`,
    );
    const readSelection = vi.fn(async () => {
      throw new Error("stale process-bound receipt must not be dispatched");
    });
    const forward = vi.fn(async () => {
      throw new Error("recovered rollback must not reach the target controller");
    });
    const context = __testing.createContext(
      {
        profile: "hosting",
        operatorUid: 1000,
        operatorGid: 1000,
        paths,
      },
      {
        readControllerSelectionReceipt: readSelection,
        requestController: forward,
      },
    );

    await expect(
      __testing.handleSupervisorRequest(rollback, context, {
        controllerInstanceId: randomUUID(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      phase: "rolled-back",
      changed: false,
      replayed: true,
    });
    expect(readSelection).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("continues one matching prepared transaction without invoking crash recovery", async () => {
    const { paths } = tempPaths();
    const transaction = request("activateRelease");
    const selectionReceipt = __testing.createControllerSelectionReceipt(
      transaction,
      {
        releaseCommit: "a".repeat(40),
        targetManifestSha256: digest("1"),
        trustPolicySha256: digest("0"),
        identity: { serverSha256: digest("2"), clientSha256: digest("3") },
      },
      randomUUID(),
    );
    type RootTransaction = Record<string, unknown>;
    let rootTransaction: RootTransaction = __testing.rootProductTransactionRecord({
      request: transaction,
      phase: "prepared",
      previousVersion: null,
      targetControllerReceipt: selectionReceipt,
      selectionDigest: selectionReceipt.selectionDigest,
      now,
    }) as unknown as RootTransaction;
    const productJournal = {
      transactionId: transaction.transactionId,
      version: transaction.version,
      phase: "prepared",
      previousVersion: null,
      selectionDigest: selectionReceipt.selectionDigest,
      targetControllerReceipt: selectionReceipt,
      targetReleaseIdentity: null,
      artifactDigests: {
        application: null,
        dependencies: null,
        signer: null,
        updaterBundle: null,
      },
      journalSha256: digest("4"),
    };
    const recover = vi.fn(async () => ({ recovered: true }));
    const reselect = parseSupervisorRequest({
      schemaVersion: 3,
      op: "updateController",
      transactionId: transaction.transactionId,
      nonce: randomUUID(),
      version: transaction.version,
      clientCapabilities: transaction.clientCapabilities,
    });
    const select = vi.fn(async () => ({
      changed: false,
      supervisorChanged: false,
      trustChanged: false,
      releaseCommit: selectionReceipt.releaseCommit,
      targetManifestSha256: selectionReceipt.targetManifestSha256,
      trustPolicySha256: selectionReceipt.trustPolicySha256,
      identity: {
        schemaVersion: 1,
        version: transaction.version,
        serverSha256: selectionReceipt.controllerServerSha256,
        clientSha256: selectionReceipt.controllerClientSha256,
      },
    }));
    const forward = vi.fn(async () => ({
      ok: true,
      transactionId: transaction.transactionId,
      version: transaction.version,
      phase: "active",
      changed: true,
    }));
    const probe = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("transient private socket probe"))
      .mockResolvedValue(selectionReceipt.controllerInstanceId);
    const restart = vi.fn(async () => undefined);
    const context = __testing.createContext(
      {
        profile: "hosting",
        operatorUid: 1000,
        operatorGid: 1000,
        paths,
      },
      {
        readRootProductTransaction: async () => rootTransaction,
        writeRootProductTransaction: async (_paths: unknown, value: RootTransaction) => {
          rootTransaction = value;
          return value;
        },
        readControllerProductJournal: async () => productJournal,
        recoverRootProductTransaction: recover,
        stageTrustedController: select,
        probeControllerIdentity: probe,
        restartController: restart,
        cleanupHistoricalControllerCandidates: async () => [],
        writeControllerSelectionReceipt: async () => selectionReceipt,
        readControllerSelectionReceipt: async () => selectionReceipt,
        requestController: forward,
      },
    );

    await expect(
      __testing.handleSupervisorRequest(reselect, context, {
        controllerInstanceId: selectionReceipt.controllerInstanceId,
      }),
    ).rejects.toThrow("controller verification failed: transient private socket probe");
    expect(recover).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    expect(rootTransaction).toMatchObject({
      transactionId: transaction.transactionId,
      version: transaction.version,
      phase: "prepared",
    });
    await expect(
      __testing.handleSupervisorRequest(reselect, context, {
        controllerInstanceId: selectionReceipt.controllerInstanceId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      controllerChanged: false,
      selectionDigest: selectionReceipt.selectionDigest,
    });
    await expect(
      __testing.handleSupervisorRequest(transaction, context, {
        controllerInstanceId: randomUUID(),
      }),
    ).resolves.toMatchObject({ ok: true, phase: "active" });
    expect(recover).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(2);
    expect(forward).toHaveBeenCalledOnce();
    expect(rootTransaction).toMatchObject({
      transactionId: transaction.transactionId,
      version: transaction.version,
      phase: "active",
    });
  });

  it("recovers interrupted target A before selecting requested target B", async () => {
    const { paths } = tempPaths();
    await fsp.mkdir(paths.supervisorStateDir, { recursive: true });
    const targetARequest = parseSupervisorRequest({
      schemaVersion: 2,
      op: "updateController",
      transactionId: randomUUID(),
      version: "1.2.2",
    });
    const targetBRequest = parseSupervisorRequest({
      schemaVersion: 2,
      op: "updateController",
      transactionId: randomUUID(),
      version,
    });
    const receiptA = __testing.createControllerSelectionReceipt(
      targetARequest,
      {
        releaseCommit: "a".repeat(40),
        targetManifestSha256: digest("1"),
        trustPolicySha256: digest("0"),
        identity: { serverSha256: digest("2"), clientSha256: digest("3") },
      },
      randomUUID(),
    );
    const receiptB = __testing.createControllerSelectionReceipt(
      targetBRequest,
      {
        releaseCommit: "b".repeat(40),
        targetManifestSha256: digest("4"),
        trustPolicySha256: digest("0"),
        identity: { serverSha256: digest("5"), clientSha256: digest("6") },
      },
      randomUUID(),
    );
    type RootTransaction = Record<string, unknown>;
    let rootTransaction: RootTransaction | null = __testing.rootProductTransactionRecord({
      request: targetARequest,
      phase: "prepared",
      previousVersion: "1.2.1",
      targetControllerReceipt: receiptA,
      selectionDigest: receiptA.selectionDigest,
      now,
    }) as unknown as RootTransaction;
    let productJournal: Record<string, unknown> | null = {
      transactionId: targetARequest.transactionId,
      version: targetARequest.version,
      phase: "prepared",
      previousVersion: "1.2.1",
      selectionDigest: receiptA.selectionDigest,
      targetControllerReceipt: receiptA,
      targetReleaseIdentity: {
        version: targetARequest.version,
        commit: "a".repeat(40),
        buildInputDigest: `sha256:${digest("7")}`,
        development: false,
      },
      artifactDigests: {
        application: digest("8"),
        dependencies: digest("9"),
        signer: digest("a"),
        updaterBundle: digest("b"),
      },
      journalSha256: digest("c"),
    };
    const calls: string[] = [];
    const context = __testing.createContext(
      {
        profile: "protected-local",
        operatorUid: process.getuid?.() ?? 1000,
        operatorGid: process.getgid?.() ?? 1000,
        paths,
      },
      {
        rootUid: process.getuid?.() ?? 0,
        rootGid: process.getgid?.() ?? 0,
        readRootProductTransaction: async () => rootTransaction,
        writeRootProductTransaction: async (_paths: unknown, value: RootTransaction) => {
          rootTransaction = value;
          return value;
        },
        clearRootProductTransaction: async () => {
          calls.push("clear-A");
          rootTransaction = null;
        },
        readControllerProductJournal: async () => productJournal,
        readProductVersion: async () => "1.2.1",
        restartController: async () => {
          calls.push("recover-A");
          productJournal = null;
        },
        waitForController: async () => undefined,
        verifyRecoveredProduct: async () => {
          calls.push("health-A");
          return { action: "rolled-back", release: null, supporting: false };
        },
        stageTrustedController: async () => {
          calls.push("stage-B");
          return {
            changed: false,
            supervisorChanged: false,
            trustChanged: false,
            releaseCommit: "b".repeat(40),
            targetManifestSha256: digest("4"),
            identity: {
              schemaVersion: 1,
              version,
              serverSha256: digest("5"),
              clientSha256: digest("6"),
            },
            previousIdentity: {
              schemaVersion: 1,
              version: "1.2.2",
              serverSha256: digest("2"),
              clientSha256: digest("3"),
            },
          };
        },
        probeControllerIdentity: async () => receiptB.controllerInstanceId,
        cleanupHistoricalControllerCandidates: async () => [],
        writeControllerSelectionReceipt: async () => receiptB,
      },
    );

    await expect(
      __testing.handleSupervisorRequest(targetBRequest, context, {
        controllerInstanceId: randomUUID(),
      }),
    ).resolves.toMatchObject({ ok: true, version, controllerChanged: false });
    expect(calls).toEqual(["recover-A", "health-A", "clear-A", "stage-B"]);
    expect(rootTransaction).toMatchObject({
      transactionId: targetBRequest.transactionId,
      version,
      phase: "selected",
      previousControllerGenerationVersion: "1.2.2",
      selectionDigest: receiptB.selectionDigest,
    });
  });

  it("clears a controller-only selection after restart without product recovery", async () => {
    const { paths } = tempPaths();
    await fsp.mkdir(paths.supervisorStateDir, { recursive: true });
    const selected = request("updateController");
    const receipt = __testing.createControllerSelectionReceipt(
      selected,
      {
        releaseCommit: "a".repeat(40),
        targetManifestSha256: digest("1"),
        trustPolicySha256: digest("0"),
        identity: { serverSha256: digest("2"), clientSha256: digest("3") },
      },
      randomUUID(),
    );
    let rootTransaction: Record<string, unknown> | null = __testing.rootProductTransactionRecord({
      request: selected,
      phase: "selected",
      previousVersion: "1.2.2",
      targetControllerReceipt: receipt,
      selectionDigest: receipt.selectionDigest,
      now,
    }) as unknown as Record<string, unknown>;
    const probe = vi.fn(async () => randomUUID());
    const verifyProduct = vi.fn(async () => {
      throw new Error("controller-only recovery must not run product health");
    });
    const restart = vi.fn(async () => undefined);
    const context = __testing.createContext(
      {
        profile: "hosting",
        operatorUid: 1000,
        operatorGid: 1000,
        paths,
      },
      {
        readRootProductTransaction: async () => rootTransaction,
        readControllerProductJournal: async () => null,
        readProductVersion: async () => "1.2.2",
        clearRootProductTransaction: async () => {
          rootTransaction = null;
        },
        probeControllerIdentity: probe,
        verifyRecoveredProduct: verifyProduct,
        restartController: restart,
      },
    );

    await expect(__testing.recoverRootProductTransaction(context)).resolves.toMatchObject({
      recovered: true,
      action: "rolled-back",
      transactionId: selected.transactionId,
    });
    expect(rootTransaction).toBeNull();
    expect(probe).toHaveBeenCalledOnce();
    expect(verifyProduct).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    await expect(
      fsp.readFile(
        path.join(paths.supervisorStateDir, "receipts", `${selected.transactionId}.json`),
        "utf8",
      ),
    ).resolves.toContain('"operation": "recoverRelease"');
  });

  it("finishes committed target A before selecting requested target B", async () => {
    const { paths } = tempPaths();
    await fsp.mkdir(paths.supervisorStateDir, { recursive: true });
    const targetARequest = parseSupervisorRequest({
      schemaVersion: 3,
      op: "updateController",
      transactionId: randomUUID(),
      nonce: randomUUID(),
      version: "1.2.2",
      clientCapabilities: { protocolVersion: 2, requestSchema: 3 },
    });
    const targetBRequest = request();
    const receiptA = __testing.createControllerSelectionReceipt(
      targetARequest,
      {
        releaseCommit: "a".repeat(40),
        targetManifestSha256: digest("1"),
        trustPolicySha256: digest("0"),
        identity: { serverSha256: digest("2"), clientSha256: digest("3") },
      },
      randomUUID(),
      { now },
    );
    const receiptB = __testing.createControllerSelectionReceipt(
      targetBRequest,
      {
        releaseCommit: "b".repeat(40),
        targetManifestSha256: digest("4"),
        trustPolicySha256: digest("0"),
        identity: { serverSha256: digest("5"), clientSha256: digest("6") },
      },
      randomUUID(),
      { now },
    );
    type RootTransaction = Record<string, unknown>;
    let rootTransaction: RootTransaction | null = __testing.rootProductTransactionRecord({
      request: targetARequest,
      phase: "gateway-verified",
      previousVersion: "1.2.1",
      targetControllerReceipt: receiptA,
      targetReleaseIdentity: {
        version: "1.2.2",
        commit: "a".repeat(40),
        buildInputDigest: `sha256:${digest("7")}`,
        development: false,
      },
      selectionDigest: receiptA.selectionDigest,
      durableCommitDecision: true,
      now,
    }) as unknown as RootTransaction;
    let productJournal: Record<string, unknown> | null = {
      transactionId: targetARequest.transactionId,
      version: targetARequest.version,
      phase: "gateway-verified",
      previousVersion: "1.2.1",
      selectionDigest: receiptA.selectionDigest,
      targetControllerReceipt: receiptA,
      targetReleaseIdentity: {
        version: "1.2.2",
        commit: "a".repeat(40),
        buildInputDigest: `sha256:${digest("7")}`,
        development: false,
      },
      artifactDigests: {
        application: null,
        dependencies: null,
        signer: null,
        updaterBundle: null,
      },
      journalSha256: digest("c"),
    };
    const calls: string[] = [];
    const context = __testing.createContext(
      {
        profile: "protected-local",
        operatorUid: process.getuid?.() ?? 1000,
        operatorGid: process.getgid?.() ?? 1000,
        paths,
      },
      {
        rootUid: process.getuid?.() ?? 0,
        rootGid: process.getgid?.() ?? 0,
        now: () => now,
        readRootProductTransaction: async () => rootTransaction,
        writeRootProductTransaction: async (_paths: unknown, value: RootTransaction) => {
          rootTransaction = value;
          return value;
        },
        clearRootProductTransaction: async () => {
          calls.push("clear-A");
          rootTransaction = null;
        },
        readControllerProductJournal: async () => productJournal,
        readProductVersion: async () => "1.2.2",
        restartController: async () => {
          calls.push("finish-A");
          productJournal = null;
        },
        waitForController: async () => undefined,
        verifyRecoveredProduct: async () => {
          calls.push("health-A");
          return {
            action: "committed",
            release: {
              version: "1.2.2",
              commit: "a".repeat(40),
              buildInputDigest: `sha256:${digest("7")}`,
              development: false,
            },
            supporting: false,
          };
        },
        stageTrustedController: async () => {
          calls.push("stage-B");
          return {
            changed: false,
            supervisorChanged: false,
            trustChanged: false,
            releaseCommit: "b".repeat(40),
            targetManifestSha256: digest("4"),
            trustPolicySha256: digest("0"),
            identity: {
              schemaVersion: 1,
              version,
              serverSha256: digest("5"),
              clientSha256: digest("6"),
            },
            previousIdentity: {
              schemaVersion: 1,
              version: "1.2.2",
              serverSha256: digest("2"),
              clientSha256: digest("3"),
            },
          };
        },
        probeControllerIdentity: async () => receiptB.controllerInstanceId,
        cleanupHistoricalControllerCandidates: async () => [],
        writeControllerSelectionReceipt: async () => receiptB,
      },
    );

    await expect(
      __testing.handleSupervisorRequest(targetBRequest, context, {
        controllerInstanceId: randomUUID(),
      }),
    ).resolves.toMatchObject({ ok: true, version, controllerChanged: false });
    expect(calls).toEqual(["finish-A", "health-A", "clear-A", "stage-B"]);
    expect(rootTransaction).toMatchObject({
      transactionId: targetBRequest.transactionId,
      version,
      phase: "selected",
      previousVersion: "1.2.2",
      selectionDigest: receiptB.selectionDigest,
    });
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
      "ReadOnlyPaths=/opt/fased/host-controller /var/lib/fased-host-updater/controller-version.json /var/lib/fased-host-updater/supervisor /etc/systemd/system/fixed-controller.service /etc/systemd/system/fixed-controller.service.d /etc/systemd/system/fixed-supervisor.service /etc/systemd/system/fixed-supervisor.service.d",
    );
    expect(units.controller.content).not.toMatch(
      /^ReadWritePaths=.*\/opt\/fased\/host-controller/mu,
    );
    expect(units.controller.content).toContain(
      "ReadWritePaths=/opt/fased/host-application /opt/fased/signer /var/lib/fased-host-updater /var/lib/fased-signer-update-gate /var/lib/fased-signerd /run/fased-host-controller /usr/local/libexec /etc/systemd/system",
    );
    expect(units.controller.content).toContain("AmbientCapabilities=CAP_SETUID CAP_SETGID");
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
      ["fased-lifecycle-supervisor.mjs", "stable-supervisor\n"],
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
      selfCheckSupervisor: async () => undefined,
      selfCheckController: async () => undefined,
      runningSupervisorDigest: sha256Text("stable-supervisor\n"),
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

  it("validates an existing controller against its own identity before A-to-B promotion", async () => {
    const { paths } = tempPaths();
    const fixture = await existingControllerTransitionFixture(paths, "1.2.2");
    const state = { controllerInstanceId: randomUUID() };

    await expect(
      __testing.handleSupervisorRequest(request(), fixture.context, state),
    ).rejects.toThrow(
      "controller promotion failed and was restored: injected target controller restart failure",
    );
    expect(await fsp.realpath(paths.currentLink)).toBe(fixture.previousGeneration);
    expect(JSON.parse(await fsp.readFile(paths.controllerVersionPath, "utf8"))).toEqual(
      fixture.previousIdentity,
    );
    expect(await fsp.readFile(paths.supervisorPath, "utf8")).toBe(fixture.previousSupervisor);
    await expect(fsp.lstat(paths.supervisorTransactionPath)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(
      __testing.handleSupervisorRequest(request(), fixture.context, state),
    ).resolves.toMatchObject({
      ok: true,
      version,
      controllerChanged: true,
      supervisorChanged: true,
    });
    expect(await fsp.realpath(paths.currentLink)).toBe(path.join(paths.releasesDir, `v${version}`));
    expect(JSON.parse(await fsp.readFile(paths.controllerVersionPath, "utf8"))).toMatchObject({
      version,
      serverSha256: fixture.targetServerSha,
      clientSha256: fixture.targetClientSha,
    });
    expect(await fsp.readFile(paths.supervisorPath, "utf8")).toBe(fixture.targetSupervisor);
    fixture.context.runningSupervisorDigest = sha256Text(fixture.targetSupervisor);

    const receiptRequests = await fsp.readdir(
      path.join(paths.supervisorStateDir, "controller-selections"),
    );
    expect(receiptRequests).toHaveLength(1);
    const receiptCurrent = (
      await fsp.readFile(
        path.join(paths.supervisorStateDir, "controller-selections", receiptRequests[0], "current"),
        "utf8",
      )
    ).trim();
    const receipt = JSON.parse(
      await fsp.readFile(
        path.join(
          paths.supervisorStateDir,
          "controller-selections",
          receiptRequests[0],
          `${receiptCurrent}.json`,
        ),
        "utf8",
      ),
    );
    expect(receipt).toMatchObject({
      version,
      releaseCommit: "a".repeat(40),
      controllerServerSha256: fixture.targetServerSha,
      controllerClientSha256: fixture.targetClientSha,
      controllerInstanceId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      protocolCapabilities: {
        supervisorProtocol: 1,
        controllerProtocol: 2,
        requestSchema: 2,
      },
      selectionDigest: receiptCurrent,
    });

    await expect(
      __testing.handleSupervisorRequest(request(), fixture.context, state),
    ).resolves.toMatchObject({
      ok: true,
      version,
      controllerChanged: false,
      supervisorChanged: false,
    });
    expect(fixture.restartController).toHaveBeenCalledTimes(3);
  });

  it("keeps one selected product transaction across a same-command controller retry", async () => {
    const { paths } = tempPaths();
    const fixture = await existingControllerTransitionFixture(paths, "1.2.2");
    const state = { controllerInstanceId: randomUUID() };
    const initial = request();

    await expect(
      __testing.handleSupervisorRequest(initial, fixture.context, state),
    ).rejects.toThrow("controller promotion failed and was restored");
    await expect(
      __testing.handleSupervisorRequest(initial, fixture.context, state),
    ).resolves.toMatchObject({ ok: true, controllerChanged: true });
    fixture.context.runningSupervisorDigest = sha256Text(fixture.targetSupervisor);
    const selectedBeforeRetry = JSON.parse(await fsp.readFile(paths.rootTransactionPath, "utf8"));
    const retry = parseSupervisorRequest({
      schemaVersion: 3,
      op: "updateController",
      transactionId: initial.transactionId,
      nonce: randomUUID(),
      version: initial.version,
      clientCapabilities: initial.clientCapabilities,
    });

    await expect(
      __testing.handleSupervisorRequest(retry, fixture.context, state),
    ).resolves.toMatchObject({ ok: true, controllerChanged: false });
    expect(JSON.parse(await fsp.readFile(paths.rootTransactionPath, "utf8"))).toEqual(
      selectedBeforeRetry,
    );
  });

  it("rejects supervisor promotion when the installed file changed beneath the running process", async () => {
    const { paths } = tempPaths();
    const fixture = await existingControllerTransitionFixture(paths, "1.2.2");
    fixture.context.runningSupervisorDigest = digest("f");

    await expect(stageTrustedController(request(), fixture.context)).rejects.toThrow(
      "installed lifecycle supervisor changed beneath the running trusted process",
    );
    expect(await fsp.readFile(paths.supervisorPath, "utf8")).toBe(fixture.previousSupervisor);
    await expect(fsp.lstat(paths.supervisorTransactionPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("commits the target supervisor slot after its first verified startup", async () => {
    const { paths } = tempPaths();
    const fixture = await existingControllerTransitionFixture(paths, "1.2.2");
    const transaction = request();
    const staged = await stageTrustedController(transaction, fixture.context);

    await __testing.beginSupervisorTransaction(paths, transaction, staged);
    await __testing.activateStagedSupervisor(
      paths,
      staged,
      process.getuid?.() ?? 0,
      process.getgid?.() ?? 0,
    );
    await __testing.activateStagedController(paths, staged);
    await __testing.commitLifecycleTrust(paths, staged);

    expect(await fsp.readFile(paths.supervisorPath, "utf8")).toBe(fixture.targetSupervisor);
    expect(await fsp.realpath(paths.currentLink)).toBe(path.join(paths.releasesDir, `v${version}`));

    const context = __testing.createContext(
      {
        profile: "protected-local",
        operatorUid: process.getuid?.() ?? 1000,
        operatorGid: process.getgid?.() ?? 1000,
        paths,
      },
      {
        rootUid: process.getuid?.() ?? 0,
        rootGid: process.getgid?.() ?? 0,
        runningSupervisorDigest: sha256Text(fixture.targetSupervisor),
      },
    );

    await expect(__testing.recoverSupervisorTransaction(context)).resolves.toBe(false);
    expect(await fsp.readFile(paths.supervisorPath, "utf8")).toBe(fixture.targetSupervisor);
    expect(await fsp.realpath(paths.currentLink)).toBe(path.join(paths.releasesDir, `v${version}`));
    expect(await fsp.realpath(path.join(paths.supervisorStateDir, "supervisor-known-good"))).toBe(
      __testing.supervisorGenerationPath(paths, sha256Text(fixture.targetSupervisor)),
    );
    await expect(fsp.lstat(paths.supervisorTransactionPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("restores the known-good supervisor slot when the prior process recovers activation", async () => {
    const { paths } = tempPaths();
    const fixture = await existingControllerTransitionFixture(paths, "1.2.2");
    const transaction = request();
    const staged = await stageTrustedController(transaction, fixture.context);
    await __testing.beginSupervisorTransaction(paths, transaction, staged);
    await __testing.activateStagedSupervisor(
      paths,
      staged,
      process.getuid?.() ?? 0,
      process.getgid?.() ?? 0,
    );
    await __testing.activateStagedController(paths, staged);
    await __testing.commitLifecycleTrust(paths, staged);
    const restart = vi.fn(async () => undefined);
    const context = __testing.createContext(
      {
        profile: "protected-local",
        operatorUid: process.getuid?.() ?? 1000,
        operatorGid: process.getgid?.() ?? 1000,
        paths,
      },
      {
        rootUid: process.getuid?.() ?? 0,
        rootGid: process.getgid?.() ?? 0,
        runningSupervisorDigest: sha256Text(fixture.previousSupervisor),
        restartController: restart,
        waitForController: async () => undefined,
      },
    );

    await expect(__testing.recoverSupervisorTransaction(context)).resolves.toBe(true);
    expect(await fsp.readFile(paths.supervisorPath, "utf8")).toBe(fixture.previousSupervisor);
    expect(await fsp.realpath(paths.currentLink)).toBe(fixture.previousGeneration);
    expect(JSON.parse(await fsp.readFile(paths.controllerVersionPath, "utf8"))).toEqual(
      fixture.previousIdentity,
    );
    expect(await fsp.realpath(path.join(paths.supervisorStateDir, "supervisor-known-good"))).toBe(
      __testing.supervisorGenerationPath(paths, sha256Text(fixture.previousSupervisor)),
    );
    await expect(fsp.lstat(paths.supervisorTransactionPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(restart).toHaveBeenCalledOnce();
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
          releaseCommit: "a".repeat(40),
          targetManifestSha256: digest("1"),
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
          releaseCommit: "a".repeat(40),
          targetManifestSha256: digest("1"),
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
        cleanupHistoricalControllerCandidates: async () => {
          calls.push("cleanup");
          return [];
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
    expect(calls).toEqual([
      "journal",
      "activate",
      "restart",
      "wait",
      "probe",
      "cleanup",
      "trust",
      "clear",
    ]);
  });

  it("restores controller selection when supervisor-owned residue cleanup fails", async () => {
    const { paths } = tempPaths();
    await fsp.mkdir(paths.supervisorStateDir, { recursive: true });
    const restore = vi.fn(async () => undefined);
    const clear = vi.fn(async () => undefined);
    const restart = vi.fn(async () => undefined);
    const context = __testing.createContext(
      {
        profile: "protected-local",
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
          releaseCommit: "a".repeat(40),
          targetManifestSha256: digest("1"),
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
        beginSupervisorTransaction: async () => undefined,
        activateStagedController: async () => undefined,
        restoreControllerSelection: restore,
        restoreLifecycleTrust: async () => undefined,
        clearSupervisorTransaction: clear,
        restartController: restart,
        waitForController: async () => undefined,
        probeControllerIdentity: async () => randomUUID(),
        cleanupHistoricalControllerCandidates: async () => {
          throw new Error("injected historical cleanup failure");
        },
      },
    );

    await expect(
      __testing.handleSupervisorRequest(request(), context, {
        controllerInstanceId: randomUUID(),
      }),
    ).rejects.toThrow("controller promotion failed and was restored");
    expect(restore).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledTimes(2);
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

  it("does not invalidate an active receipt after one unchanged-worker probe failure", async () => {
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
          releaseCommit: "a".repeat(40),
          targetManifestSha256: digest("1"),
          trustPolicySha256: digest("0"),
        }),
        probeControllerIdentity: probe,
        restartController: restart,
        waitForController: async () => undefined,
      },
    );
    const transaction = request();
    await expect(
      __testing.handleSupervisorRequest(transaction, context, {
        controllerInstanceId: randomUUID(),
      }),
    ).rejects.toThrow("controller verification failed: stale worker");
    expect(restart).not.toHaveBeenCalled();
    await expect(
      __testing.handleSupervisorRequest(transaction, context, {
        controllerInstanceId: activeInstance,
      }),
    ).resolves.toMatchObject({
      ok: true,
      version,
      controllerChanged: false,
      controllerInstanceId: activeInstance,
    });
    expect(restart).not.toHaveBeenCalled();
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
    await fsp.writeFile(paths.supervisorPath, "stable-supervisor\n", { mode: 0o755 });
    const supervisorDigest = sha256Text("stable-supervisor\n");
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
      supervisorChanged: false,
      previousSupervisorDigest: supervisorDigest,
      targetSupervisorDigest: supervisorDigest,
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
