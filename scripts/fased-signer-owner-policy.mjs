#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";

const MAX_POLICY_BYTES = 64 * 1024;
const MAX_ADMIN_OUTPUT_BYTES = 128 * 1024;
const ADMIN_TIMEOUT_MS = 20_000;
const FEDERATION_POLICY_DOMAIN = "domain:fased:federation-bond-challenge-v1";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const UINT64_MAX = 18_446_744_073_709_551_615n;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map(
  Array.from(BASE58_ALPHABET).map((character, index) => [character, index]),
);

const POLICY_KEYS = ["walletId", "role", "operations", "programs", "assets"];
const ASSET_KEYS = ["asset", "destinations", "maxPerTx", "maxDaily"];
const STORED_POLICY_KEYS = [...POLICY_KEYS.slice(0, 2), "version", ...POLICY_KEYS.slice(2), "hash"];
const POLICY_ROLES = new Set(["agent", "mining", "vault"]);
const POLICY_OPERATIONS = new Set([
  "solana.nativeTransfer",
  "solana.splTransferChecked",
  "federation.bondChallenge",
  "solana.jupiter.swap",
  "solana.jupiter.trigger.auth",
  "solana.jupiter.trigger.create",
  "solana.jupiter.trigger.deposit",
  "solana.jupiter.trigger.cancel",
  "solana.jupiter.trigger.withdraw",
]);
const SAT_MINING_ACTIONS = new Set([
  "abortEmptyCycle",
  "claimCycleRewards",
  "claimCycleRewardsBatch",
  "claimProtocolDistributorSat",
  "claimProtocolTreasury",
  "cleanupBatch",
  "closeCommitPhase",
  "closeResolvedCycleArtifacts",
  "closeResolvedCycleRegistryPage",
  "closeResolvedMinerCycleState",
  "commitCycle",
  "compactPendingCycleRange",
  "depositMinerCapital",
  "distributeCyclePage",
  "finalizeCycleSettlement",
  "initMinerCapital",
  "initializeCycle",
  "openCycle",
  "openDispute",
  "refillRegistryReserveFromTreasury",
  "releaseUnrevealedCommit",
  "republishEpochRoots",
  "resolveDispute",
  "retargetUnlock",
  "revealCycle",
  "scoreCyclePage",
  "sealCycleEntropy",
  "setActiveCommit",
  "settleCyclePage",
  "topUpRegistryReserve",
  "validatorAttestation",
  "withdrawMinerCapital",
]);
const VAULT_BOND_ACTIONS = new Set([
  "cancelBondUnlock",
  "claimBondStakingRewards",
  "claimUnallocatedStakingRewards",
  "finalizeBondUnlock",
  "increaseBondPosition",
  "openBondPosition",
  "requestBondUnlock",
  "syncBondStakingPosition",
  "syncBondStakingRewards",
  "updateBondTierPolicy",
]);

function compareCanonicalString(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const HOSTING_PATHS = Object.freeze({
  binaryPath: "/opt/fased/signer/fased-signerd",
  controlSocketPath: "/run/fased-signerd/control.sock",
  runuserPath: "/usr/sbin/runuser",
  signerUser: "fased-signer",
  signerHome: "/var/lib/fased-signerd",
  passwdPath: "/etc/passwd",
  updateGateDirectory: "/var/lib/fased-signer-update-gate",
  updateGatePath: "/var/lib/fased-signer-update-gate/active",
});

class StrictJsonParser {
  constructor(text) {
    this.text = text;
    this.offset = 0;
  }

  parse() {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.offset !== this.text.length) {
      throw new Error("policy file must contain exactly one JSON value");
    }
    return value;
  }

  skipWhitespace() {
    while (
      this.offset < this.text.length &&
      (this.text[this.offset] === " " ||
        this.text[this.offset] === "\t" ||
        this.text[this.offset] === "\n" ||
        this.text[this.offset] === "\r")
    ) {
      this.offset += 1;
    }
  }

  parseValue() {
    this.skipWhitespace();
    const character = this.text[this.offset];
    if (character === "{") {
      return this.parseObject();
    }
    if (character === "[") {
      return this.parseArray();
    }
    if (character === '"') {
      return this.parseString();
    }
    if (character === "t") {
      return this.parseLiteral("true", true);
    }
    if (character === "f") {
      return this.parseLiteral("false", false);
    }
    if (character === "n") {
      return this.parseLiteral("null", null);
    }
    if (character === "-" || (character >= "0" && character <= "9")) {
      return this.parseNumber();
    }
    throw new Error(`invalid JSON value at byte ${this.offset}`);
  }

  parseObject() {
    this.offset += 1;
    const value = Object.create(null);
    const keys = new Set();
    this.skipWhitespace();
    if (this.text[this.offset] === "}") {
      this.offset += 1;
      return value;
    }
    while (true) {
      this.skipWhitespace();
      if (this.text[this.offset] !== '"') {
        throw new Error("JSON object keys must be strings");
      }
      const key = this.parseString();
      if (keys.has(key)) {
        throw new Error(`duplicate JSON field ${JSON.stringify(key)}`);
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.offset] !== ":") {
        throw new Error("JSON object field is missing ':'");
      }
      this.offset += 1;
      value[key] = this.parseValue();
      this.skipWhitespace();
      const delimiter = this.text[this.offset];
      if (delimiter === "}") {
        this.offset += 1;
        return value;
      }
      if (delimiter !== ",") {
        throw new Error("JSON object fields must be comma separated");
      }
      this.offset += 1;
    }
  }

  parseArray() {
    this.offset += 1;
    const value = [];
    this.skipWhitespace();
    if (this.text[this.offset] === "]") {
      this.offset += 1;
      return value;
    }
    while (true) {
      value.push(this.parseValue());
      this.skipWhitespace();
      const delimiter = this.text[this.offset];
      if (delimiter === "]") {
        this.offset += 1;
        return value;
      }
      if (delimiter !== ",") {
        throw new Error("JSON array values must be comma separated");
      }
      this.offset += 1;
    }
  }

  parseString() {
    const start = this.offset;
    this.offset += 1;
    let escaped = false;
    while (this.offset < this.text.length) {
      const character = this.text[this.offset];
      this.offset += 1;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        const token = this.text.slice(start, this.offset);
        try {
          return JSON.parse(token);
        } catch {
          throw new Error("invalid JSON string");
        }
      }
    }
    throw new Error("unterminated JSON string");
  }

  parseLiteral(token, value) {
    if (this.text.slice(this.offset, this.offset + token.length) !== token) {
      throw new Error(`invalid JSON literal at byte ${this.offset}`);
    }
    this.offset += token.length;
    return value;
  }

  parseNumber() {
    const match = this.text
      .slice(this.offset)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (!match) {
      throw new Error(`invalid JSON number at byte ${this.offset}`);
    }
    this.offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      throw new Error("JSON number is outside the supported range");
    }
    return value;
  }
}

function parseStrictJson(raw, description = "JSON") {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new Error(`${description} must be valid UTF-8`);
  }
  if (text.startsWith("\uFEFF")) {
    throw new Error(`${description} must not contain a byte-order mark`);
  }
  try {
    return new StrictJsonParser(text).parse();
  } catch (error) {
    throw new Error(`${description} is not strict JSON: ${error.message}`, { cause: error });
  }
}

function requirePlainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return value;
}

function requireExactKeys(value, keys, field) {
  const actual = Object.keys(value).toSorted(compareCanonicalString);
  const expected = [...keys].toSorted(compareCanonicalString);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    const unknown = actual.filter((key) => !expected.includes(key));
    const missing = expected.filter((key) => !actual.includes(key));
    const details = [
      unknown.length ? `unknown: ${unknown.join(", ")}` : "",
      missing.length ? `missing: ${missing.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    throw new Error(`${field} must contain exactly ${keys.join(", ")} (${details})`);
  }
}

function requireCanonicalWalletID(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    throw new Error("walletId must contain 1 to 64 characters");
  }
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/u.test(value)) {
    throw new Error(
      "walletId must use normalized lowercase letters, numbers, and single underscores",
    );
  }
  return value;
}

function decodeBase58(value) {
  let number = 0n;
  for (const character of value) {
    const digit = BASE58_INDEX.get(character);
    if (digit === undefined) {
      return null;
    }
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number > 0n) {
    bytes.push(Number(number & 0xffn));
    number >>= 8n;
  }
  bytes.reverse();
  let leadingZeros = 0;
  while (value[leadingZeros] === "1") {
    leadingZeros += 1;
  }
  return Buffer.concat([Buffer.alloc(leadingZeros), Buffer.from(bytes)]);
}

function encodeBase58(bytes) {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros += 1;
  }
  let number = 0n;
  for (const byte of bytes) {
    number = (number << 8n) | BigInt(byte);
  }
  let suffix = "";
  while (number > 0n) {
    suffix = BASE58_ALPHABET[Number(number % 58n)] + suffix;
    number /= 58n;
  }
  return "1".repeat(leadingZeros) + suffix;
}

function requireSolanaPublicKey(value, field) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 32 ||
    value.length > 44
  ) {
    throw new Error(`${field} must be a canonical Solana public key`);
  }
  const decoded = decodeBase58(value);
  if (!decoded || decoded.length !== 32 || encodeBase58(decoded) !== value) {
    throw new Error(`${field} must be a canonical Solana public key`);
  }
  return value;
}

function requireUniqueStrings(values, field, normalize, { allowEmpty = false, max = 128 } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0) || values.length > max) {
    throw new Error(
      `${field} must be ${allowEmpty ? "an" : "a non-empty"} array of at most ${max} values`,
    );
  }
  const seen = new Set();
  const normalized = values.map((value, index) => {
    const result = normalize(value, `${field}[${index}]`);
    if (seen.has(result)) {
      throw new Error(`${field} contains duplicate value ${result}`);
    }
    seen.add(result);
    return result;
  });
  return normalized.toSorted(compareCanonicalString);
}

function requireCanonicalPositiveCap(value, field) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${field} must be a canonical positive raw-unit integer string`);
  }
  const amount = BigInt(value);
  if (amount > UINT64_MAX) {
    throw new Error(`${field} exceeds uint64`);
  }
  return value;
}

function normalizeAssetName(value, field) {
  if (typeof value !== "string" || value.trim() !== value) {
    throw new Error(`${field} must be a canonical policy asset`);
  }
  if (
    value === "solana:native" ||
    value === "sat:action" ||
    value === "sat:capital:lamports" ||
    value === "federation:bond-challenge"
  ) {
    return value;
  }
  for (const prefix of ["solana:spl:", "sat:mint:"]) {
    if (value.startsWith(prefix)) {
      return `${prefix}${requireSolanaPublicKey(value.slice(prefix.length), `${field} mint`)}`;
    }
  }
  throw new Error(`${field} is not a supported policy asset`);
}

function normalizePolicyOperation(value, role, field) {
  if (typeof value !== "string" || value.trim() !== value) {
    throw new Error(`${field} is not a supported typed signer operation`);
  }
  if (POLICY_OPERATIONS.has(value)) {
    return value;
  }
  const match = /^(sat|vaultBond)\.([A-Za-z][A-Za-z0-9]*)@(.+)$/u.exec(value);
  if (!match) {
    if (value === "solana.satAction" || value === "solana.vaultBondAction") {
      throw new Error(`${field} must name an exact action bound to its SAT program`);
    }
    throw new Error(`${field} is not a supported typed signer operation`);
  }
  const [, family, action, rawProgram] = match;
  const program = requireSolanaPublicKey(rawProgram, `${field} program`);
  if (family === "sat") {
    if (role !== "mining" || !SAT_MINING_ACTIONS.has(action)) {
      throw new Error(`${field} is not an allowed program-bound Mining action`);
    }
  } else if (role !== "vault" || !VAULT_BOND_ACTIONS.has(action)) {
    throw new Error(`${field} is not an allowed program-bound Vault bond action`);
  }
  return `${family}.${action}@${program}`;
}

function validatePolicyRelationships(policy) {
  const operations = new Set(policy.operations);
  const programs = new Set(policy.programs);
  const assets = new Set(policy.assets.map((asset) => asset.asset));
  const hasFederation = operations.has("federation.bondChallenge");

  if (operations.has("federation.bondChallenge") && policy.role !== "vault") {
    throw new Error("federation operations require the immutable vault role");
  }
  for (const operation of policy.operations) {
    const separator = operation.lastIndexOf("@");
    if (separator >= 0 && !programs.has(operation.slice(separator + 1))) {
      throw new Error(`program-bound operation ${operation} requires the same program in programs`);
    }
  }
  if (operations.has("solana.nativeTransfer")) {
    if (!programs.has(SYSTEM_PROGRAM) || !assets.has("solana:native")) {
      throw new Error("solana.nativeTransfer requires the System program and solana:native asset");
    }
  }
  if (operations.has("solana.splTransferChecked")) {
    const hasTokenProgram = programs.has(TOKEN_PROGRAM) || programs.has(TOKEN_2022_PROGRAM);
    const hasSPLAsset = [...assets].some((asset) => asset.startsWith("solana:spl:"));
    if (
      !hasTokenProgram ||
      !programs.has(SYSTEM_PROGRAM) ||
      !programs.has(ASSOCIATED_TOKEN_PROGRAM) ||
      !hasSPLAsset
    ) {
      throw new Error(
        "solana.splTransferChecked requires a token program, System program, Associated Token program, and explicit SPL asset",
      );
    }
  }
  if (hasFederation) {
    if (!programs.has(FEDERATION_POLICY_DOMAIN) || !assets.has("federation:bond-challenge")) {
      throw new Error(
        `federation.bondChallenge requires ${FEDERATION_POLICY_DOMAIN} and federation:bond-challenge`,
      );
    }
  } else if (programs.has(FEDERATION_POLICY_DOMAIN) || assets.has("federation:bond-challenge")) {
    throw new Error("the federation policy domain and asset require federation.bondChallenge");
  }
}

export function normalizeOwnerPolicy(value) {
  const object = requirePlainObject(value, "policy");
  requireExactKeys(object, POLICY_KEYS, "policy");
  const walletId = requireCanonicalWalletID(object.walletId);
  if (typeof object.role !== "string" || !POLICY_ROLES.has(object.role)) {
    throw new Error("policy role must be agent, mining, or vault");
  }
  const operations = requireUniqueStrings(
    object.operations,
    "operations",
    (operation, field) => normalizePolicyOperation(operation, object.role, field),
    { max: 128 },
  );
  const programs = requireUniqueStrings(
    object.programs,
    "programs",
    (program, field) =>
      program === FEDERATION_POLICY_DOMAIN ? program : requireSolanaPublicKey(program, field),
    { max: 64 },
  );
  if (!Array.isArray(object.assets) || object.assets.length < 1 || object.assets.length > 64) {
    throw new Error("assets must be a non-empty array of at most 64 entries");
  }
  const seenAssets = new Set();
  const assets = object.assets.map((entry, index) => {
    const assetObject = requirePlainObject(entry, `assets[${index}]`);
    requireExactKeys(assetObject, ASSET_KEYS, `assets[${index}]`);
    const asset = normalizeAssetName(assetObject.asset, `assets[${index}].asset`);
    if (seenAssets.has(asset)) {
      throw new Error(`assets contains duplicate policy asset ${asset}`);
    }
    seenAssets.add(asset);
    const destinations = requireUniqueStrings(
      assetObject.destinations,
      `assets[${index}].destinations`,
      requireSolanaPublicKey,
      { max: 128 },
    );
    const maxPerTx = requireCanonicalPositiveCap(assetObject.maxPerTx, `assets[${index}].maxPerTx`);
    const maxDaily = requireCanonicalPositiveCap(assetObject.maxDaily, `assets[${index}].maxDaily`);
    if (BigInt(maxDaily) < BigInt(maxPerTx)) {
      throw new Error(`assets[${index}].maxDaily must be at least maxPerTx`);
    }
    return { asset, destinations, maxPerTx, maxDaily };
  });
  const sortedAssets = assets.toSorted((left, right) =>
    compareCanonicalString(left.asset, right.asset),
  );
  const policy = { walletId, role: object.role, operations, programs, assets: sortedAssets };
  validatePolicyRelationships(policy);
  return policy;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function policyWithVersion(policy, version) {
  const unhashed = {
    walletId: policy.walletId,
    role: policy.role,
    version,
    operations: policy.operations,
    programs: policy.programs,
    assets: policy.assets,
    hash: "",
  };
  return { ...unhashed, hash: sha256(JSON.stringify(unhashed)) };
}

function normalizeStoredPolicy(raw) {
  const object = requirePlainObject(raw, "signer policy response");
  requireExactKeys(object, STORED_POLICY_KEYS, "signer policy response");
  if (!Number.isSafeInteger(object.version) || object.version < 1) {
    throw new Error("signer policy response has an invalid version");
  }
  if (typeof object.hash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(object.hash)) {
    throw new Error("signer policy response has an invalid hash");
  }
  const policy = normalizeOwnerPolicy({
    walletId: object.walletId,
    role: object.role,
    operations: object.operations,
    programs: object.programs,
    assets: object.assets,
  });
  const expected = policyWithVersion(policy, object.version);
  if (expected.hash !== object.hash) {
    throw new Error("signer policy response hash is not canonical");
  }
  return expected;
}

function normalizeLockedStoredPolicy(raw) {
  const object = requirePlainObject(raw, "current signer policy");
  requireExactKeys(object, STORED_POLICY_KEYS, "current signer policy");
  const walletId = requireCanonicalWalletID(object.walletId);
  if (typeof object.role !== "string" || !POLICY_ROLES.has(object.role)) {
    throw new Error("current signer policy has an invalid role");
  }
  if (object.version !== 1) {
    throw new Error("initial policy setup requires current policy version 1");
  }
  for (const field of ["operations", "programs", "assets"]) {
    if (!Array.isArray(object[field]) || object[field].length !== 0) {
      throw new Error("initial policy setup requires a genuinely deny-all current policy");
    }
  }
  const policy = { walletId, role: object.role, operations: [], programs: [], assets: [] };
  const expected = policyWithVersion(policy, 1);
  if (object.hash !== expected.hash) {
    throw new Error("current deny-all policy hash is not canonical");
  }
  return expected;
}

function samePolicy(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function statsIdentity(stats) {
  return [
    stats.dev,
    stats.ino,
    stats.size,
    stats.mode,
    stats.uid,
    stats.gid,
    stats.nlink,
    stats.mtimeNs,
    stats.ctimeNs,
  ]
    .map(String)
    .join(":");
}

async function assertSecureAncestors(
  targetPath,
  allowedUIDs,
  boundary = path.parse(targetPath).root,
) {
  let current = path.dirname(targetPath);
  const stop = path.resolve(boundary);
  while (true) {
    const stats = await fsp.lstat(current, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`unsafe path parent: ${current} must be a non-symlink directory`);
    }
    const permissions = Number(stats.mode & 0o777n);
    if ((permissions & 0o022) !== 0) {
      throw new Error(`unsafe path parent: ${current} is group/world writable`);
    }
    if (!allowedUIDs.has(Number(stats.uid))) {
      throw new Error(`unsafe path parent: ${current} has unexpected ownership`);
    }
    if (path.resolve(current) === stop) {
      break;
    }
    const next = path.dirname(current);
    if (next === current || !path.resolve(current).startsWith(`${stop}${path.sep}`)) {
      throw new Error("secure path boundary was not reached");
    }
    current = next;
  }
}

async function readBoundedFile(handle, maxBytes) {
  const storage = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < storage.length) {
    const { bytesRead } = await handle.read(storage, offset, storage.length - offset, null);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  if (offset > maxBytes) {
    storage.fill(0);
    throw new Error(`policy file exceeds ${maxBytes} bytes`);
  }
  const result = Buffer.from(storage.subarray(0, offset));
  storage.fill(0);
  return result;
}

export async function readOwnerPolicyFile(
  policyPath,
  expectedUID,
  boundary,
  allowedAncestorUIDs = new Set([0, expectedUID]),
) {
  if (
    typeof policyPath !== "string" ||
    !path.isAbsolute(policyPath) ||
    path.normalize(policyPath) !== policyPath
  ) {
    throw new Error("--policy-file must be an absolute clean path");
  }
  await assertSecureAncestors(policyPath, allowedAncestorUIDs, boundary);
  const before = await fsp.lstat(policyPath, { bigint: true });
  const permissions = Number(before.mode & 0o777n);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error("policy file must be a single-link regular non-symlink file");
  }
  if (Number(before.uid) !== expectedUID) {
    throw new Error("policy file has the wrong owner");
  }
  if (
    (permissions & 0o077) !== 0 ||
    (permissions & 0o400) === 0 ||
    (Number(before.mode) & 0o7000) !== 0
  ) {
    throw new Error("policy file must be owner-readable and inaccessible to group/others");
  }
  if (before.size < 1n || before.size > BigInt(MAX_POLICY_BYTES)) {
    throw new Error(`policy file must contain 1 to ${MAX_POLICY_BYTES} bytes`);
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const handle = await fsp.open(policyPath, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (statsIdentity(opened) !== statsIdentity(before) || !opened.isFile()) {
      throw new Error("policy file changed while it was opened");
    }
    const raw = await readBoundedFile(handle, MAX_POLICY_BYTES);
    const after = await handle.stat({ bigint: true });
    if (statsIdentity(after) !== statsIdentity(opened)) {
      raw.fill(0);
      throw new Error("policy file changed while it was read");
    }
    const policy = normalizeOwnerPolicy(parseStrictJson(raw, "policy file"));
    return { raw, policy, digest: sha256(raw) };
  } finally {
    await handle.close();
  }
}

async function readPasswdSignerUID(passwdPath = HOSTING_PATHS.passwdPath) {
  const stats = await fsp.lstat(passwdPath, { bigint: true });
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.uid !== 0n ||
    (Number(stats.mode) & 0o022) !== 0
  ) {
    throw new Error("/etc/passwd is not a trusted root-owned file");
  }
  if (stats.size < 1n || stats.size > 1024n * 1024n) {
    throw new Error("/etc/passwd has an invalid size");
  }
  const text = await fsp.readFile(passwdPath, "utf8");
  const matches = text
    .split("\n")
    .map((line) => line.split(":"))
    .filter((fields) => fields[0] === HOSTING_PATHS.signerUser);
  if (matches.length !== 1) {
    throw new Error("the fixed fased-signer account is missing or duplicated");
  }
  const uid = Number(matches[0][2]);
  if (!Number.isSafeInteger(uid) || uid <= 0 || matches[0][5] !== HOSTING_PATHS.signerHome) {
    throw new Error("the fixed fased-signer account has an unsafe identity");
  }
  return uid;
}

async function assertSafeExecutable(filePath, expectedUID, allowedParentUIDs) {
  await assertSecureAncestors(filePath, allowedParentUIDs);
  const stats = await fsp.lstat(filePath, { bigint: true });
  const permissions = Number(stats.mode & 0o777n);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1n ||
    Number(stats.uid) !== expectedUID
  ) {
    throw new Error(
      `${filePath} must be a single-link executable owned by the trusted installer identity`,
    );
  }
  if (
    (permissions & 0o022) !== 0 ||
    (permissions & 0o100) === 0 ||
    (Number(stats.mode) & 0o6000) !== 0
  ) {
    throw new Error(`${filePath} has unsafe executable permissions`);
  }
}

async function assertControlSocket(socketPath, ownerUID, allowedParentUIDs) {
  await assertSecureAncestors(socketPath, allowedParentUIDs);
  const stats = await fsp.lstat(socketPath, { bigint: true });
  if (
    !stats.isSocket() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1n ||
    Number(stats.uid) !== ownerUID
  ) {
    throw new Error(
      "signer control socket must be a single-link Unix socket owned by the signer identity",
    );
  }
  if ((Number(stats.mode) & 0o077) !== 0) {
    throw new Error("signer control socket must not be accessible to group/others");
  }
}

export async function assertHostingUpdateGateInactive(paths = HOSTING_PATHS, trustedRootUID = 0) {
  let directory;
  try {
    directory = await fsp.lstat(paths.updateGateDirectory, { bigint: true });
  } catch (error) {
    throw new Error(
      "root signer update gate directory is missing or unreadable; refusing policy mutation",
      {
        cause: error,
      },
    );
  }
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    Number(directory.uid) !== trustedRootUID ||
    (Number(directory.mode) & 0o022) !== 0
  ) {
    throw new Error("root signer update gate directory is invalid; refusing policy mutation");
  }
  try {
    const gate = await fsp.lstat(paths.updateGatePath, { bigint: true });
    const valid =
      gate.isFile() &&
      !gate.isSymbolicLink() &&
      Number(gate.uid) === trustedRootUID &&
      gate.nlink === 1n &&
      (Number(gate.mode) & 0o022) === 0;
    throw new Error(
      valid
        ? "root signer update gate is active; policy mutation is temporarily disabled"
        : "root signer update gate is present but invalid; refusing policy mutation",
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function localPaths(home) {
  return {
    binaryPath: path.join(home, ".fased", "bin", "fased-signerd"),
    controlSocketPath: path.join(home, ".fased", "wallet", "local-signer-control.sock"),
    signerHome: home,
  };
}

export function createExecutionPlan(profile, identity = {}) {
  const effectiveUID = identity.effectiveUID ?? process.geteuid?.();
  if (!Number.isSafeInteger(effectiveUID) || effectiveUID < 0) {
    throw new Error("could not determine the effective user identity");
  }
  if (profile === "local") {
    if (effectiveUID === 0) {
      throw new Error("Local signer policy setup must not run as root or through sudo");
    }
    const home = path.resolve(identity.home ?? os.homedir());
    if (!path.isAbsolute(home)) {
      throw new Error("Local signer home path is invalid");
    }
    const paths = localPaths(home);
    return {
      profile,
      effectiveUID,
      signerUID: effectiveUID,
      ...paths,
      executablePath: paths.binaryPath,
      executablePrefix: [],
      childEnv: {
        HOME: home,
        LANG: "C",
        LC_ALL: "C",
        NO_COLOR: "1",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
    };
  }
  if (profile !== "hosting") {
    throw new Error("--profile must be local or hosting");
  }
  if ((identity.platform ?? process.platform) !== "linux") {
    throw new Error("Hosting signer policy setup is supported only on Linux");
  }
  if (effectiveUID !== 0) {
    throw new Error("Hosting signer policy setup must run as root");
  }
  const signerUID = identity.signerUID;
  if (!Number.isSafeInteger(signerUID) || signerUID <= 0) {
    throw new Error(
      "Hosting signer policy setup requires the dedicated non-root fased-signer identity",
    );
  }
  return {
    profile,
    effectiveUID,
    signerUID,
    ...HOSTING_PATHS,
    executablePath: HOSTING_PATHS.runuserPath,
    executablePrefix: ["-u", HOSTING_PATHS.signerUser, "--", HOSTING_PATHS.binaryPath],
    childEnv: {
      HOME: HOSTING_PATHS.signerHome,
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    },
  };
}

async function resolveAndValidateExecutionPlan(profile) {
  if (profile !== "local" && profile !== "hosting") {
    throw new Error("--profile must be local or hosting");
  }
  if (profile === "local") {
    const plan = createExecutionPlan(profile);
    await assertSafeExecutable(plan.binaryPath, plan.effectiveUID, new Set([0, plan.effectiveUID]));
    await assertControlSocket(
      plan.controlSocketPath,
      plan.effectiveUID,
      new Set([0, plan.effectiveUID]),
    );
    return plan;
  }
  const signerUID = await readPasswdSignerUID();
  const plan = createExecutionPlan(profile, { signerUID });
  await assertSafeExecutable(plan.binaryPath, 0, new Set([0]));
  await assertSafeExecutable(plan.runuserPath, 0, new Set([0]));
  await assertControlSocket(plan.controlSocketPath, signerUID, new Set([0, signerUID]));
  await assertHostingUpdateGateInactive(plan);
  return plan;
}

export function buildAdminInvocation(plan, operation, walletId, stagedPolicyPath) {
  if (operation !== "get" && operation !== "put") {
    throw new Error("unsupported policy admin operation");
  }
  const args = [
    ...plan.executablePrefix,
    "admin",
    "policy",
    operation,
    "--control-socket",
    plan.controlSocketPath,
    "--wallet-id",
    walletId,
  ];
  if (operation === "put") {
    if (!stagedPolicyPath || !path.isAbsolute(stagedPolicyPath)) {
      throw new Error("an absolute signer-owned staged policy path is required");
    }
    args.push("--expected-version", "1", "--policy-file", stagedPolicyPath);
  }
  return { command: plan.executablePath, args, env: { ...plan.childEnv } };
}

async function runBoundedCommand(invocation) {
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };
    const collect = (target, chunk, kind) => {
      const buffer = Buffer.from(chunk);
      if (kind === "stdout") {
        stdoutBytes += buffer.length;
      } else {
        stderrBytes += buffer.length;
      }
      if (stdoutBytes > MAX_ADMIN_OUTPUT_BYTES || stderrBytes > MAX_ADMIN_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("native signer admin output exceeded the safe bound"));
        return;
      }
      target.push(buffer);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(stderr, chunk, "stderr"));
    child.once("error", () =>
      finish(new Error("could not execute the fixed native signer admin client")),
    );
    child.once("close", (code, signal) => {
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        const reason = signal ? `signal ${signal}` : `exit ${code}`;
        const detail = stderrText ? `: ${stderrText.slice(0, 512)}` : "";
        finish(new Error(`native signer admin command failed (${reason})${detail}`));
        return;
      }
      finish(null, Buffer.concat(stdout));
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        new Error(
          "native signer admin command timed out; query durable policy state before retrying",
        ),
      );
    }, ADMIN_TIMEOUT_MS);
    timer.unref?.();
  });
}

function parseAdminPolicyOutput(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > MAX_ADMIN_OUTPUT_BYTES) {
    throw new Error("native signer admin returned an invalid bounded response");
  }
  return normalizeStoredPolicy(parseStrictJson(raw, "native signer admin response"));
}

async function fsyncDirectory(directory) {
  const handle = await fsp.open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeStagedPolicyFile(parent, directory, stagedPath) {
  await fsp.rm(stagedPath, { force: true });
  await fsyncDirectory(directory);
  await fsp.rmdir(directory);
  await fsyncDirectory(parent);
}

async function stagePolicyFile(plan, raw) {
  const parent = path.dirname(plan.controlSocketPath);
  const directory = await fsp.mkdtemp(path.join(parent, ".owner-policy-"));
  const stagedPath = path.join(directory, "policy.json");
  let created = false;
  try {
    await fsp.chmod(directory, 0o700);
    if (plan.profile === "hosting") {
      await fsp.chown(directory, plan.signerUID, plan.signerUID);
    }
    const flags =
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_WRONLY |
      (fs.constants.O_NOFOLLOW ?? 0);
    const handle = await fsp.open(stagedPath, flags, 0o600);
    created = true;
    try {
      let offset = 0;
      while (offset < raw.length) {
        const { bytesWritten } = await handle.write(raw, offset, raw.length - offset, null);
        if (bytesWritten < 1) {
          throw new Error("short write while staging signer policy");
        }
        offset += bytesWritten;
      }
      await handle.sync();
      if (plan.profile === "hosting") {
        await handle.chown(plan.signerUID, plan.signerUID);
      }
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsyncDirectory(directory);
    await fsyncDirectory(parent);
  } catch (error) {
    try {
      if (!created) {
        await fsyncDirectory(directory);
      }
      await removeStagedPolicyFile(parent, directory, stagedPath);
    } catch (cleanupError) {
      throw new Error(
        `signer policy staging failed (${error.message}) and its private temporary path could not be durably removed`,
        { cause: cleanupError },
      );
    }
    throw error;
  }
  let cleaned = false;
  return {
    path: stagedPath,
    async cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      await removeStagedPolicyFile(parent, directory, stagedPath);
    },
  };
}

function renderPolicySummary(policy, digest) {
  const lines = [
    "INITIAL SIGNER POLICY (one-time deny-all transition)",
    `Input SHA-256: ${digest}`,
    `Wallet: ${policy.walletId}`,
    `Role: ${policy.role}`,
    "Operations:",
    ...policy.operations.map((operation) => `  - ${operation}`),
    "Programs / signer domains:",
    ...policy.programs.map((program) => `  - ${program}`),
    "Assets and raw-unit caps:",
  ];
  for (const asset of policy.assets) {
    lines.push(`  - Asset: ${asset.asset}`);
    lines.push("    Destinations:");
    lines.push(...asset.destinations.map((destination) => `      - ${destination}`));
    lines.push(`    Max per transaction (raw units): ${asset.maxPerTx}`);
    lines.push(`    Max per UTC day (raw units): ${asset.maxDaily}`);
  }
  lines.push("The Gateway cannot repeat, widen, or replace this owner-authorized transition.");
  return `${lines.join("\n")}\n`;
}

async function defaultPromptConfirmation(expected, streams = {}) {
  const input = streams.stdin ?? process.stdin;
  const output = streams.stdout ?? process.stdout;
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      "interactive confirmation requires a terminal; use --non-interactive with --confirm-digest and --initial-install only in an owner-controlled installer",
    );
  }
  const prompt = readline.createInterface({ input, output, terminal: true });
  try {
    return await prompt.question(
      `Type exactly ${JSON.stringify(expected)} to install this initial policy: `,
    );
  } finally {
    prompt.close();
  }
}

async function getCurrentPolicy(plan, walletId, runCommand) {
  const output = await runCommand(buildAdminInvocation(plan, "get", walletId));
  return parseAdminPolicyOutput(output);
}

export async function runInitialSignerPolicySetup(options, dependencies = {}) {
  if (!options?.initialInstall) {
    throw new Error("--initial-install is required for this one-time command");
  }
  const output = dependencies.output ?? process.stdout;
  const resolvePlan = dependencies.resolvePlan ?? resolveAndValidateExecutionPlan;
  const runCommand = dependencies.runCommand ?? runBoundedCommand;
  const stage = dependencies.stagePolicy ?? stagePolicyFile;
  const promptConfirmation = dependencies.promptConfirmation ?? defaultPromptConfirmation;
  const plan = await resolvePlan(options.profile);
  const expectedPolicyOwner = plan.profile === "hosting" ? 0 : plan.effectiveUID;
  const loaded = await readOwnerPolicyFile(
    options.policyFile,
    expectedPolicyOwner,
    dependencies.policyFileBoundary,
  );
  try {
    if (options.nonInteractive) {
      if (!/^sha256:[0-9a-f]{64}$/u.test(options.confirmDigest ?? "")) {
        throw new Error(
          "--non-interactive requires an exact lowercase sha256:<hex> --confirm-digest",
        );
      }
      if (options.confirmDigest !== loaded.digest) {
        throw new Error("owner confirmation digest does not match the exact policy file bytes");
      }
    } else if (options.confirmDigest) {
      throw new Error("--confirm-digest is accepted only with --non-interactive");
    }

    const current = normalizeLockedStoredPolicy(
      parseStrictJson(
        await runCommand(buildAdminInvocation(plan, "get", loaded.policy.walletId)),
        "native signer admin response",
      ),
    );
    if (current.walletId !== loaded.policy.walletId) {
      throw new Error("current signer policy walletId does not match the owner policy file");
    }
    if (current.role !== loaded.policy.role) {
      throw new Error("owner policy role does not match the signer wallet's immutable role");
    }

    output.write(renderPolicySummary(loaded.policy, loaded.digest));
    if (!options.nonInteractive) {
      const expectedConfirmation = `${loaded.policy.walletId} ${loaded.digest}`;
      const confirmed = await promptConfirmation(expectedConfirmation, dependencies.streams);
      if (confirmed !== expectedConfirmation) {
        throw new Error("owner confirmation did not match exactly");
      }
    }

    const expected = policyWithVersion(loaded.policy, 2);
    const staged = await stage(plan, loaded.raw);
    let putOutput;
    let putError;
    let cleanupError;
    try {
      putOutput = await runCommand(
        buildAdminInvocation(plan, "put", loaded.policy.walletId, staged.path),
      );
    } catch (error) {
      putError = error;
    } finally {
      try {
        await staged.cleanup();
      } catch (error) {
        cleanupError = error;
      }
    }

    let durable;
    let readbackError;
    try {
      durable = await getCurrentPolicy(plan, loaded.policy.walletId, runCommand);
    } catch (error) {
      readbackError = error;
    }
    if (cleanupError) {
      throw new Error(
        "signer policy staging cleanup failed; policy state may have changed, so inspect the signer-only runtime directory and query policy before any retry",
      );
    }
    if (putError) {
      if (durable && samePolicy(durable, expected)) {
        throw new Error(
          "the signer durably installed the expected policy but the mutation acknowledgement failed; do not retry",
        );
      }
      if (readbackError) {
        throw new Error(
          "signer policy mutation and durable readback both failed; do not retry until a host administrator queries policy state",
        );
      }
      throw putError;
    }

    let acknowledged;
    try {
      acknowledged = parseAdminPolicyOutput(putOutput);
    } catch {
      throw new Error(
        durable && samePolicy(durable, expected)
          ? "the signer installed the expected policy but returned an invalid acknowledgement; do not retry"
          : "the signer returned an invalid policy acknowledgement and durable state does not match; do not retry",
      );
    }
    if (!samePolicy(acknowledged, expected)) {
      throw new Error(
        durable && samePolicy(durable, expected)
          ? "the signer installed the expected policy but acknowledgement content did not match; do not retry"
          : "signer policy acknowledgement did not match the exact owner policy",
      );
    }
    if (readbackError || !durable || !samePolicy(durable, expected)) {
      throw new Error("durable signer policy readback did not match the acknowledged owner policy");
    }
    const result = {
      walletId: durable.walletId,
      version: durable.version,
      hash: durable.hash,
      status: "acknowledged",
    };
    output.write(
      `${JSON.stringify({ version: result.version, hash: result.hash, status: result.status })}\n`,
    );
    return result;
  } finally {
    loaded.raw.fill(0);
  }
}

function parseCLI(argv) {
  const values = Object.create(null);
  const booleans = new Set(["--initial-install", "--non-interactive"]);
  const strings = new Set(["--profile", "--policy-file", "--confirm-digest"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") {
      if (argv.length !== 1) {
        throw new Error("--help must be used alone");
      }
      return { help: true };
    }
    if (!booleans.has(flag) && !strings.has(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    if (Object.hasOwn(values, flag)) {
      throw new Error(`duplicate argument: ${flag}`);
    }
    if (booleans.has(flag)) {
      values[flag] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    values[flag] = value;
    index += 1;
  }
  return {
    profile: values["--profile"],
    policyFile: values["--policy-file"],
    confirmDigest: values["--confirm-digest"],
    initialInstall: values["--initial-install"] === true,
    nonInteractive: values["--non-interactive"] === true,
  };
}

function usage() {
  return `Usage:
  fased-signer-policy --profile local --initial-install --policy-file /secure/policy.json
  fased-signer-policy --profile hosting --initial-install --policy-file /root/policy.json

Owner-controlled noninteractive install:
  fased-signer-policy --profile <local|hosting> --initial-install --policy-file /secure/policy.json \\
    --non-interactive --confirm-digest sha256:<exact-file-digest>

There is intentionally no --yes flag. Hosting must run as root; Local must run as the
same non-root user that owns the native signer control socket.
`;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCLI(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  await runInitialSignerPolicySetup(options);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`fased-signer-policy: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export const __testing = Object.freeze({
  ASSOCIATED_TOKEN_PROGRAM,
  FEDERATION_POLICY_DOMAIN,
  HOSTING_PATHS,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  SAT_MINING_ACTIONS,
  VAULT_BOND_ACTIONS,
  encodeBase58,
  normalizeLockedStoredPolicy,
  parseAdminPolicyOutput,
  parseCLI,
  parseStrictJson,
  policyWithVersion,
  renderPolicySummary,
  stagePolicyFile,
});
