import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildSatSubmissionOperationKey,
  callLocalSocketSigner,
  claimSatSubmission,
  digestSatSubmissionIntent,
  updateSatSubmission,
  waitForSatSubmissionLease,
} = vi.hoisted(() => ({
  buildSatSubmissionOperationKey: vi.fn(() => "initMinerCapital"),
  callLocalSocketSigner: vi.fn(),
  claimSatSubmission: vi.fn(),
  digestSatSubmissionIntent: vi.fn(() => `sha256:${"ab".repeat(32)}`),
  updateSatSubmission: vi.fn(async () => undefined),
  waitForSatSubmissionLease: vi.fn(async () => undefined),
}));

vi.mock("fased/plugin-sdk/sat-runtime", () => ({
  callLocalSocketSigner,
  createSignerReviewApprovalRequest: vi.fn(),
}));

vi.mock("./submission-ledger.js", () => ({
  buildSatSubmissionOperationKey,
  claimSatSubmission,
  digestSatSubmissionIntent,
  updateSatSubmission,
  waitForSatSubmissionLease,
}));

import { SAT_RUNTIME_PROTOCOL_GENERATION } from "./state-identity.js";
import {
  assertSatSignerOperationIdentity,
  executeTypedSatIntent,
  runWithSatSubmissionWorkflow,
} from "./submission-service.js";

const instruction = {
  action: "initMinerCapital" as const,
  programId: "program-id",
  dataBase64: "AA==",
  keys: [{ pubkey: "signer", isSigner: true, isWritable: true }],
};

function claimedSubmission() {
  return {
    created: true,
    claimed: true,
    owner: "worker-1",
    record: {
      requestId: "request-exact",
      state: "reserved" as const,
    },
  };
}

function typedCapabilities() {
  return {
    ready: true,
    capabilities: {
      protocol: { current: 2, min: 2, max: 2 },
      intentTypes: ["solana.satAction"],
      operationStates: ["reserved", "broadcast", "confirmed", "failed", "unknown"],
      features: [
        "failClosedPolicies",
        "policyHashes",
        "durableCaps",
        "atomicIdempotency",
        "ambiguousBroadcastReconciliation",
        "signerOwnedKeys",
        "signerOwnedEncryptedSATCommitments",
        "typedSolanaTransactions",
        "typedSATActions",
      ],
    },
  };
}

describe("SAT submission service boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimSatSubmission.mockResolvedValue(claimedSubmission());
    callLocalSocketSigner.mockImplementation(
      async (_socketPath: string, payload: { op?: string; request?: { requestId?: string } }) => {
        if (payload.op === "v2.capabilities") {
          return typedCapabilities();
        }
        if (payload.op === "v2.policy.get") {
          return { hash: `sha256:${"cd".repeat(32)}` };
        }
        if (payload.op === "v2.execute") {
          return {
            requestId: payload.request?.requestId,
            state: "confirmed",
            signature: "signature-confirmed",
          };
        }
        throw new Error(`unexpected signer operation ${payload.op}`);
      },
    );
  });

  it("owns durable workflow staging and signer execution outside the stable facade", async () => {
    const [service, facade] = await Promise.all([
      readFile(new URL("./submission-service.ts", import.meta.url), "utf8"),
      readFile(new URL("./solana-submit.ts", import.meta.url), "utf8"),
    ]);

    expect(service).toContain('from "node:async_hooks"');
    expect(service).toContain("claimSatSubmission(");
    expect(service).toContain("waitForSatSubmissionLease(");
    expect(service).toContain("updateSatSubmission(");
    expect(service).toContain('op: "v2.execute"');
    expect(service).toContain('op: "v2.operation.reconcile"');
    expect(facade).toContain('from "./submission-service.js"');
    expect(facade).toContain(
      'export { runWithSatSubmissionWorkflow } from "./submission-service.js"',
    );
    expect(facade).not.toContain('from "node:async_hooks"');
    expect(facade).not.toContain("claimSatSubmission(");
    expect(facade).not.toContain("waitForSatSubmissionLease(");
    expect(facade).not.toContain('op: "v2.execute"');
    expect(facade).toContain("actionOverride: params.actionOverride");
    expect(facade).toContain("keeperFeePayer: params.keeperFeePayer");
    expect(facade).toMatch(/actionOverride: "openCycleV2" as const, keeperFeePayer: true/u);
  });

  it("normalizes one printable workflow key for the exact async scope", async () => {
    const task = vi.fn(async () => "submitted");

    await expect(runWithSatSubmissionWorkflow("  cycle:42:commit  ", task)).resolves.toBe(
      "submitted",
    );
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("rejects empty, control-bearing, and oversized workflow keys before execution", async () => {
    const task = vi.fn(async () => "not-run");

    await expect(runWithSatSubmissionWorkflow("   ", task)).rejects.toThrow(
      "SAT submission idempotency key must contain 1-240 printable characters",
    );
    await expect(runWithSatSubmissionWorkflow("cycle\n42", task)).rejects.toThrow(
      "SAT submission idempotency key must contain 1-240 printable characters",
    );
    await expect(runWithSatSubmissionWorkflow("x".repeat(241), task)).rejects.toThrow(
      "SAT submission idempotency key must contain 1-240 printable characters",
    );
    expect(task).not.toHaveBeenCalled();
  });

  it("rejects a signer response bound to another durable request", () => {
    expect(() =>
      assertSatSignerOperationIdentity(
        { requestId: "request-other", state: "confirmed", signature: "signature" },
        "request-exact",
      ),
    ).toThrow("SAT signer returned request request-other while reconciling request-exact");
  });

  it("returns one typed confirmed outcome and persists the exact signer result", async () => {
    await expect(
      executeTypedSatIntent({
        socketPath: "/run/fased-signerd.sock",
        walletId: "wallet-mining",
        stateProgramId: "program-id",
        action: "initMinerCapital",
        instruction,
        cluster: "devnet",
        env: {},
      }),
    ).resolves.toEqual({
      requestId: "request-exact",
      state: "confirmed",
      signature: "signature-confirmed",
    });

    expect(callLocalSocketSigner.mock.calls.map((call) => call[1]?.op)).toEqual([
      "v2.capabilities",
      "v2.policy.get",
      "v2.execute",
    ]);
    expect(updateSatSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        cluster: "devnet",
        programId: "program-id",
        protocolGeneration: SAT_RUNTIME_PROTOCOL_GENERATION,
        walletId: "wallet-mining",
        requestId: "request-exact",
        state: "confirmed",
        signature: "signature-confirmed",
        releaseLease: true,
      }),
    );
  });

  it("uses the signer-owned keeper capability while keeping the Mining ledger identity", async () => {
    callLocalSocketSigner.mockImplementation(
      async (
        _socketPath: string,
        payload: {
          op?: string;
          walletId?: string;
          request?: { requestId?: string; intent?: unknown };
        },
      ) => {
        if (payload.op === "v2.keeperFeePayer.get") {
          return {
            miningWalletId: "wallet-mining",
            feePayerWalletId: `sat_kfp_${"a".repeat(56)}`,
            feePayerPublicKey: "keeper-public-key",
            state: "ready",
          };
        }
        if (payload.op === "v2.capabilities") {
          const capabilities = typedCapabilities();
          capabilities.capabilities.intentTypes.push("solana.satKeeperAction");
          capabilities.capabilities.features.push("signerOwnedKeeperFeePayer");
          return capabilities;
        }
        if (payload.op === "v2.policy.get") {
          expect(payload.walletId).toBe(`sat_kfp_${"a".repeat(56)}`);
          return { hash: `sha256:${"ef".repeat(32)}` };
        }
        if (payload.op === "v2.execute") {
          expect(payload.walletId).toBe(`sat_kfp_${"a".repeat(56)}`);
          expect(payload.request?.intent).toMatchObject({
            type: "solana.satKeeperAction",
            authorityWalletId: "wallet-mining",
            action: "settleCyclePageV2",
          });
          return {
            requestId: payload.request?.requestId,
            state: "confirmed",
            signature: "keeper-signature",
          };
        }
        throw new Error(`unexpected signer operation ${payload.op}`);
      },
    );

    await expect(
      executeTypedSatIntent({
        socketPath: "/run/fased-signerd.sock",
        walletId: "wallet-mining",
        stateProgramId: "program-id",
        action: "settleCyclePageV2",
        instruction: { ...instruction, action: "settleCyclePageV2" },
        cluster: "devnet",
        env: {},
        useKeeperFeePayer: true,
      }),
    ).resolves.toMatchObject({ state: "confirmed", signature: "keeper-signature" });

    expect(updateSatSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: "wallet-mining",
        state: "confirmed",
        signature: "keeper-signature",
      }),
    );
  });

  it("reconciles an ambiguous broadcast without issuing a second execute", async () => {
    callLocalSocketSigner.mockImplementation(
      async (_socketPath: string, payload: { op?: string; request?: { requestId?: string } }) => {
        if (payload.op === "v2.capabilities") {
          return typedCapabilities();
        }
        if (payload.op === "v2.policy.get") {
          return { hash: `sha256:${"cd".repeat(32)}` };
        }
        if (payload.op === "v2.execute") {
          throw new Error("socket closed after possible broadcast");
        }
        if (payload.op === "v2.operation.get") {
          return {
            requestId: payload.request?.requestId,
            state: "unknown",
            signature: "signature-ambiguous",
          };
        }
        if (payload.op === "v2.operation.reconcile") {
          return {
            requestId: payload.request?.requestId,
            state: "confirmed",
            signature: "signature-ambiguous",
          };
        }
        throw new Error(`unexpected signer operation ${payload.op}`);
      },
    );

    await expect(
      executeTypedSatIntent({
        socketPath: "/run/fased-signerd.sock",
        walletId: "wallet-mining",
        stateProgramId: "program-id",
        action: "initMinerCapital",
        instruction,
        cluster: "devnet",
        env: {},
      }),
    ).resolves.toMatchObject({
      requestId: "request-exact",
      state: "confirmed",
      signature: "signature-ambiguous",
    });
    expect(
      callLocalSocketSigner.mock.calls.filter((call) => call[1]?.op === "v2.execute"),
    ).toHaveLength(1);
    expect(callLocalSocketSigner.mock.calls.map((call) => call[1]?.op)).toEqual([
      "v2.capabilities",
      "v2.policy.get",
      "v2.execute",
      "v2.operation.get",
      "v2.operation.reconcile",
    ]);
  });
});
