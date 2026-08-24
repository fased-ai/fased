#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_PHASES = new Set([
  "nodeBuild",
  "goBuild",
  "packaging",
  "attestation",
  "upload",
  "channelAdvancement",
]);

async function readReceipt(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    return { schemaVersion: 1, phases: {} };
  }
}

async function writeReceipt(file, receipt) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

function validatePhase(phase) {
  if (!RELEASE_PHASES.has(phase)) {
    throw new Error(`unknown release phase: ${phase}`);
  }
}

export async function startReleasePhase(file, phase, now = Date.now()) {
  validatePhase(phase);
  const receipt = await readReceipt(file);
  receipt.phases[phase] = { startedAtMs: now };
  await writeReceipt(file, receipt);
}

export async function finishReleasePhase(file, phase, now = Date.now()) {
  validatePhase(phase);
  const receipt = await readReceipt(file);
  const startedAtMs = receipt.phases?.[phase]?.startedAtMs;
  if (!Number.isSafeInteger(startedAtMs) || now < startedAtMs) {
    throw new Error(`release phase ${phase} was not started`);
  }
  receipt.phases[phase] = {
    startedAtMs,
    finishedAtMs: now,
    durationMillis: now - startedAtMs,
  };
  await writeReceipt(file, receipt);
}

async function main(argv) {
  const [command, file, phase] = argv;
  if (!file || !phase || (command !== "start" && command !== "finish")) {
    throw new Error("usage: release-phase-timings.mjs start|finish FILE PHASE");
  }
  if (command === "start") {
    await startReleasePhase(file, phase);
  } else {
    await finishReleasePhase(file, phase);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
