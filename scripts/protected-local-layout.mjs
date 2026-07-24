#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const INSTANCE_ID_PATTERN = /^[a-f0-9]{16}$/u;

function fail(message) {
  throw new Error(message);
}

function validateOperatorUid(value) {
  const uid = Number(value);
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    fail("operator UID must be a positive non-root integer");
  }
  return uid;
}

function validateOperatorUser(value) {
  const user = String(value ?? "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,30}$/u.test(user) || user === "root") {
    fail("operator user is invalid");
  }
  return user;
}

function validateProfile(value) {
  const profile = String(value ?? "default").trim();
  let containsControl = false;
  for (let index = 0; index < profile.length; index += 1) {
    const codeUnit = profile.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      containsControl = true;
      break;
    }
  }
  if (!profile || profile.length > 128 || containsControl) {
    fail("profile identity is invalid");
  }
  return profile;
}

function validateStateDir(value) {
  const stateDir = String(value ?? "").trim();
  if (!path.isAbsolute(stateDir) || path.resolve(stateDir) !== stateDir) {
    fail("Local state directory must be absolute and clean");
  }
  const info = fs.lstatSync(stateDir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail("Local state directory must be a non-symlink directory");
  }
  return stateDir;
}

function assertSecureRegistryParent(registryPath, expectedOwnerUid) {
  const parent = path.dirname(registryPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(parent);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== expectedOwnerUid ||
    (info.mode & 0o077) !== 0
  ) {
    fail("protected Local registry directory must be owner-only and non-symlink");
  }
  return parent;
}

function validateRegistry(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !Array.isArray(value.instances)
  ) {
    fail("protected Local instance registry has an unsupported schema");
  }
  const keys = new Set();
  const ids = new Set();
  for (const entry of value.instances) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !INSTANCE_ID_PATTERN.test(String(entry.instanceId ?? "")) ||
      !Number.isSafeInteger(entry.operatorUid) ||
      entry.operatorUid <= 0 ||
      typeof entry.operatorUser !== "string" ||
      typeof entry.profile !== "string" ||
      typeof entry.stateDir !== "string" ||
      typeof entry.createdAt !== "string"
    ) {
      fail("protected Local instance registry contains an invalid entry");
    }
    const key = `${entry.operatorUid}\u0000${entry.profile}\u0000${entry.stateDir}`;
    if (keys.has(key) || ids.has(entry.instanceId)) {
      fail("protected Local instance registry contains a duplicate identity");
    }
    keys.add(key);
    ids.add(entry.instanceId);
  }
  return value;
}

function readRegistry(registryPath, expectedOwnerUid) {
  if (!fs.existsSync(registryPath)) {
    return { schemaVersion: SCHEMA_VERSION, instances: [] };
  }
  const info = fs.lstatSync(registryPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== expectedOwnerUid ||
    info.nlink !== 1 ||
    (info.mode & 0o177) !== 0
  ) {
    fail("protected Local instance registry must be owner-only, single-link, and non-symlink");
  }
  const raw = fs.readFileSync(registryPath, "utf8");
  if (!raw.trim() || Buffer.byteLength(raw) > 1024 * 1024) {
    fail("protected Local instance registry is empty or too large");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("protected Local instance registry is not valid JSON");
  }
  return validateRegistry(parsed);
}

function writeRegistry(registryPath, registry, expectedOwnerUid) {
  const parent = assertSecureRegistryParent(registryPath, expectedOwnerUid);
  const temporaryPath = path.join(
    parent,
    `.instances-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  const payload = `${JSON.stringify(registry, null, 2)}\n`;
  const fd = fs.openSync(
    temporaryPath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const info = fs.lstatSync(temporaryPath);
  if (info.uid !== expectedOwnerUid || info.nlink !== 1 || (info.mode & 0o177) !== 0) {
    fs.rmSync(temporaryPath, { force: true });
    fail("protected Local registry transaction could not be secured");
  }
  fs.renameSync(temporaryPath, registryPath);
  const parentFd = fs.openSync(parent, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(parentFd);
  } finally {
    fs.closeSync(parentFd);
  }
}

export function buildProtectedLocalLayout(instanceId, roots = {}) {
  if (!INSTANCE_ID_PATTERN.test(String(instanceId ?? ""))) {
    fail("protected Local instance ID is invalid");
  }
  const runtimeRoot = roots.runtimeRoot ?? "/run/fased-local";
  const stateRoot = roots.stateRoot ?? "/var/lib/fased-local";
  const installRoot = roots.installRoot ?? "/opt/fased/local";
  const instanceRuntime = path.join(runtimeRoot, instanceId);
  const instanceState = path.join(stateRoot, instanceId);
  const instanceInstall = path.join(installRoot, instanceId);
  return {
    instanceId,
    gatewayUser: `fsgw-${instanceId}`,
    signerUser: `fssg-${instanceId}`,
    gatewayGroup: `fsgw-${instanceId}`,
    signerGroup: `fssg-${instanceId}`,
    operatorGroup: `fsop-${instanceId}`,
    configGroup: `fscf-${instanceId}`,
    gatewayUnit: `fased-gateway-${instanceId}.service`,
    signerUnit: `fased-signerd-${instanceId}.service`,
    controllerUnit: `fased-local-controller-${instanceId}.service`,
    runtimeDir: instanceRuntime,
    applicationSocket: path.join(instanceRuntime, "application", "app.sock"),
    operatorSocket: path.join(instanceRuntime, "operator", "operator.sock"),
    controlSocket: path.join(instanceRuntime, "control", "control.sock"),
    stateDir: instanceState,
    signerStateDir: path.join(instanceState, "signer"),
    controllerStateDir: path.join(instanceState, "controller"),
    installDir: instanceInstall,
    signerBinary: path.join(instanceInstall, "signer", "fased-signerd"),
    auditLog: path.join(instanceState, "signer", "audit.jsonl"),
    controllerTransaction: path.join(instanceState, "controller", "transaction.json"),
  };
}

export function loadOrAllocateProtectedLocalInstance(params) {
  const expectedOwnerUid = params.expectedOwnerUid ?? 0;
  const registryPath = String(params.registryPath ?? "").trim();
  if (!path.isAbsolute(registryPath) || path.resolve(registryPath) !== registryPath) {
    fail("protected Local registry path must be absolute and clean");
  }
  assertSecureRegistryParent(registryPath, expectedOwnerUid);
  const operatorUid = validateOperatorUid(params.operatorUid);
  const operatorUser = validateOperatorUser(params.operatorUser);
  const profile = validateProfile(params.profile);
  const stateDir = validateStateDir(params.stateDir);
  const registry = readRegistry(registryPath, expectedOwnerUid);
  const existing = registry.instances.find(
    (entry) =>
      entry.operatorUid === operatorUid && entry.profile === profile && entry.stateDir === stateDir,
  );
  if (existing) {
    if (existing.operatorUser !== operatorUser) {
      fail("protected Local operator identity changed for the registered UID");
    }
    return {
      entry: existing,
      layout: buildProtectedLocalLayout(existing.instanceId),
      created: false,
    };
  }
  let instanceId;
  do {
    instanceId = crypto.randomBytes(8).toString("hex");
  } while (registry.instances.some((entry) => entry.instanceId === instanceId));
  const entry = {
    instanceId,
    operatorUid,
    operatorUser,
    profile,
    stateDir,
    createdAt: new Date().toISOString(),
  };
  registry.instances.push(entry);
  registry.instances.sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  writeRegistry(registryPath, registry, expectedOwnerUid);
  return { entry, layout: buildProtectedLocalLayout(instanceId), created: true };
}

export function removeProtectedLocalInstance(params) {
  const expectedOwnerUid = params.expectedOwnerUid ?? 0;
  const registryPath = String(params.registryPath ?? "").trim();
  if (!path.isAbsolute(registryPath) || path.resolve(registryPath) !== registryPath) {
    fail("protected Local registry path must be absolute and clean");
  }
  const instanceId = String(params.instanceId ?? "").trim();
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    fail("protected Local instance ID is invalid");
  }
  const registry = readRegistry(registryPath, expectedOwnerUid);
  const next = {
    ...registry,
    instances: registry.instances.filter((entry) => entry.instanceId !== instanceId),
  };
  if (next.instances.length === registry.instances.length) {
    return false;
  }
  writeRegistry(registryPath, next, expectedOwnerUid);
  return true;
}

function parseCLI(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      fail("protected Local layout arguments must be --name value pairs");
    }
    values[name.slice(2)] = value;
  }
  return values;
}

async function main() {
  if (process.argv[2] === "--self-check") {
    process.stdout.write('{"schemaVersion":1,"role":"protected-local-layout"}\n');
    return;
  }
  if (process.argv[2] !== "allocate") {
    fail(
      "usage: protected-local-layout.mjs allocate --registry PATH --operator-uid UID --operator-user USER --state-dir PATH --profile NAME",
    );
  }
  const values = parseCLI(process.argv.slice(3));
  const result = loadOrAllocateProtectedLocalInstance({
    registryPath: values.registry,
    operatorUid: Number(values["operator-uid"]),
    operatorUser: values["operator-user"],
    stateDir: values["state-dir"],
    profile: values.profile ?? "default",
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `protected-local-layout: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
