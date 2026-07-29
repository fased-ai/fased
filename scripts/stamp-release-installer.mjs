#!/usr/bin/env node

import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const RELEASE_MARKER = 'install_entry_release_identity="__FASED_RELEASE_IDENTITY__"';

export async function stampReleaseInstaller({ source, output, version }) {
  if (!VERSION_PATTERN.test(version || "")) {
    throw new Error("release installer version is not canonical");
  }
  const sourceInfo = await fsp.lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.nlink !== 1) {
    throw new Error("release installer source must be one regular single-link file");
  }
  const body = await fsp.readFile(source, "utf8");
  if (
    body.indexOf(RELEASE_MARKER) < 0 ||
    body.indexOf(RELEASE_MARKER) !== body.lastIndexOf(RELEASE_MARKER)
  ) {
    throw new Error("installer release identity marker is missing or ambiguous");
  }
  const stamped = body.replace(RELEASE_MARKER, `install_entry_release_identity="${version}"`);
  await fsp.writeFile(output, stamped, { mode: 0o755 });
  await fsp.chmod(output, 0o755);
}

function parseArgs(argv) {
  const values = new Map();
  const allowed = new Set(["--source", "--output", "--version"]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || values.has(key)) {
      throw new Error(
        "usage: stamp-release-installer --source install.sh --output FILE --version X.Y.Z",
      );
    }
    values.set(key, value);
  }
  for (const required of allowed) {
    if (!values.has(required)) {
      throw new Error(`missing ${required}`);
    }
  }
  return {
    source: path.resolve(values.get("--source")),
    output: path.resolve(values.get("--output")),
    version: values.get("--version"),
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
