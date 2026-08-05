import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing as controllerTesting, parseUpdateRequest } from "./fased-host-updater.mjs";
import {
  __testing as supervisorTesting,
  parseSupervisorRequest,
} from "./fased-lifecycle-supervisor.mjs";

const roots: string[] = [];
const targetVersion = "1.2.2";
const recoveryControllerVersion = "1.2.3";
const previousVersion = "1.2.1";
const now = Date.parse("2026-08-02T12:00:00.000Z");
const publishedLegacyRef = "v0.1.76-rc.30";
const publishedLegacyServerSha256 =
  "ecad0b06bc1eb0612f052534e77760b8995ae144071f5973f7b1dab1b802ca6d"; // pragma: allowlist secret
const publishedLegacyClientSha256 =
  "9cee31906ba86800c2a5699d9895cbe73d5b74fea6c3f2b3c56f7732d6f34799"; // pragma: allowlist secret
const digest = (character: string) => character.repeat(64);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const prefixedSha256 = (value: string) => `sha256:${sha256(value)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("fixture contains a non-canonical number");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("fixture contains a non-canonical value");
}

function recoveryDigest(
  rootTransaction: Record<string, unknown> | null,
  productJournal: Record<string, unknown> | null,
): string {
  return sha256(
    canonical({
      schemaVersion: 1,
      supervisorTransaction: null,
      rootProductTransaction: rootTransaction,
      controllerProductJournal: productJournal,
    }),
  );
}

function fixturePaths(root: string) {
  return {
    publicSocketPath: path.join(root, "run", "supervisor.sock"),
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
    productJournalPath: path.join(root, "state", "product-transaction.json"),
    productVersionPath: path.join(root, "state", "product-version"),
    channelPath: path.join(root, "channel"),
    supervisorPath: path.join(root, "supervisor.mjs"),
    controllerUnit: "fased-local-controller-fixture.service",
    supervisorUnit: "fased-local-supervisor-fixture.service",
  };
}

function supervisorRequest(
  op: "applyRelease" | "recoverActive" | "recoveryStatus" | "updateController",
  transactionId: string,
  version = targetVersion,
  options: {
    nonce?: string;
    recoveryDigest?: string;
    recoveryControllerVersion?: string;
  } = {},
) {
  return parseSupervisorRequest({
    schemaVersion: 3,
    op,
    transactionId,
    nonce: options.nonce ?? randomUUID(),
    version,
    clientCapabilities: { protocolVersion: 2, requestSchema: 3 },
    ...(op === "recoverActive" ? { recoveryDigest: options.recoveryDigest } : {}),
    ...(op === "recoverActive"
      ? {
          recoveryControllerVersion: options.recoveryControllerVersion ?? recoveryControllerVersion,
        }
      : {}),
  });
}

function pendingState(
  rootTransaction: Record<string, unknown>,
  productJournal: Record<string, unknown>,
) {
  const receipt = rootTransaction.targetControllerReceipt as Record<string, unknown>;
  return {
    controllerInstanceId: randomUUID(),
    recovery: Object.freeze({
      state: "RECOVERY_PENDING",
      source: "product",
      transactionId: rootTransaction.transactionId,
      targetVersion: rootTransaction.version,
      phase: productJournal.phase,
      durableCommitDecision: false,
      journalDigest: recoveryDigest(rootTransaction, productJournal),
      recoveryAttempts: rootTransaction.recoveryAttempts,
      lastErrorClass: rootTransaction.lastErrorClass,
      controller: Object.freeze({
        version: receipt.version,
        serverSha256: receipt.controllerServerSha256,
        clientSha256: receipt.controllerClientSha256,
        processInstanceId: receipt.controllerInstanceId,
        selectionDigest: receipt.selectionDigest,
        protocolCapabilities: receipt.protocolCapabilities,
      }),
    }),
  };
}

async function writeControllerGeneration(
  releasesDir: string,
  version: string,
  server: string,
  client: string,
) {
  const generation = path.join(releasesDir, `v${version}`);
  await fs.mkdir(generation, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(generation, "fased-host-updater.mjs"), server, { mode: 0o600 }),
    fs.writeFile(path.join(generation, "fased-host-updaterctl.mjs"), client, { mode: 0o600 }),
  ]);
  return {
    generation,
    identity: {
      schemaVersion: 1,
      version,
      serverSha256: sha256(server),
      clientSha256: sha256(client),
    },
  };
}

describe("Local persisted-journal recovery control plane", () => {
  it("keeps invalid recovery state status-only and blocks mutation", async () => {
    const transactionId = randomUUID();
    const state = {
      controllerInstanceId: randomUUID(),
      recovery: Object.freeze({
        state: "INVALID_LEDGER",
        lastErrorClass: "INVALID_LEDGER",
      }),
    };
    const context = {} as Parameters<typeof supervisorTesting.handleSupervisorRequest>[1];

    await expect(
      supervisorTesting.handleSupervisorRequest(
        supervisorRequest("recoveryStatus", transactionId),
        context,
        state,
      ),
    ).resolves.toMatchObject({
      ok: true,
      recovery: { state: "INVALID_LEDGER", lastErrorClass: "INVALID_LEDGER" },
    });
    await expect(
      supervisorTesting.handleSupervisorRequest(
        supervisorRequest("applyRelease", transactionId),
        context,
        state,
      ),
    ).rejects.toThrow("only status is available");
  });

  it("uses a verified recovery-capable controller instead of sending recoverActive to legacy A", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-local-recovery-t1-"));
    roots.push(root);
    const paths = fixturePaths(root);
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    await fs.mkdir(paths.supervisorStateDir, { recursive: true, mode: 0o700 });

    const previous = await writeControllerGeneration(
      paths.releasesDir,
      previousVersion,
      "previous-controller-server\n",
      "previous-controller-client\n",
    );
    // This pinned published manifest is fixture evidence, never a migration
    // selector. Its published dispatcher operation contract had no explicit
    // recovery operation.
    const publishedLegacyContract = Object.freeze({
      ref: publishedLegacyRef,
      serverSha256: publishedLegacyServerSha256,
      clientSha256: publishedLegacyClientSha256,
      operations: Object.freeze([
        "updateController",
        "applyRelease",
        "prepareRelease",
        "activateRelease",
        "authorizeGatewayRelease",
        "gateGatewayRelease",
        "restartGateway",
        "commitRelease",
        "rollbackRelease",
        "controllerStatus",
        "releaseStatus",
      ]),
    });
    expect(publishedLegacyContract.operations).not.toContain("recoverActive");
    const legacyA = await writeControllerGeneration(
      paths.releasesDir,
      targetVersion,
      "pinned-published-legacy-controller-placeholder\n",
      "pinned-published-legacy-client-placeholder\n",
    );
    const legacyAIdentity = Object.freeze({
      ...legacyA.identity,
      serverSha256: publishedLegacyContract.serverSha256,
      clientSha256: publishedLegacyContract.clientSha256,
    });
    const recoveryB = await writeControllerGeneration(
      paths.releasesDir,
      recoveryControllerVersion,
      "verified-recovery-controller-b\n",
      "verified-recovery-controller-b-client\n",
    );
    await fs.symlink(legacyA.generation, paths.currentLink);
    await fs.writeFile(
      paths.controllerVersionPath,
      `${JSON.stringify(legacyAIdentity, null, 2)}\n`,
      { mode: 0o600 },
    );

    const transactionId = randomUUID();
    const selectedAInstance = randomUUID();
    const selectionRequest = supervisorRequest("updateController", transactionId);
    const legacyAReceipt = supervisorTesting.createControllerSelectionReceipt(
      selectionRequest,
      {
        releaseCommit: "a".repeat(40),
        targetManifestSha256: digest("1"),
        trustPolicySha256: digest("2"),
        identity: legacyAIdentity,
      },
      selectedAInstance,
      { now },
    );
    const release = {
      version: targetVersion,
      commit: "a".repeat(40),
      buildInputDigest: `sha256:${digest("3")}`,
      development: false,
    };
    const artifactDigests = {
      application: digest("4"),
      dependencies: digest("5"),
      signer: digest("6"),
      updaterBundle: digest("7"),
    };
    let productJournal: Record<string, unknown> | null = {
      schemaVersion: 7,
      transactionId,
      version: targetVersion,
      phase: "active",
      previousVersion,
      selectionDigest: legacyAReceipt.selectionDigest,
      targetControllerReceipt: legacyAReceipt,
      targetReleaseIdentity: release,
      artifactDigests,
      legacyAdoption: null,
      journalSha256: digest("8"),
    };
    let rootTransaction: Record<string, unknown> | null =
      supervisorTesting.rootProductTransactionRecord({
        request: selectionRequest,
        phase: "active",
        previousVersion,
        previousControllerIdentity: previous.identity,
        previousControllerGenerationVersion: previousVersion,
        targetControllerReceipt: legacyAReceipt,
        targetReleaseIdentity: release,
        artifactDigests,
        targetJournalSha256: productJournal.journalSha256,
        selectionDigest: legacyAReceipt.selectionDigest,
        recoveryAttempts: 8,
        now,
      }) as unknown as Record<string, unknown>;
    const stableRecoveryIdentity = supervisorTesting.recoveryIdentityDigest(
      null,
      rootTransaction,
      productJournal,
    );
    expect(
      supervisorTesting.recoveryIdentityDigest(
        null,
        {
          ...rootTransaction,
          recoveryAttempts: Number(rootTransaction.recoveryAttempts) + 1,
          lastErrorClass: "RECOVERY_FAILED",
          updatedAt: "2026-08-02T11:59:59.000Z",
        },
        productJournal,
      ),
    ).toBe(stableRecoveryIdentity);
    expect(
      supervisorTesting.recoveryIdentityDigest(
        null,
        { ...rootTransaction, phase: "committing" },
        productJournal,
      ),
    ).not.toBe(stableRecoveryIdentity);
    expect(
      supervisorTesting.recoveryIdentityDigest(
        null,
        { ...rootTransaction, durableCommitDecision: true },
        productJournal,
      ),
    ).not.toBe(stableRecoveryIdentity);
    expect(
      supervisorTesting.recoveryIdentityDigest(
        null,
        {
          ...rootTransaction,
          targetControllerReceipt: {
            ...(rootTransaction.targetControllerReceipt as Record<string, unknown>),
            controllerServerSha256: digest("e"),
          },
        },
        productJournal,
      ),
    ).not.toBe(stableRecoveryIdentity);
    expect(
      supervisorTesting.recoveryIdentityDigest(null, rootTransaction, {
        ...productJournal,
        phase: "committing",
      }),
    ).not.toBe(stableRecoveryIdentity);
    const state = pendingState(rootTransaction, productJournal);
    const protectedStatePath = path.join(root, "user-state", "wallet-mining-network.json");
    await fs.mkdir(path.dirname(protectedStatePath), { recursive: true });
    await fs.writeFile(
      protectedStatePath,
      `${JSON.stringify({ wallet: "agent", miningActions: 40_841, network: "sat" })}\n`,
    );
    const stateBefore = sha256(await fs.readFile(protectedStatePath, "utf8"));

    const recoveryBInstance = randomUUID();
    const recoveryBSelectionRequest = supervisorRequest(
      "updateController",
      transactionId,
      recoveryControllerVersion,
    );
    const recoveryBReceipt = supervisorTesting.createControllerSelectionReceipt(
      recoveryBSelectionRequest,
      {
        releaseCommit: "b".repeat(40),
        targetManifestSha256: digest("9"),
        trustPolicySha256: digest("2"),
        identity: recoveryB.identity,
      },
      recoveryBInstance,
      { now },
    );
    const recoveryCapabilities = Object.freeze({
      protocolVersion: 1,
      operations: Object.freeze(["recoverActive"]),
      journalSchemas: Object.freeze([7, 8]),
    });
    const calls: string[] = [];
    let legacyARecoveryCalls = 0;
    let recoveryCalls = 0;
    const recoveryAuthorizations: Record<string, unknown>[] = [];
    const requestController = vi.fn(async (request: Record<string, unknown>) => {
      if (request.op === "recoverActive") {
        const receipt = request.supervisorReceipt as Record<string, unknown> | undefined;
        if (receipt?.selectionDigest === legacyAReceipt.selectionDigest) {
          legacyARecoveryCalls += 1;
          throw new Error("legacy controller A must never receive recoverActive");
        }
        recoveryCalls += 1;
        expect(receipt).toBeUndefined();
        expect(request.recoveryControllerInstanceId).toBe(recoveryBInstance);
        const parsedWire = parseUpdateRequest(
          JSON.parse(JSON.stringify(request)) as Record<string, unknown>,
        );
        expect(parsedWire).toMatchObject({
          transactionId,
          version: targetVersion,
          recoveryControllerInstanceId: recoveryBInstance,
          recoveryAuthorization: {
            transactionId,
            version: targetVersion,
            expectedOutcome: "rolled-back",
            recoveryController: {
              version: recoveryControllerVersion,
              releaseCommit: "b".repeat(40),
              targetManifestSha256: digest("9"),
              serverSha256: recoveryB.identity.serverSha256,
              clientSha256: recoveryB.identity.clientSha256,
              trustPolicySha256: digest("2"),
              recoveryCapabilities: { journalSchemas: [7, 8] },
            },
          },
        });
        const authorization = request.recoveryAuthorization as {
          authorizationDigest: string;
          expectedOutcome: string;
          recoveryIdentityDigest: string;
          productJournalDigest: string;
          legacySelectionDigest: string;
          recoveryController: Record<string, unknown>;
        };
        recoveryAuthorizations.push(authorization as unknown as Record<string, unknown>);
        expect(authorization.recoveryIdentityDigest).toBe(stableRecoveryIdentity);
        expect(authorization.recoveryIdentityDigest).toMatch(/^[a-f0-9]{64}$/u);
        expect(authorization.productJournalDigest).toBe(digest("8"));
        expect(authorization.legacySelectionDigest).toBe(legacyAReceipt.selectionDigest);
        expect(authorization.recoveryController).toMatchObject({
          version: recoveryControllerVersion,
          releaseCommit: "b".repeat(40),
          targetManifestSha256: digest("9"),
          serverSha256: recoveryB.identity.serverSha256,
          clientSha256: recoveryB.identity.clientSha256,
          trustPolicySha256: digest("2"),
          recoveryCapabilities: {
            protocolVersion: 1,
            operations: ["recoverActive"],
            journalSchemas: [7, 8],
          },
        });
        expect(authorization.expectedOutcome).toBe("rolled-back");
        calls.push("recover-with-B");
        if (recoveryCalls <= 4) {
          return {
            ok: true,
            transactionId,
            version: targetVersion,
            phase: "rolled-back",
            recoveryControllerInstanceId: request.recoveryControllerInstanceId,
            recoveryAuthorizationDigest: digest("0"),
          };
        }
        productJournal = null;
        return {
          ok: true,
          transactionId,
          version: targetVersion,
          phase: "rolled-back",
          recoveryControllerInstanceId: request.recoveryControllerInstanceId,
          recoveryAuthorizationDigest: authorization.authorizationDigest,
        };
      }
      if (request.op === "releaseStatus") {
        return {
          ok: true,
          transactionId,
          version: targetVersion,
          phase: "rolled-back",
          healthy: true,
          release: null,
        };
      }
      throw new Error(`unexpected controller request ${String(request.op)}`);
    });
    const probeControllerIdentity = vi.fn(
      async (_request: unknown, _context: unknown, identity: { version: string }) => {
        calls.push(`probe-${identity.version}`);
        return randomUUID();
      },
    );
    const stageTrustedController = vi.fn(async (request: { version: string }) => {
      expect(request.version).toBe(recoveryControllerVersion);
      calls.push("stage-B");
      return {
        changed: false,
        supervisorChanged: false,
        trustChanged: false,
        releaseCommit: "b".repeat(40),
        targetManifestSha256: digest("9"),
        trustPolicySha256: digest("2"),
        identity: recoveryB.identity,
        previousGeneration: legacyA.generation,
        previousIdentity: legacyAIdentity,
      };
    });
    const probeRecoveryControllerIdentity = vi.fn(
      async (
        request: { version: string },
        _context: unknown,
        identity: { version: string; serverSha256: string; clientSha256: string },
      ) => {
        expect(request.version).toBe(recoveryControllerVersion);
        expect(identity).toEqual(recoveryB.identity);
        calls.push(`probe-recovery-${identity.version}`);
        return { controllerInstanceId: recoveryBInstance, recoveryCapabilities };
      },
    );
    const writeControllerSelectionReceipt = vi.fn(async () => recoveryBReceipt);
    let recoveryNow = now;
    const context = supervisorTesting.createContext(
      {
        profile: "protected-local",
        operatorUid: uid,
        operatorGid: gid,
        paths,
      },
      {
        rootUid: uid,
        rootGid: gid,
        operatorStateDirSha256: prefixedSha256(path.join(root, "legacy-fixture-state")),
        now: () => recoveryNow,
        stageTrustedController,
        probeRecoveryControllerIdentity,
        writeControllerSelectionReceipt,
        readSupervisorTransaction: async () => null,
        readRootProductTransaction: async () => rootTransaction,
        writeRootProductTransaction: async (_paths: unknown, value: Record<string, unknown>) => {
          rootTransaction = value;
          return value;
        },
        clearRootProductTransaction: async () => {
          if (productJournal !== null) {
            throw new Error("root journal cannot clear before the controller journal");
          }
          calls.push("clear-root");
          rootTransaction = null;
        },
        readControllerProductJournal: async () => productJournal,
        readProductVersion: async () => previousVersion,
        requestController,
        probeControllerIdentity,
        restartController: async () => calls.push("restart-controller"),
        waitForController: async () => calls.push("wait-controller"),
      },
    );

    const statusRequest = supervisorRequest("recoveryStatus", transactionId);
    const status = await supervisorTesting.handleSupervisorRequest(statusRequest, context, state);
    expect(status).toMatchObject({
      ok: true,
      phase: "recovery-pending",
      recovery: {
        state: "RECOVERY_PENDING",
        transactionId,
        targetVersion,
        phase: "active",
      },
    });
    await expect(
      supervisorTesting.handleSupervisorRequest(
        supervisorRequest("applyRelease", transactionId),
        context,
        state,
      ),
    ).rejects.toThrow("new product mutation is blocked");
    expect(requestController).not.toHaveBeenCalled();

    const wrongRecovery = supervisorRequest("recoverActive", transactionId, targetVersion, {
      recoveryDigest: digest("f"),
    });
    await expect(
      supervisorTesting.handleSupervisorRequest(wrongRecovery, context, state),
    ).rejects.toThrow("does not match the protected journal");
    expect(requestController).not.toHaveBeenCalled();

    const firstNonce = randomUUID();
    const firstRecovery = supervisorRequest("recoverActive", transactionId, targetVersion, {
      nonce: firstNonce,
      recoveryDigest: state.recovery.journalDigest,
    });
    await expect(
      supervisorTesting.handleSupervisorRequest(firstRecovery, context, state),
    ).rejects.toThrow("target controller did not complete the bound product recovery");
    expect(state.recovery).toMatchObject({ state: "RECOVERY_PENDING", transactionId });

    const replayedNonce = supervisorRequest("recoverActive", transactionId, targetVersion, {
      nonce: firstNonce,
      recoveryDigest: state.recovery.journalDigest,
    });
    await expect(
      supervisorTesting.handleSupervisorRequest(replayedNonce, context, state),
    ).rejects.toThrow("nonce was already consumed");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        supervisorTesting.handleSupervisorRequest(
          supervisorRequest("recoverActive", transactionId, targetVersion, {
            nonce: randomUUID(),
            recoveryDigest: state.recovery.journalDigest,
          }),
          context,
          state,
        ),
      ).rejects.toThrow("target controller did not complete the bound product recovery");
    }
    recoveryNow += 10 * 60_000;
    const retry = supervisorRequest("recoverActive", transactionId, targetVersion, {
      nonce: randomUUID(),
      recoveryDigest: state.recovery.journalDigest,
    });
    await expect(
      supervisorTesting.handleSupervisorRequest(retry, context, state),
    ).resolves.toMatchObject({
      ok: true,
      action: "rolled-back",
      recovery: { state: "READY" },
    });
    expect(rootTransaction).toBeNull();
    expect(productJournal).toBeNull();
    expect(await fs.realpath(paths.currentLink)).toBe(previous.generation);
    expect(JSON.parse(await fs.readFile(paths.controllerVersionPath, "utf8"))).toEqual(
      previous.identity,
    );
    expect(sha256(await fs.readFile(protectedStatePath, "utf8"))).toBe(stateBefore);
    await expect(
      fs.access(path.join(paths.supervisorStateDir, "explicit-recovery-attempt.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      supervisorTesting.handleSupervisorRequest(statusRequest, context, state),
    ).resolves.toMatchObject({ recovery: { state: "READY" }, phase: "ready" });
    expect(calls).toContain("recover-with-B");
    expect(legacyARecoveryCalls).toBe(0);
    expect(recoveryCalls).toBe(5);
    expect(recoveryAuthorizations).toHaveLength(5);
    expect(new Set(recoveryAuthorizations.map((entry) => entry.authorizationDigest))).toEqual(
      new Set([recoveryAuthorizations[0]?.authorizationDigest]),
    );
    expect(recoveryAuthorizations.at(-1)?.authorizationDigest).toBe(
      recoveryAuthorizations[0]?.authorizationDigest,
    );
    const durableAuthorization = recoveryAuthorizations[0];
    const expectedAuthorization = {
      transactionId: durableAuthorization.transactionId,
      version: durableAuthorization.version,
      recoveryIdentityDigest: durableAuthorization.recoveryIdentityDigest,
      productJournalDigest: durableAuthorization.productJournalDigest,
      legacySelectionDigest: durableAuthorization.legacySelectionDigest,
      expectedOutcome: durableAuthorization.expectedOutcome,
      recoveryController: durableAuthorization.recoveryController,
      recoveryEpoch: durableAuthorization.recoveryEpoch,
    };
    expect(() =>
      supervisorTesting.assertRecoveryAuthorizationBinding(
        durableAuthorization,
        expectedAuthorization,
      ),
    ).not.toThrow();
    for (const changed of [
      { recoveryIdentityDigest: digest("d") },
      { productJournalDigest: digest("e") },
      { expectedOutcome: "committed" },
      {
        recoveryController: {
          ...(durableAuthorization.recoveryController as Record<string, unknown>),
          serverSha256: digest("f"),
        },
      },
    ]) {
      expect(() =>
        supervisorTesting.assertRecoveryAuthorizationBinding(durableAuthorization, {
          ...expectedAuthorization,
          ...changed,
        }),
      ).toThrow("recovery controller authorization changed across retry");
    }
    expect(stageTrustedController).toHaveBeenCalledTimes(5);
    expect(probeRecoveryControllerIdentity).toHaveBeenCalledTimes(5);
    expect(probeRecoveryControllerIdentity).toHaveBeenLastCalledWith(
      expect.objectContaining({ version: recoveryControllerVersion }),
      context,
      recoveryB.identity,
    );
    expect(writeControllerSelectionReceipt).toHaveBeenCalledTimes(5);
    expect(probeControllerIdentity).toHaveBeenLastCalledWith(
      expect.any(Object),
      context,
      previous.identity,
    );
    expect(calls.at(-1)).toBe("clear-root");
  });

  it("rejects a live recovery-controller process mismatch before mutation", async () => {
    const transactionId = randomUUID();
    const runningInstance = randomUUID();
    const wrongInstance = randomUUID();
    const selectionRequest = supervisorRequest("updateController", transactionId);
    const selectionReceipt = supervisorTesting.createControllerSelectionReceipt(
      selectionRequest,
      {
        releaseCommit: "a".repeat(40),
        targetManifestSha256: digest("d"),
        trustPolicySha256: digest("e"),
        identity: {
          version: targetVersion,
          serverSha256: digest("b"),
          clientSha256: digest("c"),
        },
      },
      runningInstance,
      { now },
    );
    const recovery = Object.freeze({
      state: "RECOVERY_PENDING",
      transactionId,
      targetVersion,
      phase: "active",
      durableCommitDecision: false,
      journalDigest: digest("a"),
      recoveryIdentityDigest: digest("f"),
      legacySelectionDigest: selectionReceipt.selectionDigest,
      journalSchemaVersion: 7,
      lastErrorClass: null,
    });
    const authorizedAt = Date.now() - 10 * 60_000;
    const authorizationUnsigned = {
      schemaVersion: 3,
      transactionId,
      version: targetVersion,
      recoveryIdentityDigest: recovery.recoveryIdentityDigest,
      productJournalDigest: recovery.journalDigest,
      legacySelectionDigest: selectionReceipt.selectionDigest,
      expectedOutcome: "rolled-back",
      recoveryController: {
        version: targetVersion,
        releaseCommit: selectionReceipt.releaseCommit,
        targetManifestSha256: selectionReceipt.targetManifestSha256,
        serverSha256: digest("b"),
        clientSha256: digest("c"),
        trustPolicySha256: selectionReceipt.trustPolicySha256,
        protocolCapabilities: selectionReceipt.protocolCapabilities,
        recoveryCapabilities: {
          protocolVersion: 1,
          operations: ["recoverActive"],
          journalSchemas: [7, 8],
        },
      },
      allowedOperation: "recoverActive",
      recoveryEpoch: randomUUID(),
      authorizedAt: new Date(authorizedAt).toISOString(),
    };
    const recoveryAuthorization = {
      ...authorizationUnsigned,
      authorizationDigest: sha256(canonical(authorizationUnsigned)),
    };
    const context = {
      supervised: true,
      runningControllerVersion: targetVersion,
      runningControllerIdentity: {
        version: targetVersion,
        serverSha256: digest("b"),
        clientSha256: digest("c"),
      },
      controllerInstanceId: runningInstance,
    } as unknown as Parameters<typeof controllerTesting.dispatchUpdateRequest>[1];
    const request = parseUpdateRequest({
      schemaVersion: 2,
      op: "recoverActive",
      transactionId,
      version: targetVersion,
      recoveryDigest: recovery.journalDigest,
      recoveryControllerInstanceId: wrongInstance,
      recoveryAuthorization,
    });

    await expect(
      controllerTesting.dispatchUpdateRequest(request, context, { recovery }),
    ).rejects.toThrow("process identity is mismatched");
  });
});
