import fs from "node:fs";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { resolveOAuthPath } from "../../config/paths.js";
import { coerceSecretRef, isSecretRef } from "../../config/types.secrets.js";
import { withFileLock } from "../../infra/file-lock.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import { AUTH_STORE_LOCK_OPTIONS, AUTH_STORE_VERSION, log } from "./constants.js";
import { syncExternalCliCredentials } from "./external-cli-sync.js";
import { ensureAuthStoreFile, resolveAuthStorePath, resolveLegacyAuthStorePath } from "./paths.js";
import type {
  AuthProfileCredential,
  AuthProfileFailureReason,
  AuthProfileStore,
  ProfileUsageStats,
} from "./types.js";

type LegacyAuthStore = Record<string, AuthProfileCredential>;
type CredentialRejectReason =
  | "non_object"
  | "invalid_type"
  | "missing_provider"
  | "invalid_shape"
  | "missing_material";
type RejectedCredentialEntry = { key: string; reason: CredentialRejectReason };
type LoadAuthProfileStoreOptions = {
  allowKeychainPrompt?: boolean;
  readOnly?: boolean;
  strict?: boolean;
  syncExternalCli?: boolean;
};

type StoreCoercionOptions = {
  rejectInvalidEntries?: boolean;
};

const AUTH_PROFILE_TYPES = new Set<AuthProfileCredential["type"]>(["api_key", "oauth", "token"]);
const AUTH_PROFILE_FAILURE_REASONS = new Set<AuthProfileFailureReason>([
  "auth",
  "auth_permanent",
  "format",
  "rate_limit",
  "overloaded",
  "billing",
  "timeout",
  "model_not_found",
  "session_expired",
  "unknown",
]);

const runtimeAuthStoreSnapshots = new Map<string, AuthProfileStore>();

function resolveRuntimeStoreKey(agentDir?: string): string {
  return resolveAuthStorePath(agentDir);
}

function cloneAuthProfileStore(store: AuthProfileStore): AuthProfileStore {
  return structuredClone(store);
}

function resolveRuntimeAuthProfileStore(agentDir?: string): AuthProfileStore | null {
  if (runtimeAuthStoreSnapshots.size === 0) {
    return null;
  }

  const mainKey = resolveRuntimeStoreKey(undefined);
  const requestedKey = resolveRuntimeStoreKey(agentDir);
  const mainStore = runtimeAuthStoreSnapshots.get(mainKey);
  const requestedStore = runtimeAuthStoreSnapshots.get(requestedKey);

  if (!agentDir || requestedKey === mainKey) {
    if (!mainStore) {
      return null;
    }
    return cloneAuthProfileStore(mainStore);
  }

  if (mainStore && requestedStore) {
    return mergeAuthProfileStores(
      cloneAuthProfileStore(mainStore),
      cloneAuthProfileStore(requestedStore),
    );
  }
  if (requestedStore) {
    return cloneAuthProfileStore(requestedStore);
  }
  if (mainStore) {
    return cloneAuthProfileStore(mainStore);
  }

  return null;
}

export function replaceRuntimeAuthProfileStoreSnapshots(
  entries: Array<{ agentDir?: string; store: AuthProfileStore }>,
): void {
  runtimeAuthStoreSnapshots.clear();
  for (const entry of entries) {
    runtimeAuthStoreSnapshots.set(
      resolveRuntimeStoreKey(entry.agentDir),
      cloneAuthProfileStore(entry.store),
    );
  }
}

export function clearRuntimeAuthProfileStoreSnapshots(): void {
  runtimeAuthStoreSnapshots.clear();
}

export async function updateAuthProfileStoreWithLock(params: {
  agentDir?: string;
  updater: (store: AuthProfileStore) => boolean;
}): Promise<AuthProfileStore | null> {
  const authPath = resolveAuthStorePath(params.agentDir);
  ensureAuthStoreFile(authPath);

  try {
    return await withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
      const store = ensureAuthProfileStore(params.agentDir);
      const shouldSave = params.updater(store);
      if (shouldSave) {
        saveAuthProfileStore(store, params.agentDir);
      }
      return store;
    });
  } catch {
    return null;
  }
}

/**
 * Normalise a raw auth-profiles.json credential entry.
 *
 * The official format uses `type` and (for api_key credentials) `key`.
 * A common mistake — caused by the similarity with the `fased.json`
 * `auth.profiles` section which uses `mode` — is to write `mode` instead of
 * `type` and `apiKey` instead of `key`.  Accept both spellings so users don't
 * silently lose their credentials.
 */
function normalizeRawCredentialEntry(raw: Record<string, unknown>): Partial<AuthProfileCredential> {
  const entry = { ...raw } as Record<string, unknown>;
  // mode → type alias (fased.json uses "mode"; auth-profiles.json uses "type")
  if (!("type" in entry) && typeof entry["mode"] === "string") {
    entry["type"] = entry["mode"];
  }
  // apiKey → key alias for ApiKeyCredential
  if (!("key" in entry) && typeof entry["apiKey"] === "string") {
    entry["key"] = entry["apiKey"];
  }
  return entry as Partial<AuthProfileCredential>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUsableString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isValidStringMetadata(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) && Object.values(value).every((entry) => typeof entry === "string"))
  );
}

function isSupportedStoredSecretRef(value: unknown): boolean {
  if (isSecretRef(value)) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value).toSorted();
  // Previous releases persisted `{ source, id }`. Validate that the compatibility
  // coercion accepts it, but preserve the raw value so secrets runtime can apply
  // the active source-specific default provider during resolution.
  return (
    keys.length === 2 && keys[0] === "id" && keys[1] === "source" && coerceSecretRef(value) !== null
  );
}

function hasValidSecretMaterial(params: { value: unknown; ref: unknown }): boolean {
  const valueIsValid = isUsableString(params.value) || isSupportedStoredSecretRef(params.value);
  const refIsValid = isSupportedStoredSecretRef(params.ref);
  return valueIsValid || refIsValid;
}

function isValidCredentialShape(
  entry: Record<string, unknown>,
  type: AuthProfileCredential["type"],
): CredentialRejectReason | null {
  if (!isOptionalString(entry.email)) {
    return "invalid_shape";
  }

  if (type === "api_key") {
    if (
      (entry.key !== undefined &&
        typeof entry.key !== "string" &&
        !isSupportedStoredSecretRef(entry.key)) ||
      (entry.keyRef !== undefined && !isSupportedStoredSecretRef(entry.keyRef)) ||
      !isValidStringMetadata(entry.metadata)
    ) {
      return "invalid_shape";
    }
    return hasValidSecretMaterial({ value: entry.key, ref: entry.keyRef })
      ? null
      : "missing_material";
  }

  if (type === "token") {
    if (
      (entry.token !== undefined &&
        typeof entry.token !== "string" &&
        !isSupportedStoredSecretRef(entry.token)) ||
      (entry.tokenRef !== undefined && !isSupportedStoredSecretRef(entry.tokenRef)) ||
      !isOptionalFiniteNumber(entry.expires)
    ) {
      return "invalid_shape";
    }
    return hasValidSecretMaterial({ value: entry.token, ref: entry.tokenRef })
      ? null
      : "missing_material";
  }

  if (
    !isUsableString(entry.access) ||
    !isUsableString(entry.refresh) ||
    typeof entry.expires !== "number" ||
    !Number.isFinite(entry.expires)
  ) {
    return "missing_material";
  }
  for (const field of ["clientId", "enterpriseUrl", "projectId", "accountId"] as const) {
    if (!isOptionalString(entry[field])) {
      return "invalid_shape";
    }
  }
  if (
    entry.availableModelIds !== undefined &&
    (!Array.isArray(entry.availableModelIds) ||
      !entry.availableModelIds.every((modelId) => isUsableString(modelId)))
  ) {
    return "invalid_shape";
  }
  return null;
}

function parseCredentialEntry(
  raw: unknown,
  fallbackProvider?: string,
  options?: { strict?: boolean },
): { ok: true; credential: AuthProfileCredential } | { ok: false; reason: CredentialRejectReason } {
  if (!isRecord(raw)) {
    return { ok: false, reason: "non_object" };
  }
  const typed = normalizeRawCredentialEntry(raw);
  if (!AUTH_PROFILE_TYPES.has(typed.type as AuthProfileCredential["type"])) {
    return { ok: false, reason: "invalid_type" };
  }
  const provider = typed.provider ?? fallbackProvider;
  if (typeof provider !== "string" || provider.trim().length === 0) {
    return { ok: false, reason: "missing_provider" };
  }
  const type = typed.type as AuthProfileCredential["type"];
  if (options?.strict) {
    const invalidReason = isValidCredentialShape(typed as Record<string, unknown>, type);
    if (invalidReason) {
      return { ok: false, reason: invalidReason };
    }
  }
  return {
    ok: true,
    credential: {
      ...typed,
      type,
      provider,
    } as AuthProfileCredential,
  };
}

function warnRejectedCredentialEntries(source: string, rejected: RejectedCredentialEntry[]): void {
  if (rejected.length === 0) {
    return;
  }
  const reasons = rejected.reduce(
    (acc, current) => {
      acc[current.reason] = (acc[current.reason] ?? 0) + 1;
      return acc;
    },
    {} as Partial<Record<CredentialRejectReason, number>>,
  );
  log.warn("ignored invalid auth profile entries during store load", {
    source,
    dropped: rejected.length,
    reasons,
    keys: rejected.slice(0, 10).map((entry) => entry.key),
  });
}

function coerceLegacyStore(raw: unknown, options?: StoreCoercionOptions): LegacyAuthStore | null {
  if (!isRecord(raw)) {
    return null;
  }
  const record = raw;
  if ("profiles" in record) {
    return null;
  }
  const entries: LegacyAuthStore = {};
  const rejected: RejectedCredentialEntry[] = [];
  for (const [key, value] of Object.entries(record)) {
    const parsed = parseCredentialEntry(value, key, {
      strict: options?.rejectInvalidEntries === true,
    });
    if (!parsed.ok) {
      rejected.push({ key, reason: parsed.reason });
      continue;
    }
    entries[key] = parsed.credential;
  }
  if (options?.rejectInvalidEntries && rejected.length > 0) {
    return null;
  }
  warnRejectedCredentialEntries("auth.json", rejected);
  return Object.keys(entries).length > 0 || options?.rejectInvalidEntries ? entries : null;
}

function isValidProfileOrder(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).every(
    ([provider, profileIds]) =>
      isUsableString(provider) &&
      Array.isArray(profileIds) &&
      profileIds.every((profileId) => isUsableString(profileId)),
  );
}

function isValidLastGood(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).every(
    ([provider, profileId]) => isUsableString(provider) && isUsableString(profileId),
  );
}

function isValidFailureCounts(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).every(
    ([reason, count]) =>
      AUTH_PROFILE_FAILURE_REASONS.has(reason as AuthProfileFailureReason) &&
      typeof count === "number" &&
      Number.isFinite(count) &&
      Number.isInteger(count) &&
      count >= 0,
  );
}

function isValidUsageStats(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).every(([profileId, stats]) => {
    if (!isUsableString(profileId) || !isRecord(stats)) {
      return false;
    }
    for (const field of ["lastUsed", "cooldownUntil", "disabledUntil", "lastFailureAt"] as const) {
      if (!isOptionalFiniteNumber(stats[field])) {
        return false;
      }
    }
    if (
      stats.errorCount !== undefined &&
      (typeof stats.errorCount !== "number" ||
        !Number.isFinite(stats.errorCount) ||
        !Number.isInteger(stats.errorCount) ||
        stats.errorCount < 0)
    ) {
      return false;
    }
    for (const field of ["disabledReason", "cooldownReason"] as const) {
      if (
        stats[field] !== undefined &&
        (typeof stats[field] !== "string" ||
          !AUTH_PROFILE_FAILURE_REASONS.has(stats[field] as AuthProfileFailureReason))
      ) {
        return false;
      }
    }
    if (!isOptionalString(stats.cooldownModel) || !isValidFailureCounts(stats.failureCounts)) {
      return false;
    }
    return true;
  });
}

function hasValidStoreMetadata(record: Record<string, unknown>): boolean {
  return (
    (record.version === undefined ||
      (typeof record.version === "number" &&
        Number.isFinite(record.version) &&
        Number.isInteger(record.version) &&
        record.version >= 1 &&
        record.version <= AUTH_STORE_VERSION)) &&
    isValidProfileOrder(record.order) &&
    isValidLastGood(record.lastGood) &&
    isValidUsageStats(record.usageStats)
  );
}

function coerceAuthStore(raw: unknown, options?: StoreCoercionOptions): AuthProfileStore | null {
  if (!isRecord(raw)) {
    return null;
  }
  const record = raw;
  if (!isRecord(record.profiles)) {
    return null;
  }
  if (options?.rejectInvalidEntries && !hasValidStoreMetadata(record)) {
    return null;
  }
  const profiles = record.profiles;
  const normalized: Record<string, AuthProfileCredential> = {};
  const rejected: RejectedCredentialEntry[] = [];
  for (const [key, value] of Object.entries(profiles)) {
    const parsed =
      !options?.rejectInvalidEntries || isUsableString(key)
        ? parseCredentialEntry(value, undefined, {
            strict: options?.rejectInvalidEntries === true,
          })
        : ({ ok: false, reason: "invalid_shape" } as const);
    if (!parsed.ok) {
      rejected.push({ key, reason: parsed.reason });
      continue;
    }
    normalized[key] = parsed.credential;
  }
  if (options?.rejectInvalidEntries && rejected.length > 0) {
    return null;
  }
  warnRejectedCredentialEntries("auth-profiles.json", rejected);
  const order = options?.rejectInvalidEntries
    ? (record.order as Record<string, string[]> | undefined)
    : record.order && typeof record.order === "object"
      ? Object.entries(record.order as Record<string, unknown>).reduce(
          (acc, [provider, value]) => {
            if (!Array.isArray(value)) {
              return acc;
            }
            const list = value
              .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
              .filter(Boolean);
            if (list.length === 0) {
              return acc;
            }
            acc[provider] = list;
            return acc;
          },
          {} as Record<string, string[]>,
        )
      : undefined;
  return {
    version: Number(record.version ?? AUTH_STORE_VERSION),
    profiles: normalized,
    order,
    lastGood:
      record.lastGood && typeof record.lastGood === "object"
        ? (record.lastGood as Record<string, string>)
        : undefined,
    usageStats:
      record.usageStats && typeof record.usageStats === "object"
        ? (record.usageStats as Record<string, ProfileUsageStats>)
        : undefined,
  };
}

function mergeRecord<T>(
  base?: Record<string, T>,
  override?: Record<string, T>,
): Record<string, T> | undefined {
  if (!base && !override) {
    return undefined;
  }
  if (!base) {
    return { ...override };
  }
  if (!override) {
    return { ...base };
  }
  return { ...base, ...override };
}

function mergeAuthProfileStores(
  base: AuthProfileStore,
  override: AuthProfileStore,
): AuthProfileStore {
  if (
    Object.keys(override.profiles).length === 0 &&
    !override.order &&
    !override.lastGood &&
    !override.usageStats
  ) {
    return base;
  }
  return {
    version: Math.max(base.version, override.version ?? base.version),
    profiles: { ...base.profiles, ...override.profiles },
    order: mergeRecord(base.order, override.order),
    lastGood: mergeRecord(base.lastGood, override.lastGood),
    usageStats: mergeRecord(base.usageStats, override.usageStats),
  };
}

function readJsonFileForAuthRuntime(params: {
  pathname: string;
  label: string;
  strict: boolean;
}): unknown {
  if (!params.strict) {
    return loadJsonFile(params.pathname);
  }
  if (!fs.existsSync(params.pathname)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(params.pathname, "utf8")) as unknown;
  } catch {
    throw new Error(`${params.label} is unreadable or contains invalid JSON.`);
  }
}

function mergeOAuthFileIntoStore(store: AuthProfileStore, strict = false): boolean {
  const oauthPath = resolveOAuthPath();
  const oauthRaw = readJsonFileForAuthRuntime({
    pathname: oauthPath,
    label: "OAuth credential store",
    strict,
  });
  if (oauthRaw === undefined) {
    return false;
  }
  if (!oauthRaw || typeof oauthRaw !== "object" || Array.isArray(oauthRaw)) {
    if (strict) {
      throw new Error("OAuth credential store has an invalid structure.");
    }
    return false;
  }
  const oauthEntries = oauthRaw as Record<string, unknown>;
  let mutated = false;
  for (const [provider, rawCreds] of Object.entries(oauthEntries)) {
    if (!isRecord(rawCreds)) {
      if (strict) {
        throw new Error("OAuth credential store has an invalid credential entry.");
      }
      continue;
    }
    const creds = rawCreds as OAuthCredentials;
    let credential: AuthProfileCredential;
    if (strict) {
      const parsed = parseCredentialEntry(
        {
          ...creds,
          type: "oauth",
          provider,
        },
        undefined,
        { strict: true },
      );
      if (!parsed.ok) {
        throw new Error("OAuth credential store has an invalid credential entry.");
      }
      credential = parsed.credential;
    } else {
      credential = {
        ...creds,
        type: "oauth",
        provider,
      } as AuthProfileCredential;
    }
    const profileId = `${provider}:default`;
    if (store.profiles[profileId]) {
      continue;
    }
    store.profiles[profileId] = credential;
    mutated = true;
  }
  return mutated;
}

function applyLegacyStore(store: AuthProfileStore, legacy: LegacyAuthStore): void {
  for (const [provider, cred] of Object.entries(legacy)) {
    const profileId = `${provider}:default`;
    if (cred.type === "api_key") {
      store.profiles[profileId] = {
        type: "api_key",
        provider: String(cred.provider ?? provider),
        ...(cred.key !== undefined ? { key: cred.key } : {}),
        ...(cred.keyRef ? { keyRef: cred.keyRef } : {}),
        ...(cred.email ? { email: cred.email } : {}),
        ...(cred.metadata ? { metadata: cred.metadata } : {}),
      };
      continue;
    }
    if (cred.type === "token") {
      store.profiles[profileId] = {
        type: "token",
        provider: String(cred.provider ?? provider),
        ...(cred.token !== undefined ? { token: cred.token } : {}),
        ...(cred.tokenRef ? { tokenRef: cred.tokenRef } : {}),
        ...(typeof cred.expires === "number" ? { expires: cred.expires } : {}),
        ...(cred.email ? { email: cred.email } : {}),
      } as AuthProfileCredential;
      continue;
    }
    store.profiles[profileId] = {
      type: "oauth",
      provider: String(cred.provider ?? provider),
      access: cred.access,
      refresh: cred.refresh,
      expires: cred.expires,
      ...(cred.enterpriseUrl ? { enterpriseUrl: cred.enterpriseUrl } : {}),
      ...(cred.projectId ? { projectId: cred.projectId } : {}),
      ...(cred.accountId ? { accountId: cred.accountId } : {}),
      ...(cred.email ? { email: cred.email } : {}),
    };
  }
}

function loadCoercedStore(authPath: string, strict = false): AuthProfileStore | null {
  const raw = readJsonFileForAuthRuntime({
    pathname: authPath,
    label: "Auth profile store",
    strict,
  });
  if (raw === undefined) {
    return null;
  }
  const store = coerceAuthStore(raw, { rejectInvalidEntries: strict });
  if (!store && strict) {
    throw new Error("Auth profile store has an invalid structure or credential entry.");
  }
  return store;
}

export function loadAuthProfileStore(): AuthProfileStore {
  const authPath = resolveAuthStorePath();
  const asStore = loadCoercedStore(authPath);
  if (asStore) {
    // Sync from external CLI tools on every load.
    const synced = syncExternalCliCredentials(asStore);
    if (synced) {
      saveJsonFile(authPath, asStore);
    }
    return asStore;
  }
  const legacyRaw = loadJsonFile(resolveLegacyAuthStorePath());
  const legacy = coerceLegacyStore(legacyRaw);
  if (legacy) {
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {},
    };
    applyLegacyStore(store, legacy);
    syncExternalCliCredentials(store);
    return store;
  }

  const store: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
  syncExternalCliCredentials(store);
  return store;
}

function loadAuthProfileStoreForAgent(
  agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  const readOnly = options?.readOnly === true;
  const strict = options?.strict === true;
  const authPath = resolveAuthStorePath(agentDir);
  const asStore = loadCoercedStore(authPath, strict);
  if (asStore) {
    // Runtime secret activation must remain read-only:
    // sync external CLI credentials in-memory, but never persist while readOnly.
    const synced = shouldSyncExternalCliCredentials(options)
      ? syncExternalCliCredentials(asStore)
      : false;
    if (synced && !readOnly) {
      saveJsonFile(authPath, asStore);
    }
    return asStore;
  }

  // Fallback: inherit auth-profiles from main agent if subagent has none
  if (agentDir && !readOnly) {
    const mainAuthPath = resolveAuthStorePath(); // without agentDir = main
    const mainRaw = loadJsonFile(mainAuthPath);
    const mainStore = coerceAuthStore(mainRaw);
    if (mainStore && Object.keys(mainStore.profiles).length > 0) {
      // Clone main store to subagent directory for auth inheritance
      saveJsonFile(authPath, mainStore);
      log.info("inherited auth-profiles from main agent", { agentDir });
      return mainStore;
    }
  }

  const legacyPath = resolveLegacyAuthStorePath(agentDir);
  const legacyRaw = readJsonFileForAuthRuntime({
    pathname: legacyPath,
    label: "Legacy auth profile store",
    strict,
  });
  const legacy = coerceLegacyStore(legacyRaw, { rejectInvalidEntries: strict });
  if (legacyRaw !== undefined && !legacy && strict) {
    throw new Error("Legacy auth profile store has an invalid structure or credential entry.");
  }
  const store: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  if (legacy) {
    applyLegacyStore(store, legacy);
  }

  const mergedOAuth = mergeOAuthFileIntoStore(store, strict);
  // Keep external CLI credentials visible in runtime even during read-only loads.
  const syncedCli = shouldSyncExternalCliCredentials(options)
    ? syncExternalCliCredentials(store)
    : false;
  const forceReadOnly = process.env.FASED_AUTH_STORE_READONLY === "1";
  const shouldWrite = !readOnly && !forceReadOnly && (legacy !== null || mergedOAuth || syncedCli);
  if (shouldWrite) {
    saveJsonFile(authPath, store);
  }

  // PR #368: legacy auth.json could get re-migrated from other agent dirs,
  // overwriting fresh OAuth creds with stale tokens (fixes #363). Delete only
  // after we've successfully written auth-profiles.json.
  if (shouldWrite && legacy !== null) {
    const legacyPath = resolveLegacyAuthStorePath(agentDir);
    try {
      fs.unlinkSync(legacyPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log.warn("failed to delete legacy auth.json after migration", {
          err,
          legacyPath,
        });
      }
    }
  }

  return store;
}

function shouldSyncExternalCliCredentials(options?: { syncExternalCli?: boolean }): boolean {
  return options?.syncExternalCli !== false;
}

export function loadAuthProfileStoreForRuntime(
  agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  return mergeAuthProfileStores(mainStore, store);
}

export function loadAuthProfileStoreForSecretsRuntime(agentDir?: string): AuthProfileStore {
  return loadAuthProfileStoreForRuntime(agentDir, {
    readOnly: true,
    strict: true,
    allowKeychainPrompt: false,
  });
}

export function ensureAuthProfileStore(
  agentDir?: string,
  options?: { allowKeychainPrompt?: boolean },
): AuthProfileStore {
  const runtimeStore = resolveRuntimeAuthProfileStore(agentDir);
  if (runtimeStore) {
    return runtimeStore;
  }

  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  const merged = mergeAuthProfileStores(mainStore, store);

  return merged;
}

export function ensureAuthProfileStoreForLocalUpdate(agentDir?: string): AuthProfileStore {
  const runtimeStore = resolveRuntimeAuthProfileStore(agentDir);
  if (runtimeStore) {
    return runtimeStore;
  }
  return loadAuthProfileStoreForAgent(agentDir, { syncExternalCli: false });
}

export function saveAuthProfileStore(store: AuthProfileStore, agentDir?: string): void {
  const authPath = resolveAuthStorePath(agentDir);
  const profiles = Object.fromEntries(
    Object.entries(store.profiles).map(([profileId, credential]) => {
      if (credential.type === "api_key" && credential.keyRef && credential.key !== undefined) {
        const sanitized = { ...credential } as Record<string, unknown>;
        delete sanitized.key;
        return [profileId, sanitized];
      }
      if (credential.type === "token" && credential.tokenRef && credential.token !== undefined) {
        const sanitized = { ...credential } as Record<string, unknown>;
        delete sanitized.token;
        return [profileId, sanitized];
      }
      return [profileId, credential];
    }),
  ) as AuthProfileStore["profiles"];
  const payload = {
    version: AUTH_STORE_VERSION,
    profiles,
    order: store.order ?? undefined,
    lastGood: store.lastGood ?? undefined,
    usageStats: store.usageStats ?? undefined,
  } satisfies AuthProfileStore;
  saveJsonFile(authPath, payload);
}
