import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSatSubmissionOperationKey,
  buildSatSubmissionRequestId,
  claimSatSubmission,
  parseSatSubmissionRecordsBytes,
  readSatSubmission,
  resolveSatSubmissionLedgerPath,
  updateSatSubmission,
} from "./submission-ledger.js";

const execFileAsync = promisify(execFile);
const DIGEST_A = `sha256:${"11".repeat(32)}`;
const DIGEST_B = `sha256:${"22".repeat(32)}`;
const STATE_IDENTITY = {
  cluster: "devnet" as const,
  programId: "sat-program-generation-2",
  protocolGeneration: "sat-protocol-generation-2",
  walletId: "mining-1",
};

describe("SAT durable submission ledger", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-sat-ledger-test-"));
    env = { ...process.env, FASED_STATE_DIR: stateDir, FASED_SAT_SUBMISSION_LEASE_MS: "5000" };
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("binds lookup-table extension chunks to their exact semantic addresses", () => {
    const first = buildSatSubmissionOperationKey({
      action: "extend",
      lookupTable: { address: "table", addresses: ["a", "b"] },
    });
    const second = buildSatSubmissionOperationKey({
      action: "extend",
      lookupTable: { address: "table", addresses: ["c"] },
    });
    expect(first).not.toBe(second);
    expect(first).toBe(
      buildSatSubmissionOperationKey({
        action: "extend",
        lookupTable: { address: "table", addresses: ["a", "b"] },
      }),
    );
  });

  it("isolates durable requests by cluster, program, protocol generation, and Wallet", async () => {
    const otherIdentities = [
      { ...STATE_IDENTITY, cluster: "mainnet-beta" as const },
      { ...STATE_IDENTITY, programId: "sat-program-generation-3" },
      { ...STATE_IDENTITY, protocolGeneration: "sat-protocol-generation-3" },
      { ...STATE_IDENTITY, walletId: "mining-2" },
    ];
    const shared = {
      workflowId: "cycle:42:commit",
      operationKey: "commitCycle:accounts",
      intentDigest: DIGEST_A,
      action: "commitCycle",
      env,
    };

    const exact = await claimSatSubmission({
      ...STATE_IDENTITY,
      ...shared,
      owner: "worker-exact",
    });
    for (const [index, identity] of otherIdentities.entries()) {
      const isolated = await claimSatSubmission({
        ...identity,
        ...shared,
        owner: `worker-isolated-${index}`,
      });
      expect(isolated.record.requestId).not.toBe(exact.record.requestId);
      expect(resolveSatSubmissionLedgerPath({ ...STATE_IDENTITY, env })).not.toBe(
        resolveSatSubmissionLedgerPath({ ...identity, env }),
      );
      await expect(
        readSatSubmission({
          ...identity,
          requestId: exact.record.requestId,
          env,
        }),
      ).resolves.toBeNull();
    }
  });

  it("parses descriptor-pinned migration bytes without reopening a ledger path", () => {
    expect(
      parseSatSubmissionRecordsBytes(
        Buffer.from(
          JSON.stringify({
            version: 1,
            records: {
              "request-b": {
                requestId: "request-b",
                workflowId: "cycle:2",
                operationKey: "commit:2",
                intentDigest: DIGEST_B,
                walletId: "mining-1",
                action: "commitCycle",
                state: "prepared",
                attempts: 1,
                createdAt: "2026-08-19T00:00:00.000Z",
                updatedAt: "2026-08-19T00:00:00.000Z",
              },
            },
          }),
        ),
      ),
    ).toMatchObject([{ requestId: "request-b", intentDigest: DIGEST_B }]);
  });

  it("serializes concurrent workers and lets the waiter claim after the exact owner releases", async () => {
    const first = await claimSatSubmission({
      ...STATE_IDENTITY,
      workflowId: "cycle:42:commit",
      operationKey: "commitCycle:accounts",
      intentDigest: DIGEST_A,
      action: "commitCycle",
      env,
      owner: "worker-a",
    });
    const second = await claimSatSubmission({
      ...STATE_IDENTITY,
      workflowId: "cycle:42:commit",
      operationKey: "commitCycle:accounts",
      intentDigest: DIGEST_A,
      action: "commitCycle",
      env,
      owner: "worker-b",
    });

    expect(first).toMatchObject({ created: true, claimed: true });
    expect(second).toMatchObject({ created: false, claimed: false });

    await updateSatSubmission({
      ...STATE_IDENTITY,
      requestId: first.record.requestId,
      intentDigest: DIGEST_A,
      state: "confirmed",
      signature: "sig-42",
      owner: "worker-a",
      releaseLease: true,
      env,
    });
    const retry = await claimSatSubmission({
      ...STATE_IDENTITY,
      workflowId: "cycle:42:commit",
      operationKey: "commitCycle:accounts",
      intentDigest: DIGEST_A,
      action: "commitCycle",
      env,
      owner: "worker-b",
    });
    expect(retry).toMatchObject({ created: false, claimed: true });
    expect(retry.record.signature).toBe("sig-42");
  });

  it("allocates a new request only for an explicitly retryable definitive failure", async () => {
    const first = await claimSatSubmission({
      ...STATE_IDENTITY,
      workflowId: "cycle:42:lookup:extend",
      operationKey: "extend:lookup-table",
      intentDigest: DIGEST_A,
      action: "extend",
      allowFailedRetry: true,
      env,
      owner: "worker-a",
    });
    await updateSatSubmission({
      ...STATE_IDENTITY,
      requestId: first.record.requestId,
      intentDigest: DIGEST_A,
      state: "failed",
      signature: "definitively-failed-lookup-signature",
      error: "pre-broadcast preparation failed",
      owner: "worker-a",
      releaseLease: true,
      env,
    });

    const retry = await claimSatSubmission({
      ...STATE_IDENTITY,
      workflowId: "cycle:42:lookup:extend",
      operationKey: "extend:lookup-table",
      intentDigest: DIGEST_A,
      action: "extend",
      allowFailedRetry: true,
      env,
      owner: "worker-b",
    });
    expect(retry).toMatchObject({ created: true, claimed: true });
    expect(retry.record.requestId).not.toBe(first.record.requestId);
    expect(retry.record.operationKey).toBe("extend:lookup-table:retry:1");

    const stable = await claimSatSubmission({
      ...STATE_IDENTITY,
      workflowId: "cycle:42:lookup:extend",
      operationKey: "extend:lookup-table",
      intentDigest: DIGEST_A,
      action: "extend",
      env,
      owner: "worker-c",
    });
    expect(stable.record.requestId).toBe(first.record.requestId);
    expect(stable.record.state).toBe("failed");
  });

  it("does not lose distinct records created concurrently in one process", async () => {
    const claims = await Promise.all(
      Array.from(
        { length: 24 },
        async (_, index) =>
          await claimSatSubmission({
            ...STATE_IDENTITY,
            workflowId: `cycle:${index}:open`,
            operationKey: `openCycle:cycle-${index}`,
            intentDigest: `sha256:${index.toString(16).padStart(2, "0").repeat(32)}`,
            action: "openCycle",
            env,
            owner: `worker-${index}`,
          }),
      ),
    );

    expect(new Set(claims.map((claim) => claim.record.requestId)).size).toBe(24);
    const records = await Promise.all(
      claims.map(
        async (claim) =>
          await readSatSubmission({
            ...STATE_IDENTITY,
            requestId: claim.record.requestId,
            env,
          }),
      ),
    );
    expect(records.every(Boolean)).toBe(true);
  });

  it("fails closed when one idempotency key is reused for a different immutable intent", async () => {
    await claimSatSubmission({
      ...STATE_IDENTITY,
      workflowId: "manual-key",
      operationKey: "deposit:capital-account",
      intentDigest: DIGEST_A,
      action: "depositMinerCapital",
      env,
    });

    await expect(
      claimSatSubmission({
        ...STATE_IDENTITY,
        workflowId: "manual-key",
        operationKey: "deposit:capital-account",
        intentDigest: DIGEST_B,
        action: "depositMinerCapital",
        env,
      }),
    ).rejects.toThrow(/idempotency collision/);
  });

  it("rejects state regression after a potentially broadcast operation", async () => {
    const claim = await claimSatSubmission({
      ...STATE_IDENTITY,
      workflowId: "cycle:18:commit",
      operationKey: "commitCycle:accounts",
      intentDigest: DIGEST_A,
      action: "commitCycle",
      env,
      owner: "worker-a",
    });
    await updateSatSubmission({
      ...STATE_IDENTITY,
      requestId: claim.record.requestId,
      intentDigest: DIGEST_A,
      state: "unknown",
      error: "transport closed after submission",
      owner: "worker-a",
      env,
    });

    await expect(
      updateSatSubmission({
        ...STATE_IDENTITY,
        requestId: claim.record.requestId,
        intentDigest: DIGEST_A,
        state: "reserved",
        owner: "worker-a",
        env,
      }),
    ).rejects.toThrow(/cannot move from unknown back to reserved/);
  });

  it("recovers a stale lease after its bounded expiry", async () => {
    const shortLeaseEnv = { ...env, FASED_SAT_SUBMISSION_LEASE_MS: "75" };
    const first = await claimSatSubmission({
      ...STATE_IDENTITY,
      workflowId: "cycle:7:reveal",
      operationKey: "reveal:cycle-7",
      intentDigest: DIGEST_A,
      action: "revealCycle",
      env: shortLeaseEnv,
      owner: "crashed-worker",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const recovered = await claimSatSubmission({
      ...STATE_IDENTITY,
      workflowId: "cycle:7:reveal",
      operationKey: "reveal:cycle-7",
      intentDigest: DIGEST_A,
      action: "revealCycle",
      env: shortLeaseEnv,
      owner: "recovery-worker",
    });
    expect(recovered).toMatchObject({ created: false, claimed: true });
    expect(recovered.record.requestId).toBe(first.record.requestId);
  });

  it("reopens the same durable request after the owning process exits mid-flight", async () => {
    const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "submission-ledger.ts")).href;
    const script = `
      const ledger = await import(${JSON.stringify(moduleUrl)});
      const claim = await ledger.claimSatSubmission({
        cluster: "devnet",
        programId: "sat-program-generation-2",
        protocolGeneration: "sat-protocol-generation-2",
        walletId: "mining-1",
        workflowId: "cycle:99:settle:0:0",
        operationKey: "settle:cycle-99-page-0",
        intentDigest: ${JSON.stringify(DIGEST_A)},
        action: "settleCyclePage",
        env: process.env,
        owner: "child-before-crash"
      });
      process.stdout.write(claim.record.requestId);
    `;
    await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: path.resolve(import.meta.dirname, "../../.."), env, encoding: "utf8" },
    );

    const recovered = await claimSatSubmission({
      ...STATE_IDENTITY,
      workflowId: "cycle:99:settle:0:0",
      operationKey: "settle:cycle-99-page-0",
      intentDigest: DIGEST_A,
      action: "settleCyclePage",
      env,
      owner: "parent-after-restart",
    });
    const expectedRequestId = buildSatSubmissionRequestId({
      ...STATE_IDENTITY,
      workflowId: "cycle:99:settle:0:0",
      operationKey: "settle:cycle-99-page-0",
    });
    expect(recovered).toMatchObject({ created: false, claimed: true });
    expect(recovered.record.requestId).toBe(expectedRequestId);

    const persisted = await readSatSubmission({
      ...STATE_IDENTITY,
      requestId: expectedRequestId,
      env,
    });
    expect(persisted?.attempts).toBe(2);
    expect(resolveSatSubmissionLedgerPath({ ...STATE_IDENTITY, env })).toContain(stateDir);
  });
});
