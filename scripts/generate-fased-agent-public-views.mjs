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
  update(generatedPath, Buffer.concat([Buffer.from("/* oxlint-disable */\n"), generatedBytes]));
  execFileSync("pnpm", ["exec", "oxfmt", "--write", generatedPath], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const localGeneratedBytes = fs.readFileSync(generatedPath);
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
        publicViews: contract.publicViews,
      }),
    ),
  );
}

const contractBytes = fs.readFileSync(contractPath);
const generatedBytes = fs.readFileSync(generatedPath);
const contract = JSON.parse(contractBytes.toString("utf8"));
const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
if (
  source.schema !== "fased.agent-public-view-source.v1" ||
  source.repository !== "fased-ai/agent-protocol" ||
  !/^[0-9a-f]{40}$/u.test(source.commit) ||
  !/^[0-9a-f]{40}$/u.test(source.tree) ||
  source.contractSha256 !== sha256(contractBytes) ||
  !/^[0-9a-f]{64}$/u.test(source.upstreamGeneratedTypeScriptSha256) ||
  source.generatedTypeScriptSha256 !== sha256(generatedBytes) ||
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
  }),
);
