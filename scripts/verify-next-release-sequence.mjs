#!/usr/bin/env node

import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function verifyNextReleaseSequence(current, candidate) {
  if (
    current?.schemaVersion !== 1 ||
    current?.type !== "fased-release-index" ||
    !["stable", "beta"].includes(current.channel) ||
    !Number.isSafeInteger(current.releaseSequence) ||
    current.releaseSequence < 1 ||
    !Number.isSafeInteger(current.securityEpoch) ||
    current.securityEpoch < 1
  ) {
    throw new Error("current public channel identity is invalid");
  }
  if (
    candidate?.channel !== current.channel ||
    candidate?.securityEpoch !== current.securityEpoch ||
    candidate?.releaseSequence !== current.releaseSequence + 1
  ) {
    throw new Error(
      `candidate must use ${current.channel} security epoch ${current.securityEpoch} and release sequence ${current.releaseSequence + 1}`,
    );
  }
  return {
    channel: current.channel,
    securityEpoch: current.securityEpoch,
    releaseSequence: current.releaseSequence + 1,
  };
}

async function main() {
  const [currentFlag, currentPath, sequenceFlag, sequence, epochFlag, epoch] =
    process.argv.slice(2);
  if (
    currentFlag !== "--current" ||
    !currentPath ||
    sequenceFlag !== "--release-sequence" ||
    !/^[1-9][0-9]*$/u.test(sequence ?? "") ||
    epochFlag !== "--security-epoch" ||
    !/^[1-9][0-9]*$/u.test(epoch ?? "")
  ) {
    throw new Error(
      "usage: verify-next-release-sequence.mjs --current <index> --release-sequence <n> --security-epoch <n>",
    );
  }
  const current = JSON.parse(await fs.readFile(currentPath, "utf8"));
  process.stdout.write(
    `${JSON.stringify(
      verifyNextReleaseSequence(current, {
        channel: "beta",
        releaseSequence: Number(sequence),
        securityEpoch: Number(epoch),
      }),
    )}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
