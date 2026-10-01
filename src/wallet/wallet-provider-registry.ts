import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WalletProviderId } from "../config/types.wallet.js";
import { throwLegacyEmbeddedKeystoreMigrationRequired } from "./legacy-embedded-keystore.js";
import { ensureWalletStateDir, walletApplicationStateFileMode } from "./wallet-runtime-config.js";

const PROVIDER_REGISTRY_FILENAME = "provider-registry.v1.json";

export const WALLET_PROVIDER_IDS: WalletProviderId[] = [
  "local-socket-signer",
  "alchemy",
  "turnkey",
  "wallet-standard",
];

const WALLET_PROVIDER_REGISTRY_IDS: WalletProviderId[] = [
  "embedded-keystore",
  ...WALLET_PROVIDER_IDS,
  "privy",
];

export type WalletUserRole = "agent";
export type WalletRoleAccountChain = "solana" | "evm";

export function nextRoleWalletIdentity(
  _role: WalletUserRole,
  wallets: ReadonlyArray<Pick<WalletNamedWallet, "id">>,
  _chain: WalletRoleAccountChain = "solana",
): { walletName: string; walletId: string } {
  const ids = new Set(wallets.map((w) => w.id));
  for (let i = 1; i < 1000; i++) {
    const id = i === 1 ? "wallet" : `wallet-${i}`;
    if (!ids.has(id)) {
      return { walletName: i === 1 ? "Wallet" : `Wallet ${i}`, walletId: id };
    }
  }
  const suffix = Date.now();
  return { walletName: `Wallet ${suffix}`, walletId: `wallet-${suffix}` };
}

export type WalletNamedWallet = {
  id: string;
  name: string;
  providerId: WalletProviderId;
  addresses?: {
    solana?: string;
    evm?: string;
  };
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export function normalizeWalletUserRole(value: unknown): WalletUserRole | undefined {
  return value === "agent" ? "agent" : undefined;
}

export function normalizeWalletRoleAccountChain(
  value: unknown,
): WalletRoleAccountChain | undefined {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return raw === "solana" || raw === "evm" ? raw : undefined;
}

export function resolveWalletUserRole(
  wallet: WalletNamedWallet | undefined,
): WalletUserRole | undefined {
  if (!wallet?.metadata || typeof wallet.metadata !== "object" || Array.isArray(wallet.metadata)) {
    return undefined;
  }
  return (
    normalizeWalletUserRole(wallet.metadata.purpose) ??
    normalizeWalletUserRole(wallet.metadata.role)
  );
}

export function resolveWalletRoleAccountChain(
  wallet: WalletNamedWallet | undefined,
): WalletRoleAccountChain | undefined {
  if (!wallet) {
    return undefined;
  }
  const explicit = normalizeWalletRoleAccountChain(wallet.metadata?.roleChain);
  if (explicit) {
    return explicit;
  }
  if (wallet.addresses?.evm && !wallet.addresses.solana) {
    return "evm";
  }
  return wallet.addresses?.solana ? "solana" : undefined;
}

export type WalletProviderConfigEntry = {
  enabled: boolean;
  label?: string;
  updatedAt: string;
};

export type WalletProviderRegistry = {
  version: 1;
  /** Wallet Standard is optional in legacy in-memory fixtures; disk reads always normalize it. */
  providers: Record<Exclude<WalletProviderId, "wallet-standard">, WalletProviderConfigEntry> &
    Partial<Record<"wallet-standard", WalletProviderConfigEntry>>;
  wallets: WalletNamedWallet[];
  assignments: Record<string, string>;
  defaultWalletId?: string;
  updatedAt: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  const walletState = ensureWalletStateDir(env);
  return path.join(walletState.rootDir, PROVIDER_REGISTRY_FILENAME);
}

function newWalletId(): string {
  return `w_${randomBytes(8).toString("hex")}`;
}

function normalizeProviderId(value: unknown): WalletProviderId | null {
  const raw = typeof value === "string" ? value.trim() : "";
  switch (raw) {
    case "embedded-keystore":
    case "local-socket-signer":
    case "alchemy":
    case "turnkey":
    case "wallet-standard":
    case "privy":
      return raw;
    default:
      return null;
  }
}

function normalizeWalletEntry(raw: unknown): WalletNamedWallet | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const providerId = normalizeProviderId(value.providerId);
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : "";
  if (!id || !name || !providerId || !createdAt || !updatedAt) {
    return null;
  }
  const addressesRaw =
    value.addresses && typeof value.addresses === "object" && !Array.isArray(value.addresses)
      ? (value.addresses as Record<string, unknown>)
      : null;
  const addresses = addressesRaw
    ? {
        solana:
          typeof addressesRaw.solana === "string"
            ? addressesRaw.solana.trim() || undefined
            : undefined,
        evm:
          typeof addressesRaw.evm === "string" ? addressesRaw.evm.trim() || undefined : undefined,
      }
    : undefined;
  return {
    id,
    name,
    providerId,
    addresses,
    metadata:
      value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
        ? (value.metadata as Record<string, unknown>)
        : undefined,
    createdAt,
    updatedAt,
  };
}

function makeDefaultRegistry(): WalletProviderRegistry {
  const ts = nowIso();
  return {
    version: 1,
    providers: {
      "embedded-keystore": {
        enabled: false,
        updatedAt: ts,
        label: "Legacy embedded keystore (migration required)",
      },
      "local-socket-signer": { enabled: true, updatedAt: ts, label: "Local signer" },
      alchemy: { enabled: false, updatedAt: ts },
      turnkey: { enabled: false, updatedAt: ts, label: "Turnkey (policy-managed)" },
      "wallet-standard": {
        enabled: true,
        updatedAt: ts,
        label: "Wallet Standard (verify hardware on device)",
      },
      privy: { enabled: false, updatedAt: ts, label: "Privy (integration unavailable)" },
    },
    wallets: [],
    assignments: {},
    updatedAt: ts,
  };
}

function normalizeRegistry(raw: unknown): { registry: WalletProviderRegistry; changed: boolean } {
  const defaults = makeDefaultRegistry();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { registry: defaults, changed: false };
  }
  let changed = false;
  const value = raw as Record<string, unknown>;
  const providersRaw =
    value.providers && typeof value.providers === "object" && !Array.isArray(value.providers)
      ? (value.providers as Record<string, unknown>)
      : {};
  const providers: Record<WalletProviderId, WalletProviderConfigEntry> = {
    "embedded-keystore": defaults.providers["embedded-keystore"],
    "local-socket-signer": defaults.providers["local-socket-signer"],
    alchemy: defaults.providers.alchemy,
    turnkey: defaults.providers.turnkey,
    "wallet-standard": defaults.providers["wallet-standard"]!,
    privy: defaults.providers.privy,
  };
  for (const providerId of WALLET_PROVIDER_REGISTRY_IDS) {
    const entryRaw = providersRaw[providerId];
    if (!entryRaw || typeof entryRaw !== "object" || Array.isArray(entryRaw)) {
      continue;
    }
    const entry = entryRaw as Record<string, unknown>;
    const enabled = Boolean(entry.enabled);
    let label = typeof entry.label === "string" ? entry.label.trim() || undefined : undefined;
    if (providerId === "embedded-keystore") {
      if (
        !label ||
        label === "Embedded keystore (default)" ||
        label === "Self-hosted wallet" ||
        label === "Self-hosted"
      ) {
        label = "Legacy embedded keystore (migration required)";
      }
    }
    if (providerId === "local-socket-signer") {
      if (!label || label === "Local signer daemon") {
        label = "Local signer";
      }
    }
    const updatedAt = typeof entry.updatedAt === "string" ? entry.updatedAt : defaults.updatedAt;
    providers[providerId] = { enabled, label, updatedAt };
  }
  const wallets = Array.isArray(value.wallets)
    ? value.wallets
        .map(normalizeWalletEntry)
        .filter((entry): entry is WalletNamedWallet => Boolean(entry))
    : [];
  if (wallets.some((wallet) => wallet.providerId === "local-socket-signer")) {
    const current = providers["local-socket-signer"];
    if (!current.enabled) {
      providers["local-socket-signer"] = {
        ...current,
        enabled: true,
        updatedAt: nowIso(),
      };
      changed = true;
    }
  }
  const assignmentsRaw =
    value.assignments && typeof value.assignments === "object" && !Array.isArray(value.assignments)
      ? (value.assignments as Record<string, unknown>)
      : {};
  const assignments: Record<string, string> = {};
  for (const [agentId, walletIdRaw] of Object.entries(assignmentsRaw)) {
    const normalizedAgentId = agentId.trim();
    const walletId = typeof walletIdRaw === "string" ? walletIdRaw.trim() : "";
    if (!normalizedAgentId || !walletId) {
      continue;
    }
    if (!wallets.some((wallet) => wallet.id === walletId)) {
      continue;
    }
    assignments[normalizedAgentId] = walletId;
  }
  const defaultWalletIdRaw =
    typeof value.defaultWalletId === "string" ? value.defaultWalletId.trim() : undefined;
  const defaultWalletId =
    defaultWalletIdRaw && wallets.some((wallet) => wallet.id === defaultWalletIdRaw)
      ? defaultWalletIdRaw
      : undefined;
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : defaults.updatedAt;
  return {
    changed,
    registry: {
      version: 1,
      providers,
      wallets,
      assignments,
      defaultWalletId,
      updatedAt,
    },
  };
}

export function readWalletProviderRegistry(
  env: NodeJS.ProcessEnv = process.env,
): WalletProviderRegistry {
  const file = registryPath(env);
  if (!fs.existsSync(file)) {
    return makeDefaultRegistry();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const normalized = normalizeRegistry(parsed);
    if (normalized.changed) {
      writeWalletProviderRegistry(normalized.registry, env);
    }
    return normalized.registry;
  } catch {
    return makeDefaultRegistry();
  }
}

export function writeWalletProviderRegistry(
  registry: WalletProviderRegistry,
  env: NodeJS.ProcessEnv = process.env,
) {
  const file = registryPath(env);
  const payload: WalletProviderRegistry = {
    ...registry,
    version: 1,
    updatedAt: nowIso(),
  };
  const fileMode = walletApplicationStateFileMode(env);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: fileMode,
  });
  try {
    fs.chmodSync(file, fileMode);
  } catch {
    // best effort
  }
}

export function setWalletProviderEnabled(params: {
  providerId: WalletProviderId;
  enabled: boolean;
  label?: string;
  env?: NodeJS.ProcessEnv;
}): WalletProviderRegistry {
  if (params.providerId === "embedded-keystore" && params.enabled) {
    throwLegacyEmbeddedKeystoreMigrationRequired("cannot enable retired wallet provider");
  }
  if (params.providerId === "privy" && params.enabled) {
    throw new Error(
      "Privy wallet creation and signing are unavailable; the provider stays disabled.",
    );
  }
  const env = params.env ?? process.env;
  const registry = readWalletProviderRegistry(env);
  registry.providers[params.providerId] = {
    enabled: Boolean(params.enabled),
    label: params.label?.trim() || undefined,
    updatedAt: nowIso(),
  };
  writeWalletProviderRegistry(registry, env);
  return registry;
}

export function setWalletProvidersEnabled(params: {
  enabledProviders: WalletProviderId[];
  env?: NodeJS.ProcessEnv;
}): WalletProviderRegistry {
  const env = params.env ?? process.env;
  const registry = readWalletProviderRegistry(env);
  const enabledSet = new Set<WalletProviderId>(params.enabledProviders);
  const now = nowIso();
  const legacy = registry.providers["embedded-keystore"];
  registry.providers["embedded-keystore"] = {
    ...legacy,
    enabled: false,
    label: "Legacy embedded keystore (migration required)",
    updatedAt: legacy.enabled ? now : legacy.updatedAt,
  };
  const unavailablePrivy = registry.providers.privy;
  registry.providers.privy = {
    ...unavailablePrivy,
    enabled: false,
    label: "Privy (integration unavailable)",
    updatedAt: unavailablePrivy.enabled ? now : unavailablePrivy.updatedAt,
  };
  for (const providerId of WALLET_PROVIDER_IDS) {
    const current = registry.providers[providerId] ?? {
      enabled: false,
      updatedAt: now,
    };
    const nextEnabled = enabledSet.has(providerId);
    registry.providers[providerId] = {
      ...current,
      enabled: nextEnabled,
      updatedAt: current.enabled === nextEnabled ? current.updatedAt : now,
    };
  }
  writeWalletProviderRegistry(registry, env);
  return registry;
}

export function upsertNamedWallet(params: {
  walletId?: string;
  name: string;
  providerId: WalletProviderId;
  addresses?: { solana?: string; evm?: string };
  metadata?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}): WalletNamedWallet {
  if (params.providerId === "embedded-keystore") {
    throwLegacyEmbeddedKeystoreMigrationRequired("cannot register a new legacy wallet");
  }
  if (params.providerId === "privy") {
    throw new Error("Privy wallet creation and signing are unavailable; no wallet was registered.");
  }
  const env = params.env ?? process.env;
  const registry = readWalletProviderRegistry(env);
  const name = params.name.trim();
  const providedWalletId = params.walletId?.trim();
  if (!name) {
    throw new Error("wallet name is required");
  }
  if (providedWalletId && !/^[a-zA-Z0-9_-]+$/.test(providedWalletId)) {
    throw new Error("walletId must contain only letters, numbers, hyphens, or underscores");
  }
  const existing = providedWalletId
    ? registry.wallets.find((entry) => entry.id === providedWalletId)
    : undefined;
  const now = nowIso();
  const next: WalletNamedWallet = {
    id: existing?.id ?? providedWalletId ?? newWalletId(),
    name,
    providerId: params.providerId,
    addresses: params.addresses ?? existing?.addresses,
    metadata: params.metadata ?? existing?.metadata,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  registry.wallets = [...registry.wallets.filter((entry) => entry.id !== next.id), next].toSorted(
    (a, b) => a.createdAt.localeCompare(b.createdAt),
  );
  writeWalletProviderRegistry(registry, env);
  return next;
}

export function deleteNamedWallet(params: {
  walletId: string;
  protectedWalletIds?: string[];
  env?: NodeJS.ProcessEnv;
}): {
  removed: boolean;
  registry: WalletProviderRegistry;
} {
  const env = params.env ?? process.env;
  const registry = readWalletProviderRegistry(env);
  const walletId = params.walletId.trim();
  const protectedWalletIds = new Set(
    (params.protectedWalletIds ?? []).map((value) => value.trim()).filter(Boolean),
  );
  if (protectedWalletIds.has(walletId)) {
    throw new Error("walletId is protected from deletion");
  }
  const before = registry.wallets.length;
  registry.wallets = registry.wallets.filter((entry) => entry.id !== walletId);
  for (const [agentId, assignedWalletId] of Object.entries(registry.assignments)) {
    if (assignedWalletId === walletId) {
      delete registry.assignments[agentId];
    }
  }
  if (registry.defaultWalletId === walletId) {
    registry.defaultWalletId = undefined;
  }
  const removed = registry.wallets.length !== before;
  writeWalletProviderRegistry(registry, env);
  return { removed, registry };
}

export function setAgentWalletAssignment(params: {
  agentId: string;
  walletId?: string;
  env?: NodeJS.ProcessEnv;
}): WalletProviderRegistry {
  const env = params.env ?? process.env;
  const registry = readWalletProviderRegistry(env);
  const agentId = params.agentId.trim();
  if (!agentId) {
    throw new Error("agentId is required");
  }
  const walletId = params.walletId?.trim();
  if (!walletId) {
    delete registry.assignments[agentId];
    writeWalletProviderRegistry(registry, env);
    return registry;
  }
  const wallet = registry.wallets.find((entry) => entry.id === walletId);
  if (!wallet) {
    throw new Error("walletId does not exist");
  }
  if (resolveWalletUserRole(wallet) !== "agent") {
    throw new Error("only Agent wallets can be assigned to an Agent");
  }
  registry.assignments[agentId] = walletId;
  writeWalletProviderRegistry(registry, env);
  return registry;
}

export function setDefaultWallet(params: {
  walletId?: string;
  env?: NodeJS.ProcessEnv;
}): WalletProviderRegistry {
  const env = params.env ?? process.env;
  const registry = readWalletProviderRegistry(env);
  const walletId = params.walletId?.trim();
  if (!walletId) {
    registry.defaultWalletId = undefined;
    writeWalletProviderRegistry(registry, env);
    return registry;
  }
  const targetWallet = registry.wallets.find((wallet) => wallet.id === walletId);
  if (!targetWallet) {
    throw new Error("walletId does not exist");
  }
  const purpose = resolveWalletUserRole(targetWallet);
  if (purpose !== "agent") {
    throw new Error("only an explicit Agent wallet can become the Default Agent wallet fallback");
  }
  registry.defaultWalletId = walletId;
  writeWalletProviderRegistry(registry, env);
  return registry;
}

export function resolveWalletSelectionForAgent(params: {
  agentId?: string;
  skillWalletId?: string;
  env?: NodeJS.ProcessEnv;
}): {
  walletId?: string;
  providerId?: WalletProviderId;
  walletName?: string;
  source?: "skill" | "agent" | "default";
} {
  const env = params.env ?? process.env;
  const registry = readWalletProviderRegistry(env);
  const directAgent = params.agentId?.trim();
  const directWalletId = directAgent ? registry.assignments[directAgent] : undefined;
  const skillWalletId = params.skillWalletId?.trim();
  const walletId = skillWalletId ?? directWalletId ?? registry.defaultWalletId;
  if (!walletId) {
    return {};
  }
  const wallet = registry.wallets.find((entry) => entry.id === walletId);
  if (!wallet) {
    return {};
  }
  return {
    walletId: wallet.id,
    walletName: wallet.name,
    providerId: wallet.providerId,
    source: skillWalletId ? "skill" : directWalletId ? "agent" : "default",
  };
}

export type WalletResolvedSelection = {
  walletId?: string;
  walletName?: string;
  providerId?: WalletProviderId;
  source: "explicit" | "skill" | "agent" | "default" | "fallback" | "none";
};

export function resolveWalletSelection(params: {
  walletId?: string;
  walletName?: string;
  providerId?: WalletProviderId;
  agentId?: string;
  skillWalletId?: string;
  env?: NodeJS.ProcessEnv;
}): WalletResolvedSelection {
  const env = params.env ?? process.env;
  const registry = readWalletProviderRegistry(env);
  const walletId = params.walletId?.trim();
  const walletName = params.walletName?.trim();
  const providerId = params.providerId;

  if (walletId || walletName || providerId) {
    let matchedWallet: WalletNamedWallet | undefined;

    if (walletId) {
      matchedWallet = registry.wallets.find((entry) => entry.id === walletId);
      if (!matchedWallet) {
        throw new Error(`walletId not found: ${walletId}`);
      }
    }

    if (walletName) {
      const normalizedName = walletName.toLowerCase();
      const byName = registry.wallets.filter(
        (entry) => entry.name.toLowerCase() === normalizedName,
      );
      if (!byName.length) {
        throw new Error(`walletName not found: ${walletName}`);
      }
      if (matchedWallet) {
        const matchedWalletId = matchedWallet.id;
        const same = byName.find((entry) => entry.id === matchedWalletId);
        if (!same) {
          throw new Error("walletId and walletName do not refer to the same wallet");
        }
      } else if (providerId) {
        const byProvider = byName.filter((entry) => entry.providerId === providerId);
        if (!byProvider.length) {
          throw new Error(`walletName ${walletName} is not available for provider ${providerId}`);
        }
        if (byProvider.length > 1) {
          throw new Error(
            `walletName ${walletName} is ambiguous for provider ${providerId}; use walletId`,
          );
        }
        matchedWallet = byProvider[0];
      } else if (byName.length > 1) {
        throw new Error(`walletName ${walletName} is ambiguous; include providerId or walletId`);
      } else {
        matchedWallet = byName[0];
      }
    }

    if (matchedWallet && providerId && matchedWallet.providerId !== providerId) {
      throw new Error(
        `wallet ${matchedWallet.name} (${matchedWallet.id}) belongs to provider ${matchedWallet.providerId}, not ${providerId}`,
      );
    }

    if (matchedWallet) {
      return {
        walletId: matchedWallet.id,
        walletName: matchedWallet.name,
        providerId: matchedWallet.providerId,
        source: "explicit",
      };
    }

    return {
      providerId,
      source: "explicit",
    };
  }

  const fallback = resolveWalletSelectionForAgent({
    agentId: params.agentId,
    skillWalletId: params.skillWalletId,
    env,
  });
  if (fallback.walletId || fallback.providerId) {
    return {
      ...fallback,
      source: fallback.source ?? "fallback",
    };
  }
  return { source: "none" };
}
