#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { verifyAcceptanceReceipt } from "./lifecycle-acceptance-contract.mjs";

function fail(message) {
  throw new Error(`lifecycle receipt verifier: ${message}`);
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || args[index + 1] === undefined) {
      fail("arguments must be --name value pairs");
    }
    options[args[index].slice(2)] = args[index + 1];
  }
  return options;
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function verifyLifecycleReceipt({ contract, receipt, expected }) {
  return verifyAcceptanceReceipt({ contract, receipt, expected });
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const predecessorCapsuleDigest = options["predecessor-capsule-digest"] || null;
  const predecessorInstallationClass = options["predecessor-installation-class"] || null;
  const predecessorInstallationClassDigest =
    options["predecessor-installation-class-digest"] || null;
  const receipt = verifyLifecycleReceipt({
    contract: readJson(options.contract, "contract"),
    receipt: readJson(options.receipt, "receipt"),
    expected: {
      profile: options.profile,
      scenario: options.scenario,
      version: options.version,
      commit: options.commit,
      candidateDescriptorDigest: options["candidate-descriptor-digest"],
      predecessorCapsuleDigest,
      predecessorInstallationClass,
      predecessorInstallationClassDigest,
      evidenceClass: options["evidence-class"] || "PASS",
      acquisitionEvidenceClass:
        options["acquisition-evidence-class"] || options["evidence-class"] || "PASS",
    },
  });
  process.stdout.write(
    `${JSON.stringify({ ok: true, profile: receipt.profile, scenario: receipt.scenario })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
