#!/usr/bin/env node

import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const RELEASE_MARKER = 'install_entry_release_identity="__FASED_RELEASE_IDENTITY__"';
const BOOTSTRAP_X64_MARKER = 'bootstrap_sha256_x64="__FASED_BOOTSTRAP_SHA256_X64__"';
const BOOTSTRAP_ARM64_MARKER = 'bootstrap_sha256_arm64="__FASED_BOOTSTRAP_SHA256_ARM64__"';

async function bootstrapDigest(file) {
  const info = await fsp.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0) {
    throw new Error("release bootstrap must be one non-empty regular single-link file");
  }
  return createHash("sha256")
    .update(await fsp.readFile(file))
    .digest("hex");
}

export async function stampReleaseInstaller({
  source,
  output,
  version,
  bootstrapX64,
  bootstrapArm64,
  architecture,
}) {
  if (!VERSION_PATTERN.test(version || "")) {
    throw new Error("release installer version is not canonical");
  }
  const sourceInfo = await fsp.lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.nlink !== 1) {
    throw new Error("release installer source must be one regular single-link file");
  }
  const body = await fsp.readFile(source, "utf8");
  for (const marker of [RELEASE_MARKER, BOOTSTRAP_X64_MARKER, BOOTSTRAP_ARM64_MARKER]) {
    if (body.indexOf(marker) < 0 || body.indexOf(marker) !== body.lastIndexOf(marker)) {
      throw new Error("installer release identity or bootstrap marker is missing or ambiguous");
    }
  }
  if (architecture !== undefined && architecture !== "x64" && architecture !== "arm64") {
    throw new Error("branch installer architecture must be x64 or arm64");
  }
  if (
    (!architecture && (!bootstrapX64 || !bootstrapArm64)) ||
    (architecture === "x64" && !bootstrapX64) ||
    (architecture === "arm64" && !bootstrapArm64)
  ) {
    throw new Error("required release bootstrap architecture is missing");
  }
  const unsupportedDigest = "0".repeat(64);
  const x64Digest = bootstrapX64 ? await bootstrapDigest(bootstrapX64) : unsupportedDigest;
  const arm64Digest = bootstrapArm64 ? await bootstrapDigest(bootstrapArm64) : unsupportedDigest;
  const stamped = body
    .replace(RELEASE_MARKER, `install_entry_release_identity="${version}"`)
    .replace(BOOTSTRAP_X64_MARKER, `bootstrap_sha256_x64="${x64Digest}"`)
    .replace(BOOTSTRAP_ARM64_MARKER, `bootstrap_sha256_arm64="${arm64Digest}"`);
  await fsp.writeFile(output, stamped, { mode: 0o755 });
  await fsp.chmod(output, 0o755);
}

function parseArgs(argv) {
  const values = new Map();
  const allowed = new Set([
    "--source",
    "--output",
    "--version",
    "--bootstrap-x64",
    "--bootstrap-arm64",
    "--architecture",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || values.has(key)) {
      throw new Error(
        "usage: stamp-release-installer --source install.sh --output FILE --version X.Y.Z --bootstrap-x64 FILE --bootstrap-arm64 FILE",
      );
    }
    values.set(key, value);
  }
  for (const required of ["--source", "--output", "--version"]) {
    if (!values.has(required)) {
      throw new Error(`missing ${required}`);
    }
  }
  const architecture = values.get("--architecture");
  if ((!architecture || architecture === "x64") && !values.has("--bootstrap-x64")) {
    throw new Error("missing --bootstrap-x64");
  }
  if ((!architecture || architecture === "arm64") && !values.has("--bootstrap-arm64")) {
    throw new Error("missing --bootstrap-arm64");
  }
  return {
    source: path.resolve(values.get("--source")),
    output: path.resolve(values.get("--output")),
    version: values.get("--version"),
    bootstrapX64: values.has("--bootstrap-x64")
      ? path.resolve(values.get("--bootstrap-x64"))
      : undefined,
    bootstrapArm64: values.has("--bootstrap-arm64")
      ? path.resolve(values.get("--bootstrap-arm64"))
      : undefined,
    architecture,
  };
}

async function main(argv) {
  await stampReleaseInstaller(parseArgs(argv));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`stamp-release-installer: ${error.message}\n`);
    process.exitCode = 1;
  });
}
