#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_POLICY_PATH = "/etc/fased/signer-migration-policies.json";
const DEFAULT_STATE_DIR = "/var/lib/fased-host-updater/legacy-wallet-migration";

function fail(message) {
  throw new Error(message);
}

function normalizeSignerWalletId(value) {
  return (
    String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "default"
  );
}

function walletEnvSuffix(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function walletRole(wallet, registry, config) {
  const normalize = (value) => {
    const role = String(value ?? "")
      .trim()
      .toLowerCase();
    return new Set(["agent", "mining", "vault"]).has(role) ? role : "";
  };
  const recorded = normalize(wallet?.metadata?.purpose) || normalize(wallet?.metadata?.role);
  if (recorded) {
    return recorded;
  }
  const walletId = String(wallet?.id ?? "").trim();
  const normalizedId = walletId.toLowerCase();
  const label = String(wallet?.name ?? "").toLowerCase();
  const miningWalletId = String(
    config?.plugins?.entries?.["sat-mining"]?.config?.walletId ?? "",
  ).trim();
  if (
    walletId === miningWalletId ||
    normalizedId.startsWith("mining") ||
    /\bmin(?:er|ing)\b/u.test(label)
  ) {
    return "mining";
  }
  if (normalizedId.startsWith("vault") || /\bvault\b/u.test(label)) {
    return "vault";
  }
  if (
    walletId === registry?.defaultWalletId ||
    normalizedId.startsWith("agent") ||
    /\bagent\b/u.test(label)
  ) {
    return "agent";
  }
  fail(`legacy wallet ${walletId || "(missing ID)"} has no Agent, Mining, or Vault role`);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function regularPrivateFile(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function firstPrivateFile(candidates) {
  for (const candidate of candidates) {
    const file = String(candidate ?? "").trim();
    if (path.isAbsolute(file) && regularPrivateFile(file)) {
      return file;
    }
  }
  return "";
}

function ensureAbsoluteClean(value, label) {
  const resolved = String(value ?? "").trim();
  if (!path.isAbsolute(resolved) || path.normalize(resolved) !== resolved) {
    fail(`${label} must be an absolute clean path`);
  }
  return resolved;
}

function atomicWrite(file, data, metadata = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, data, { mode: metadata.mode ?? 0o600, flag: "wx" });
  if (Number.isInteger(metadata.uid) && Number.isInteger(metadata.gid)) {
    const currentUid = process.getuid?.();
    const currentGid = process.getgid?.();
    if (currentUid === 0 || (metadata.uid === currentUid && metadata.gid === currentGid)) {
      fs.chownSync(temporary, metadata.uid, metadata.gid);
    }
  }
  fs.chmodSync(temporary, metadata.mode ?? 0o600);
  fs.renameSync(temporary, file);
}

function snapshotFile(source, destination) {
  try {
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail(`migration source is unsafe: ${source}`);
    }
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
    return { existed: true, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { existed: false };
    }
    throw error;
  }
}

function restoreSnapshot(snapshot, source, destination) {
  if (!snapshot.existed) {
    fs.rmSync(destination, { force: true });
    return;
  }
  atomicWrite(destination, fs.readFileSync(source), snapshot);
}

export function buildHostedLegacyWalletPlan({ appHome, legacySignerHome }) {
  const appWalletDir = path.join(appHome, ".fased", "wallet");
  const legacyWalletDir = path.join(legacySignerHome, ".fased", "wallet");
  const registryPath = path.join(appWalletDir, "provider-registry.v1.json");
  const configPath = path.join(appHome, ".fased", "fased.json");
  const registry = readJson(registryPath);
  const config = readJson(configPath, {});
  const wallets = Array.isArray(registry?.wallets)
    ? registry.wallets.filter((wallet) => wallet?.providerId === "embedded-keystore")
    : [];
  if (wallets.length === 0) {
    fail("legacy key files exist without registered embedded wallets");
  }
  const vars = config?.env?.vars && typeof config.env.vars === "object" ? config.env.vars : {};
  const planned = [];
  const seenSignerIds = new Set();
  for (const wallet of wallets) {
    const registryWalletId = String(wallet?.id ?? "").trim();
    const expectedPublicKey = String(wallet?.addresses?.solana ?? "").trim();
    if (!registryWalletId || !expectedPublicKey) {
      fail("every legacy wallet must have a registered ID and Solana public address");
    }
    const walletId = normalizeSignerWalletId(registryWalletId);
    if (walletId.length > 64 || seenSignerIds.has(walletId)) {
      fail(`legacy wallet ID does not map uniquely to the native signer: ${registryWalletId}`);
    }
    seenSignerIds.add(walletId);
    const suffix = walletEnvSuffix(registryWalletId);
    const keystorePath = firstPrivateFile([
      vars[`FASED_WALLET_SOLANA_KEYSTORE_PATH__${suffix}`],
      wallets.length === 1 ? vars.FASED_WALLET_SOLANA_KEYSTORE_PATH : "",
      path.join(appWalletDir, `keystore-solana-${registryWalletId}.v1.enc`),
      path.join(appWalletDir, `keystore-solana-${walletId}.v1.enc`),
      path.join(legacyWalletDir, `keystore-solana-${registryWalletId}.v1.enc`),
      path.join(legacyWalletDir, `keystore-solana-${walletId}.v1.enc`),
      wallets.length === 1 ? path.join(appWalletDir, "keystore-solana.v1.enc") : "",
      wallets.length === 1 ? path.join(legacyWalletDir, "keystore-solana.v1.enc") : "",
    ]);
    if (!keystorePath) {
      fail(`legacy keystore is missing for wallet ${registryWalletId}`);
    }
    if (
      ![appWalletDir, legacyWalletDir].some((root) => {
        const relative = path.relative(root, keystorePath);
        return (
          relative &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        );
      })
    ) {
      fail(`legacy keystore is outside approved wallet directories: ${keystorePath}`);
    }
    const sourcePassphrasePath = firstPrivateFile([
      vars[`FASED_WALLET_PASSPHRASE_FILE__${suffix}`],
      vars.FASED_WALLET_PASSPHRASE_FILE,
      config?.wallet?.keystore?.passphraseFile,
      path.join(appWalletDir, "passphrase"),
      path.join(legacyWalletDir, "passphrase"),
    ]);
    const inlinePassphrase = String(
      vars[`FASED_WALLET_PASSPHRASE__${suffix}`] ?? vars.FASED_WALLET_PASSPHRASE ?? "",
    );
    if (!sourcePassphrasePath && !inlinePassphrase) {
      fail(`legacy passphrase file is missing for wallet ${registryWalletId}`);
    }
    planned.push({
      registryWalletId,
      walletId,
      role: walletRole(wallet, registry, config),
      expectedPublicKey,
      keystorePath,
      sourcePassphrasePath,
      inlinePassphrase,
      passphrasePath: path.join(appWalletDir, `.migration-passphrase-${walletId}`),
      primaryRpcUrl: String(
        vars[`FASED_WALLET_SOLANA_RPC_URL__${suffix}`] ??
          vars.FASED_WALLET_SOLANA_RPC_URL ??
          vars.FASED_WALLET_RPC_URL ??
          "",
      ).trim(),
    });
  }
  const coveredKeystores = new Set(planned.map((wallet) => wallet.keystorePath));
  for (const directory of [appWalletDir, legacyWalletDir]) {
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (entry.isFile() && /^keystore-.*\.enc$/u.test(entry.name)) {
        const candidate = path.join(directory, entry.name);
        if (!coveredKeystores.has(candidate)) {
          fail(`legacy keystore has no registered wallet mapping: ${candidate}`);
        }
      }
    }
  }
  return { registryPath, configPath, registry, config, wallets: planned };
}

function readState(stateDir) {
  const value = readJson(path.join(stateDir, "state.json"));
  if (value?.schemaVersion !== 1 || !Array.isArray(value?.wallets)) {
    fail("hosted legacy-wallet migration state is missing or invalid");
  }
  return value;
}

export function prepareHostedLegacyWalletMigration(options) {
  const appHome = ensureAbsoluteClean(options.appHome, "app home");
  const legacySignerHome = ensureAbsoluteClean(options.legacySignerHome, "legacy signer home");
  const policyPath = ensureAbsoluteClean(options.policyPath, "policy path");
  const stateDir = ensureAbsoluteClean(options.stateDir, "state directory");
  if (fs.existsSync(path.join(stateDir, "state.json"))) {
    return readState(stateDir);
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  let plan;
  try {
    plan = buildHostedLegacyWalletPlan({ appHome, legacySignerHome });
    const registrySnapshot = snapshotFile(
      plan.registryPath,
      path.join(stateDir, "registry.previous"),
    );
    const configSnapshot = snapshotFile(plan.configPath, path.join(stateDir, "config.previous"));
    for (const wallet of plan.wallets) {
      const passphrase = wallet.sourcePassphrasePath
        ? fs.readFileSync(wallet.sourcePassphrasePath)
        : Buffer.from(`${wallet.inlinePassphrase}\n`);
      atomicWrite(wallet.passphrasePath, passphrase, { mode: 0o600, uid: 0, gid: 0 });
      wallet.inlinePassphrase = "";
    }
    const policy = {
      schemaVersion: 1,
      wallets: plan.wallets.map((wallet) => ({
        walletId: wallet.walletId,
        expectedPublicKey: wallet.expectedPublicKey,
        keystorePath: wallet.keystorePath,
        passphrasePath: wallet.passphrasePath,
        baselineRole: wallet.role,
        ...(wallet.primaryRpcUrl ? { primaryRpcUrl: wallet.primaryRpcUrl } : {}),
      })),
    };
    atomicWrite(policyPath, `${JSON.stringify(policy, null, 2)}\n`, {
      mode: 0o600,
      uid: 0,
      gid: 0,
    });
    const state = {
      schemaVersion: 1,
      appHome,
      legacySignerHome,
      policyPath,
      registryPath: plan.registryPath,
      configPath: plan.configPath,
      registrySnapshot,
      configSnapshot,
      activated: false,
      wallets: plan.wallets.map(({ inlinePassphrase: _discarded, ...wallet }) => wallet),
    };
    atomicWrite(path.join(stateDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
    return state;
  } catch (error) {
    for (const wallet of plan?.wallets ?? []) {
      fs.rmSync(wallet.passphrasePath, { force: true });
      fs.rmSync(`${wallet.passphrasePath}.migrated-v2`, { force: true });
    }
    fs.rmSync(policyPath, { force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    throw error;
  }
}

function cleanLegacyConfig(config) {
  const next = structuredClone(config ?? {});
  const existingProvider =
    next.wallet?.provider && typeof next.wallet.provider === "object" ? next.wallet.provider : {};
  next.wallet = {
    ...next.wallet,
    provider: { ...existingProvider, id: "local-socket-signer" },
    localSigner: { socketPath: "/run/fased-signerd/app.sock" },
    runtime: { enabled: true, mode: "external", runtime: "external-custom" },
  };
  delete next.wallet.keystore;
  if (next.env?.vars && typeof next.env.vars === "object") {
    for (const key of Object.keys(next.env.vars)) {
      if (
        /^FASED_WALLET_(?:SOLANA_)?KEYSTORE_/u.test(key) ||
        key.startsWith("FASED_WALLET_PASSPHRASE") ||
        /^FASED_WALLET_(?:SOLANA_)?PRIVATE_KEY/u.test(key) ||
        /^FASED_WALLET_(?:SOLANA_)?RPC_URL/u.test(key)
      ) {
        delete next.env.vars[key];
      }
    }
  }
  return next;
}

export function activateHostedLegacyWalletMigration(stateDir) {
  const state = readState(stateDir);
  const registry = readJson(state.registryPath);
  const config = readJson(state.configPath, {});
  const byRegistryId = new Map(state.wallets.map((wallet) => [wallet.registryWalletId, wallet]));
  const now = new Date().toISOString();
  const nextRegistry = structuredClone(registry);
  nextRegistry.providers = {
    ...nextRegistry.providers,
    "embedded-keystore": {
      ...nextRegistry.providers?.["embedded-keystore"],
      enabled: false,
      updatedAt: now,
    },
    "local-socket-signer": {
      ...nextRegistry.providers?.["local-socket-signer"],
      enabled: true,
      updatedAt: now,
    },
  };
  nextRegistry.wallets = (nextRegistry.wallets ?? []).map((wallet) => {
    const migrated = byRegistryId.get(wallet.id);
    if (!migrated) {
      return wallet;
    }
    return {
      ...wallet,
      providerId: "local-socket-signer",
      metadata: {
        ...wallet.metadata,
        role: migrated.role,
        purpose: migrated.role,
        signerWalletId: migrated.walletId,
        migratedFromProviderId: "embedded-keystore",
        migratedAt: now,
      },
      updatedAt: now,
    };
  });
  nextRegistry.updatedAt = now;
  const registryStat = fs.statSync(state.registryPath);
  const configStat = fs.statSync(state.configPath);
  atomicWrite(state.registryPath, `${JSON.stringify(nextRegistry, null, 2)}\n`, {
    mode: registryStat.mode & 0o777,
    uid: registryStat.uid,
    gid: registryStat.gid,
  });
  atomicWrite(state.configPath, `${JSON.stringify(cleanLegacyConfig(config), null, 2)}\n`, {
    mode: configStat.mode & 0o777,
    uid: configStat.uid,
    gid: configStat.gid,
  });
  state.activated = true;
  atomicWrite(path.join(stateDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function rollbackHostedLegacyWalletMigration(stateDir) {
  if (!fs.existsSync(path.join(stateDir, "state.json"))) {
    return { rolledBack: false };
  }
  const state = readState(stateDir);
  restoreSnapshot(
    state.registrySnapshot,
    path.join(stateDir, "registry.previous"),
    state.registryPath,
  );
  restoreSnapshot(state.configSnapshot, path.join(stateDir, "config.previous"), state.configPath);
  for (const wallet of state.wallets) {
    fs.rmSync(wallet.passphrasePath, { force: true });
    fs.rmSync(`${wallet.passphrasePath}.migrated-v2`, { force: true });
  }
  fs.rmSync(state.policyPath, { force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
  return { rolledBack: true };
}

export function commitHostedLegacyWalletMigration(stateDir) {
  if (!fs.existsSync(path.join(stateDir, "state.json"))) {
    return { committed: false };
  }
  const state = readState(stateDir);
  if (!state.activated) {
    fail("hosted legacy-wallet application state was not activated");
  }
  for (const wallet of state.wallets) {
    fs.rmSync(wallet.passphrasePath, { force: true });
    fs.rmSync(`${wallet.passphrasePath}.migrated-v2`, { force: true });
    fs.rmSync(`${wallet.keystorePath}.migrated-v2`, { force: true });
    if (wallet.sourcePassphrasePath) {
      const insideLegacyWallet = [
        path.join(state.appHome, ".fased", "wallet"),
        path.join(state.legacySignerHome, ".fased", "wallet"),
      ].some((root) => {
        const relative = path.relative(root, wallet.sourcePassphrasePath);
        return (
          relative &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        );
      });
      if (insideLegacyWallet) {
        fs.rmSync(wallet.sourcePassphrasePath, { force: true });
      }
    }
  }
  fs.rmSync(state.policyPath, { force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
  return { committed: true };
}

function parseArgs(argv) {
  const action = argv[0];
  if (!new Set(["prepare", "activate", "rollback", "commit"]).has(action)) {
    fail("usage: hosted-legacy-wallet-migration.mjs {prepare|activate|rollback|commit} [options]");
  }
  const options = {
    action,
    appHome: "/home/app",
    legacySignerHome: "/home/fased-signer",
    policyPath: DEFAULT_POLICY_PATH,
    stateDir: DEFAULT_STATE_DIR,
  };
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value) {
      fail(`${key} requires a value`);
    }
    if (key === "--app-home") {
      options.appHome = value;
    } else if (key === "--legacy-signer-home") {
      options.legacySignerHome = value;
    } else if (key === "--policy-file") {
      options.policyPath = value;
    } else if (key === "--state-dir") {
      options.stateDir = value;
    } else {
      fail(`unknown option: ${key}`);
    }
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result =
    options.action === "prepare"
      ? prepareHostedLegacyWalletMigration(options)
      : options.action === "activate"
        ? activateHostedLegacyWalletMigration(options.stateDir)
        : options.action === "rollback"
          ? rollbackHostedLegacyWalletMigration(options.stateDir)
          : commitHostedLegacyWalletMigration(options.stateDir);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}

export const __testing = { cleanLegacyConfig, parseArgs };
