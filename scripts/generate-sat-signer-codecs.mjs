#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(root, "extensions", "sat-mining", "signer-codec-schema.v1.json");
const accountContractPath = path.join(
  root,
  "extensions",
  "sat-mining",
  "sat-account-order.v1.json",
);
const typescriptPath = path.join(
  root,
  "extensions",
  "sat-mining",
  "src",
  "signer-codec-manifest.ts",
);
const goPath = path.join(root, "tools", "fased-signerd", "sat_manifest_generated.go");
const check = process.argv.includes("--check");
const explicitlyUnboundLegacyActions = new Set([
  "initializeCycle",
  "validatorAttestation",
  "openDispute",
  "resolveDispute",
  "republishEpochRoots",
]);

function fail(message) {
  throw new Error(`SAT signer codec schema: ${message}`);
}

function accountFlags(entry) {
  const match = /:(readonly|writable)(\+signer)?$/.exec(entry);
  if (!match) {
    fail(`canonical account entry ${JSON.stringify(entry)} is invalid`);
  }
  return `${match[2] ? "S" : "-"}${match[1] === "writable" ? "W" : "-"}`;
}

function loadAccountContract() {
  const raw = fs.readFileSync(accountContractPath);
  const parsed = JSON.parse(raw);
  if (
    parsed?.schema !== "sat.account-order.v1" ||
    !Array.isArray(parsed?.programs?.satMining) ||
    !Array.isArray(parsed?.programs?.satBond)
  ) {
    fail("canonical account-order contract is invalid");
  }
  return {
    digest: createHash("sha256").update(raw).digest("hex"),
    programs: {
      main: parsed.programs.satMining,
      bond: parsed.programs.satBond,
    },
  };
}

function assertCanonicalAccountShape(codec, accountContract) {
  const instruction = accountContract.programs[codec.family].find(
    (candidate) => candidate.discriminant === codec.discriminator,
  );
  if (!instruction) {
    if (explicitlyUnboundLegacyActions.has(codec.action)) {
      return;
    }
    fail(
      `${codec.action} has no canonical ${codec.family} instruction for discriminator ${codec.discriminator}`,
    );
  }
  if (explicitlyUnboundLegacyActions.has(codec.action)) {
    fail(`${codec.action} unexpectedly overlaps the canonical SAT account-order contract`);
  }
  if (instruction.status === "reserved" || instruction.status === "retired-rejected") {
    fail(`${codec.action} targets rejected instruction ${instruction.name}`);
  }
  const order = instruction.accountOrder;
  if (!Array.isArray(order) || order.length === 0) {
    fail(`${instruction.name} has no canonical account order`);
  }
  const repeated = order.filter((entry) => entry.includes("[]:"));
  const fixed = order.filter((entry) => !entry.includes("[]:"));
  const expectedVariablePatterns = {
    minerCycles: ["sat_miner_cycle_state[]:writable"],
    registryPages: ["sat_cycle_registry_page[]:readonly"],
    minerCyclePairs: ["sat_miner_cycle_state[]:writable", "sat_miner_capital_state[]:writable"],
    compactCycles: [
      "front_sat_miner_cycle_state[]:readonly",
      "back_sat_miner_cycle_state[]:readonly",
    ],
    claimBatch: ["sat_cycle_state[]:writable", "sat_miner_cycle_state[]:writable"],
  };
  if (codec.variable === "") {
    if (repeated.length !== 0) {
      fail(`${codec.action} omits canonical repeated accounts`);
    }
    const canonicalShape = fixed.map(accountFlags).join(",");
    if (codec.accountShape !== canonicalShape) {
      fail(
        `${codec.action}.accountShape ${codec.accountShape} differs from canonical ${canonicalShape}`,
      );
    }
    return;
  }
  const expectedRepeated = expectedVariablePatterns[codec.variable];
  if (!expectedRepeated) {
    fail(`${codec.action} has unsupported canonical variable ${codec.variable}`);
  }
  if (JSON.stringify(repeated) !== JSON.stringify(expectedRepeated)) {
    fail(
      `${codec.action} repeated account order ${JSON.stringify(repeated)} differs from canonical ${JSON.stringify(expectedRepeated)}`,
    );
  }
  const firstRepeatedIndex = order.findIndex((entry) => entry.includes("[]:"));
  const fixedPrefix = order.slice(0, firstRepeatedIndex).map(accountFlags).join(",");
  if (codec.accountShape !== fixedPrefix) {
    fail(
      `${codec.action}.accountShape ${codec.accountShape} differs from canonical fixed prefix ${fixedPrefix}`,
    );
  }
  const suffix = order.slice(firstRepeatedIndex).filter((entry) => !entry.includes("[]:"));
  const expectedSuffix =
    codec.variable === "claimBatch"
      ? [
          "system_program:readonly",
          "token_program:readonly",
          "associated_token_program:readonly",
          "sat_mint_program:readonly",
          "sat_rebate_vault:writable",
        ]
      : [];
  if (JSON.stringify(suffix) !== JSON.stringify(expectedSuffix)) {
    fail(
      `${codec.action} fixed account suffix ${JSON.stringify(suffix)} differs from canonical ${JSON.stringify(expectedSuffix)}`,
    );
  }
}

function loadSchema() {
  const accountContract = loadAccountContract();
  const parsed = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  if (parsed?.version !== 1 || !Array.isArray(parsed.codecs) || parsed.codecs.length === 0) {
    fail("expected a non-empty version 1 codecs array");
  }
  const actions = new Set();
  const discriminators = new Set();
  const variables = new Set([
    "",
    "minerCycles",
    "registryPages",
    "minerCyclePairs",
    "claimBatch",
    "compactCycles",
  ]);
  for (const [index, codec] of parsed.codecs.entries()) {
    const label = `codecs[${index}]`;
    if (!codec || typeof codec !== "object" || Array.isArray(codec)) {
      fail(`${label} must be an object`);
    }
    if (typeof codec.action !== "string" || !/^[a-z][A-Za-z0-9]*$/.test(codec.action)) {
      fail(`${label}.action is invalid`);
    }
    if (actions.has(codec.action)) {
      fail(`duplicate action ${codec.action}`);
    }
    actions.add(codec.action);
    if (codec.family !== "main" && codec.family !== "bond") {
      fail(`${codec.action}.family must be main or bond`);
    }
    if (typeof codec.contractKey !== "string" || !/^[a-z][A-Za-z0-9]*$/.test(codec.contractKey)) {
      fail(`${codec.action}.contractKey is invalid`);
    }
    if (
      !Number.isInteger(codec.discriminator) ||
      codec.discriminator < 0 ||
      codec.discriminator > 255
    ) {
      fail(`${codec.action}.discriminator must be one byte`);
    }
    const discriminatorKey = `${codec.family}:${codec.discriminator}`;
    if (discriminators.has(discriminatorKey)) {
      fail(`duplicate ${codec.family} discriminator ${codec.discriminator}`);
    }
    discriminators.add(discriminatorKey);
    if (!Number.isInteger(codec.dataLength) || (codec.dataLength <= 0 && codec.dataLength !== -1)) {
      fail(`${codec.action}.dataLength must be positive or -1`);
    }
    if (
      typeof codec.accountShape !== "string" ||
      !codec.accountShape.split(",").every((flags) => /^(?:S|-)(?:W|-)$/.test(flags))
    ) {
      fail(`${codec.action}.accountShape contains invalid signer/writable flags`);
    }
    if (!variables.has(codec.variable)) {
      fail(`${codec.action}.variable is unsupported`);
    }
    if ((codec.dataLength === -1) !== (codec.variable === "claimBatch")) {
      fail(`${codec.action} must pair variable claimBatch with dataLength -1`);
    }
    assertCanonicalAccountShape(codec, accountContract);
  }
  return { codecs: parsed.codecs, accountContractDigest: accountContract.digest };
}

function renderTypescript(codecs, accountContractDigest) {
  const entries = codecs
    .map(
      (codec) => `  {
    action: ${JSON.stringify(codec.action)},
    family: ${JSON.stringify(codec.family)},
    contractKey: ${JSON.stringify(codec.contractKey)},
    discriminator: ${codec.discriminator},
    dataLength: ${codec.dataLength},
    accountShape: ${JSON.stringify(codec.accountShape)},
    variable: ${JSON.stringify(codec.variable)},
  },`,
    )
    .join("\n");
  return `// Code generated from extensions/sat-mining/signer-codec-schema.v1.json.
// Run \`pnpm sat:signer-codecs:generate\`; do not edit this file directly.

export const SAT_SIGNER_CODECS = [
${entries}
] as const;

export const SAT_ACCOUNT_ORDER_CONTRACT_SHA256 =
  ${JSON.stringify(accountContractDigest)};
export const SAT_UNBOUND_LEGACY_ACTIONS = [
${[...explicitlyUnboundLegacyActions]
  .toSorted()
  .map((action) => `  ${JSON.stringify(action)},`)
  .join("\n")}
] as const;

export type SatSignerAction = (typeof SAT_SIGNER_CODECS)[number]["action"];
export type SatSignerCodec = (typeof SAT_SIGNER_CODECS)[number];

function assertCodecData(codec: SatSignerCodec, data: Buffer): void {
  if (data[0] !== codec.discriminator) {
    throw new Error(\`SAT \${codec.action} discriminator mismatch\`);
  }
  if (codec.variable === "claimBatch") {
    if (data.length < 17 || data.subarray(2, 9).some((value) => value !== 0)) {
      throw new Error("SAT claimCycleRewardsBatch has invalid canonical header");
    }
    const count = data[1] ?? 0;
    if (count === 0 || data.length !== 9 + count * 8) {
      throw new Error("SAT claimCycleRewardsBatch item count does not match its payload");
    }
    return;
  }
  if (data.length !== codec.dataLength) {
    throw new Error(
      \`SAT \${codec.action} payload must contain \${codec.dataLength} bytes, got \${data.length}\`,
    );
  }
}

export function resolveSatSignerCodec(params: {
  programId: string;
  mainProgramId: string;
  bondProgramId?: string;
  data: Buffer;
}): SatSignerCodec {
  const family =
    params.programId === params.mainProgramId
      ? "main"
      : params.bondProgramId && params.programId === params.bondProgramId
        ? "bond"
        : null;
  if (!family) {
    throw new Error(\`SAT signer rejects unconfigured program \${params.programId}\`);
  }
  const codec = SAT_SIGNER_CODECS.find(
    (candidate) => candidate.family === family && candidate.discriminator === params.data[0],
  );
  if (!codec) {
    throw new Error(
      \`SAT signer has no typed action for discriminator \${params.data[0] ?? -1} on \${params.programId}\`,
    );
  }
  assertCodecData(codec, params.data);
  return codec;
}

export const SAT_SIGNER_ACTIONS = SAT_SIGNER_CODECS.map(
  (codec) => codec.action,
) as readonly SatSignerAction[];
`;
}

function renderGo(codecs, accountContractDigest) {
  const entries = codecs
    .map(
      (codec) => `\t${JSON.stringify(codec.action)}: {
\t\tAction:        ${JSON.stringify(codec.action)},
\t\tDiscriminator: ${codec.discriminator},
\t\tDataLength:    ${codec.dataLength},
\t\tFamily:        satFamily${codec.family === "main" ? "Main" : "Bond"},
\t\tContractKey:   ${JSON.stringify(codec.contractKey)},
\t\tAccountShape:  ${JSON.stringify(codec.accountShape)},
\t\tVariable:      ${JSON.stringify(codec.variable)},
\t},`,
    )
    .join("\n");
  return `package main

// Code generated from extensions/sat-mining/signer-codec-schema.v1.json.
// Run \`pnpm sat:signer-codecs:generate\`; DO NOT EDIT.

type signerSATCodecV2 struct {
\tAction        string
\tDiscriminator byte
\tDataLength    int
\tFamily        string
\tContractKey   string
\tAccountShape  string
\tVariable      string
}

const (
\tsatFamilyMain = "main"
\tsatFamilyBond = "bond"
)

const satAccountOrderContractSHA256 = ${JSON.stringify(accountContractDigest)}

var satUnboundLegacyActions = map[string]struct{}{
${[...explicitlyUnboundLegacyActions]
  .toSorted()
  .map((action, _index, actions) => {
    const rendered = JSON.stringify(action);
    const width = Math.max(...actions.map((entry) => JSON.stringify(entry).length));
    return `\t${rendered}:${" ".repeat(width - rendered.length + 1)}{},`;
  })
  .join("\n")}
}

var signerSATCodecsV2 = map[string]signerSATCodecV2{
${entries}
}
`;
}

function updateGeneratedFile(filePath, expected) {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  if (current === expected) {
    return false;
  }
  if (check) {
    process.stderr.write(
      `${path.relative(root, filePath)} is stale; run pnpm sat:signer-codecs:generate\n`,
    );
    process.exitCode = 1;
    return true;
  }
  fs.writeFileSync(filePath, expected, "utf8");
  return true;
}

const { codecs, accountContractDigest } = loadSchema();
updateGeneratedFile(typescriptPath, renderTypescript(codecs, accountContractDigest));
updateGeneratedFile(goPath, renderGo(codecs, accountContractDigest));
