#!/usr/bin/env node

import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const RELEASE_MARKER = 'install_entry_release_identity="__FASED_RELEASE_IDENTITY__"';
const BOOTSTRAP_X64_MARKER = 'bootstrap_sha256_x64="__FASED_BOOTSTRAP_SHA256_X64__"';
const BOOTSTRAP_ARM64_MARKER = 'bootstrap_sha256_arm64="__FASED_BOOTSTRAP_SHA256_ARM64__"';
const BOOTSTRAP_DARWIN_X64_MARKER =
  'bootstrap_sha256_darwin_x64="__FASED_BOOTSTRAP_SHA256_DARWIN_X64__"';
const BOOTSTRAP_DARWIN_ARM64_MARKER =
  'bootstrap_sha256_darwin_arm64="__FASED_BOOTSTRAP_SHA256_DARWIN_ARM64__"';

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
  bootstrapDarwinX64,
  bootstrapDarwinArm64,
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
  for (const marker of [
    RELEASE_MARKER,
    BOOTSTRAP_X64_MARKER,
    BOOTSTRAP_ARM64_MARKER,
    BOOTSTRAP_DARWIN_X64_MARKER,
    BOOTSTRAP_DARWIN_ARM64_MARKER,
  ]) {
    if (body.indexOf(marker) < 0 || body.indexOf(marker) !== body.lastIndexOf(marker)) {
      throw new Error("installer release identity or bootstrap marker is missing or ambiguous");
    }
  }
  if (architecture !== undefined && !["x64", "arm64", "all"].includes(architecture)) {
    throw new Error("managed release installer architecture is unsupported");
  }
  if (!bootstrapX64) {
    throw new Error("required x64 release bootstrap is missing");
  }
  const x64Digest = await bootstrapDigest(bootstrapX64);
  const arm64Digest = bootstrapArm64 ? await bootstrapDigest(bootstrapArm64) : "";
  const darwinX64Digest = bootstrapDarwinX64 ? await bootstrapDigest(bootstrapDarwinX64) : "";
  const darwinArm64Digest = bootstrapDarwinArm64 ? await bootstrapDigest(bootstrapDarwinArm64) : "";
  if ((architecture === "arm64" || architecture === "all") && !arm64Digest) {
    throw new Error("required arm64 release bootstrap is missing");
  }
  if (architecture === "all" && (!darwinX64Digest || !darwinArm64Digest)) {
    throw new Error("required Darwin release bootstrap is missing");
  }
  const stamped = body
    .replace(RELEASE_MARKER, `install_entry_release_identity="${version}"`)
    .replace(BOOTSTRAP_X64_MARKER, `bootstrap_sha256_x64="${x64Digest}"`)
    .replace(BOOTSTRAP_ARM64_MARKER, `bootstrap_sha256_arm64="${arm64Digest}"`)
    .replace(BOOTSTRAP_DARWIN_X64_MARKER, `bootstrap_sha256_darwin_x64="${darwinX64Digest}"`)
    .replace(BOOTSTRAP_DARWIN_ARM64_MARKER, `bootstrap_sha256_darwin_arm64="${darwinArm64Digest}"`);
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
    "--bootstrap-darwin-x64",
    "--bootstrap-darwin-arm64",
    "--architecture",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || values.has(key)) {
      throw new Error(
        "usage: stamp-release-installer --source install.sh --output FILE --version X.Y.Z --bootstrap-x64 FILE [--architecture x64]",
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
  if (!values.has("--bootstrap-x64")) {
    throw new Error("missing --bootstrap-x64");
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
    bootstrapDarwinX64: values.has("--bootstrap-darwin-x64")
      ? path.resolve(values.get("--bootstrap-darwin-x64"))
      : undefined,
    bootstrapDarwinArm64: values.has("--bootstrap-darwin-arm64")
      ? path.resolve(values.get("--bootstrap-darwin-arm64"))
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
