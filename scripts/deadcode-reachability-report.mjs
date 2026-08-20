#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const artifacts = path.join(root, ".artifacts", "deadcode");
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function firstCount(source, pattern) {
  const match = pattern.exec(source);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function readEvidence(name) {
  const bytes = await fs.readFile(path.join(artifacts, name));
  return { bytes, text: bytes.toString("utf8") };
}

const [knip, tsPrune, tsUnused, componentContract] = await Promise.all([
  readEvidence("knip.txt"),
  readEvidence("ts-prune.txt"),
  readEvidence("ts-unused-exports.txt"),
  fs.readFile(path.join(root, "config", "hosted-component-packs.json")),
]);

const tsPruneComplete =
  !tsPrune.text.includes("heap out of memory") && !tsPrune.text.includes("FATAL ERROR");
const report = {
  schemaVersion: 1,
  type: "fased-core-reachability-report",
  source: {
    componentContractDigest: sha256(componentContract),
    analyzers: {
      knip: packageJson.devDependencies?.knip,
      tsPrune: packageJson.devDependencies?.["ts-prune"],
      tsUnusedExports: packageJson.devDependencies?.["ts-unused-exports"],
    },
  },
  evidence: {
    knip: {
      digest: sha256(knip.bytes),
      complete: !knip.text.includes("FATAL ERROR"),
      nominalUnusedFiles: firstCount(knip.text, /^Unused files \((\d+)\)$/mu),
      nominalUnusedDependencies: firstCount(knip.text, /^Unused dependencies \((\d+)\)$/mu),
      nominalUnusedExports: firstCount(knip.text, /^Unused exports \((\d+)\)$/mu),
    },
    tsPrune: {
      digest: sha256(tsPrune.bytes),
      complete: tsPruneComplete,
      failure: tsPruneComplete ? null : "heap-budget-exhausted",
    },
    tsUnusedExports: {
      digest: sha256(tsUnused.bytes),
      complete: /\d+ modules with unused exports/u.test(tsUnused.text),
      nominalModules: firstCount(tsUnused.text, /^(\d+) modules with unused exports$/mu),
    },
  },
  decision: {
    authoritativeForDeletion: false,
    reason:
      "Analyzer findings include dynamic entrypoint false positives and ts-prune is incomplete; no source deletion is authorized.",
  },
};

await fs.mkdir(artifacts, { recursive: true });
const output = path.join(artifacts, "reachability.json");
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${output}\n`);
