import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MiningReadyAgentProjection } from "../../../src/agents/agent-mining-ready-projection.js";
import type { FirstPartyAdapterSignerRequest } from "../../../src/agents/capability-adapter-authorization.js";
import { executeGuardedMiningLifecycle } from "./agent-guarded-auto.js";

const admitAgentFinancialAction = vi.hoisted(() =>
  vi.fn(async () => ({ intentDigest: "a".repeat(64) })),
);
const appendFinancialEvent = vi.hoisted(() => vi.fn(async (value) => value));

vi.mock("../../../src/agents/agent-financial-admission.js", () => ({
  admitAgentFinancialAction,
  ReconciledRiskSnapshotSchema: {},
}));
vi.mock("../../../src/agents/agent-truth-store.js", () => ({ appendFinancialEvent }));

function projection(patch: Partial<MiningReadyAgentProjection> = {}): MiningReadyAgentProjection {
  return {
    schema: "fased.agent.mining-ready-projection.v1",
    agentId: "wally",
    mode: "guarded-auto",
    profiles: {} as MiningReadyAgentProjection["profiles"],
    capability: {
      capabilityId: "fased.mining",
      version: 1,
      adapterId: "fased.mining-adapter",
      adapterOperations: [
        "cycle.commit",
        "cycle.reveal",
        "cycle.recover",
        "cycle.claim",
        "capital.drain",
      ],
      signerKeyId: "key",
    },
    authority: { capitalPolicyMode: "allowlisted", ownerApprovalRequired: false },
    truth: {
      researchRoot: null,
      financialRoot: null,
      publicEvidenceBuiltAt: "2026-09-02T00:00:00.000Z",
    },
    mining: {
      integrity: "verified",
      lifecycle: "active",
      entryState: "enabled",
    } as MiningReadyAgentProjection["mining"],
    qualification: { status: "pass" } as MiningReadyAgentProjection["qualification"],
    privateMining: {
      channelAllocations: Array.from({ length: 16 }, () => "625"),
      allocationDigestSha256: "b".repeat(64),
      allocationState: "draft",
      configuredCadenceCycles: "48",
      recommendedCadenceCycles: "48",
      projectedRunwayCycles: "1000",
      projectedRunwayDays: "166",
      nextEligibleCycleId: "42",
      operatingReserveState: "healthy",
      lifecycleState: "idle",
    },
    ...patch,
  };
}

function request(operation = "cycle.commit"): FirstPartyAdapterSignerRequest {
  return {
    schema: "fased.first-party-adapter-signer-request.v1",
    requestId: `request-${operation.replaceAll(".", "-")}`,
    capabilityId: "fased.mining",
    adapterId: "fased.mining-adapter",
    operation,
    installedArtifactSha256: "c".repeat(64),
    chain: "solana",
    walletId: "mining",
    walletRole: "mining",
    programId: "sat-program",
    assetId: "solana.native",
    destination: "miner-capital-pda",
    amountAtoms: operation === "cycle.commit" ? "1000000000" : "0",
    slippageBps: 0,
    ownerApproved: true,
    policyGeneration: 2,
    policyDigest: "d".repeat(64),
    signerPolicyVersion: 7,
    signerPolicyHash: `sha256:${"e".repeat(64)}`,
    requestedAt: "2026-09-02T12:00:00.000Z",
    expiresAt: "2026-09-02T12:05:00.000Z",
  };
}

function common(operation = "cycle.commit", currentProjection = projection()) {
  const currentRequest = request(operation);
  return {
    agentId: "wally",
    projection: currentProjection,
    operation: operation as Parameters<typeof executeGuardedMiningLifecycle>[0]["operation"],
    envelope: {} as Parameters<typeof executeGuardedMiningLifecycle>[0]["envelope"],
    trustedSignerKeys: {},
    request: currentRequest,
    signerPolicyReader: { getSignerPolicy: vi.fn() },
    riskSnapshot: {} as Parameters<typeof executeGuardedMiningLifecycle>[0]["riskSnapshot"],
    env: {},
    now: new Date("2026-09-02T12:00:00.000Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("guarded-auto SAT mining lifecycle", () => {
  it("admits a commit before typed execution and records only the finalized result", async () => {
    const execute = vi.fn(async () => ({
      requestId: "request-cycle-commit",
      state: "confirmed" as const,
      signature: "solana:signature-42",
    }));

    await expect(executeGuardedMiningLifecycle({ ...common(), execute })).resolves.toMatchObject({
      state: "confirmed",
      canonicalRef: "solana:signature-42",
    });

    expect(admitAgentFinancialAction).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({
      workflowId: "agent:wally:request-cycle-commit",
      requestId: "request-cycle-commit",
      operation: "cycle.commit",
    });
    expect(admitAgentFinancialAction.mock.invocationCallOrder[0]).toBeLessThan(
      execute.mock.invocationCallOrder[0]!,
    );
    expect(appendFinancialEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "settlement-request-cycle-commit",
        kind: "position",
        status: "settled",
        canonicalRef: "solana:signature-42",
      }),
    );
  });

  it("blocks new entry while paused but leaves reveal, recovery, claim, and drain live", async () => {
    const paused = projection({
      mining: {
        ...projection().mining,
        entryState: "paused",
      },
      qualification: { status: "fail" } as MiningReadyAgentProjection["qualification"],
    });
    const execute = vi.fn(async ({ requestId }: { requestId: string; workflowId: string }) => ({
      requestId,
      state: "confirmed" as const,
      canonicalRef: `solana:${requestId}`,
    }));

    await expect(
      executeGuardedMiningLifecycle({ ...common("cycle.commit", paused), execute }),
    ).rejects.toThrow("new mining entry is unavailable");

    for (const operation of [
      "cycle.reveal",
      "cycle.recover",
      "cycle.claim",
      "capital.drain",
    ] as const) {
      await expect(
        executeGuardedMiningLifecycle({ ...common(operation, paused), execute }),
      ).resolves.toMatchObject({ state: "confirmed" });
    }
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("refuses commits before admission when mode, identity, reserve, or lifecycle is unsafe", async () => {
    const execute = vi.fn();
    const cases = [
      projection({ mode: "propose" }),
      projection({ mining: { ...projection().mining, integrity: "conflict" } }),
      projection({
        privateMining: { ...projection().privateMining, operatingReserveState: "exhausted" },
      }),
      projection({
        privateMining: { ...projection().privateMining, lifecycleState: "reveal_pending" },
      }),
    ];
    for (const unsafe of cases) {
      await expect(
        executeGuardedMiningLifecycle({ ...common("cycle.commit", unsafe), execute }),
      ).rejects.toThrow();
    }
    expect(admitAgentFinancialAction).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("reuses one durable request after restart and never settles an ambiguous broadcast", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        requestId: "request-cycle-reveal",
        state: "unknown" as const,
        signature: "signature-pending",
      })
      .mockResolvedValueOnce({
        requestId: "request-cycle-reveal",
        state: "confirmed" as const,
        signature: "signature-final",
      });
    const input = { ...common("cycle.reveal"), execute };

    await expect(executeGuardedMiningLifecycle(input)).resolves.toMatchObject({ state: "unknown" });
    expect(appendFinancialEvent).not.toHaveBeenCalled();
    await expect(executeGuardedMiningLifecycle(input)).resolves.toMatchObject({
      state: "confirmed",
    });

    expect(execute.mock.calls.map((call) => call[0])).toEqual([
      {
        workflowId: "agent:wally:request-cycle-reveal",
        requestId: "request-cycle-reveal",
        operation: "cycle.reveal",
      },
      {
        workflowId: "agent:wally:request-cycle-reveal",
        requestId: "request-cycle-reveal",
        operation: "cycle.reveal",
      },
    ]);
    expect(appendFinancialEvent).toHaveBeenCalledOnce();
  });

  it("runs the complete commit, reveal, recovery, claim, and drain matrix as separate receipts", async () => {
    const execute = vi.fn(async ({ requestId }: { requestId: string; workflowId: string }) => ({
      requestId,
      state: "confirmed" as const,
      canonicalRef: `solana:${requestId}`,
    }));
    for (const operation of [
      "cycle.commit",
      "cycle.reveal",
      "cycle.recover",
      "cycle.claim",
      "capital.drain",
    ] as const) {
      await executeGuardedMiningLifecycle({ ...common(operation), execute });
    }

    expect(appendFinancialEvent.mock.calls.map((call) => call[0].kind)).toEqual([
      "position",
      "reconciliation",
      "reconciliation",
      "claim",
      "withdrawal",
    ]);
    expect(new Set(execute.mock.calls.map((call) => call[0].workflowId)).size).toBe(5);
  });

  it("rejects operation, Agent, capability, and executor request drift", async () => {
    const execute = vi.fn(async () => ({
      requestId: "another-request",
      state: "confirmed" as const,
      signature: "signature",
    }));
    await expect(
      executeGuardedMiningLifecycle({ ...common(), agentId: "other", execute }),
    ).rejects.toThrow("belongs to another Agent");
    await expect(
      executeGuardedMiningLifecycle({
        ...common(),
        request: { ...request(), operation: "cycle.reveal" },
        execute,
      }),
    ).rejects.toThrow("does not match the signer request");
    await expect(executeGuardedMiningLifecycle({ ...common(), execute })).rejects.toThrow(
      "returned another durable request id",
    );
    expect(appendFinancialEvent).not.toHaveBeenCalled();
  });
});
