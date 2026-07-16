#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const CONTROL_SOCKET = "/run/fased-signerd/control.sock";
const APP_SOCKET = "/run/fased-signerd/app.sock";
const IMPORT_DIR = "/var/lib/fased-signerd/import";
const POLICY_FILE = "/etc/fased/signer-migration-policies.json";
const MAX_RESPONSE_BYTES = 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  const keys = Object.keys(value).toSorted();
  if (keys.join(",") !== expected.toSorted().join(",")) {
    fail(`${label} contains unsupported fields: ${keys.join(",")}`);
  }
}

function assertNonEmptyStrings(values, label) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => typeof value !== "string" || !value.trim()) ||
    new Set(values).size !== values.length
  ) {
    fail(`${label} must be an explicit, non-empty list without duplicates`);
  }
}

function assertPolicy(value, walletId) {
  const policy = assertPlainObject(value, `policy for ${walletId}`);
  assertExactKeys(policy, ["assets", "operations", "programs", "role"], `policy for ${walletId}`);
  if (!new Set(["agent", "mining", "vault"]).has(policy.role)) {
    fail(`policy role must be agent, mining, or vault for ${walletId}`);
  }
  assertNonEmptyStrings(policy.operations, `policy operations for ${walletId}`);
  assertNonEmptyStrings(policy.programs, `policy programs for ${walletId}`);
  if (!Array.isArray(policy.assets) || policy.assets.length === 0) {
    fail(`policy assets and positive caps must be explicit for ${walletId}`);
  }
  for (const [index, value] of policy.assets.entries()) {
    const asset = assertPlainObject(value, `policy asset ${index} for ${walletId}`);
    assertExactKeys(
      asset,
      ["asset", "destinations", "maxDaily", "maxPerTx"],
      `policy asset ${index} for ${walletId}`,
    );
    if (typeof asset.asset !== "string" || !asset.asset.trim()) {
      fail(`policy asset ${index} must name an exact asset for ${walletId}`);
    }
    assertNonEmptyStrings(
      asset.destinations,
      `policy destinations for asset ${asset.asset} in ${walletId}`,
    );
    for (const cap of ["maxPerTx", "maxDaily"]) {
      if (typeof asset[cap] !== "string" || !/^[1-9][0-9]*$/.test(asset[cap])) {
        fail(`${cap} must be a positive raw-unit string for asset ${asset.asset} in ${walletId}`);
      }
    }
  }
  return policy;
}

function assertWalletEntry(value) {
  const entry = assertPlainObject(value, "migration wallet");
  const required = ["expectedPublicKey", "keystorePath", "passphrasePath", "policy", "walletId"];
  assertExactKeys(entry, required, "migration wallet");
  const walletId = String(entry.walletId ?? "").trim();
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(walletId)) {
    fail("walletId must be a stable lowercase wallet identifier");
  }
  const expectedPublicKey = String(entry.expectedPublicKey ?? "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(expectedPublicKey)) {
    fail(`expectedPublicKey is invalid for ${walletId}`);
  }
  const keystorePath = path.resolve(String(entry.keystorePath ?? ""));
  const passphrasePath = path.resolve(String(entry.passphrasePath ?? ""));
  const policy = assertPolicy(entry.policy, walletId);
  return { walletId, expectedPublicKey, keystorePath, passphrasePath, policy };
}

async function assertSourceFile(filePath, allowedRoots, label) {
  if (
    !allowedRoots.some((root) => filePath === root || filePath.startsWith(`${root}${path.sep}`))
  ) {
    fail(`${label} is outside an approved legacy wallet directory: ${filePath}`);
  }
  const stat = await fsp.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular non-symlink file: ${filePath}`);
  }
}

async function copySignerOwned(source, destination, signerUid, signerGid) {
  await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  await fsp.chmod(destination, 0o600);
  await fsp.chown(destination, signerUid, signerGid);
  const handle = await fsp.open(destination, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function socketRequest(socketPath, request) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.setEncoding("utf8");
    socket.setTimeout(30_000);
    let body = "";
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
        socket.destroy();
        reject(new Error("signer migration response is too large"));
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0) {
        return;
      }
      socket.destroy();
      try {
        resolve(JSON.parse(body.slice(0, newline)));
      } catch {
        reject(new Error("signer migration response is invalid"));
      }
    });
    socket.once("timeout", () => reject(new Error("signer migration request timed out")));
    socket.once("error", reject);
  });
}

async function quarantineLegacyFile(filePath, stamp) {
  const destination = `${filePath}.migrated-v2-${stamp}`;
  await fsp.rename(filePath, destination);
  await fsp.chown(destination, 0, 0);
  await fsp.chmod(destination, 0o000);
  return destination;
}

async function main() {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    fail("hosted signer migration must run as root");
  }
  const policyPath = path.resolve(process.argv[2] || POLICY_FILE);
  const policyStat = await fsp.lstat(policyPath);
  if (
    !policyStat.isFile() ||
    policyStat.isSymbolicLink() ||
    policyStat.uid !== 0 ||
    (policyStat.mode & 0o022) !== 0
  ) {
    fail(
      "migration policy must be a root-owned, non-symlink regular file not writable by group or others",
    );
  }
  const parsed = JSON.parse(await fsp.readFile(policyPath, "utf8"));
  assertExactKeys(
    assertPlainObject(parsed, "migration policy"),
    ["schemaVersion", "wallets"],
    "migration policy",
  );
  if (
    parsed?.schemaVersion !== 1 ||
    !Array.isArray(parsed.wallets) ||
    parsed.wallets.length === 0
  ) {
    fail("migration policy must use schemaVersion 1 and a non-empty wallets array");
  }
  const entries = parsed.wallets.map(assertWalletEntry);
  if (new Set(entries.map((entry) => entry.walletId)).size !== entries.length) {
    fail("migration policy contains duplicate wallet IDs");
  }
  const signer = await fsp.stat("/var/lib/fased-signerd");
  const appHome = String(process.env.FASED_APP_HOME || "/home/app");
  const legacySignerHome = String(process.env.FASED_LEGACY_SIGNER_HOME || "/home/fased-signer");
  const allowedRoots = [
    path.resolve(appHome, ".fased", "wallet"),
    path.resolve(legacySignerHome, ".fased", "wallet"),
  ];
  await fsp.mkdir(IMPORT_DIR, { recursive: true, mode: 0o700 });
  await fsp.chown(IMPORT_DIR, signer.uid, signer.gid);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const verified = [];

  for (const entry of entries) {
    await assertSourceFile(entry.keystorePath, allowedRoots, "legacy keystore");
    await assertSourceFile(entry.passphrasePath, allowedRoots, "legacy passphrase");
    const stagedKeystore = path.join(IMPORT_DIR, `keystore-${entry.walletId}-${stamp}.v1.enc`);
    const stagedPassphrase = path.join(IMPORT_DIR, `passphrase-${entry.walletId}-${stamp}`);
    try {
      await copySignerOwned(entry.keystorePath, stagedKeystore, signer.uid, signer.gid);
      await copySignerOwned(entry.passphrasePath, stagedPassphrase, signer.uid, signer.gid);
      const imported = await socketRequest(CONTROL_SOCKET, {
        op: "v2.wallet.importLegacy",
        walletId: entry.walletId,
        request: {
          expectedPolicyVersion: 0,
          path: stagedKeystore,
          passphrasePath: stagedPassphrase,
          policy: entry.policy,
        },
      });
      const wallet = imported?.result?.wallet;
      const policy = imported?.result?.policy;
      if (
        imported?.ok !== true ||
        wallet?.walletId !== entry.walletId ||
        wallet?.publicKey !== entry.expectedPublicKey ||
        !/^sha256:[a-f0-9]{64}$/.test(policy?.hash ?? "")
      ) {
        fail(`signer did not verify the expected address and policy for ${entry.walletId}`);
      }
      const health = await socketRequest(APP_SOCKET, { op: "health" });
      const acknowledged = health?.result?.policies?.some(
        (candidate) =>
          candidate?.walletId === entry.walletId &&
          candidate?.version === policy.version &&
          candidate?.hash === policy.hash,
      );
      if (
        health?.ok !== true ||
        health?.result?.ready !== true ||
        health?.result?.capabilities?.protocol?.current !== 2 ||
        !acknowledged
      ) {
        fail(`signer health did not acknowledge the imported policy for ${entry.walletId}`);
      }
      verified.push({ entry, policyHash: policy.hash });
    } finally {
      await fsp.rm(stagedKeystore, { force: true });
      await fsp.rm(stagedPassphrase, { force: true });
    }
  }
  const sources = [
    ...new Set(entries.flatMap((entry) => [entry.keystorePath, entry.passphrasePath])),
  ];
  const quarantined = new Map();
  for (const source of sources) {
    quarantined.set(source, await quarantineLegacyFile(source, stamp));
  }
  for (const result of verified) {
    process.stdout.write(
      `${result.entry.walletId}: ${result.entry.expectedPublicKey} policy=${result.policyHash} legacy=${[
        quarantined.get(result.entry.keystorePath),
        quarantined.get(result.entry.passphrasePath),
      ].join(",")}\n`,
    );
  }
}

await main();
