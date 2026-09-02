import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";
import { projectMiningReadyAgent } from "./agent-mining-ready-projection.js";
import { ensureAgentProfileState } from "./agent-profile-store.js";
import { ensureAgentTruthStores } from "./agent-truth-store.js";
import {
  capabilityManifestSigningPayloadForTest,
  createZeroCapabilityPermissions,
  firstPartySignerKeyId,
  type FirstPartyCapabilityManifest,
  type SignedFirstPartyCapabilityManifest,
} from "./capability-manifest.js";
import type { FinalizedFinancialAgentReadback } from "./financial-agent-binding.js";
import { buildTemplateProfilePayloads } from "./persona-templates.js";

const roots: string[] = [];
const now = new Date("2026-09-02T12:00:00.000Z");

function address(): string {
  return Keypair.generate().publicKey.toBase58();
}

function testEnv(): NodeJS.ProcessEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-agent-mining-projection-"));
  roots.push(root);
  return { ...process.env, FASED_STATE_DIR: root };
}

function signedManifest(): {
  envelope: SignedFirstPartyCapabilityManifest;
  trustedKeys: Record<string, string>;
} {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const manifest: FirstPartyCapabilityManifest = {
    schema: "fased.first-party-capability-manifest.v1",
    capabilityId: "satcoin-mining",
    version: 1,
    adapterId: "satcoin-mining-read",
    adapterOperations: [
      "sat.mining-status",
      "sat.miner-capital",
      "sat.pending-cycles",
      "sat.claims",
      "sat.keeper-status",
    ],
    capabilityPacks: ["miner", "risk-officer", "allocator", "public-host"],
    permissions: createZeroCapabilityPermissions(),
    artifactSha256: "a".repeat(64),
    issuedAt: "2026-09-02T11:00:00.000Z",
    expiresAt: "2026-09-03T11:00:00.000Z",
  };
  const signerKeyId = firstPartySignerKeyId(publicKeyPem);
  return {
    envelope: {
      schema: "fased.signed-first-party-capability-manifest.v1",
      signerKeyId,
      signature: sign(
        null,
        capabilityManifestSigningPayloadForTest(manifest),
        keys.privateKey,
      ).toString("base64"),
      manifest,
    },
    trustedKeys: { [signerKeyId]: publicKeyPem },
  };
}

function miningSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    lifecycle: "active" as const,
    entryState: "enabled" as const,
    satAgentRecord: address(),
    satcoinProgramId: "H79sGVMLFSHX14rAj7gBxNS31V1984Br3d6PZKP4jNhF", // pragma: allowlist secret
    permanentMiningId: address(),
    controller: address(),
    activeMinerAuthority: address(),
    runtimeExecutor: address(),
    keeperFeePayer: address(),
    authorityGeneration: "1",
    runtimeGeneration: "1",
    policyGeneration: "14",
    componentGenerations: {
      tupleFormat: "1",
      schema: "2",
      protocol: "2",
      cycle: "2",
      economics: "3",
      penalty: "2",
      bond: "2",
      keeper: "2",
      receipt: "2",
      signerCapability: "2",
    },
    lifetimeCounters: {
      entered: "10",
      valid: "10",
      missed: "0",
      penalized: "0",
      protocolFault: "0",
    },
    currentEconomicEpochCounters: {
      entered: "10",
      valid: "10",
      missed: "0",
      penalized: "0",
      protocolFault: "0",
    },
    lifetimeRewards: {
      baseSatRaw: "1000",
      performanceSatRaw: "100",
      deterministicSolLamports: "10000",
      performanceSolLamports: "1000",
      treasurySolLamports: "2500",
      penaltySolLamports: "0",
      keeperCostLamports: "100",
    },
    currentEconomicEpochRewards: {
      baseSatRaw: "1000",
      performanceSatRaw: "100",
      deterministicSolLamports: "10000",
      performanceSolLamports: "1000",
      treasurySolLamports: "2500",
      penaltySolLamports: "0",
      keeperCostLamports: "100",
    },
    capital: {
      activeCapitalLamports: "1000000000",
      committedCapitalLamports: "0",
      operatingReserveLamports: "100000000",
      capitalTimeLamportCycles: "10000000000",
    },
    operations: {
      pendingCommitCount: "0",
      pendingClaimCount: "0",
      unresolvedCycleCount: "0",
      keeperMonitor: "healthy" as const,
      keeperBroadcast: "eligible" as const,
    },
    receipts: {
      lastRecordedCycleId: "10",
      receiptSequence: "10",
      currentEconomicEpochId: "1",
      currentEconomicEpochReceiptRoot: "b".repeat(64),
      closedEconomicEpochsRoot: "c".repeat(64),
    },
    strikes: { rollingStrikeCount: "0", cleanActiveDays: "10" },
    ...overrides,
  };
}

function privateMining(overrides: Record<string, unknown> = {}) {
  return {
    channelAllocations: Array.from({ length: 16 }, () => "1"),
    allocationDigestSha256: "d".repeat(64),
    allocationState: "draft" as const,
    configuredCadenceCycles: "48",
    recommendedCadenceCycles: "48",
    projectedRunwayCycles: "1000",
    projectedRunwayDays: "34",
    nextEligibleCycleId: "11",
    operatingReserveState: "healthy" as const,
    lifecycleState: "idle" as const,
    ...overrides,
  };
}

function identityFor(mining: ReturnType<typeof miningSnapshot>): FinalizedFinancialAgentReadback {
  return {
    programId: "FasEdZ9BAsboUPF2TUQjLaapC8arcAkV5fRnMtV2G1Ev", // pragma: allowlist secret
    genesisHash: address(),
    fasedAgentRecord: address(),
    status: "active",
    controller: address(),
    recoveryAuthority: address(),
    authorityGeneration: "1",
    createdSlot: "1",
    createdUnixTimestamp: "1788350400",
    finalizedSlot: 100,
    miningBinding: {
      address: address(),
      satAgentRecord: mining.satAgentRecord,
      satcoinProgramId: mining.satcoinProgramId,
      permanentMiningId: mining.permanentMiningId,
      boundSlot: 90,
    },
  };
}

async function harness(options?: {
  mining?: ReturnType<typeof miningSnapshot>;
  observedAt?: string;
  identity?: FinalizedFinancialAgentReadback;
  privateState?: ReturnType<typeof privateMining>;
  mode?: "observe" | "propose" | "guarded-auto";
}) {
  const env = testEnv();
  const agentId = "wally";
  const profileState = await ensureAgentProfileState({
    agentId,
    source: "creation",
    initialPayloads: buildTemplateProfilePayloads({
      templateId: "mining-operator",
      displayName: "Wally",
    }),
    env,
    now,
  });
  const truth = await ensureAgentTruthStores({ agentId, source: "creation", env, now });
  const capability = signedManifest();
  const mining = options?.mining ?? miningSnapshot();
  return projectMiningReadyAgent({
    agentId,
    mode: options?.mode ?? "observe",
    profileState,
    truth,
    capabilityEnvelope: capability.envelope,
    trustedCapabilitySignerKeys: capability.trustedKeys,
    ...(options?.identity ? { identity: options.identity } : {}),
    mining,
    miningObservedAt: options?.observedAt ?? now.toISOString(),
    evidence: [
      {
        schema: "fased.agent-evidence-ref.v1",
        evidenceId: "sat-agent-record:10",
        source: "satcoin_program",
        trust: "finalized",
        observedAt: now.toISOString(),
        slot: "10",
      },
    ],
    privateMining: options?.privateState ?? privateMining(),
    now,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Mining-ready Agent projection", () => {
  it("projects a Mining-only Agent through P2 profiles, manifest and truth stores", async () => {
    const result = await harness();
    expect(result.identity).toBeUndefined();
    expect(result.qualification.status).toBe("pass");
    expect(result.mining.entryState).toBe("enabled");
    expect(result.privateMining.channelAllocations).toHaveLength(16);
    expect(JSON.stringify(result.mining)).not.toContain("channelAllocations");
  });

  it("joins a matching public Agent and permanent Mining binding", async () => {
    const mining = miningSnapshot();
    const result = await harness({ mining, identity: identityFor(mining) });
    expect(result.identity?.miningBinding?.satAgentRecord).toBe(mining.satAgentRecord);
    expect(result.identity?.integrity).toBe("verified");
    expect(result.qualification.status).toBe("pass");
  });

  it("reports a binding mismatch as conflict instead of merging identities", async () => {
    const mining = miningSnapshot();
    const identity = identityFor(mining);
    identity.miningBinding = { ...identity.miningBinding!, satAgentRecord: address() };
    const result = await harness({ mining, identity });
    expect(result.identity?.integrity).toBe("conflict");
    expect(result.mining.integrity).toBe("conflict");
    expect(result.qualification.status).toBe("conflict");
  });

  it("marks an old observation pending rather than presenting it as current", async () => {
    const result = await harness({ observedAt: "2026-09-02T11:50:00.000Z" });
    expect(result.mining.freshness).toBe("stale");
    expect(result.qualification.status).toBe("pending");
  });

  it("keeps paused Mining readable while failing the new-entry gate", async () => {
    const result = await harness({ mining: miningSnapshot({ entryState: "paused" }) });
    expect(result.mining.entryState).toBe("paused");
    expect(result.qualification.status).toBe("fail");
    expect(result.qualification.gates).toContainEqual(
      expect.objectContaining({ gate: "mining:new-entry", status: "fail" }),
    );
  });

  it("does not call deny-all policy guarded-auto authority", async () => {
    const result = await harness({ mode: "guarded-auto" });
    expect(result.authority.capitalPolicyMode).toBe("deny-all");
    expect(result.qualification.status).toBe("fail");
  });

  it("rejects an incomplete private 16-channel state", async () => {
    await expect(
      harness({ privateState: privateMining({ channelAllocations: ["1", "1"] }) }),
    ).rejects.toThrow("exactly 16 channel allocations");
  });

  it("rejects a capability signature outside the trusted first-party boundary", async () => {
    const env = testEnv();
    const agentId = "wally";
    const profileState = await ensureAgentProfileState({
      agentId,
      source: "creation",
      initialPayloads: buildTemplateProfilePayloads({
        templateId: "mining-operator",
        displayName: "Wally",
      }),
      env,
      now,
    });
    const truth = await ensureAgentTruthStores({ agentId, source: "creation", env, now });
    const capability = signedManifest();
    await expect(async () =>
      projectMiningReadyAgent({
        agentId,
        mode: "observe",
        profileState,
        truth,
        capabilityEnvelope: capability.envelope,
        trustedCapabilitySignerKeys: {},
        mining: miningSnapshot(),
        miningObservedAt: now.toISOString(),
        evidence: [],
        privateMining: privateMining(),
        now,
      }),
    ).rejects.toThrow("trusted first-party key");
  });
});
