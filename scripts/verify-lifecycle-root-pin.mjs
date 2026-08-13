#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DIGEST = /^[a-f0-9]{64}$/u;

async function readRegularFile(file, label) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0) {
    throw new Error(`${label} is not a safe regular file: ${file}`);
  }
  return fs.readFile(file);
}

export async function verifyLifecycleRootPin({ pinPath, rootPath }) {
  const [root, pin] = await Promise.all([
    readRegularFile(rootPath, "lifecycle root"),
    readRegularFile(pinPath, "lifecycle root pin"),
  ]);
  const expected = pin.toString("utf8").trim();
  if (!DIGEST.test(expected)) {
    throw new Error("lifecycle root pin must contain exactly one lowercase SHA-256 digest");
  }
  const actual = createHash("sha256").update(root).digest("hex");
  if (actual !== expected) {
    throw new Error(`lifecycle root pin mismatch: expected ${expected}, got ${actual}`);
  }
  return actual;
}

async function main(argv) {
  let rootPath = "release/lifecycle-trust/root-v1/fased-lifecycle-root-v1.json";
  let pinPath = "release/lifecycle-trust/root-v1/fased-lifecycle-root-v1.sha256";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      rootPath = argv[++index];
    } else if (argument === "--pin") {
      pinPath = argv[++index];
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  const digest = await verifyLifecycleRootPin({
    pinPath: path.resolve(pinPath),
    rootPath: path.resolve(rootPath),
  });
  process.stdout.write(`${digest}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
