import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyProtectedLocalControl,
  commitProtectedLocalControlNormalization,
  markProtectedLocalBoundaryCommitted,
  prepareProtectedLocalControlNormalization,
  recoverProtectedLocalControlNormalization,
  rollbackProtectedLocalControlNormalization,
} from "./lifecycle-control-normalizer.mjs";

const roots: string[] = [];
const digest = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const legacyTransactionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-control-normalizer-"));
  roots.push(root);
  const operatorStateDir = path.join(root, "operator");
  const controllerStateDir = path.join(root, "controller");
  const supervisorStateDir = path.join(controllerStateDir, "supervisor");
  await fs.mkdir(supervisorStateDir, { recursive: true });
  await fs.mkdir(operatorStateDir, { recursive: true });
  return {
    root,
    operatorStateDir,
    controllerStateDir,
    supervisorStateDir,
    expectedOperatorUid: process.getuid?.() ?? 0,
    expectedOperatorStateGid: process.getgid?.() ?? 0,
    expectedRootUid: process.getuid?.() ?? 0,
    targetVersion: "1.2.3",
    previousVersion: "1.2.2",
    transactionId: "11111111-1111-4111-8111-111111111111",
    now: () => "2026-08-05T14:00:00.000Z",
  };
}

async function writeJson(file: string, value: unknown) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes, { mode: 0o600 });
  return bytes;
}

describe("protected Local lifecycle-control normalization", () => {
  it("accepts the canonical protected Local shared state root", async () => {
    const options = await fixture();
    await fs.chmod(options.operatorStateDir, 0o2770);

    await expect(prepareProtectedLocalControlNormalization(options)).resolves.toEqual({
      strategy: "STANDARD",
      reason: "canonical-control",
    });
  });

  it("rejects a shared state root outside the expected configuration group", async () => {
    const options = await fixture();
    await fs.chmod(options.operatorStateDir, 0o2770);

    await expect(
      prepareProtectedLocalControlNormalization({
        ...options,
        expectedOperatorStateGid: options.expectedOperatorStateGid + 1,
      }),
    ).rejects.toThrow(/control directory is unsafe/);
  });

  it("rejects a group-writable state root without the setgid boundary", async () => {
    const options = await fixture();
    await fs.chmod(options.operatorStateDir, 0o770);

    await expect(prepareProtectedLocalControlNormalization(options)).rejects.toThrow(
      /control directory is unsafe/,
    );
  });

  it("selects one legacy reset for mixed control generations without version matrices", () => {
    expect(
      classifyProtectedLocalControl({
        operatorJournal: {
          schemaVersion: 1,
          phase: "rolling-back",
          transactionId: legacyTransactionId,
        },
        adoptionReceipt: {
          schemaVersion: 1,
          outcome: "rolled-back",
          rootVerificationPending: true,
          transactionId: legacyTransactionId,
        },
        controllerHint: { schemaVersion: 1, version: "1.2.1" },
        supervisorTransaction: null,
        rootProductTransaction: null,
        controllerProductJournal: null,
      }),
    ).toEqual({ strategy: "UNIVERSAL_TAKEOVER", reason: "legacy-control-quarantined" });
    expect(
      classifyProtectedLocalControl({
        operatorJournal: null,
        adoptionReceipt: null,
        controllerHint: null,
        supervisorTransaction: null,
        rootProductTransaction: null,
        controllerProductJournal: null,
      }),
    ).toEqual({ strategy: "STANDARD", reason: "canonical-control" });
  });

  it("preserves non-terminal root authority instead of trusting operator rollback state", () => {
    const legacyOperatorState = {
      operatorJournal: {
        schemaVersion: 1,
        phase: "rolling-back",
        transactionId: legacyTransactionId,
      },
      adoptionReceipt: {
        schemaVersion: 1,
        outcome: "rolled-back",
        rootVerificationPending: true,
        transactionId: legacyTransactionId,
      },
      controllerHint: { schemaVersion: 1, version: "1.2.1" },
      supervisorTransaction: null,
      rootProductTransaction: {
        schemaVersion: 3,
        phase: "active",
        durableCommitDecision: false,
      },
      controllerProductJournal: null,
    };

    expect(classifyProtectedLocalControl(legacyOperatorState)).toEqual({
      strategy: "STANDARD_RECOVERY",
      reason: "root-product-authority-preserved",
    });
    expect(
      classifyProtectedLocalControl({
        ...legacyOperatorState,
        rootProductTransaction: null,
        controllerProductJournal: { schemaVersion: 8, phase: "active" },
      }),
    ).toEqual({
      strategy: "STANDARD_RECOVERY",
      reason: "root-controller-authority-preserved",
    });
  });

  it("takes over disposable operator control without a release-version matrix", () => {
    expect(
      classifyProtectedLocalControl({
        operatorJournal: { schemaVersion: 77, phase: "future-legacy-residue" },
        adoptionReceipt: null,
        controllerHint: null,
        supervisorTransaction: null,
        rootProductTransaction: null,
        controllerProductJournal: null,
      }),
    ).toEqual({ strategy: "UNIVERSAL_TAKEOVER", reason: "legacy-control-quarantined" });
    expect(
      classifyProtectedLocalControl({
        operatorJournal: {
          schemaVersion: 1,
          phase: "rolling-back",
          transactionId: legacyTransactionId,
        },
        adoptionReceipt: null,
        controllerHint: null,
        supervisorTransaction: null,
        rootProductTransaction: null,
        controllerProductJournal: null,
      }),
    ).toEqual({ strategy: "UNIVERSAL_TAKEOVER", reason: "legacy-control-quarantined" });
  });

  it("leaves unknown-newer root authority byte-for-byte unchanged", async () => {
    const options = await fixture();
    const journalPath = path.join(options.supervisorStateDir, "product-transaction.json");
    const bytes = await writeJson(journalPath, {
      schemaVersion: 4,
      phase: "future",
    });

    await expect(prepareProtectedLocalControlNormalization(options)).rejects.toThrow(
      /unknown newer lifecycle-control schema/,
    );
    expect(await fs.readFile(journalPath, "utf8")).toBe(bytes);
    await expect(
      fs.access(path.join(options.supervisorStateDir, "control-normalization", "active.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("quarantines opaque legacy control and restores it byte-for-byte", async () => {
    const options = await fixture();
    const journalPath = path.join(options.operatorStateDir, "hosted-update-transaction.json");
    const opaque = Buffer.from("interrupted legacy journal\nnot-json\n", "utf8");
    await fs.writeFile(journalPath, opaque, { mode: 0o600 });

    const prepared = await prepareProtectedLocalControlNormalization(options);
    expect(prepared.strategy).toBe("UNIVERSAL_TAKEOVER");
    await expect(fs.access(journalPath)).rejects.toMatchObject({ code: "ENOENT" });

    await rollbackProtectedLocalControlNormalization(options);
    expect(await fs.readFile(journalPath)).toEqual(opaque);
  });

  it("never mistakes opaque root residue for a recoverable current transaction", async () => {
    const options = await fixture();
    const transactionPath = path.join(options.supervisorStateDir, "product-transaction.json");
    const opaque = Buffer.from("truncated-root-transaction", "utf8");
    await fs.writeFile(transactionPath, opaque, { mode: 0o600 });

    const prepared = await prepareProtectedLocalControlNormalization(options);
    expect(prepared.strategy).toBe("UNIVERSAL_TAKEOVER");
    await expect(fs.access(transactionPath)).rejects.toMatchObject({ code: "ENOENT" });

    await rollbackProtectedLocalControlNormalization(options);
    expect(await fs.readFile(transactionPath)).toEqual(opaque);
  });

  it("rejects a symbolic control file without reading or unlinking its target", async () => {
    const options = await fixture();
    const journalPath = path.join(options.operatorStateDir, "hosted-update-transaction.json");
    const targetPath = path.join(options.root, "operator-secret.json");
    const target = await writeJson(targetPath, {
      schemaVersion: 1,
      phase: "restored",
      transactionId: legacyTransactionId,
    });
    await fs.symlink(targetPath, journalPath);

    await expect(prepareProtectedLocalControlNormalization(options)).rejects.toThrow(
      /control file is unsafe/,
    );
    expect(await fs.readFile(targetPath, "utf8")).toBe(target);
    expect((await fs.lstat(journalPath)).isSymbolicLink()).toBe(true);
  });

  it("rejects writable privileged control directories without mutation", async () => {
    const options = await fixture();
    const journalPath = path.join(options.operatorStateDir, "hosted-update-transaction.json");
    const journal = await writeJson(journalPath, {
      schemaVersion: 1,
      phase: "restored",
      transactionId: legacyTransactionId,
    });
    await fs.chmod(options.controllerStateDir, 0o777);

    await expect(prepareProtectedLocalControlNormalization(options)).rejects.toThrow(
      /control directory is unsafe/,
    );
    expect(await fs.readFile(journalPath, "utf8")).toBe(journal);
    await expect(
      fs.access(path.join(options.supervisorStateDir, "control-normalization", "active.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("backs up only lifecycle metadata and restores it byte-for-byte", async () => {
    const options = await fixture();
    const journalPath = path.join(options.operatorStateDir, "hosted-update-transaction.json");
    const rootTransactionPath = path.join(options.supervisorStateDir, "product-transaction.json");
    const userStatePath = path.join(options.operatorStateDir, "wallets", "registry.json");
    const trustPath = path.join(options.supervisorStateDir, "trusted-root.json");
    const journal = await writeJson(journalPath, {
      schemaVersion: 1,
      phase: "restored",
      transactionId: legacyTransactionId,
    });
    const rootTransaction = await writeJson(rootTransactionPath, {
      schemaVersion: 3,
      phase: "restored",
      durableCommitDecision: false,
    });
    const userState = await writeJson(userStatePath, { wallets: ["keep"] });
    const trust = await writeJson(trustPath, { schemaVersion: 1, root: "keep" });

    const prepared = await prepareProtectedLocalControlNormalization(options);
    expect(prepared.strategy).toBe("UNIVERSAL_TAKEOVER");
    await expect(fs.access(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(rootTransactionPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(userStatePath, "utf8")).toBe(userState);
    expect(await fs.readFile(trustPath, "utf8")).toBe(trust);

    const restored = await rollbackProtectedLocalControlNormalization(options);
    expect(restored.outcome).toBe("restored");
    expect(await fs.readFile(journalPath, "utf8")).toBe(journal);
    expect(await fs.readFile(rootTransactionPath, "utf8")).toBe(rootTransaction);
  });

  it("commits one canonical boundary receipt and retries as standard", async () => {
    const options = await fixture();
    const journalPath = path.join(options.operatorStateDir, "hosted-update-transaction.json");
    const journal = await writeJson(journalPath, {
      schemaVersion: 1,
      phase: "restored",
      transactionId: legacyTransactionId,
    });
    const prepared = await prepareProtectedLocalControlNormalization(options);
    expect(prepared.files).toContainEqual(
      expect.objectContaining({ path: journalPath, digest: digest(journal) }),
    );
    await markProtectedLocalBoundaryCommitted(options);
    const committed = await recoverProtectedLocalControlNormalization(options);
    expect(committed.outcome).toBe("committed");
    expect(committed.targetVersion).toBe(options.targetVersion);
    await expect(fs.access(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await prepareProtectedLocalControlNormalization({
        ...options,
        transactionId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toEqual({ strategy: "STANDARD", reason: "canonical-control" });
    expect(await commitProtectedLocalControlNormalization(options)).toEqual(committed);
  });

  it("accepts a prior success receipt when a later target starts", async () => {
    const options = await fixture();
    await writeJson(path.join(options.operatorStateDir, "hosted-update-transaction.json"), {
      schemaVersion: 1,
      phase: "restored",
      transactionId: legacyTransactionId,
    });
    await prepareProtectedLocalControlNormalization(options);
    await markProtectedLocalBoundaryCommitted(options);
    const priorReceipt = await commitProtectedLocalControlNormalization(options);

    const next = {
      ...options,
      previousVersion: options.targetVersion,
      targetVersion: "1.2.4",
      transactionId: "22222222-2222-4222-8222-222222222222",
    };
    expect(await recoverProtectedLocalControlNormalization(next)).toEqual(priorReceipt);
    expect(await prepareProtectedLocalControlNormalization(next)).toEqual({
      strategy: "STANDARD",
      reason: "canonical-control",
    });
  });
});
