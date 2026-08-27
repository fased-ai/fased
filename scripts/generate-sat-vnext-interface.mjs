#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = path.join(root, "extensions", "sat-mining", "protocol-generation");
const importMode = process.argv.includes("--import");
const checkMode = process.argv.includes("--check");
const satRootIndex = process.argv.indexOf("--sat-root");
const satRoot = satRootIndex >= 0 ? path.resolve(process.argv[satRootIndex + 1] ?? "") : null;
if ((importMode || satRootIndex >= 0) && !satRoot) {
  throw new Error("--sat-root requires the canonical SAT checkout path");
}
if (importMode === checkMode) {
  throw new Error(
    "use exactly one mode: --import --sat-root <path> or --check [--sat-root <path>]",
  );
}

const artifacts = [
  "interface-generation.v2.json",
  "idl.generation-2.json",
  "account-order.generation-2.json",
  "state-layouts.generation-2.json",
  "signer-codecs.generation-2.json",
];
const tsPath = path.join(root, "extensions", "sat-mining", "src", "vnext-interface-manifest.ts");
const releaseContractPath = path.join(
  root,
  "src",
  "mining",
  "sat-vnext-release-contract.generated.ts",
);
const goPath = path.join(root, "tools", "fased-signerd", "sat_vnext_manifest_generated.go");
const goReleasePath = path.join(root, "tools", "fased-signerd", "sat_release_ack_generated.go");

function fail(message) {
  throw new Error(`Fased SAT vNext interface: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourcePath(name) {
  return path.join(satRoot, "api", name);
}

function bundledPath(name) {
  return path.join(bundleDir, name);
}

function update(filePath, expected) {
  const actual = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  if (actual?.equals(expected)) {
    return;
  }
  if (checkMode) {
    fail(`${path.relative(root, filePath)} is stale`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, expected);
}

if (importMode) {
  for (const artifact of artifacts) {
    update(bundledPath(artifact), fs.readFileSync(sourcePath(artifact)));
  }
} else if (satRoot) {
  for (const artifact of artifacts) {
    const canonical = fs.readFileSync(sourcePath(artifact));
    const bundled = fs.readFileSync(bundledPath(artifact));
    if (!canonical.equals(bundled)) {
      fail(`${artifact} differs from canonical SAT bytes`);
    }
  }
}

const bytesByArtifact = Object.fromEntries(
  artifacts.map((artifact) => [artifact, fs.readFileSync(bundledPath(artifact))]),
);
const parsed = Object.fromEntries(
  Object.entries(bytesByArtifact).map(([artifact, bytes]) => [artifact, JSON.parse(bytes)]),
);
const contract = parsed["interface-generation.v2.json"];
const idl = parsed["idl.generation-2.json"];
const accountOrder = parsed["account-order.generation-2.json"];
const layouts = parsed["state-layouts.generation-2.json"];
const signer = parsed["signer-codecs.generation-2.json"];

if (
  contract?.freezeId !== "SAT-VNEXT-GATE-P3-008" ||
  contract?.state !== "EXECUTABLE_BOUND_PUBLIC_ENTRY_DISABLED" ||
  contract?.strategyChannels !== 16 ||
  contract?.legacyDrain?.strategyChannels !== 25 ||
  contract?.activation?.programDispatchBound !== true ||
  contract?.activation?.publicEntryEnabled !== false ||
  contract?.activation?.fasedRuntimeSelected !== false
) {
  fail("interface contract is not the executable-bound, public-entry-disabled generation");
}
const idlReveal = idl?.satMiningInstructions?.find(
  (instruction) => instruction.name === "SatRevealCycleV2",
);
const orderReveal = accountOrder?.programs?.satMining?.find(
  (instruction) => instruction.name === "SatRevealCycleV2",
);
const codec = signer?.codecs?.find((candidate) => candidate.action === "revealCycleV2");
if (
  idlReveal?.args?.at(-1)?.type !== "u32[16]" ||
  idlReveal?.discriminant !== 114 ||
  orderReveal?.discriminant !== 114 ||
  codec?.dataLength !== 105 ||
  codec?.allocationChannels !== 16 ||
  codec?.active !== false ||
  codec?.executableDispatchBound !== true ||
  layouts?.vnext?.allocationVector?.channels !== 16
) {
  fail("generated IDL/account/layout/signer surfaces disagree");
}
const legacyReveal = idl.satMiningInstructions.find(
  (instruction) => instruction.name === "SatRevealCycle",
);
if (
  legacyReveal?.args?.at(-1)?.type !== "u32[25]" ||
  legacyReveal?.status !== "legacy-drain-only" ||
  layouts?.legacy?.reinterpretAsGeneration2 !== false
) {
  fail("legacy drain decoder is not preserved distinctly");
}

const keeperActions = [
  "settleCyclePageV2",
  "finalizeCycleSettlementV2",
  "scoreCyclePageV2",
  "distributeCyclePageV2",
];
const codecsByAction = new Map(signer.codecs.map((candidate) => [candidate.action, candidate]));
const accountOrdersByKey = new Map(
  accountOrder.programs.satMining.map((instruction) => [instruction.name, instruction]),
);
const expectedRepeatedGroups = {
  settleCyclePageV2: ["sat_miner_cycle_state_v2:writable", "sat_keeper_operating_reserve:writable"],
  scoreCyclePageV2: ["sat_miner_cycle_state_v2:writable", "sat_keeper_operating_reserve:writable"],
  distributeCyclePageV2: [
    "sat_miner_cycle_state_v2:writable",
    "sat_miner_capital_state:writable",
    "sat_agent_record:readonly",
    "sat_agent_reward_remainder_v2:writable",
    "sat_keeper_operating_reserve:writable",
  ],
};
for (const action of keeperActions) {
  const keeperCodec = codecsByAction.get(action);
  const keeperOrder = accountOrdersByKey.get(keeperCodec?.accountOrderKey);
  if (
    !keeperCodec ||
    keeperCodec.active !== false ||
    keeperCodec.executableDispatchBound !== true ||
    typeof keeperCodec.dataLength !== "number" ||
    !keeperOrder?.accountOrder?.includes("keeper_fee_payer:writable+signer") ||
    !keeperOrder.accountOrder.includes("keeper_payout_authority:writable") ||
    !keeperOrder.accountOrder.includes("sat_keeper_snapshot:readonly") ||
    !keeperOrder.accountOrder.includes("sat_keeper_capability:readonly") ||
    JSON.stringify(keeperOrder.repeatedAccountGroup ?? null) !==
      JSON.stringify(expectedRepeatedGroups[action] ?? null)
  ) {
    fail(`keeper codec ${action} is not bound to the generation-2 capability contract`);
  }
}
if (
  contract?.keeperAccounting?.commonWorkSource !== "BOOTSTRAP_THEN_TREASURY" ||
  contract?.keeperAccounting?.identityWorkSource !== "OPERATING_RESERVE" ||
  contract?.keeperAccounting?.feeAllowanceLamports !== 36_000 ||
  contract?.keeperAccounting?.serviceMarginLamports !== 4_000 ||
  contract?.keeperAccounting?.maximumChargePerWorkLamports !== 40_000 ||
  contract?.keeperAccounting?.identityWorkUnitsPerCycle !== 3 ||
  contract?.keeperAccounting?.publicRescuePaid !== false ||
  contract?.keeperAccounting?.duplicatePaid !== false
) {
  fail("keeper payment contract is not the exact P3-008 generation");
}

const digests = Object.fromEntries(
  Object.entries(bytesByArtifact).map(([artifact, bytes]) => [artifact, sha256(bytes)]),
);
const releaseAcknowledgement = {
  schema: "fased.sat-release-acknowledgement.v1",
  state: contract.state,
  componentGenerations: contract.componentGenerations,
  interfaceContractSha256: `sha256:${digests["interface-generation.v2.json"]}`,
  idlSha256: `sha256:${digests["idl.generation-2.json"]}`,
  accountOrderSha256: `sha256:${digests["account-order.generation-2.json"]}`,
  stateLayoutsSha256: `sha256:${digests["state-layouts.generation-2.json"]}`,
  signerCodecsSha256: `sha256:${digests["signer-codecs.generation-2.json"]}`,
};
function accountShape(order) {
  return order.map((entry) => {
    const match = /:(readonly|writable)(\+signer)?$/u.exec(entry);
    if (!match) {
      fail(`invalid account-order entry ${entry}`);
    }
    return `${match[2] ? "S" : "-"}${match[1] === "writable" ? "W" : "-"}`;
  });
}
function typescriptLiteral(value, depth = 0) {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    return `[\n${value.map((item) => `${childIndent}${typescriptLiteral(item, depth + 1)},`).join("\n")}\n${indent}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return "{}";
    }
    return `{\n${entries.map(([key, item]) => `${childIndent}${key}: ${typescriptLiteral(item, depth + 1)},`).join("\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}
const accountFlags = accountShape(orderReveal.accountOrder);
const generatedCodecs = [codec, ...keeperActions.map((action) => codecsByAction.get(action))].map(
  (generatedCodec) => {
    const order = accountOrdersByKey.get(generatedCodec.accountOrderKey);
    return {
      ...generatedCodec,
      accountShape: accountShape(order.accountOrder).join(","),
      repeatedAccountGroup: order.repeatedAccountGroup ?? null,
    };
  },
);
const keeperCodecs = Object.fromEntries(
  generatedCodecs.slice(1).map((item) => [
    item.action,
    {
      discriminator: item.discriminator,
      dataLength: item.dataLength,
      accountShape: item.accountShape,
      repeatedAccountGroup: item.repeatedAccountGroup,
    },
  ]),
);

const typescript = `// Generated from the exact SAT generation-2 interface bundle; do not edit.\n\nexport const SAT_VNEXT_INTERFACE = {\n  freezeId: ${JSON.stringify(contract.freezeId)},\n  state: ${JSON.stringify(contract.state)},\n  active: false,\n  executableDispatchBound: true,\n  publicEntryEnabled: false,\n  schemaGeneration: 2,\n  signerCapabilityGeneration: 2,\n  strategyChannels: 16,\n  legacyStrategyChannels: 25,\n  keeperExclusiveWindowSlots: 20,\n  keeperFallbackJitterSlots: 8,\n  keeperAccounting: ${typescriptLiteral(contract.keeperAccounting, 1)} as const,\n  revealDiscriminator: 114,\n  revealDataLength: 105,\n  revealAccountShape: ${JSON.stringify(accountFlags.join(","))},\n  keeperCodecs: ${typescriptLiteral(keeperCodecs, 1)} as const,\n  contractSha256: ${JSON.stringify(digests["interface-generation.v2.json"])},\n  idlSha256: ${JSON.stringify(digests["idl.generation-2.json"])},\n  accountOrderSha256: ${JSON.stringify(digests["account-order.generation-2.json"])},\n  stateLayoutsSha256: ${JSON.stringify(digests["state-layouts.generation-2.json"])},\n  signerCodecsSha256: ${JSON.stringify(digests["signer-codecs.generation-2.json"])},\n} as const;\n\nexport function encodeSatVNextRevealData(params: {\n  cycleId: bigint;\n  nonce: Buffer;\n  allocationFp: readonly number[];\n}): Buffer {\n  if (params.nonce.length !== 32) throw new Error("SAT vNext reveal nonce must contain 32 bytes");\n  if (params.allocationFp.length !== SAT_VNEXT_INTERFACE.strategyChannels) {\n    throw new Error("SAT vNext reveal must contain exactly 16 strategy channels");\n  }\n  const data = Buffer.alloc(SAT_VNEXT_INTERFACE.revealDataLength);\n  data[0] = SAT_VNEXT_INTERFACE.revealDiscriminator;\n  data.writeBigUInt64LE(params.cycleId, 1);\n  params.nonce.copy(data, 9);\n  params.allocationFp.forEach((value, index) => {\n    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {\n      throw new Error(\`SAT vNext allocation[\${index}] is not a u32\`);\n    }\n    data.writeUInt32LE(value, 41 + index * 4);\n  });\n  return data;\n}\n`;

const generationEntries = Object.entries(releaseAcknowledgement.componentGenerations)
  .map(([key, value]) => `    ${key}: ${JSON.stringify(value)},`)
  .join("\n");
const releaseContract = `// Generated from the exact SAT generation-2 interface bundle; do not edit.\n\nexport const SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT = {\n  schema: ${JSON.stringify(releaseAcknowledgement.schema)},\n  state: ${JSON.stringify(releaseAcknowledgement.state)},\n  componentGenerations: {\n${generationEntries}\n  },\n  interfaceContractSha256:\n    ${JSON.stringify(releaseAcknowledgement.interfaceContractSha256)}, // pragma: allowlist secret\n  idlSha256: ${JSON.stringify(releaseAcknowledgement.idlSha256)}, // pragma: allowlist secret\n  accountOrderSha256: ${JSON.stringify(releaseAcknowledgement.accountOrderSha256)}, // pragma: allowlist secret\n  stateLayoutsSha256: ${JSON.stringify(releaseAcknowledgement.stateLayoutsSha256)}, // pragma: allowlist secret\n  signerCodecsSha256: ${JSON.stringify(releaseAcknowledgement.signerCodecsSha256)}, // pragma: allowlist secret\n} as const;\n`;

const goCodecEntries = generatedCodecs
  .map(
    (generatedCodec) =>
      `\t${JSON.stringify(generatedCodec.action)}: {\n\t\tAction:             ${JSON.stringify(generatedCodec.action)},\n\t\tDiscriminator:      ${generatedCodec.discriminator},\n\t\tDataLength:         ${generatedCodec.dataLength},\n\t\tAllocationChannels: ${generatedCodec.allocationChannels ?? 0},\n\t\tAccountShape:       ${JSON.stringify(generatedCodec.accountShape)},\n\t\tActive:             false,\n\t},`,
  )
  .join("\n");
const go = `package main\n\n// Code generated from the exact SAT generation-2 interface bundle; DO NOT EDIT.\n\ntype frozenSATCodecGeneration2 struct {\n\tAction             string\n\tDiscriminator      byte\n\tDataLength         int\n\tAllocationChannels int\n\tAccountShape       string\n\tActive             bool\n}\n\nconst (\n\tsatVNextInterfaceContractSHA256 = ${JSON.stringify(digests["interface-generation.v2.json"])} // pragma: allowlist secret\n\tsatVNextIDLContractSHA256       = ${JSON.stringify(digests["idl.generation-2.json"])} // pragma: allowlist secret\n\tsatVNextAccountOrderSHA256      = ${JSON.stringify(digests["account-order.generation-2.json"])} // pragma: allowlist secret\n)\n\nvar signerSATCodecsGeneration2 = map[string]frozenSATCodecGeneration2{\n${goCodecEntries}\n}\n\nfunc isCanonicalFrozenSATGeneration2Data(action string, data []byte) bool {\n\tcodec, ok := signerSATCodecsGeneration2[action]\n\treturn ok && !codec.Active && len(data) == codec.DataLength && data[0] == codec.Discriminator\n}\n`;

const goRelease = `package main\n\n// Code generated from the exact SAT generation-2 interface bundle; DO NOT EDIT.\n\ntype frozenSATComponentGenerationsV2 struct {\n\tBond             string \`json:"bond"\`\n\tCycle            string \`json:"cycle"\`\n\tEconomics        string \`json:"economics"\`\n\tKeeper           string \`json:"keeper"\`\n\tPenalty          string \`json:"penalty"\`\n\tProtocol         string \`json:"protocol"\`\n\tReceipt          string \`json:"receipt"\`\n\tSchema           string \`json:"schema"\`\n\tSignerCapability string \`json:"signerCapability"\`\n}\n\ntype frozenSATReleaseAcknowledgementV2 struct {\n\tSchema                  string                          \`json:"schema"\`\n\tState                   string                          \`json:"state"\`\n\tComponentGenerations    frozenSATComponentGenerationsV2 \`json:"componentGenerations"\`\n\tInterfaceContractSHA256 string                          \`json:"interfaceContractSha256"\`\n\tIDLSHA256               string                          \`json:"idlSha256"\`\n\tAccountOrderSHA256      string                          \`json:"accountOrderSha256"\`\n\tStateLayoutsSHA256      string                          \`json:"stateLayoutsSha256"\`\n\tSignerCodecsSHA256      string                          \`json:"signerCodecsSha256"\`\n}\n\nvar signerSATReleaseAcknowledgementGeneration2 = frozenSATReleaseAcknowledgementV2{\n\tSchema: ${JSON.stringify(releaseAcknowledgement.schema)},\n\tState:  ${JSON.stringify(releaseAcknowledgement.state)},\n\tComponentGenerations: frozenSATComponentGenerationsV2{\n\t\tBond:             ${JSON.stringify(releaseAcknowledgement.componentGenerations.bond)},\n\t\tCycle:            ${JSON.stringify(releaseAcknowledgement.componentGenerations.cycle)},\n\t\tEconomics:        ${JSON.stringify(releaseAcknowledgement.componentGenerations.economics)},\n\t\tKeeper:           ${JSON.stringify(releaseAcknowledgement.componentGenerations.keeper)},\n\t\tPenalty:          ${JSON.stringify(releaseAcknowledgement.componentGenerations.penalty)},\n\t\tProtocol:         ${JSON.stringify(releaseAcknowledgement.componentGenerations.protocol)},\n\t\tReceipt:          ${JSON.stringify(releaseAcknowledgement.componentGenerations.receipt)},\n\t\tSchema:           ${JSON.stringify(releaseAcknowledgement.componentGenerations.schema)},\n\t\tSignerCapability: ${JSON.stringify(releaseAcknowledgement.componentGenerations.signerCapability)},\n\t},\n\tInterfaceContractSHA256: ${JSON.stringify(releaseAcknowledgement.interfaceContractSha256)}, // pragma: allowlist secret\n\tIDLSHA256:               ${JSON.stringify(releaseAcknowledgement.idlSha256)}, // pragma: allowlist secret\n\tAccountOrderSHA256:      ${JSON.stringify(releaseAcknowledgement.accountOrderSha256)}, // pragma: allowlist secret\n\tStateLayoutsSHA256:      ${JSON.stringify(releaseAcknowledgement.stateLayoutsSha256)}, // pragma: allowlist secret\n\tSignerCodecsSHA256:      ${JSON.stringify(releaseAcknowledgement.signerCodecsSha256)}, // pragma: allowlist secret\n}\n`;

const typescriptWithPublicIdentityAllowlist = typescript.replace(
  /(\n  (?:contract|idl|accountOrder|stateLayouts|signerCodecs)Sha256: [^\n]+,)/gu,
  "$1 // pragma: allowlist secret",
);

update(tsPath, Buffer.from(typescriptWithPublicIdentityAllowlist));
update(releaseContractPath, Buffer.from(releaseContract));
update(goPath, Buffer.from(go));
update(goReleasePath, Buffer.from(goRelease));
process.stdout.write(
  importMode
    ? "Imported exact SAT generation-2 interface and generated Fased codecs.\n"
    : "Fased SAT generation-2 interface and codecs are synchronized.\n",
);
