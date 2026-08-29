import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

void test("Fased activates only when the finalized deployment matches the candidate interface", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/generate-sat-vnext-interface.mjs", "--check"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const generated = fs.readFileSync(
    path.join(root, "extensions/sat-mining/src/vnext-interface-manifest.ts"),
    "utf8",
  );
  const bundledInterface = fs.readFileSync(
    path.join(root, "extensions/sat-mining/protocol-generation/interface-generation.v2.json"),
  );
  const activationContract = JSON.parse(
    fs.readFileSync(
      path.join(root, "extensions/sat-mining/protocol-generation/activation.sat-dep-0009.json"),
      "utf8",
    ),
  );
  const activationMatchesCandidate =
    activationContract.state === "ACTIVE" &&
    activationContract.protocolGenerationState.publicEntryEnabled === true &&
    activationContract.interfaceContractSha256 ===
      `sha256:${createHash("sha256").update(bundledInterface).digest("hex")}`;
  assert.match(
    generated,
    activationMatchesCandidate ? /state: "ACTIVE"/u : /state: "FROZEN_NOT_ACTIVE"/u,
  );
  assert.match(generated, activationMatchesCandidate ? /active: true/u : /active: false/u);
  assert.match(generated, /executableDispatchBound: true/u);
  assert.match(
    generated,
    activationMatchesCandidate ? /publicEntryEnabled: true/u : /publicEntryEnabled: false/u,
  );
  assert.match(generated, /freezeId: "SAT-VNEXT-GATE-P3-008"/u);
  assert.match(generated, /strategyChannels: 16/u);
  assert.match(generated, /legacyStrategyChannels: 25/u);
  assert.match(generated, /revealDataLength: 105/u);
  assert.match(generated, /actionCodecs:/u);
  assert.match(generated, /openCycleV2:/u);
  assert.match(generated, /commitCycleV2:/u);
  assert.match(generated, /closeCommitPhaseV2:/u);
  assert.match(generated, /sealCycleEntropyV2:/u);
  assert.match(generated, /claimCycleRewardsV2:/u);
  assert.match(generated, /snapshotKeeperCapabilitiesV2:/u);
  assert.match(generated, /settleCyclePageV2/u);
  assert.match(generated, /distributeCyclePageV2/u);
  assert.match(generated, /maximumChargePerWorkLamports: 40000/u);
  assert.match(generated, /sat_keeper_operating_reserve:writable/u);
  const accountOrder = fs.readFileSync(
    path.join(root, "extensions/sat-mining/protocol-generation/account-order.generation-2.json"),
    "utf8",
  );
  assert.match(accountOrder, /keeper_payout_authority:writable/u);
  assert.equal(generated.match(/pragma: allowlist secret/gu)?.length, 6);
  const activationGenerated = fs.readFileSync(
    path.join(root, "extensions/sat-mining/src/vnext-activation-manifest.ts"),
    "utf8",
  );
  assert.equal(activationGenerated.match(/pragma: allowlist secret/gu)?.length, 21);

  const releaseContract = fs.readFileSync(
    path.join(root, "src", "mining", "sat-vnext-release-contract.generated.ts"),
    "utf8",
  );
  assert.match(releaseContract, /fased\.sat-release-acknowledgement\.v1/u);
  assert.match(releaseContract, /state: "EXECUTABLE_BOUND_PUBLIC_ENTRY_DISABLED"/u);
  assert.match(releaseContract, /schema: "SAT-SCHEMA-GEN-002"/u);
  assert.match(releaseContract, /keeper: "SAT-KEEPER-GEN-002"/u);
  assert.match(releaseContract, /protocol: "SAT-PROTO-GEN-002"/u);
  assert.match(releaseContract, /signerCapability: "FSD-SIGNER-GEN-002"/u);

  const signerReleaseContract = fs.readFileSync(
    path.join(root, "tools", "fased-signerd", "sat_release_ack_generated.go"),
    "utf8",
  );
  assert.match(signerReleaseContract, /signerSATReleaseAcknowledgementGeneration2/u);

  const activation = fs.readFileSync(
    path.join(root, "extensions/sat-mining/src/vnext-activation-manifest.ts"),
    "utf8",
  );
  assert.match(activation, /deploymentId: "SAT-DEP-0009"/u);
  assert.match(activation, /cluster: "devnet"/u);
  assert.match(activation, /state: "ACTIVE"/u);
  assert.match(activation, /publicEntryEnabled: true/u);
  assert.match(activation, /activationGeneration: 6/u);

  const legacy = fs.readFileSync(
    path.join(root, "extensions/sat-mining/src/protocol-contract.ts"),
    "utf8",
  );
  assert.match(legacy, /allocationBuckets: 25/u);
  const legacySigner = fs.readFileSync(
    path.join(root, "extensions/sat-mining/src/signer-codec-manifest.ts"),
    "utf8",
  );
  assert.match(legacySigner, /action: "revealCycle"[\s\S]*?dataLength: 145/u);
  assert.doesNotMatch(legacySigner, /action: "revealCycleV2"/u);
});
