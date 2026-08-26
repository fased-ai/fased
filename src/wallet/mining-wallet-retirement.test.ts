import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMiningRetirementEvidence,
  verifyMiningRecoveryPackage,
  writeMiningRetirementReceipt,
} from "./mining-wallet-retirement.js";

const roots: string[] = [];

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-mining-retirement-"));
  roots.push(root);
  const env = { ...process.env, FASED_STATE_DIR: root };
  const walletDir = path.join(root, "sat-mining", "wallets", "mining");
  fs.mkdirSync(walletDir, { recursive: true });
  const runtime = {
    version: 12,
    recentActions: [],
    pendingPlannerCycles: [],
    claimBacklog: [],
    enabledWanted: false,
    workers: {
      roundWatcher: { enabled: false, running: false },
      epoch: { enabled: false, running: false },
      claim: { enabled: false, running: false },
      recovery: { enabled: false, running: false },
    },
    lastKnownStatus: {
      walletId: "mining",
      currentSolBalanceLamports: "42",
      currentSatBalanceRaw: "99",
      currentCapitalFundedLamports: "0",
      currentCapitalLockedLamports: "0",
      currentCapitalFreeLamports: "0",
      currentCapitalPendingCycleCount: 0,
      exactPendingCycleId: null,
      updatedAt: "2026-07-20T14:00:00.000Z",
    },
  };
  fs.writeFileSync(path.join(walletDir, "runtime-store.json"), `${JSON.stringify(runtime)}\n`, {
    mode: 0o600,
  });
  const status = {
    walletId: "mining",
    running: false,
    drainOnly: false,
    enabledWanted: false,
    statusFresh: true,
    workers: runtime.workers,
    currentSolBalanceLamports: "42",
    currentSatBalanceRaw: "99",
    currentCapitalFundedLamports: "0",
    currentCapitalLockedLamports: "0",
    currentCapitalFreeLamports: "0",
    currentCapitalPendingCycleCount: 0,
    pendingCycleIds: [],
    exactPendingCycleId: null,
    missingCycleCount: 0,
    claimBacklog: { total: 0 },
    updatedAt: "2026-07-20T14:00:00.000Z",
    retirementEvidence: {
      version: 1,
      walletId: "mining",
      scopeKey: "devnet:program:generation:mining",
      protocolGeneration: "sha256:generation-2",
      observedAt: "2026-07-20T14:00:00.000Z",
      newJobsStopped: true,
      workersDrained: true,
      clearingDrained: true,
      submissionsReconciled: true,
      pendingCommits: 0,
      pendingReveals: 0,
      pendingSettlements: 0,
      pendingClaims: 0,
      pendingCleanup: 0,
      pendingAltMutations: 0,
      runtimeStateHash: `sha256:${"a".repeat(64)}`,
      submissionLedgerHash: `sha256:${"b".repeat(64)}`,
    },
  };
  return { root, env, walletDir, runtime, status };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Mining wallet retirement evidence", () => {
  it("proves stopped workers, zero Clearing state, balances, and reconciled submissions", () => {
    const fixture = createFixture();
    fs.writeFileSync(
      path.join(fixture.walletDir, "runtime-store.json"),
      '{"enabledWanted":true,"claimBacklog":[{"cycleId":1}]}\n',
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(fixture.walletDir, "submission-ledger.json"),
      '{"version":1,"records":{"stale":{"state":"unknown","action":"commitCycle"}}}\n',
      { mode: 0o600 },
    );
    const evidence = buildMiningRetirementEvidence({
      walletId: "mining",
      signerWalletId: "mining",
      publicKey: "source-public-key",
      signerSolBalanceLamports: "42",
      liveStatus: { payload: { status: fixture.status } },
      env: fixture.env,
    });
    expect(evidence).toMatchObject({
      newJobsStopped: true,
      workersDrained: true,
      clearingDrained: true,
      submissionsReconciled: true,
      solBalanceLamports: "42",
      satBalanceRaw: "99",
      pendingCommits: 0,
      pendingReveals: 0,
      pendingSettlements: 0,
      pendingClaims: 0,
      pendingCleanup: 0,
      pendingAltMutations: 0,
    });
    expect(evidence.runtimeStateHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(evidence.submissionLedgerHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("refuses unresolved SQLite state and degraded balance evidence", () => {
    const fixture = createFixture();
    expect(() =>
      buildMiningRetirementEvidence({
        walletId: "mining",
        signerWalletId: "mining",
        publicKey: "source-public-key",
        signerSolBalanceLamports: "42",
        liveStatus: {
          ...fixture.status,
          retirementEvidence: {
            ...fixture.status.retirementEvidence,
            submissionsReconciled: false,
            pendingAltMutations: 1,
          },
        },
        env: fixture.env,
      }),
    ).toThrow(/snapshot/u);
    expect(() =>
      buildMiningRetirementEvidence({
        walletId: "mining",
        signerWalletId: "mining",
        publicKey: "source-public-key",
        signerSolBalanceLamports: "42",
        liveStatus: {
          ...fixture.status,
          retirementEvidence: {
            ...fixture.status.retirementEvidence,
            pendingCommits: "0",
          },
        },
        env: fixture.env,
      }),
    ).toThrow(/invalid pending commit count/u);
    expect(() =>
      buildMiningRetirementEvidence({
        walletId: "mining",
        signerWalletId: "mining",
        publicKey: "source-public-key",
        signerSolBalanceLamports: "42",
        liveStatus: { ...fixture.status, statusFresh: false },
        env: fixture.env,
      }),
    ).toThrow(/degraded/u);
  });

  it("binds the encrypted recovery package and writes a secret-free owner-only receipt", () => {
    const fixture = createFixture();
    const recoveryFile = path.join(fixture.root, "mining-recovery.json");
    fs.writeFileSync(
      recoveryFile,
      `${JSON.stringify({
        kind: "fased-signer-wallet-recovery",
        version: 1,
        walletId: "mining",
        role: "mining",
        publicKey: "source-public-key",
        createdAt: "2026-07-20T13:00:00.000Z",
        kdf: {
          name: "argon2id",
          memoryKiB: 64 * 1024,
          iterations: 3,
          parallelism: 1,
          salt: Buffer.alloc(16, 1).toString("base64url"),
        },
        encryption: {
          name: "aes-256-gcm",
          nonce: Buffer.alloc(12, 2).toString("base64url"),
          ciphertext: Buffer.alloc(80, 3).toString("base64url"),
        },
      })}\n`,
      { mode: 0o600 },
    );
    const recovery = verifyMiningRecoveryPackage({
      recoveryFile,
      walletId: "mining",
      publicKey: "source-public-key",
    });
    const receiptPath = writeMiningRetirementReceipt({
      sourceWalletId: "mining",
      receipt: {
        kind: "fased-mining-wallet-retirement",
        recoveryPackageHash: recovery.packageHash,
        sourcePublicKey: "source-public-key",
      },
      env: fixture.env,
    });
    expect(recovery.packageHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(receiptPath, "utf8")).not.toMatch(/private|ciphertext|rpc-url/iu);
  });
});
