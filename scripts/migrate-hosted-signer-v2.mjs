#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

async function openVerifiedSourceFile(filePath, allowedRoots, allowedUids, label) {
  if (
    !allowedRoots.some((root) => filePath === root || filePath.startsWith(`${root}${path.sep}`))
  ) {
    fail(`${label} is outside an approved legacy wallet directory: ${filePath}`);
  }
  const noFollow = Number(fs.constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await fsp.open(filePath, fs.constants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      fail(`${label} must be a regular single-link file: ${filePath}`);
    }
    if ((stat.mode & 0o077) !== 0) {
      fail(`${label} must not be accessible by group or others: ${filePath}`);
    }
    if (!allowedUids.has(stat.uid)) {
      fail(`${label} has an unexpected owner uid ${stat.uid}: ${filePath}`);
    }
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

async function copySignerOwned(sourceHandle, destination, signerUid, signerGid) {
  // Copy from the already verified descriptor so an app-owned path cannot be
  // swapped for a symlink between validation and the privileged copy.
  await fsp.copyFile(`/proc/self/fd/${sourceHandle.fd}`, destination, fs.constants.COPYFILE_EXCL);
  await fsp.chmod(destination, 0o600);
  await fsp.chown(destination, signerUid, signerGid);
  const handle = await fsp.open(destination, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function comparablePolicy(policy) {
  return JSON.stringify({
    role: String(policy?.role ?? "")
      .trim()
      .toLowerCase(),
    operations: [...(policy?.operations ?? [])].map(String).toSorted(),
    programs: [...(policy?.programs ?? [])].map(String).toSorted(),
    assets: [...(policy?.assets ?? [])]
      .map((asset) => ({
        asset: String(asset?.asset ?? "").trim(),
        destinations: [...(asset?.destinations ?? [])].map(String).toSorted(),
        maxPerTx: String(asset?.maxPerTx ?? "").trim(),
        maxDaily: String(asset?.maxDaily ?? "").trim(),
      }))
      .toSorted((left, right) => left.asset.localeCompare(right.asset)),
  });
}

async function readExistingWallet(entry) {
  const walletResponse = await socketRequest(CONTROL_SOCKET, {
    op: "v2.wallet.get",
    walletId: entry.walletId,
  });
  if (walletResponse?.ok !== true) {
    return null;
  }
  const policyResponse = await socketRequest(CONTROL_SOCKET, {
    op: "v2.policy.get",
    walletId: entry.walletId,
  });
  if (policyResponse?.ok !== true) {
    fail(`existing signer wallet has no explicit policy: ${entry.walletId}`);
  }
  if (walletResponse.result?.publicKey !== entry.expectedPublicKey) {
    fail(`existing signer wallet address does not match migration policy: ${entry.walletId}`);
  }
  if (comparablePolicy(policyResponse.result) !== comparablePolicy(entry.policy)) {
    fail(`existing signer wallet policy does not match migration policy: ${entry.walletId}`);
  }
  return { wallet: walletResponse.result, policy: policyResponse.result };
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

function deferLegacyQuarantine(env = process.env) {
  return env.FASED_DEFER_LEGACY_QUARANTINE === "1";
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
    (policyStat.mode & 0o777) !== 0o600
  ) {
    fail("migration policy must be a root-owned, non-symlink regular file with mode 0600");
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
  const sourceHandles = new Map();
  const ownerUids = new Set([0, signer.uid]);
  for (const home of [appHome, legacySignerHome]) {
    const owner = await fsp.stat(home).catch(() => null);
    if (owner) {
      ownerUids.add(owner.uid);
    }
  }

  const sources = [
    ...new Set(entries.flatMap((entry) => [entry.keystorePath, entry.passphrasePath])),
  ];
  try {
    for (const source of sources) {
      sourceHandles.set(
        source,
        await openVerifiedSourceFile(source, allowedRoots, ownerUids, "legacy wallet material"),
      );
    }

    for (const entry of entries) {
      const stagedKeystore = path.join(IMPORT_DIR, `keystore-${entry.walletId}-${stamp}.v1.enc`);
      const stagedPassphrase = path.join(IMPORT_DIR, `passphrase-${entry.walletId}-${stamp}`);
      try {
        const existing = await readExistingWallet(entry);
        let wallet = existing?.wallet;
        let policy = existing?.policy;
        if (!existing) {
          await copySignerOwned(
            sourceHandles.get(entry.keystorePath),
            stagedKeystore,
            signer.uid,
            signer.gid,
          );
          await copySignerOwned(
            sourceHandles.get(entry.passphrasePath),
            stagedPassphrase,
            signer.uid,
            signer.gid,
          );
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
          wallet = imported?.result?.wallet;
          policy = imported?.result?.policy;
          if (imported?.ok !== true) {
            fail(
              `signer import failed for ${entry.walletId}: ${imported?.error ?? "unknown error"}`,
            );
          }
        }
        if (
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
  } finally {
    await Promise.all([...sourceHandles.values()].map((handle) => handle.close()));
  }
  const deferQuarantine = deferLegacyQuarantine();
  const quarantined = new Map();
  if (!deferQuarantine) {
    for (const source of sources) {
      quarantined.set(source, await quarantineLegacyFile(source, stamp));
    }
  }
  for (const result of verified) {
    process.stdout.write(
      `${result.entry.walletId}: ${result.entry.expectedPublicKey} policy=${result.policyHash} legacy=${
        deferQuarantine
          ? "verified-pending-commit"
          : [
              quarantined.get(result.entry.keystorePath),
              quarantined.get(result.entry.passphrasePath),
            ].join(",")
      }\n`,
    );
  }
}

const isMain = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href
  : false;
if (isMain) {
  await main();
}

export const __testing = {
  assertPolicy,
  assertWalletEntry,
  comparablePolicy,
  copySignerOwned,
  deferLegacyQuarantine,
  openVerifiedSourceFile,
};
