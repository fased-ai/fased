#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "oxfmt";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generationRoot = path.join(root, "src/agents/protocol-generation");
const contractPath = path.join(generationRoot, "sat-sol-money-foundation.v1.json");
const schemaPath = path.join(generationRoot, "sat-sol-money-foundation.v1.schema.json");
const fixturePath = path.join(generationRoot, "sat-sol-money-foundation.v1.fixtures.json");
const sourcePath = path.join(generationRoot, "money-foundation.v1.source.json");
const generatedPath = path.join(root, "src/agents/fased-sat-sol-money-foundation.generated.ts");
const capitalPath = path.join(generationRoot, "fased-agent-capital-interface.v1.json");
const bondFiles = [
  "bond-tier-policy-layout.json",
  "bond-epoch-distributor-v3-layout.json",
  "bond-epoch-position-v3-layout.json",
  "bond-epoch-snapshot-v3-layout.json",
];
const importMode = process.argv.includes("--import");
const checkMode = process.argv.includes("--check");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? "") : "";
}

const agentRoot = argument("--agent-root");
const agentRef = argument("--agent-ref") || "HEAD";
const satRoot = argument("--sat-root");
const satRef = argument("--sat-ref") || "HEAD";

if (importMode === checkMode) {
  throw new Error("use exactly one mode: --import or --check");
}
if (importMode && (!agentRoot || !satRoot)) {
  throw new Error("--import requires --agent-root and --sat-root");
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stableJson = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: args[0] === "rev-parse" || args[0] === "ls-tree" ? "utf8" : null,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitText(repo, args) {
  return String(git(repo, args)).trim();
}

function gitBytes(repo, spec) {
  return Buffer.from(git(repo, ["show", spec]));
}

function update(filePath, bytes) {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  if (current?.equals(bytes)) {
    return;
  }
  if (checkMode) {
    throw new Error(`${path.relative(root, filePath)} is stale`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
}

function importFixtures(repo, ref, commit) {
  const files = gitText(repo, [
    "ls-tree",
    "-r",
    "--name-only",
    ref,
    "fixtures/sat-sol-money-foundation",
  ])
    .split("\n")
    .filter((file) => file.endsWith(".json"))
    .toSorted();
  const entries = files.map((file) => {
    const fixture = JSON.parse(gitBytes(repo, `${ref}:${file}`).toString("utf8"));
    if (
      !fixture ||
      typeof fixture !== "object" ||
      Array.isArray(fixture) ||
      typeof fixture.valid !== "boolean" ||
      !fixture.value ||
      typeof fixture.value !== "object" ||
      Array.isArray(fixture.value)
    ) {
      throw new Error(`canonical money-foundation fixture ${file} is malformed`);
    }
    return { path: file, valid: fixture.valid, value: fixture.value };
  });
  return {
    schema: "fased.money-foundation-fixtures.v1",
    sourceCommit: commit,
    valid: entries.filter((entry) => entry.valid),
    invalid: entries.filter((entry) => !entry.valid),
  };
}

if (importMode) {
  const agentCommit = gitText(agentRoot, ["rev-parse", agentRef]);
  const agentTree = gitText(agentRoot, ["rev-parse", `${agentRef}^{tree}`]);
  const satCommit = gitText(satRoot, ["rev-parse", satRef]);
  const satTree = gitText(satRoot, ["rev-parse", `${satRef}^{tree}`]);
  const contractBytes = gitBytes(
    agentRoot,
    `${agentRef}:contracts/sat-sol-money-foundation.v1.json`,
  );
  const schemaBytes = gitBytes(
    agentRoot,
    `${agentRef}:schemas/sat-sol-money-foundation.v1.schema.json`,
  );
  const upstreamGeneratedBytes = gitBytes(
    agentRoot,
    `${agentRef}:clients/js/src/money-foundation/generated/satSolMoneyFoundation.ts`,
  );
  const generatedBytes = Buffer.from(
    `/* oxlint-disable */\n${upstreamGeneratedBytes.toString("utf8")}`,
  );
  const fixtureBundle = importFixtures(agentRoot, agentRef, agentCommit);
  const fixtureBytes = stableJson(fixtureBundle);
  const contract = JSON.parse(contractBytes.toString("utf8"));
  if (
    contract.$schema !== "fased.sat-sol-money-foundation-contract.v1" ||
    contract.contractId !== "fased.sat-sol-money-foundation.v1" ||
    contract.initialState !== "DISABLED_UNFUNDED" ||
    contract.leadingCanary?.authorized !== false
  ) {
    throw new Error("canonical SAT/SOL money-foundation contract is unsupported");
  }
  const bondLayoutSha256 = {};
  const upstreamBondLayoutSha256 = {};
  for (const file of bondFiles) {
    const bytes = gitBytes(satRoot, `${satRef}:bond-api/${file}`);
    const formatted = await format(file, bytes.toString("utf8"));
    const formattedBytes = Buffer.from(formatted.code);
    upstreamBondLayoutSha256[file] = sha256(bytes);
    bondLayoutSha256[file] = sha256(formattedBytes);
    update(path.join(root, "token/sat/bond-api", file), formattedBytes);
  }
  update(contractPath, contractBytes);
  update(schemaPath, schemaBytes);
  update(fixturePath, fixtureBytes);
  update(generatedPath, generatedBytes);
  await Promise.all(
    [contractPath, schemaPath, fixturePath, generatedPath].map(async (filePath) => {
      const formatted = await format(path.basename(filePath), fs.readFileSync(filePath, "utf8"));
      update(filePath, Buffer.from(formatted.code));
    }),
  );
  const capitalBytes = fs.readFileSync(capitalPath);
  const capital = JSON.parse(capitalBytes.toString("utf8"));
  if (capital.source?.commit !== agentCommit || capital.source?.tree !== agentTree) {
    throw new Error("Agent Capital interface is not pinned to the selected Agent-protocol source");
  }
  update(
    sourcePath,
    stableJson({
      schema: "fased.money-foundation-source.v1",
      agentProtocol: {
        repository: "fased-ai/agent-protocol",
        commit: agentCommit,
        tree: agentTree,
        contractSha256: sha256(fs.readFileSync(contractPath)),
        schemaSha256: sha256(fs.readFileSync(schemaPath)),
        upstreamGeneratedTypeScriptSha256: sha256(upstreamGeneratedBytes),
        generatedTypeScriptSha256: sha256(fs.readFileSync(generatedPath)),
        fixtureBundleSha256: sha256(fs.readFileSync(fixturePath)),
        validFixtureCount: fixtureBundle.valid.length,
        invalidFixtureCount: fixtureBundle.invalid.length,
        capitalInterfaceSha256: sha256(capitalBytes),
      },
      satcoin: {
        repository: "satcoin-org/sat",
        commit: satCommit,
        tree: satTree,
        upstreamBondLayoutSha256,
        bondLayoutSha256,
      },
    }),
  );
}

const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const contractBytes = fs.readFileSync(contractPath);
const schemaBytes = fs.readFileSync(schemaPath);
const generatedBytes = fs.readFileSync(generatedPath);
const fixtureBytes = fs.readFileSync(fixturePath);
const capitalBytes = fs.readFileSync(capitalPath);
const fixtureBundle = JSON.parse(fixtureBytes.toString("utf8"));
const sha256Pattern = /^[0-9a-f]{64}$/u;
if (
  source.schema !== "fased.money-foundation-source.v1" ||
  source.agentProtocol.repository !== "fased-ai/agent-protocol" ||
  source.satcoin.repository !== "satcoin-org/sat" ||
  !/^[0-9a-f]{40}$/u.test(source.agentProtocol.commit) ||
  !/^[0-9a-f]{40}$/u.test(source.agentProtocol.tree) ||
  !/^[0-9a-f]{40}$/u.test(source.satcoin.commit) ||
  !/^[0-9a-f]{40}$/u.test(source.satcoin.tree) ||
  source.agentProtocol.contractSha256 !== sha256(contractBytes) ||
  source.agentProtocol.schemaSha256 !== sha256(schemaBytes) ||
  !sha256Pattern.test(source.agentProtocol.upstreamGeneratedTypeScriptSha256) ||
  source.agentProtocol.generatedTypeScriptSha256 !== sha256(generatedBytes) ||
  source.agentProtocol.fixtureBundleSha256 !== sha256(fixtureBytes) ||
  source.agentProtocol.capitalInterfaceSha256 !== sha256(capitalBytes) ||
  fixtureBundle.schema !== "fased.money-foundation-fixtures.v1" ||
  fixtureBundle.sourceCommit !== source.agentProtocol.commit ||
  fixtureBundle.valid.length !== source.agentProtocol.validFixtureCount ||
  fixtureBundle.invalid.length !== source.agentProtocol.invalidFixtureCount ||
  fixtureBundle.valid.length < 5 ||
  fixtureBundle.invalid.length < 5
) {
  throw new Error("bundled money-foundation source is incomplete or inconsistent");
}
for (const file of bondFiles) {
  if (
    !sha256Pattern.test(source.satcoin.upstreamBondLayoutSha256[file]) ||
    source.satcoin.bondLayoutSha256[file] !==
      sha256(fs.readFileSync(path.join(root, "token/sat/bond-api", file)))
  ) {
    throw new Error(`packaged Satcoin Bond layout ${file} drifted`);
  }
}

console.log(
  JSON.stringify({
    agentProtocolCommit: source.agentProtocol.commit,
    agentProtocolTree: source.agentProtocol.tree,
    satcoinCommit: source.satcoin.commit,
    satcoinTree: source.satcoin.tree,
    validFixtureCount: source.agentProtocol.validFixtureCount,
    invalidFixtureCount: source.agentProtocol.invalidFixtureCount,
  }),
);
