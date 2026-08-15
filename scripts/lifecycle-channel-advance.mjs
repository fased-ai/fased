#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const GIT = /^[a-f0-9]{40}$/u;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeIndex(bytes, label) {
  let index;
  try {
    index = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} release index is not JSON`);
  }
  if (
    index?.schemaVersion !== 1 ||
    index?.type !== "fased-release-index" ||
    !["stable", "beta"].includes(index.channel) ||
    !VERSION.test(index.version ?? "") ||
    !Number.isSafeInteger(index.releaseSequence) ||
    index.releaseSequence < 1 ||
    !Number.isSafeInteger(index.securityEpoch) ||
    index.securityEpoch < 1 ||
    !GIT.test(index.commit ?? "")
  ) {
    throw new Error(`${label} release index identity is invalid`);
  }
  const prerelease = index.version.includes("-");
  if ((index.channel === "beta") !== prerelease) {
    throw new Error(`${label} release index channel and version disagree`);
  }
  return index;
}

export function planLifecycleChannelAdvance({
  candidateBytes,
  currentBytes,
  expectedCommit,
  expectedVersion,
}) {
  const candidate = decodeIndex(candidateBytes, "candidate");
  if (candidate.version !== expectedVersion || candidate.commit !== expectedCommit) {
    throw new Error("candidate release index differs from the exact release identity");
  }
  if (currentBytes == null) {
    return { action: "INITIALIZE", candidate };
  }
  const current = decodeIndex(currentBytes, "current channel");
  if (current.channel !== candidate.channel) {
    throw new Error("current and candidate release indexes select different channels");
  }
  if (digest(currentBytes) === digest(candidateBytes)) {
    return { action: "ALREADY_CURRENT", candidate, current };
  }
  if (candidate.releaseSequence <= current.releaseSequence) {
    throw new Error("candidate release sequence does not advance the channel");
  }
  if (candidate.securityEpoch < current.securityEpoch) {
    throw new Error("candidate security epoch would roll back the channel");
  }
  return { action: "ADVANCE", candidate, current };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) {
      throw new Error("channel advance requires named option/value pairs");
    }
    values.set(key, value);
  }
  for (const key of ["--candidate", "--version", "--commit"]) {
    if (!values.has(key)) {
      throw new Error(`missing ${key}`);
    }
  }
  for (const key of values.keys()) {
    if (!["--candidate", "--current", "--version", "--commit"].includes(key)) {
      throw new Error(`unsupported ${key}`);
    }
  }
  return {
    candidate: path.resolve(values.get("--candidate")),
    current: values.has("--current") ? path.resolve(values.get("--current")) : undefined,
    expectedVersion: values.get("--version"),
    expectedCommit: values.get("--commit"),
  };
}

async function main(argv) {
  const options = parseArgs(argv);
  const result = planLifecycleChannelAdvance({
    candidateBytes: await fs.readFile(options.candidate),
    currentBytes: options.current ? await fs.readFile(options.current) : null,
    expectedCommit: options.expectedCommit,
    expectedVersion: options.expectedVersion,
  });
  process.stdout.write(`${result.action}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`lifecycle-channel-advance: ${error.message}\n`);
    process.exitCode = 1;
  });
}
