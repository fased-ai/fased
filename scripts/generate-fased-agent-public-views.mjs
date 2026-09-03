#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = path.join(
  root,
  "src",
  "agents",
  "protocol-generation",
  "public-agent-views.v1.json",
);
const sourcePath = path.join(
  root,
  "src",
  "agents",
  "protocol-generation",
  "public-agent-views.v1.source.json",
);
const generatedPath = path.join(root, "src", "agents", "fased-agent-public-views.generated.ts");
const fixtureBundlePath = path.join(
  root,
  "src",
  "agents",
  "protocol-generation",
  "public-agent-views.v1.fixtures.json",
);
const importMode = process.argv.includes("--import");
const checkMode = process.argv.includes("--check");
const agentRootIndex = process.argv.indexOf("--agent-root");
const sourceRefIndex = process.argv.indexOf("--source-ref");
const agentRoot = agentRootIndex >= 0 ? path.resolve(process.argv[agentRootIndex + 1] ?? "") : null;
const sourceRef = sourceRefIndex >= 0 ? process.argv[sourceRefIndex + 1] : "HEAD";

if (importMode === checkMode) {
  throw new Error("use exactly one mode: --import or --check");
}
if (importMode && !agentRoot) {
  throw new Error("--import requires --agent-root <agent-protocol-checkout>");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: args[0] === "show" ? null : "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function importedFixtures(repo, sourceRef, commit) {
  const fixtureRoot = "fixtures/public-agent-views/v1";
  const files = String(git(repo, ["ls-tree", "-r", "--name-only", sourceRef, fixtureRoot]))
    .trim()
    .split("\n")
    .filter((file) => file.endsWith(".json"))
    .toSorted();
  const entries = files.map((file) => {
    const fixture = JSON.parse(
      Buffer.from(git(repo, ["show", `${sourceRef}:${file}`])).toString("utf8"),
    );
    if (
      !fixture ||
      typeof fixture !== "object" ||
      Array.isArray(fixture) ||
      Object.keys(fixture).toSorted().join(",") !== "scenario,value" ||
      typeof fixture.scenario !== "string" ||
      !fixture.value ||
      typeof fixture.value !== "object" ||
      Array.isArray(fixture.value)
    ) {
      throw new Error(`canonical Agent public-view fixture ${file} is malformed`);
    }
    return { path: file, scenario: fixture.scenario, value: fixture.value };
  });
  return {
    schema: "fased.agent-public-view-fixtures.v1",
    sourceCommit: commit,
    valid: entries.filter((entry) => entry.path.includes("/valid/")),
    invalid: entries.filter((entry) => entry.path.includes("/invalid/")),
  };
}

function update(filePath, expected) {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  if (current?.equals(expected)) {
    return;
  }
  if (checkMode) {
    throw new Error(`${path.relative(root, filePath)} is stale`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, expected);
}

if (importMode) {
  const commit = String(git(agentRoot, ["rev-parse", sourceRef])).trim();
  const tree = String(git(agentRoot, ["rev-parse", `${sourceRef}^{tree}`])).trim();
  const contractBytes = Buffer.from(
    git(agentRoot, ["show", `${sourceRef}:contracts/public-agent-views.v1.json`]),
  );
  const generatedBytes = Buffer.from(
    git(agentRoot, ["show", `${sourceRef}:clients/js/src/views/generated/publicAgentViews.ts`]),
  );
  const fixtureBundle = importedFixtures(agentRoot, sourceRef, commit);
  const contract = JSON.parse(contractBytes.toString("utf8"));
  if (
    contract.$schema !== "fased.public-agent-view-contract.v1" ||
    contract.contractId !== "fased.public-agent-views.v1" ||
    JSON.stringify(contract.publicViews) !==
      JSON.stringify([
        "AgentEvidenceRef",
        "AgentIdentityView",
        "AgentMiningView",
        "AgentQualificationView",
      ])
  ) {
    throw new Error("canonical Agent public-view contract is unsupported");
  }
  update(contractPath, contractBytes);
  update(fixtureBundlePath, Buffer.from(stableJson(fixtureBundle)));
  update(generatedPath, Buffer.concat([Buffer.from("/* oxlint-disable */\n"), generatedBytes]));
  execFileSync("pnpm", ["exec", "oxfmt", "--write", generatedPath, fixtureBundlePath], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const localGeneratedBytes = fs.readFileSync(generatedPath);
  const localFixtureBundleBytes = fs.readFileSync(fixtureBundlePath);
  update(
    sourcePath,
    Buffer.from(
      stableJson({
        schema: "fased.agent-public-view-source.v1",
        repository: "fased-ai/agent-protocol",
        commit,
        tree,
        contractSha256: sha256(contractBytes),
        upstreamGeneratedTypeScriptSha256: sha256(generatedBytes),
        generatedTypeScriptSha256: sha256(localGeneratedBytes),
        fixtureBundleSha256: sha256(localFixtureBundleBytes),
        validFixtureCount: fixtureBundle.valid.length,
        invalidFixtureCount: fixtureBundle.invalid.length,
        publicViews: contract.publicViews,
      }),
    ),
  );
}

const contractBytes = fs.readFileSync(contractPath);
const generatedBytes = fs.readFileSync(generatedPath);
const fixtureBundleBytes = fs.readFileSync(fixtureBundlePath);
const contract = JSON.parse(contractBytes.toString("utf8"));
const fixtureBundle = JSON.parse(fixtureBundleBytes.toString("utf8"));
const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
if (
  source.schema !== "fased.agent-public-view-source.v1" ||
  source.repository !== "fased-ai/agent-protocol" ||
  !/^[0-9a-f]{40}$/u.test(source.commit) ||
  !/^[0-9a-f]{40}$/u.test(source.tree) ||
  source.contractSha256 !== sha256(contractBytes) ||
  !/^[0-9a-f]{64}$/u.test(source.upstreamGeneratedTypeScriptSha256) ||
  source.generatedTypeScriptSha256 !== sha256(generatedBytes) ||
  source.fixtureBundleSha256 !== sha256(fixtureBundleBytes) ||
  fixtureBundle.schema !== "fased.agent-public-view-fixtures.v1" ||
  fixtureBundle.sourceCommit !== source.commit ||
  fixtureBundle.valid.length !== source.validFixtureCount ||
  fixtureBundle.invalid.length !== source.invalidFixtureCount ||
  source.validFixtureCount < 10 ||
  source.invalidFixtureCount < 5 ||
  contract.contractId !== "fased.public-agent-views.v1" ||
  JSON.stringify(source.publicViews) !== JSON.stringify(contract.publicViews)
) {
  throw new Error("bundled Agent public-view source is incomplete or inconsistent");
}

console.log(
  JSON.stringify({
    contractId: contract.contractId,
    sourceCommit: source.commit,
    sourceTree: source.tree,
    contractSha256: source.contractSha256,
    upstreamGeneratedTypeScriptSha256: source.upstreamGeneratedTypeScriptSha256,
    generatedTypeScriptSha256: source.generatedTypeScriptSha256,
    fixtureBundleSha256: source.fixtureBundleSha256,
    validFixtureCount: source.validFixtureCount,
    invalidFixtureCount: source.invalidFixtureCount,
  }),
);
