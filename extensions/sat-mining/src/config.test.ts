import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "../../../src/plugins/schema-validator.js";
import {
  type SatMiningConfig,
  resolveSatBondProgramId,
  resolveSatMintAddress,
  resolveSatMintProgramId,
  resolveSatProgramId,
  parseSatMiningConfig,
  satMiningConfigJsonSchema,
} from "./config.js";

function readManifestSchema(): Record<string, unknown> {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.resolve(dirname, "../fased.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
    configSchema?: Record<string, unknown>;
  };
  if (!manifest.configSchema) {
    throw new Error("sat-mining manifest is missing configSchema");
  }
  return manifest.configSchema;
}

const persistedSatMiningConfig = {
  enabled: true,
  drainOnly: false,
  network: "devnet",
  riskMode: "balanced",
  strategyPreset: "adaptive",
  strategyExecution: "deterministic",
  strategyMode: "base",
  cycleCadence: 6,
  cadencePolicy: {
    annualFeeExposureBps: 500,
    fasterCadenceAcknowledgement: "sat-cadence-cost-v1:test-only",
  },
  commitLamports: 6_000_000_000,
  minSolBalanceLamports: 1_000_000_000,
  walletId: "wallet-a",
  role: "miner",
  claimMode: "auto",
  payout: true,
  skillConfig: {
    enabled: false,
    useAgentDefaultModel: true,
    preferredSkillId: "sat-mining-skill",
    preferredModelId: "model-a",
    fallbackToBaseOnFailure: true,
    maxDecisionLatencyMs: 8000,
  },
  automation: {
    autoFinalizeEpoch: true,
    autoClaim: true,
    claimBatchCycles: 8,
    satSweep: {
      enabled: false,
      destinationWalletId: "wallet-b",
      destinationAddress: "recipient-address",
      mode: "all",
      percentage: 100,
      minRaw: "1",
      keepRaw: "0",
    },
  },
  tokenConfig: {
    programId: "sat-program",
    bondProgramId: "sat-bond-program",
    mintAddress: "sat-mint",
    mintProgramId: "sat-mint-program",
  },
  plannerConfig: {
    policyMode: "thompson",
    explorationRatePpm: 80_000,
    minContextSamples: 8,
    priorSamples: 4,
    enableCapitalTierPolicies: true,
  },
  federationHandle: "miner-a",
  federationPeers: ["miner-b"],
  coordinationGroup: "group-a",
} satisfies SatMiningConfig;

describe("sat mining config schemas", () => {
  it("keeps the manifest schema aligned with persisted runtime config", () => {
    const manifestResult = validateJsonSchemaValue({
      schema: readManifestSchema(),
      cacheKey: "sat-mining-manifest-config-test",
      value: persistedSatMiningConfig,
    });
    const sourceResult = validateJsonSchemaValue({
      schema: satMiningConfigJsonSchema as Record<string, unknown>,
      cacheKey: "sat-mining-source-config-test",
      value: persistedSatMiningConfig,
    });

    expect(manifestResult).toEqual({ ok: true });
    expect(sourceResult).toEqual({ ok: true });
  });

  it("allows explicit test-network SAT ids through plugin tokenConfig", () => {
    expect(resolveSatProgramId(persistedSatMiningConfig)).toBe("sat-program");
    expect(resolveSatBondProgramId(persistedSatMiningConfig)).toBe("sat-bond-program");
    expect(resolveSatMintAddress(persistedSatMiningConfig)).toBe("sat-mint");
    expect(resolveSatMintProgramId(persistedSatMiningConfig)).toBe("sat-mint-program");
  });

  it("normalizes the owner fee budget and trims a cost acknowledgement", () => {
    const parsed = parseSatMiningConfig({
      cadencePolicy: {
        annualFeeExposureBps: 25_000,
        fasterCadenceAcknowledgement: "  sat-cadence-cost-v1:abc  ",
      },
    });

    expect(parsed.cadencePolicy).toEqual({
      annualFeeExposureBps: 10_000,
      fasterCadenceAcknowledgement: "sat-cadence-cost-v1:abc",
    });
  });
});
