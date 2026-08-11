#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as tar from "tar";
import { parsePredecessorCapsule } from "./predecessor-capsule.mjs";

function fail(message) {
  throw new Error(`predecessor capsule restore: ${message}`);
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function requireAuthorizationMarker(file) {
  const info = await fsp.lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== 0 ||
    info.nlink !== 1 ||
    (info.mode & 0o777) !== 0o600
  ) {
    fail("fixture authorization marker is unsafe");
  }
  if ((await fsp.readFile(file, "utf8")) !== "fased-predecessor-capsule-fixture-v1\n") {
    fail("fixture authorization marker is invalid");
  }
}

export async function inspectCapsuleArchive(archive, descriptor) {
  const data = new Map();
  const pending = [];
  await Promise.resolve(
    tar.t({
      file: archive,
      strict: true,
      onentry(entry) {
        const name = entry.path.replace(/^\.\//u, "").replace(/\/$/u, "");
        if (!["Directory", "File", "SymbolicLink"].includes(entry.type)) {
          pending.push(Promise.reject(new Error(`unsupported archive entry type: ${name}`)));
          entry.resume();
          return;
        }
        const promise = new Promise((resolve, reject) => {
          const chunks = [];
          entry.on("data", (chunk) => chunks.push(chunk));
          entry.once("error", reject);
          entry.once("end", () => {
            if (data.has(name)) {
              return reject(new Error(`duplicate archive entry: ${name}`));
            }
            data.set(name, {
              type:
                entry.type === "SymbolicLink"
                  ? "symlink"
                  : entry.type === "Directory"
                    ? "directory"
                    : "file",
              bytes: Buffer.concat(chunks),
              target: entry.linkpath || null,
            });
            resolve();
          });
        });
        pending.push(promise);
      },
    }),
  );
  await Promise.all(pending);
  if (data.size !== descriptor.entries.length) {
    fail("archive inventory differs from descriptor");
  }
  for (const entry of descriptor.entries) {
    const archived = data.get(entry.path);
    if (!archived || archived.type !== entry.type) {
      fail(`archive entry is missing: ${entry.path}`);
    }
    if (entry.type === "symlink") {
      if (archived.target !== entry.target) {
        fail(`archive symlink target mismatch: ${entry.path}`);
      }
      continue;
    }
    if (entry.type === "directory") {
      continue;
    }
    const digest = `sha256:${createHash("sha256").update(archived.bytes).digest("hex")}`;
    if (digest !== entry.sha256) {
      fail(`archive entry digest mismatch: ${entry.path}`);
    }
  }
  return data;
}

async function ensureSafeParent(root, relative) {
  const segments = path.posix.dirname(relative).split("/").filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const info = await fsp.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        fail(`destination ancestry is unsafe: ${relative}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await fsp.mkdir(current, { mode: 0o755 });
    }
  }
}

export async function restorePredecessorCapsule({
  descriptorPath,
  archivePath,
  root,
  authorizationMarker,
  operatorUid,
  operatorGid,
  expectedProfile,
}) {
  if (process.getuid?.() !== 0 || path.resolve(root) !== "/") {
    fail("restore is restricted to a root-authorized disposable fixture");
  }
  await requireAuthorizationMarker(authorizationMarker);
  if (
    !Number.isSafeInteger(operatorUid) ||
    operatorUid <= 0 ||
    !Number.isSafeInteger(operatorGid) ||
    operatorGid <= 0
  ) {
    fail("operator identity is invalid");
  }
  const descriptor = parsePredecessorCapsule(
    JSON.parse(await fsp.readFile(descriptorPath, "utf8")),
    { profile: expectedProfile },
  );
  if (
    operatorUid !== descriptor.ownership.operatorUid ||
    operatorGid !== descriptor.ownership.operatorGid
  ) {
    fail("operator identity differs from the attested capsule");
  }
  const archiveInfo = await fsp.lstat(archivePath);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.nlink !== 1) {
    fail("archive is unsafe");
  }
  if (
    archiveInfo.size !== descriptor.archive.size ||
    (await sha256(archivePath)) !== descriptor.archive.sha256
  ) {
    fail("archive identity differs from descriptor");
  }
  const data = await inspectCapsuleArchive(archivePath, descriptor);
  for (const entry of descriptor.entries) {
    await ensureSafeParent(root, entry.path);
    const destination = path.join(root, entry.path);
    if (entry.type === "directory") {
      await fsp.mkdir(destination, { mode: entry.mode });
      await fsp.chmod(destination, entry.mode);
      await fsp.chown(
        destination,
        entry.owner === "root" ? 0 : operatorUid,
        entry.owner === "root" ? 0 : operatorGid,
      );
      continue;
    }
    if (entry.type === "symlink") {
      await fsp.symlink(entry.target, destination);
      await fsp.lchown(
        destination,
        entry.owner === "root" ? 0 : operatorUid,
        entry.owner === "root" ? 0 : operatorGid,
      );
      continue;
    }
    const handle = await fsp.open(
      destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      entry.mode,
    );
    try {
      await handle.writeFile(data.get(entry.path).bytes);
      await handle.chmod(entry.mode);
      await handle.chown(
        entry.owner === "root" ? 0 : operatorUid,
        entry.owner === "root" ? 0 : operatorGid,
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  return descriptor;
}

function argumentsFrom(argv) {
  const [command, ...rest] = argv;
  if (command !== "restore") {
    fail("expected restore command");
  }
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith("--") || rest[index + 1] === undefined) {
      fail("arguments must be --name value pairs");
    }
    values[rest[index].slice(2)] = rest[index + 1];
  }
  return values;
}

async function main() {
  const values = argumentsFrom(process.argv.slice(2));
  const capsule = await restorePredecessorCapsule({
    descriptorPath: values.descriptor,
    archivePath: values.archive,
    root: values.root,
    authorizationMarker: values["authorization-marker"],
    operatorUid: Number.parseInt(values["operator-uid"], 10),
    operatorGid: Number.parseInt(values["operator-gid"], 10),
    expectedProfile: values.profile,
  });
  process.stdout.write(
    `${JSON.stringify({ ok: true, profile: capsule.profile, version: capsule.release.version })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
