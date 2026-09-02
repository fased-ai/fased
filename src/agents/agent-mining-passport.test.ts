import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  findAgentMiningPassport,
  projectAgentMiningPassportDirectory,
  type AgentMiningPassportState,
} from "./agent-mining-passport.js";
import {
  rebuildAgentPublicViewIndex,
  type AgentPublicViewSourceEvent,
} from "./agent-public-view-indexer.js";
import type {
  AgentEvidenceRef,
  AgentIdentityView,
  AgentMiningView,
  AgentQualificationView,
} from "./fased-agent-public-views.generated.js";

const observedAt = "2026-09-02T12:00:00.000Z";
const programId = "H79sGVMLFSHX14rAj7gBxNS31V1984Br3d6PZKP4jNhF"; // pragma: allowlist secret

function address(): string {
  return Keypair.generate().publicKey.toBase58();
}

function evidence(id: string): AgentEvidenceRef {
  return {
    schema: "fased.agent-evidence-ref.v1",
    evidenceId: id,
    source: "satcoin_program",
    trust: "finalized",
    observedAt,
    slot: "100",
  };
}

function identity(subject: string, overrides: Partial<AgentIdentityView> = {}): AgentIdentityView {
  return {
    schema: "fased.agent-identity-view.v1",
    viewId: "a".repeat(64),
    observedAt,
    freshness: "fresh",
    integrity: "verified",
    lifecycle: "active",
    fasedAgentRecord: address(),
    networkAgentId: "1".repeat(64),
    controller: address(),
    recoveryAuthority: address(),
    authorityGeneration: "1",
    createdSlot: "1",
    createdUnixTimestamp: "1788350400",
    conflicts: [],
    evidence: [evidence(`${subject}-identity`)],
    ...overrides,
  };
}

function mining(overrides: Partial<AgentMiningView> = {}): AgentMiningView {
  return {
    schema: "fased.agent-mining-view.v1",
    viewId: "b".repeat(64),
    observedAt,
    freshness: "fresh",
    integrity: "verified",
    lifecycle: "active",
    entryState: "enabled",
    satAgentRecord: address(),
    satcoinProgramId: programId,
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
      entered: "100",
      valid: "100",
      missed: "0",
      penalized: "0",
      protocolFault: "0",
    },
    currentEconomicEpochCounters: {
      entered: "100",
      valid: "100",
      missed: "0",
      penalized: "0",
      protocolFault: "0",
    },
    lifetimeRewards: {
      baseSatRaw: "1",
      performanceSatRaw: "1",
      deterministicSolLamports: "1",
      performanceSolLamports: "1",
      treasurySolLamports: "1",
      penaltySolLamports: "0",
      keeperCostLamports: "1",
    },
    currentEconomicEpochRewards: {
      baseSatRaw: "1",
      performanceSatRaw: "1",
      deterministicSolLamports: "1",
      performanceSolLamports: "1",
      treasurySolLamports: "1",
      penaltySolLamports: "0",
      keeperCostLamports: "1",
    },
    capital: {
      activeCapitalLamports: "1000000000",
      committedCapitalLamports: "0",
      operatingReserveLamports: "100000000",
      capitalTimeLamportCycles: "100000000000",
    },
    operations: {
      pendingCommitCount: "0",
      pendingClaimCount: "0",
      unresolvedCycleCount: "0",
      keeperMonitor: "healthy",
      keeperBroadcast: "eligible",
    },
    receipts: {
      lastRecordedCycleId: "100",
      receiptSequence: "100",
      currentEconomicEpochId: "1",
      currentEconomicEpochReceiptRoot: "c".repeat(64),
      closedEconomicEpochsRoot: "d".repeat(64),
    },
    strikes: { rollingStrikeCount: "0", cleanActiveDays: "30" },
    conflicts: [],
    evidence: [evidence("mining")],
    ...overrides,
  };
}

function qualification(subject: {
  fasedAgentRecord?: string;
  satAgentRecord?: string;
}): AgentQualificationView {
  return {
    schema: "fased.agent-qualification-view.v1",
    viewId: "e".repeat(64),
    evaluatedAt: observedAt,
    purpose: "mining_ready",
    status: "pass",
    policyId: "fased:mining-ready:v1",
    policyGeneration: "1",
    policyDigestSha256: "f".repeat(64),
    subject,
    gates: [
      {
        gate: "mining:record-active",
        status: "pass",
        observed: "active",
        required: "active",
        evidenceIds: [],
      },
    ],
    conflicts: [],
    evidence: [evidence("qualification")],
  };
}

function event(params: {
  subject: string;
  kind: "identity" | "mining" | "qualification";
  ordinal: number;
  view: AgentIdentityView | AgentMiningView | AgentQualificationView;
  source?: "fased-signed" | "solana-finalized";
}): AgentPublicViewSourceEvent {
  const source = params.source ?? "solana-finalized";
  return {
    schema: "fased.agent-public-view-source-event.v1",
    eventId: `${params.subject}-${params.kind}-${params.ordinal}`,
    subjectId: params.subject,
    viewKind: params.kind,
    source,
    sourceRef: `${source}:${params.ordinal}`,
    ordinal: String(params.ordinal),
    observedAt,
    view: params.view,
  };
}

function passportStateFixture(state: AgentMiningPassportState) {
  const subject = `agent-${state.replaceAll("_", "-")}`;
  const miningView = mining();
  const identityView = identity(subject, {
    miningBinding: {
      binding: address(),
      satAgentRecord: miningView.satAgentRecord,
      satcoinProgramId: miningView.satcoinProgramId,
      permanentMiningId: miningView.permanentMiningId,
      boundSlot: "90",
    },
  });
  let events: AgentPublicViewSourceEvent[];
  switch (state) {
    case "network_only": {
      identityView.lifecycle = "network_only";
      delete identityView.fasedAgentRecord;
      delete identityView.controller;
      delete identityView.recoveryAuthority;
      delete identityView.authorityGeneration;
      delete identityView.createdSlot;
      delete identityView.createdUnixTimestamp;
      delete identityView.miningBinding;
      identityView.runtime = {
        state: "current",
        nodeId: "runtime-wally",
        runtimeVersion: "1.0.0",
        coreHash: "8".repeat(64),
        attestedAt: observedAt,
        expiresAt: "2026-09-02T13:00:00.000Z",
      };
      events = [
        event({
          subject,
          kind: "identity",
          ordinal: 1,
          view: identityView,
          source: "fased-signed",
        }),
      ];
      break;
    }
    case "identity_only":
      events = [event({ subject, kind: "identity", ordinal: 1, view: identityView })];
      break;
    case "mining_only":
      events = [event({ subject, kind: "mining", ordinal: 1, view: miningView })];
      break;
    case "stale":
      identityView.runtime = {
        state: "stale",
        nodeId: "runtime-wally",
        runtimeVersion: "1.0.0",
        coreHash: "8".repeat(64),
        attestedAt: "2026-09-02T11:00:00.000Z",
        expiresAt: "2026-09-02T11:30:00.000Z",
      };
      events = [
        event({ subject, kind: "identity", ordinal: 1, view: identityView }),
        event({ subject, kind: "mining", ordinal: 2, view: miningView }),
      ];
      break;
    case "paused":
    case "draining":
    case "drained":
      miningView.entryState = state;
      if (state === "drained") {
        miningView.capital = {
          ...miningView.capital,
          activeCapitalLamports: "0",
          committedCapitalLamports: "0",
        };
      }
      events = [
        event({ subject, kind: "identity", ordinal: 1, view: identityView }),
        event({ subject, kind: "mining", ordinal: 2, view: miningView }),
      ];
      break;
    case "retired":
      identityView.lifecycle = "retired";
      miningView.lifecycle = "retired";
      miningView.entryState = "drained";
      miningView.capital = {
        ...miningView.capital,
        activeCapitalLamports: "0",
        committedCapitalLamports: "0",
      };
      events = [
        event({ subject, kind: "identity", ordinal: 1, view: identityView }),
        event({ subject, kind: "mining", ordinal: 2, view: miningView }),
      ];
      break;
    case "conflict": {
      const lower = identity(subject, {
        fasedAgentRecord: identityView.fasedAgentRecord,
        controller: address(),
        viewId: "8".repeat(64),
      });
      events = [
        event({ subject, kind: "identity", ordinal: 1, view: lower, source: "fased-signed" }),
        event({ subject, kind: "identity", ordinal: 2, view: identityView }),
        event({ subject, kind: "mining", ordinal: 3, view: miningView }),
      ];
      break;
    }
    case "bound_active":
      events = [
        event({ subject, kind: "identity", ordinal: 1, view: identityView }),
        event({ subject, kind: "mining", ordinal: 2, view: miningView }),
        event({
          subject,
          kind: "qualification",
          ordinal: 3,
          view: qualification({
            fasedAgentRecord: identityView.fasedAgentRecord,
            satAgentRecord: miningView.satAgentRecord,
          }),
        }),
      ];
      break;
  }
  return { subject, index: rebuildAgentPublicViewIndex(events) };
}

describe("Agent Mining passport projection", () => {
  it.each([
    "network_only",
    "identity_only",
    "mining_only",
    "bound_active",
    "stale",
    "paused",
    "draining",
    "drained",
    "retired",
    "conflict",
  ] as const)("projects the %s state without an App or API contract", (state) => {
    const fixture = passportStateFixture(state);
    const directory = projectAgentMiningPassportDirectory(fixture.index);
    expect(directory.passports).toHaveLength(1);
    expect(directory.passports[0]?.state).toBe(state);
    expect(directory.indexDigest).toBe(fixture.index.indexDigest);
  });

  it("supports exact subject, AgentRecord, Network and Mining lookups", () => {
    const fixture = passportStateFixture("bound_active");
    const directory = projectAgentMiningPassportDirectory(fixture.index);
    const passport = directory.passports[0];
    for (const lookup of [
      { subjectId: passport.subjectId },
      { fasedAgentRecord: passport.lookup.fasedAgentRecord! },
      { networkAgentId: passport.lookup.networkAgentId! },
      { satAgentRecord: passport.lookup.satAgentRecord! },
      { permanentMiningId: passport.lookup.permanentMiningId! },
    ]) {
      expect(findAgentMiningPassport(directory, lookup)).toBe(passport);
    }
  });

  it("selects the newest controller without treating same-source history as an integrity conflict", () => {
    const subject = "agent-controller-rotation";
    const oldView = identity(subject, { controller: address() });
    const newController = address();
    const currentView = identity(subject, {
      fasedAgentRecord: oldView.fasedAgentRecord,
      controller: newController,
      authorityGeneration: "2",
      viewId: "9".repeat(64),
    });
    const index = rebuildAgentPublicViewIndex([
      event({ subject, kind: "identity", ordinal: 1, view: oldView }),
      event({ subject, kind: "identity", ordinal: 2, view: currentView }),
    ]);
    const passport = projectAgentMiningPassportDirectory(index).passports[0];
    expect(passport.identity?.controller).toBe(newController);
    expect(passport.identity?.authorityGeneration).toBe("2");
    expect(passport.state).toBe("identity_only");
    expect(passport.integrity).toBe("verified");
    expect(passport.conflicts).toHaveLength(1);
    expect(passport.conflicts[0]?.reason).toBe("same-source-update");
  });

  it("rejects a tampered source index", () => {
    const fixture = passportStateFixture("identity_only");
    fixture.index.records[`${fixture.subject}:identity`].sourceRef = "tampered";
    expect(() => projectAgentMiningPassportDirectory(fixture.index)).toThrow(
      "Agent public-view index digest is invalid",
    );
  });

  it("exports only current generated public views and safe source metadata", () => {
    const fixture = passportStateFixture("bound_active");
    const serialized = JSON.stringify(projectAgentMiningPassportDirectory(fixture.index));
    expect(serialized).not.toContain("channelAllocations");
    expect(serialized).not.toContain("allocationDigestSha256");
    expect(serialized).not.toContain("privateMemory");
    expect(serialized).not.toContain("serializedTransaction");
    expect(serialized).not.toContain("AgentMarketView");
    expect(serialized).not.toContain("AgentStrategyView");
    expect(serialized).not.toContain('"events"');
  });

  it("replay produces the identical directory and rejects ambiguous identifiers", () => {
    const first = passportStateFixture("bound_active");
    const replayEvents = first.index.events.map(
      ({ eventDigest: _eventDigest, ...sourceEvent }) => sourceEvent,
    );
    const rebuilt = rebuildAgentPublicViewIndex(replayEvents);
    expect(projectAgentMiningPassportDirectory(rebuilt)).toEqual(
      projectAgentMiningPassportDirectory(first.index),
    );
    const directory = projectAgentMiningPassportDirectory(first.index);
    directory.passports.push({ ...directory.passports[0], subjectId: "duplicate-subject" });
    expect(() =>
      findAgentMiningPassport(directory, {
        satAgentRecord: directory.passports[0].lookup.satAgentRecord!,
      }),
    ).toThrow("ambiguous");
  });
});
