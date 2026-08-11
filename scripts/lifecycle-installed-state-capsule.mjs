#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as tar from "tar";
import { parsePredecessorCapsule } from "./predecessor-capsule.mjs";

export const parseInstalledStateCapsule = parsePredecessorCapsule;

function fail(message) {
  throw new Error(`installed-state capsule: ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} is invalid`);
  }
  if (
    Object.keys(value).toSorted().join(",") !==
    [...expected].toSorted((left, right) => left.localeCompare(right)).join(",")
  ) {
    fail(`${label} fields are invalid`);
  }
}

async function digestFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function safeSourceFile(root, relative) {
  const segments = relative.split("/");
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const info = await fsp.lstat(current);
    if (info.isSymbolicLink()) {
      fail(`source path contains a symlink: ${relative}`);
    }
  }
  const info = await fsp.lstat(current);
  if (!info.isFile() || info.nlink !== 1) {
    fail(`source entry is not one regular file: ${relative}`);
  }
  return { file: current, info };
}

export async function buildInstalledStateCapsule({ spec, sourceRoot, outputDirectory }) {
  exactKeys(
    spec,
    [
      "schemaVersion",
      "role",
      "profile",
      "compatibilityGroupId",
      "release",
      "releaseIndex",
      "topology",
      "ownership",
      "pointers",
      "expectedReceiptDigest",
      "sanitization",
      "services",
      "archiveName",
      "entries",
    ],
    "spec",
  );
  if (
    spec.schemaVersion !== 1 ||
    spec.role !== "fased-installed-state-capsule-spec" ||
    !Array.isArray(spec.entries) ||
    spec.entries.length === 0
  ) {
    fail("spec identity or entries are invalid");
  }
  const rootInfo = await fsp.lstat(sourceRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    fail("source root is unsafe");
  }
  await fsp.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  if ((await fsp.readdir(outputDirectory)).length !== 0) {
    fail("output directory must be empty");
  }

  const entries = [];
  for (const requested of spec.entries) {
    exactKeys(requested, ["path", "owner"], "spec entry");
    const { file, info } = await safeSourceFile(sourceRoot, requested.path);
    const expectedUid = requested.owner === "root" ? 0 : spec.ownership.operatorUid;
    const expectedGid = requested.owner === "root" ? 0 : spec.ownership.operatorGid;
    if (
      !["root", "operator"].includes(requested.owner) ||
      info.uid !== expectedUid ||
      info.gid !== expectedGid ||
      (info.mode & 0o022) !== 0
    ) {
      fail(`source ownership or mode is unsafe: ${requested.path}`);
    }
    entries.push({
      path: requested.path,
      type: "file",
      mode: info.mode & 0o777,
      owner: requested.owner,
      sha256: await digestFile(file),
    });
  }

  const archivePath = path.join(outputDirectory, spec.archiveName);
  await tar.c(
    {
      cwd: sourceRoot,
      file: archivePath,
      gzip: true,
      portable: true,
      noPax: true,
      mtime: new Date(0),
    },
    entries.map((entry) => entry.path),
  );
  const archiveInfo = await fsp.lstat(archivePath);
  const descriptor = parseInstalledStateCapsule({
    schemaVersion: 1,
    role: "fased-sanitized-predecessor-capsule",
    profile: spec.profile,
    compatibilityGroupId: spec.compatibilityGroupId,
    release: spec.release,
    releaseIndex: spec.releaseIndex,
    topology: spec.topology,
    ownership: spec.ownership,
    pointers: spec.pointers,
    expectedReceiptDigest: spec.expectedReceiptDigest,
    archive: {
      name: spec.archiveName,
      size: archiveInfo.size,
      sha256: await digestFile(archivePath),
    },
    sanitization: spec.sanitization,
    services: spec.services,
    entries,
  });
  const descriptorPath = path.join(outputDirectory, "fased-predecessor-capsule.json");
  await fsp.writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return { descriptor, descriptorPath, archivePath };
}

function argumentsFrom(args) {
  const [command, ...rest] = args;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith("--") || rest[index + 1] === undefined) {
      fail("arguments must be --name value pairs");
    }
    options[rest[index].slice(2)] = rest[index + 1];
  }
  return { command, options };
}

async function main() {
  const { command, options } = argumentsFrom(process.argv.slice(2));
  if (command === "verify") {
    const capsule = parseInstalledStateCapsule(
      JSON.parse(await fsp.readFile(options.descriptor, "utf8")),
    );
    process.stdout.write(
      `${JSON.stringify({ ok: true, profile: capsule.profile, version: capsule.release.version })}\n`,
    );
    return;
  }
  if (command === "build") {
    const result = await buildInstalledStateCapsule({
      spec: JSON.parse(await fsp.readFile(options.spec, "utf8")),
      sourceRoot: options.source,
      outputDirectory: options.output,
    });
    process.stdout.write(
      `${JSON.stringify({ ok: true, descriptor: result.descriptorPath, archive: result.archivePath })}\n`,
    );
    return;
  }
  fail("usage: verify --descriptor FILE | build --spec FILE --source DIR --output DIR");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
