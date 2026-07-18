import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSatSubmissionRequestId,
  claimSatSubmission,
  readSatSubmission,
  resolveSatSubmissionLedgerPath,
  updateSatSubmission,
} from "./submission-ledger.js";

const execFileAsync = promisify(execFile);
const DIGEST_A = `sha256:${"11".repeat(32)}`;
const DIGEST_B = `sha256:${"22".repeat(32)}`;

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

  it("serializes concurrent workers and lets the waiter claim after the exact owner releases", async () => {
    const first = await claimSatSubmission({
      walletId: "mining-1",
      workflowId: "cycle:42:commit",
      operationKey: "commitCycle:accounts",
      intentDigest: DIGEST_A,
      action: "commitCycle",
      env,
      owner: "worker-a",
    });
    const second = await claimSatSubmission({
      walletId: "mining-1",
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
      walletId: "mining-1",
      requestId: first.record.requestId,
      intentDigest: DIGEST_A,
      state: "confirmed",
      signature: "sig-42",
      owner: "worker-a",
      releaseLease: true,
      env,
    });
    const retry = await claimSatSubmission({
      walletId: "mining-1",
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

  it("does not lose distinct records created concurrently in one process", async () => {
    const claims = await Promise.all(
      Array.from(
        { length: 24 },
        async (_, index) =>
          await claimSatSubmission({
            walletId: "mining-1",
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
            walletId: "mining-1",
            requestId: claim.record.requestId,
            env,
          }),
      ),
    );
    expect(records.every(Boolean)).toBe(true);
  });

  it("fails closed when one idempotency key is reused for a different immutable intent", async () => {
    await claimSatSubmission({
      walletId: "mining-1",
      workflowId: "manual-key",
      operationKey: "deposit:capital-account",
      intentDigest: DIGEST_A,
      action: "depositMinerCapital",
      env,
    });

    await expect(
      claimSatSubmission({
        walletId: "mining-1",
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
      walletId: "mining-1",
      workflowId: "cycle:18:commit",
      operationKey: "commitCycle:accounts",
      intentDigest: DIGEST_A,
      action: "commitCycle",
      env,
      owner: "worker-a",
    });
    await updateSatSubmission({
      walletId: "mining-1",
      requestId: claim.record.requestId,
      intentDigest: DIGEST_A,
      state: "unknown",
      error: "transport closed after submission",
      owner: "worker-a",
      env,
    });

    await expect(
      updateSatSubmission({
        walletId: "mining-1",
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
      walletId: "mining-1",
      workflowId: "cycle:7:reveal",
      operationKey: "reveal:cycle-7",
      intentDigest: DIGEST_A,
      action: "revealCycle",
      env: shortLeaseEnv,
      owner: "crashed-worker",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const recovered = await claimSatSubmission({
      walletId: "mining-1",
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
      walletId: "mining-1",
      workflowId: "cycle:99:settle:0:0",
      operationKey: "settle:cycle-99-page-0",
      intentDigest: DIGEST_A,
      action: "settleCyclePage",
      env,
      owner: "parent-after-restart",
    });
    const expectedRequestId = buildSatSubmissionRequestId({
      walletId: "mining-1",
      workflowId: "cycle:99:settle:0:0",
      operationKey: "settle:cycle-99-page-0",
    });
    expect(recovered).toMatchObject({ created: false, claimed: true });
    expect(recovered.record.requestId).toBe(expectedRequestId);

    const persisted = await readSatSubmission({
      walletId: "mining-1",
      requestId: expectedRequestId,
      env,
    });
    expect(persisted?.attempts).toBe(2);
    expect(resolveSatSubmissionLedgerPath({ walletId: "mining-1", env })).toContain(stateDir);
  });
});
