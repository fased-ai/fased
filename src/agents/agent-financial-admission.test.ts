import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalSocketSignerPolicyV2 } from "../wallet/local-socket-signer-protocol.js";
import { admitAgentFinancialAction } from "./agent-financial-admission.js";
import type { CapitalPolicy } from "./agent-profile-contracts.js";
import {
  appendAgentProfileGeneration,
  ensureAgentProfileState,
  readActiveAgentProfile,
} from "./agent-profile-store.js";
import { ensureAgentTruthStores, readAgentTruthSnapshot } from "./agent-truth-store.js";
import {
  capabilityManifestSigningPayloadForTest,
  createZeroCapabilityPermissions,
  firstPartySignerKeyId,
  type FirstPartyCapabilityManifest,
} from "./capability-manifest.js";

const roots: string[] = [];

function testEnv(): NodeJS.ProcessEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-agent-admission-"));
  roots.push(root);
  return { FASED_STATE_DIR: root };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const env = testEnv();
  const initial = await ensureAgentProfileState({ agentId: "wally", source: "creation", env });
  const policy: CapitalPolicy = {
    schema: "fased.agent.capital-policy.v1",
    mode: "allowlisted",
    allowedChains: ["solana"],
    allowedWalletIds: ["mining"],
    allowedPrograms: ["sat-program"],
    allowedAssets: ["sat"],
    allowedDestinations: ["capital-pda"],
    perActionLimitAtoms: "1000000",
    dailyLimitAtoms: "2000000",
    rollingLimitAtoms: "3000000",
    maxSlippageBps: 25,
    maxCadencePerDay: 2,
    maxDrawdownBps: 1000,
    ownerApprovalRequired: true,
    expiresAt: "2027-09-02T12:00:00.000Z",
  };
  const state = await appendAgentProfileGeneration({
    agentId: "wally",
    kind: "capitalPolicy",
    expectedGeneration: initial.active.capitalPolicy.generation,
    expectedDigest: initial.active.capitalPolicy.digest,
    payload: policy,
    source: "owner",
    env,
    now: new Date("2026-09-02T11:55:00.000Z"),
  });
  await ensureAgentTruthStores({ agentId: "wally", source: "creation", env });

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const signerKeyId = firstPartySignerKeyId(publicKeyPem);
  const manifest: FirstPartyCapabilityManifest = {
    schema: "fased.first-party-capability-manifest.v1",
    capabilityId: "fased.mining",
    version: 1,
    adapterId: "fased.mining-adapter",
    adapterOperations: ["cycle.commit"],
    capabilityPacks: ["miner"],
    permissions: {
      ...createZeroCapabilityPermissions(),
      walletRoles: ["mining"],
      programIds: ["sat-program"],
      assetIds: ["sat"],
    },
    artifactSha256: "a".repeat(64),
    issuedAt: "2026-09-02T11:00:00.000Z",
    expiresAt: "2027-09-02T11:00:00.000Z",
  };
  const envelope = {
    schema: "fased.signed-first-party-capability-manifest.v1" as const,
    signerKeyId,
    signature: sign(null, capabilityManifestSigningPayloadForTest(manifest), privateKey).toString(
      "base64",
    ),
    manifest,
  };
  const policyRef = state.active.capitalPolicy;
  const request = {
    schema: "fased.first-party-adapter-signer-request.v1" as const,
    requestId: "request-1",
    capabilityId: "fased.mining",
    adapterId: "fased.mining-adapter",
    operation: "cycle.commit",
    installedArtifactSha256: "a".repeat(64),
    chain: "solana",
    walletId: "mining",
    walletRole: "mining",
    programId: "sat-program",
    assetId: "sat",
    destination: "capital-pda",
    amountAtoms: "1000000",
    slippageBps: 0,
    ownerApproved: true,
    policyGeneration: policyRef.generation,
    policyDigest: policyRef.digest,
    signerPolicyVersion: 7,
    signerPolicyHash: `sha256:${"d".repeat(64)}`,
    requestedAt: "2026-09-02T12:00:00.000Z",
    expiresAt: "2026-09-02T12:05:00.000Z",
  };
  const signerPolicy: LocalSocketSignerPolicyV2 = {
    walletId: "mining",
    role: "mining",
    version: 7,
    operations: ["cycle.commit"],
    programs: ["sat-program"],
    assets: [
      {
        asset: "sat",
        destinations: ["capital-pda"],
        maxPerTx: "1000000",
        maxDaily: "2000000",
      },
    ],
    hash: `sha256:${"d".repeat(64)}`,
  };
  const signerPolicyReader = { getSignerPolicy: async () => signerPolicy };
  const riskSnapshot = {
    schema: "fased.reconciled-risk-snapshot.v1" as const,
    financialRoot: null,
    currentDrawdownBps: 0,
    observedAt: "2026-09-02T11:59:00.000Z",
    expiresAt: "2026-09-02T12:05:00.000Z",
  };
  return {
    env,
    state,
    envelope,
    trustedSignerKeys: { [signerKeyId]: publicKeyPem },
    request,
    signerPolicy,
    signerPolicyReader,
    riskSnapshot,
  };
}

describe("Agent financial authority convergence", () => {
  it("atomically binds active policy, manifest, native signer policy, budgets, and objective ledger", async () => {
    const value = await fixture();
    const event = await admitAgentFinancialAction({
      agentId: "wally",
      envelope: value.envelope,
      trustedSignerKeys: value.trustedSignerKeys,
      request: value.request,
      signerPolicyReader: value.signerPolicyReader,
      riskSnapshot: value.riskSnapshot,
      env: value.env,
      now: new Date("2026-09-02T12:00:00.000Z"),
    });
    expect(event.requestId).toBe("request-1");
    expect(event.policyDigest).toBe(value.state.active.capitalPolicy.digest);
    expect(event.signerPolicyRevision).toBe(7);
    expect(event.signerPolicyHash).toBe(value.signerPolicy.hash);
    const snapshot = readAgentTruthSnapshot({ agentId: "wally", env: value.env });
    expect(snapshot.financial.events).toEqual([event]);
    expect(snapshot.publicEvidence.entries).toEqual([]);
  });

  it("is replay-idempotent and rejects a changed request under the same request id", async () => {
    const value = await fixture();
    const admit = (request: unknown) =>
      admitAgentFinancialAction({
        agentId: "wally",
        envelope: value.envelope,
        trustedSignerKeys: value.trustedSignerKeys,
        request,
        signerPolicyReader: value.signerPolicyReader,
        riskSnapshot: value.riskSnapshot,
        env: value.env,
        now: new Date("2026-09-02T12:00:00.000Z"),
      });
    const first = await admit(value.request);
    await expect(admit(value.request)).resolves.toEqual(first);
    await expect(admit({ ...value.request, amountAtoms: "999999" })).rejects.toThrow(
      "different immutable event",
    );
  });

  it("rejects signer drift, stale ledger roots, drawdown, and exhausted budgets", async () => {
    const value = await fixture();
    await expect(
      admitAgentFinancialAction({
        agentId: "wally",
        envelope: value.envelope,
        trustedSignerKeys: value.trustedSignerKeys,
        request: value.request,
        signerPolicyReader: {
          getSignerPolicy: async () => ({ ...value.signerPolicy, programs: ["other-program"] }),
        },
        riskSnapshot: value.riskSnapshot,
        env: value.env,
        now: new Date("2026-09-02T12:00:00.000Z"),
      }),
    ).rejects.toThrow();

    await admitAgentFinancialAction({
      agentId: "wally",
      envelope: value.envelope,
      trustedSignerKeys: value.trustedSignerKeys,
      request: value.request,
      signerPolicyReader: value.signerPolicyReader,
      riskSnapshot: value.riskSnapshot,
      env: value.env,
      now: new Date("2026-09-02T12:00:00.000Z"),
    });
    await expect(
      admitAgentFinancialAction({
        agentId: "wally",
        envelope: value.envelope,
        trustedSignerKeys: value.trustedSignerKeys,
        request: { ...value.request, requestId: "request-2" },
        signerPolicyReader: value.signerPolicyReader,
        riskSnapshot: value.riskSnapshot,
        env: value.env,
        now: new Date("2026-09-02T12:01:00.000Z"),
      }),
    ).rejects.toThrow("ledger root");

    const financialRoot = readAgentTruthSnapshot({
      agentId: "wally",
      env: value.env,
    }).financial.events.at(-1)?.digest;
    await expect(
      admitAgentFinancialAction({
        agentId: "wally",
        envelope: value.envelope,
        trustedSignerKeys: value.trustedSignerKeys,
        request: { ...value.request, requestId: "request-2" },
        signerPolicyReader: value.signerPolicyReader,
        riskSnapshot: {
          ...value.riskSnapshot,
          financialRoot,
          currentDrawdownBps: 1001,
        },
        env: value.env,
        now: new Date("2026-09-02T12:01:00.000Z"),
      }),
    ).rejects.toThrow("drawdown limit");

    await admitAgentFinancialAction({
      agentId: "wally",
      envelope: value.envelope,
      trustedSignerKeys: value.trustedSignerKeys,
      request: { ...value.request, requestId: "request-2" },
      signerPolicyReader: value.signerPolicyReader,
      riskSnapshot: { ...value.riskSnapshot, financialRoot },
      env: value.env,
      now: new Date("2026-09-02T12:01:00.000Z"),
    });
    const secondFinancialRoot = readAgentTruthSnapshot({
      agentId: "wally",
      env: value.env,
    }).financial.events.at(-1)?.digest;
    await expect(
      admitAgentFinancialAction({
        agentId: "wally",
        envelope: value.envelope,
        trustedSignerKeys: value.trustedSignerKeys,
        request: { ...value.request, requestId: "request-3" },
        signerPolicyReader: value.signerPolicyReader,
        riskSnapshot: { ...value.riskSnapshot, financialRoot: secondFinancialRoot },
        env: value.env,
        now: new Date("2026-09-02T12:02:00.000Z"),
      }),
    ).rejects.toThrow("daily limit");
  });

  it("fails closed after policy revocation while leaving truth readback available", async () => {
    const value = await fixture();
    const active = value.state.active.capitalPolicy;
    const denyAll = readActiveAgentProfile(
      await ensureAgentProfileState({ agentId: "new-agent", source: "creation", env: value.env }),
      "capitalPolicy",
    );
    await appendAgentProfileGeneration({
      agentId: "wally",
      kind: "capitalPolicy",
      expectedGeneration: active.generation,
      expectedDigest: active.digest,
      payload: denyAll,
      source: "owner",
      env: value.env,
      now: new Date("2026-09-02T11:59:30.000Z"),
    });
    await expect(
      admitAgentFinancialAction({
        agentId: "wally",
        envelope: value.envelope,
        trustedSignerKeys: value.trustedSignerKeys,
        request: value.request,
        signerPolicyReader: value.signerPolicyReader,
        riskSnapshot: value.riskSnapshot,
        env: value.env,
        now: new Date("2026-09-02T12:00:00.000Z"),
      }),
    ).rejects.toThrow("active CapitalPolicy generation");
    expect(readAgentTruthSnapshot({ agentId: "wally", env: value.env }).financial.events).toEqual(
      [],
    );
  });
});
