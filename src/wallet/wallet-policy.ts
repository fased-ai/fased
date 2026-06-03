import fs from "node:fs";
import path from "node:path";
import type { FasedAgentConfig } from "../config/config.js";
import { tryResolveSatRuntimeIds } from "../config/sat-runtime-ids.js";
import { assertValidSolanaAddress } from "./solana-address.js";
import { readWalletProviderRegistry, resolveWalletUserRole } from "./wallet-provider-registry.js";
import {
  ensureWalletStateDir,
  resolveWalletRuntimeConfig,
  type ResolvedWalletRuntimeConfig,
} from "./wallet-runtime-config.js";

export type WalletRolePolicyProfile = {
  role: "mining" | "agent" | "vault";
  label: "Mining" | "Agent" | "Vault";
  summary: string;
  defaults: {
    capsEnabled: boolean;
    directSigning: boolean;
    skillsEnabled: boolean;
    solana: {
      maxPerTx: string;
      maxDaily: string;
      allowPrograms: string[];
    };
  };
};

export type WalletPolicyPresetId =
  | "recommended"
  | "read-only"
  | "manual-only"
  | "small-agent-spend"
  | "mining-only"
  | "skill-limited"
  | "trading-experimental";

export type WalletScopedPolicyPatch = {
  template?: WalletPolicyPresetId;
  capsEnabled?: boolean;
  directSigning?: boolean;
  skillsEnabled?: boolean;
  solanaAllowPrograms?: string[];
  solanaMaxPerTx?: string;
  solanaMaxDaily?: string;
  solanaTokenCaps?: Record<string, { maxPerTx?: string; maxDaily?: string }>;
  recurringTransfer?: WalletRecurringTransferPolicyPatch | null;
};

export type WalletRecurringTransferPolicy = {
  enabled: boolean;
  chain: "solana";
  to: string;
  program?: string;
  amountMode: "fixed" | "percentage";
  amount?: string;
  percentage?: number;
  minAmount?: string;
  keepAmount?: string;
  schedule?: Record<string, unknown>;
  name?: string;
  updatedAt: string;
};

export type WalletRecurringTransferPolicyPatch = {
  enabled?: boolean;
  chain?: "solana";
  to?: string;
  program?: string;
  amountMode?: "fixed" | "percentage";
  amount?: string;
  percentage?: number;
  minAmount?: string;
  keepAmount?: string;
  schedule?: Record<string, unknown>;
  name?: string;
};

type WalletUsageBucket = {
  solanaSpent: string;
  solanaTokenSpent: Record<string, string>;
};

type WalletUsageLedgerV1 = {
  version: 1;
  date: string;
  solanaSpent: string;
};

type WalletUsageLedger = {
  version: 2;
  date: string;
  wallets: Record<string, WalletUsageBucket>;
};

type StoredWalletPolicyRecord = {
  version: 1;
  walletId: string;
  role: "mining" | "agent" | "vault";
  updatedAt: string;
  capsEnabled?: boolean;
  skillsEnabled?: boolean;
  directSigning: boolean;
  solana: {
    allowPrograms: string[];
    tokenCaps?: Record<string, { maxPerTx?: string; maxDaily?: string }>;
    maxPerTx: string;
    maxDaily: string;
  };
  recurringTransfer?: WalletRecurringTransferPolicy;
};

type WalletPolicyState = {
  version: 1;
  updatedAt: string;
  wallets: Record<string, StoredWalletPolicyRecord>;
};

const SOLANA_SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const SOLANA_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOLANA_TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const DEFAULT_POLICY_CAPS = {
  solana: {
    maxPerTx: "1000000000",
    maxDaily: "5000000000",
  },
} as const;
const WALLET_POLICY_STATE_FILENAME = "wallet-policy-state.v1.json";
const LEDGER_LEGACY_GLOBAL_BUCKET_ID = "__legacy_global__";
const DEFAULT_EFFECTIVE_WALLET_ID = "__default__";

function currentDateKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function nowIso(): string {
  return new Date().toISOString();
}

function resolveWalletPolicyStatePath(paths: ReturnType<typeof ensureWalletStateDir>): string {
  return path.join(paths.rootDir, WALLET_POLICY_STATE_FILENAME);
}

function defaultWalletUsageBucket(): WalletUsageBucket {
  return {
    solanaSpent: "0",
    solanaTokenSpent: {},
  };
}

function defaultWalletUsageLedger(): WalletUsageLedger {
  return {
    version: 2,
    date: currentDateKey(),
    wallets: {},
  };
}

function normalizeWalletUsageBucket(raw: unknown): WalletUsageBucket | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  return {
    solanaSpent: typeof value.solanaSpent === "string" ? value.solanaSpent : "0",
    solanaTokenSpent:
      value.solanaTokenSpent && typeof value.solanaTokenSpent === "object"
        ? Object.fromEntries(
            Object.entries(value.solanaTokenSpent as Record<string, unknown>)
              .map(([mint, spent]) => [mint.trim(), typeof spent === "string" ? spent : "0"])
              .filter(([mint]) => Boolean(mint)),
          )
        : {},
  };
}

function loadLedger(paths: ReturnType<typeof ensureWalletStateDir>): WalletUsageLedger {
  const fallback = defaultWalletUsageLedger();
  if (!fs.existsSync(paths.dailyUsagePath)) {
    return fallback;
  }
  try {
    const raw = fs.readFileSync(paths.dailyUsagePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<WalletUsageLedger | WalletUsageLedgerV1>;
    if (parsed && parsed.version === 2 && typeof parsed.date === "string") {
      const walletsRaw =
        parsed.wallets && typeof parsed.wallets === "object" && !Array.isArray(parsed.wallets)
          ? (parsed.wallets as Record<string, unknown>)
          : {};
      const wallets: Record<string, WalletUsageBucket> = {};
      for (const [walletId, bucketRaw] of Object.entries(walletsRaw)) {
        const bucket = normalizeWalletUsageBucket(bucketRaw);
        if (!walletId.trim() || !bucket) {
          continue;
        }
        wallets[walletId.trim()] = bucket;
      }
      return {
        version: 2,
        date: parsed.date,
        wallets,
      };
    }
    if (parsed && parsed.version === 1) {
      return {
        version: 2,
        date: typeof parsed.date === "string" ? parsed.date : fallback.date,
        wallets: {
          [LEDGER_LEGACY_GLOBAL_BUCKET_ID]: {
            solanaSpent: typeof parsed.solanaSpent === "string" ? parsed.solanaSpent : "0",
            solanaTokenSpent: {},
          },
        },
      };
    }
  } catch {
    // ignore parse issues and reset ledger
  }
  return fallback;
}

function writeLedger(
  paths: ReturnType<typeof ensureWalletStateDir>,
  ledger: WalletUsageLedger,
): void {
  fs.writeFileSync(paths.dailyUsagePath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(paths.dailyUsagePath, 0o600);
  } catch {
    // best effort
  }
}

function resolveWalletUsageBucket(
  ledger: WalletUsageLedger,
  walletId: string | undefined,
): WalletUsageBucket {
  const normalizedWalletId = walletId?.trim() || DEFAULT_EFFECTIVE_WALLET_ID;
  const existing = ledger.wallets[normalizedWalletId];
  if (existing) {
    return existing;
  }
  const legacy = ledger.wallets[LEDGER_LEGACY_GLOBAL_BUCKET_ID];
  if (legacy) {
    ledger.wallets[normalizedWalletId] = legacy;
    delete ledger.wallets[LEDGER_LEGACY_GLOBAL_BUCKET_ID];
    return ledger.wallets[normalizedWalletId];
  }
  const bucket = defaultWalletUsageBucket();
  ledger.wallets[normalizedWalletId] = bucket;
  return bucket;
}

function readWalletUsageBucket(
  ledger: WalletUsageLedger,
  walletId: string | undefined,
): WalletUsageBucket {
  const normalizedWalletId = walletId?.trim() || DEFAULT_EFFECTIVE_WALLET_ID;
  return (
    ledger.wallets[normalizedWalletId] ??
    ledger.wallets[LEDGER_LEGACY_GLOBAL_BUCKET_ID] ??
    defaultWalletUsageBucket()
  );
}

function parseValue(raw: string | undefined): bigint {
  if (!raw) {
    return 0n;
  }
  const text = raw.trim();
  if (!text) {
    return 0n;
  }
  return BigInt(text);
}

function normalizeAddressList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function miningPolicyProgramAllowlist(env: NodeJS.ProcessEnv): string[] {
  const ids = tryResolveSatRuntimeIds(env);
  return normalizeAddressList([
    ids?.programId ?? "",
    ids?.mintAddress ?? "",
    SOLANA_SYSTEM_PROGRAM_ID,
    SOLANA_TOKEN_PROGRAM_ID,
    SOLANA_TOKEN_2022_PROGRAM_ID,
    SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID,
  ]);
}

function isWalletHandle(value: string): boolean {
  return /^@wallet:[a-zA-Z0-9_-]+$/.test(value.trim());
}

function normalizeNonNegativeRawAmount(value: string | undefined, fallback = "0"): string {
  const text = value?.trim() || fallback;
  const parsed = parseValue(text);
  if (parsed < 0n) {
    throw new Error("wallet recurring transfer amount must be non-negative");
  }
  return parsed.toString();
}

function isPositivePolicyAmount(raw: unknown): boolean {
  if (typeof raw !== "string") {
    return false;
  }
  try {
    return BigInt(raw.trim() || "0") > 0n;
  } catch {
    return false;
  }
}

function storedRecordHasPositiveCaps(value: Record<string, unknown>): boolean {
  const solanaRaw =
    value.solana && typeof value.solana === "object" && !Array.isArray(value.solana)
      ? (value.solana as Record<string, unknown>)
      : {};
  if (isPositivePolicyAmount(solanaRaw.maxPerTx) || isPositivePolicyAmount(solanaRaw.maxDaily)) {
    return true;
  }
  const tokenCaps =
    solanaRaw.tokenCaps &&
    typeof solanaRaw.tokenCaps === "object" &&
    !Array.isArray(solanaRaw.tokenCaps)
      ? (solanaRaw.tokenCaps as Record<string, unknown>)
      : {};
  return Object.values(tokenCaps).some((capRaw) => {
    const cap = capRaw && typeof capRaw === "object" ? (capRaw as Record<string, unknown>) : {};
    return isPositivePolicyAmount(cap.maxPerTx) || isPositivePolicyAmount(cap.maxDaily);
  });
}

function normalizeRecurringTransferDestination(value: string | undefined): string {
  const text = value?.trim() ?? "";
  if (!text) {
    return "";
  }
  if (isWalletHandle(text)) {
    return text;
  }
  assertValidSolanaAddress(text, "wallet recurring transfer destination");
  return text;
}

function normalizeRecurringTransferSchedule(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function normalizeRecurringTransferPolicy(raw: unknown): WalletRecurringTransferPolicy | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const to = normalizeRecurringTransferDestination(
    typeof value.to === "string" ? value.to : undefined,
  );
  const program = typeof value.program === "string" ? value.program.trim() : "";
  if (program) {
    assertValidSolanaAddress(program, "wallet recurring transfer mint");
  }
  const amountMode = value.amountMode === "percentage" ? "percentage" : "fixed";
  const percentage =
    typeof value.percentage === "number" && Number.isFinite(value.percentage)
      ? Math.max(1, Math.min(100, Math.floor(value.percentage)))
      : undefined;
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : nowIso();
  const schedule = normalizeRecurringTransferSchedule(value.schedule);
  return {
    enabled: value.enabled === true,
    chain: "solana",
    to,
    ...(program ? { program } : {}),
    amountMode,
    ...(amountMode === "fixed"
      ? {
          amount: normalizeNonNegativeRawAmount(
            typeof value.amount === "string" ? value.amount : undefined,
          ),
        }
      : {
          percentage: percentage ?? 100,
          minAmount: normalizeNonNegativeRawAmount(
            typeof value.minAmount === "string" ? value.minAmount : undefined,
          ),
          keepAmount: normalizeNonNegativeRawAmount(
            typeof value.keepAmount === "string" ? value.keepAmount : undefined,
          ),
        }),
    ...(schedule ? { schedule } : {}),
    ...(typeof value.name === "string" && value.name.trim() ? { name: value.name.trim() } : {}),
    updatedAt,
  };
}

function buildRecurringTransferPolicyFromPatch(params: {
  existing?: WalletRecurringTransferPolicy;
  patch: WalletRecurringTransferPolicyPatch;
  role: "mining" | "agent" | "vault";
}): WalletRecurringTransferPolicy {
  if (params.role !== "agent") {
    throw new Error("generic recurring transfer policy requires an Agent wallet");
  }
  const existing = params.existing;
  const enabled = params.patch.enabled ?? existing?.enabled ?? false;
  const to = normalizeRecurringTransferDestination(params.patch.to ?? existing?.to);
  const program =
    params.patch.program !== undefined ? params.patch.program.trim() : existing?.program;
  if (program) {
    assertValidSolanaAddress(program, "wallet recurring transfer mint");
  }
  const amountMode = params.patch.amountMode ?? existing?.amountMode ?? "fixed";
  const schedule =
    params.patch.schedule !== undefined
      ? normalizeRecurringTransferSchedule(params.patch.schedule)
      : existing?.schedule;
  if (enabled && !to) {
    throw new Error("wallet recurring transfer destination is required");
  }
  if (amountMode === "fixed") {
    const amount = normalizeNonNegativeRawAmount(params.patch.amount ?? existing?.amount);
    if (enabled && parseValue(amount) <= 0n) {
      throw new Error("wallet recurring transfer amount must be greater than zero");
    }
    return {
      enabled,
      chain: "solana",
      to,
      ...(program ? { program } : {}),
      amountMode,
      amount,
      ...(schedule ? { schedule } : {}),
      ...((params.patch.name ?? existing?.name)
        ? { name: (params.patch.name ?? existing?.name ?? "").trim() }
        : {}),
      updatedAt: nowIso(),
    };
  }
  const percentage =
    typeof params.patch.percentage === "number" && Number.isFinite(params.patch.percentage)
      ? Math.max(1, Math.min(100, Math.floor(params.patch.percentage)))
      : (existing?.percentage ?? 100);
  return {
    enabled,
    chain: "solana",
    to,
    ...(program ? { program } : {}),
    amountMode: "percentage",
    percentage,
    minAmount: normalizeNonNegativeRawAmount(params.patch.minAmount ?? existing?.minAmount),
    keepAmount: normalizeNonNegativeRawAmount(params.patch.keepAmount ?? existing?.keepAmount),
    ...(schedule ? { schedule } : {}),
    ...((params.patch.name ?? existing?.name)
      ? { name: (params.patch.name ?? existing?.name ?? "").trim() }
      : {}),
    updatedAt: nowIso(),
  };
}

function resolveConfiguredMiningWalletId(cfg: FasedAgentConfig | undefined): string | undefined {
  const value = cfg?.plugins?.entries?.["sat-mining"]?.config?.walletId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveEffectiveWalletId(params: {
  walletId?: string;
  cfg?: FasedAgentConfig;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const explicitWalletId = params.walletId?.trim();
  if (explicitWalletId) {
    return explicitWalletId;
  }
  const env = params.env ?? process.env;
  const registry = readWalletProviderRegistry(env);
  const configuredMiningWalletId = resolveConfiguredMiningWalletId(params.cfg);
  return (
    registry.defaultWalletId?.trim() ||
    configuredMiningWalletId ||
    registry.wallets.find((entry) => entry.providerId === "local-socket-signer")?.id ||
    registry.wallets[0]?.id ||
    undefined
  );
}

export function resolveWalletRoleForId(params: {
  walletId?: string;
  cfg?: FasedAgentConfig;
  env?: NodeJS.ProcessEnv;
}): "mining" | "agent" | "vault" {
  const env = params.env ?? process.env;
  const registry = readWalletProviderRegistry(env);
  const walletId = resolveEffectiveWalletId(params);
  const configuredMiningWalletId = resolveConfiguredMiningWalletId(params.cfg);
  if (walletId && configuredMiningWalletId && walletId === configuredMiningWalletId) {
    return "mining";
  }
  const registryWallet = walletId
    ? registry.wallets.find((entry) => entry.id === walletId)
    : undefined;
  const storedPurpose = resolveWalletUserRole(registryWallet);
  if (walletId && storedPurpose === "mining") {
    return "mining";
  }
  if (
    walletId &&
    ((registry.defaultWalletId && walletId === registry.defaultWalletId) ||
      storedPurpose === "agent")
  ) {
    return "agent";
  }
  return "vault";
}

function normalizeStoredWalletPolicyRecord(raw: unknown): StoredWalletPolicyRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const role =
    value.role === "mining" || value.role === "agent" || value.role === "vault" ? value.role : null;
  if (
    value.version !== 1 ||
    typeof value.walletId !== "string" ||
    !role ||
    typeof value.updatedAt !== "string" ||
    typeof value.directSigning !== "boolean"
  ) {
    return null;
  }
  const solanaRaw =
    value.solana && typeof value.solana === "object" && !Array.isArray(value.solana)
      ? (value.solana as Record<string, unknown>)
      : null;
  if (!solanaRaw) {
    return null;
  }
  const recurringTransfer = normalizeRecurringTransferPolicy(value.recurringTransfer);
  return {
    version: 1,
    walletId: value.walletId.trim(),
    role,
    updatedAt: value.updatedAt,
    capsEnabled:
      typeof value.capsEnabled === "boolean"
        ? value.capsEnabled
        : storedRecordHasPositiveCaps(value),
    skillsEnabled: value.skillsEnabled === true,
    directSigning: value.directSigning,
    solana: {
      allowPrograms: Array.isArray(solanaRaw.allowPrograms)
        ? normalizeAddressList(solanaRaw.allowPrograms.map((entry) => String(entry)))
        : [],
      tokenCaps:
        solanaRaw.tokenCaps && typeof solanaRaw.tokenCaps === "object"
          ? Object.fromEntries(
              Object.entries(solanaRaw.tokenCaps as Record<string, unknown>)
                .map(([mint, capRaw]) => {
                  const cap =
                    capRaw && typeof capRaw === "object" && !Array.isArray(capRaw)
                      ? (capRaw as Record<string, unknown>)
                      : {};
                  return [
                    mint.trim(),
                    {
                      maxPerTx: typeof cap.maxPerTx === "string" ? cap.maxPerTx.trim() : undefined,
                      maxDaily: typeof cap.maxDaily === "string" ? cap.maxDaily.trim() : undefined,
                    },
                  ] as const;
                })
                .filter(([mint]) => Boolean(mint)),
            )
          : {},
      maxPerTx: typeof solanaRaw.maxPerTx === "string" ? solanaRaw.maxPerTx : "0",
      maxDaily: typeof solanaRaw.maxDaily === "string" ? solanaRaw.maxDaily : "0",
    },
    ...(recurringTransfer ? { recurringTransfer } : {}),
  };
}

function readWalletPolicyState(env: NodeJS.ProcessEnv = process.env): WalletPolicyState {
  const paths = ensureWalletStateDir(env);
  const statePath = resolveWalletPolicyStatePath(paths);
  const fallback: WalletPolicyState = {
    version: 1,
    updatedAt: nowIso(),
    wallets: {},
  };
  if (!fs.existsSync(statePath)) {
    return fallback;
  }
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<WalletPolicyState>;
    if (parsed.version !== 1) {
      return fallback;
    }
    const walletsRaw =
      parsed.wallets && typeof parsed.wallets === "object" && !Array.isArray(parsed.wallets)
        ? (parsed.wallets as Record<string, unknown>)
        : {};
    const wallets: Record<string, StoredWalletPolicyRecord> = {};
    for (const [walletId, recordRaw] of Object.entries(walletsRaw)) {
      const record = normalizeStoredWalletPolicyRecord(recordRaw);
      if (!walletId.trim() || !record) {
        continue;
      }
      wallets[walletId.trim()] = record;
    }
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : fallback.updatedAt,
      wallets,
    };
  } catch {
    return fallback;
  }
}

function writeWalletPolicyState(
  state: WalletPolicyState,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const paths = ensureWalletStateDir(env);
  const statePath = resolveWalletPolicyStatePath(paths);
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(statePath, 0o600);
  } catch {
    // best effort
  }
}

function buildResolvedPolicyFromDefaults(
  defaults: WalletRolePolicyProfile["defaults"],
): ResolvedWalletRuntimeConfig["policy"] {
  return {
    capsEnabled: defaults.capsEnabled,
    directSigning: defaults.directSigning,
    skillsEnabled: defaults.skillsEnabled,
    solana: {
      allowPrograms: normalizeAddressList(defaults.solana.allowPrograms.map((value) => value)),
      caps: {
        maxPerTx: parseValue(defaults.solana.maxPerTx),
        maxDaily: parseValue(defaults.solana.maxDaily),
      },
      tokenCaps: {},
    },
  };
}

function buildResolvedPolicyFromPreset(params: {
  role: "mining" | "agent" | "vault";
  preset: WalletPolicyPresetId;
  env?: NodeJS.ProcessEnv;
}): ResolvedWalletRuntimeConfig["policy"] {
  const env = params.env ?? process.env;
  const recommended = buildResolvedPolicyFromDefaults(
    resolveWalletRolePolicyProfile(params.role, env).defaults,
  );
  switch (params.preset) {
    case "read-only":
      return {
        ...recommended,
        capsEnabled: true,
        directSigning: false,
        skillsEnabled: false,
        solana: {
          ...recommended.solana,
          caps: { maxPerTx: 0n, maxDaily: 0n },
          tokenCaps: {},
        },
      };
    case "manual-only":
      return {
        ...recommended,
        directSigning: false,
        skillsEnabled: false,
      };
    case "small-agent-spend":
      return {
        ...recommended,
        capsEnabled: true,
        directSigning: params.role === "agent",
        skillsEnabled: false,
        solana: {
          ...recommended.solana,
          caps: {
            maxPerTx: 100_000_000n,
            maxDaily: 500_000_000n,
          },
        },
      };
    case "mining-only":
      return {
        ...recommended,
        capsEnabled: false,
        directSigning: params.role === "mining",
        skillsEnabled: false,
        solana: {
          ...recommended.solana,
          allowPrograms: params.role === "mining" ? miningPolicyProgramAllowlist(env) : [],
          caps: { maxPerTx: 0n, maxDaily: 0n },
          tokenCaps: {},
        },
      };
    case "skill-limited":
      return {
        ...recommended,
        capsEnabled: true,
        directSigning: false,
        skillsEnabled: params.role === "agent",
        solana: {
          ...recommended.solana,
          caps: {
            maxPerTx: 50_000_000n,
            maxDaily: 250_000_000n,
          },
        },
      };
    case "trading-experimental":
      return {
        ...recommended,
        capsEnabled: true,
        directSigning: params.role === "agent",
        skillsEnabled: false,
        solana: {
          ...recommended.solana,
          caps: {
            maxPerTx: 250_000_000n,
            maxDaily: 1_000_000_000n,
          },
        },
      };
    case "recommended":
    default:
      return recommended;
  }
}

function normalizeTokenCapsRecord(
  raw: Record<string, { maxPerTx?: string; maxDaily?: string }> | undefined,
): ResolvedWalletRuntimeConfig["policy"]["solana"]["tokenCaps"] {
  const out: ResolvedWalletRuntimeConfig["policy"]["solana"]["tokenCaps"] = {};
  for (const [mintRaw, cap] of Object.entries(raw ?? {})) {
    const mint = mintRaw.trim();
    if (!mint) {
      continue;
    }
    out[mint] = {
      maxPerTx: parseValue(cap.maxPerTx),
      maxDaily: parseValue(cap.maxDaily),
    };
  }
  return out;
}

function buildResolvedPolicyFromStoredRecord(
  record: StoredWalletPolicyRecord,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedWalletRuntimeConfig["policy"] {
  const miningAllowPrograms =
    record.role === "mining"
      ? normalizeAddressList(
          resolveWalletRolePolicyProfile("mining", env).defaults.solana.allowPrograms,
        )
      : normalizeAddressList(record.solana.allowPrograms.map((value) => value));
  return {
    capsEnabled: record.capsEnabled === true,
    directSigning: record.role === "vault" ? false : record.directSigning,
    skillsEnabled: record.role === "agent" && record.skillsEnabled === true,
    solana: {
      allowPrograms: miningAllowPrograms,
      caps: {
        maxPerTx: parseValue(record.solana.maxPerTx),
        maxDaily: parseValue(record.solana.maxDaily),
      },
      tokenCaps: normalizeTokenCapsRecord(record.solana.tokenCaps),
    },
  };
}

function cloneWalletConfigWithPolicy(
  config: ResolvedWalletRuntimeConfig,
  policy: ResolvedWalletRuntimeConfig["policy"],
): ResolvedWalletRuntimeConfig {
  return {
    ...config,
    policy: {
      capsEnabled: policy.capsEnabled,
      directSigning: policy.directSigning,
      skillsEnabled: policy.skillsEnabled,
      solana: {
        allowPrograms: [...policy.solana.allowPrograms],
        caps: {
          maxPerTx: policy.solana.caps.maxPerTx,
          maxDaily: policy.solana.caps.maxDaily,
        },
        tokenCaps: Object.fromEntries(
          Object.entries(policy.solana.tokenCaps).map(([mint, cap]) => [
            mint,
            { maxPerTx: cap.maxPerTx, maxDaily: cap.maxDaily },
          ]),
        ),
      },
    },
  };
}

function buildStoredPolicyRecord(params: {
  walletId: string;
  role: "mining" | "agent" | "vault";
  policy: ResolvedWalletRuntimeConfig["policy"];
  recurringTransfer?: WalletRecurringTransferPolicy;
  updatedAt?: string;
}): StoredWalletPolicyRecord {
  return {
    version: 1,
    walletId: params.walletId,
    role: params.role,
    updatedAt: params.updatedAt ?? nowIso(),
    capsEnabled: params.policy.capsEnabled,
    skillsEnabled: params.policy.skillsEnabled,
    directSigning: params.policy.directSigning,
    solana: {
      allowPrograms: normalizeAddressList(params.policy.solana.allowPrograms.map((value) => value)),
      tokenCaps: Object.fromEntries(
        Object.entries(params.policy.solana.tokenCaps).map(([mint, cap]) => [
          mint,
          { maxPerTx: cap.maxPerTx.toString(), maxDaily: cap.maxDaily.toString() },
        ]),
      ),
      maxPerTx: params.policy.solana.caps.maxPerTx.toString(),
      maxDaily: params.policy.solana.caps.maxDaily.toString(),
    },
    ...(params.recurringTransfer ? { recurringTransfer: params.recurringTransfer } : {}),
  };
}

export function applyWalletPolicyConfig(params: {
  config: ResolvedWalletRuntimeConfig;
  cfg?: FasedAgentConfig;
  env?: NodeJS.ProcessEnv;
  walletId?: string;
}): ResolvedWalletRuntimeConfig {
  const env = params.env ?? process.env;
  const effectiveWalletId = resolveEffectiveWalletId({
    walletId: params.walletId,
    cfg: params.cfg,
    env,
  });
  if (!effectiveWalletId) {
    return params.config;
  }
  const state = readWalletPolicyState(env);
  const override = state.wallets[effectiveWalletId];
  if (override) {
    return cloneWalletConfigWithPolicy(
      params.config,
      buildResolvedPolicyFromStoredRecord(override, env),
    );
  }
  const role = resolveWalletRoleForId({
    walletId: effectiveWalletId,
    cfg: params.cfg,
    env,
  });
  if (role === "agent") {
    return params.config;
  }
  const profile = resolveWalletRolePolicyProfile(role, env);
  return cloneWalletConfigWithPolicy(
    params.config,
    buildResolvedPolicyFromDefaults(profile.defaults),
  );
}

export function upsertWalletPolicyConfig(params: {
  cfg: FasedAgentConfig;
  env?: NodeJS.ProcessEnv;
  walletId: string;
  patch: WalletScopedPolicyPatch;
}): {
  walletId: string;
  role: "mining" | "agent" | "vault";
  config: ResolvedWalletRuntimeConfig;
} {
  const env = params.env ?? process.env;
  const walletId = params.walletId.trim();
  if (!walletId) {
    throw new Error("walletId is required for wallet-scoped policy updates");
  }
  const role = resolveWalletRoleForId({
    walletId,
    cfg: params.cfg,
    env,
  });
  const base = applyWalletPolicyConfig({
    config: resolveWalletRuntimeConfig(params.cfg, env),
    cfg: params.cfg,
    env,
    walletId,
  });
  const state = readWalletPolicyState(env);
  const existingRecord = state.wallets[walletId];
  if (role === "vault" && params.patch.directSigning === true) {
    throw new Error("Vault wallets are manual-only; automation cannot be enabled");
  }
  if (role !== "agent" && params.patch.skillsEnabled === true) {
    throw new Error("Skill wallet access can only be enabled for Agent wallets");
  }
  if (role !== "agent" && params.patch.recurringTransfer !== undefined) {
    throw new Error("generic recurring transfer policy requires an Agent wallet");
  }
  const nextPolicy: ResolvedWalletRuntimeConfig["policy"] = {
    ...(params.patch.template
      ? buildResolvedPolicyFromPreset({ role, preset: params.patch.template, env })
      : {
          directSigning:
            typeof params.patch.directSigning === "boolean"
              ? params.patch.directSigning
              : base.policy.directSigning,
          capsEnabled:
            typeof params.patch.capsEnabled === "boolean"
              ? params.patch.capsEnabled
              : base.policy.capsEnabled,
          skillsEnabled:
            role === "agent" && typeof params.patch.skillsEnabled === "boolean"
              ? params.patch.skillsEnabled
              : base.policy.skillsEnabled,
          solana: {
            allowPrograms:
              params.patch.solanaAllowPrograms !== undefined
                ? normalizeAddressList(params.patch.solanaAllowPrograms.map((value) => value))
                : [...base.policy.solana.allowPrograms],
            caps: {
              maxPerTx:
                params.patch.solanaMaxPerTx !== undefined
                  ? parseValue(params.patch.solanaMaxPerTx)
                  : base.policy.solana.caps.maxPerTx,
              maxDaily:
                params.patch.solanaMaxDaily !== undefined
                  ? parseValue(params.patch.solanaMaxDaily)
                  : base.policy.solana.caps.maxDaily,
            },
            tokenCaps:
              params.patch.solanaTokenCaps !== undefined
                ? normalizeTokenCapsRecord(params.patch.solanaTokenCaps)
                : { ...base.policy.solana.tokenCaps },
          },
        }),
  };
  const recurringTransfer =
    role !== "agent" || params.patch.recurringTransfer === null
      ? undefined
      : params.patch.recurringTransfer !== undefined
        ? buildRecurringTransferPolicyFromPatch({
            existing: existingRecord?.recurringTransfer,
            patch: params.patch.recurringTransfer,
            role,
          })
        : existingRecord?.recurringTransfer;
  state.wallets[walletId] = buildStoredPolicyRecord({
    walletId,
    role,
    policy: nextPolicy,
    recurringTransfer,
  });
  state.updatedAt = nowIso();
  writeWalletPolicyState(state, env);
  return {
    walletId,
    role,
    config: cloneWalletConfigWithPolicy(base, nextPolicy),
  };
}

export function resolveWalletRolePolicyProfile(
  role: "mining" | "agent" | "vault",
  env: NodeJS.ProcessEnv = process.env,
): WalletRolePolicyProfile {
  switch (role) {
    case "mining":
      return {
        role,
        label: "Mining",
        summary:
          "SAT mining wallet. It is reserved for mining operations and SAT sweep, not generic agent payments or federation bond.",
        defaults: {
          capsEnabled: false,
          directSigning: true,
          skillsEnabled: false,
          solana: {
            maxPerTx: "0",
            maxDaily: "0",
            allowPrograms: miningPolicyProgramAllowlist(env),
          },
        },
      };
    case "agent":
      return {
        role,
        label: "Agent",
        summary:
          "Hot Agent wallet for reviewed payments, Fased Network payment evidence, and approved skill actions. Keep explicit caps and narrow token / contract routes.",
        defaults: {
          capsEnabled: false,
          directSigning: true,
          skillsEnabled: false,
          solana: {
            maxPerTx: DEFAULT_POLICY_CAPS.solana.maxPerTx,
            maxDaily: DEFAULT_POLICY_CAPS.solana.maxDaily,
            allowPrograms: [],
          },
        },
      };
    case "vault":
    default:
      return {
        role: "vault",
        label: "Vault",
        summary:
          "Manual-first Vault wallet for storage and federation bond assignment. No background agent execution by default; use split-key/passkey lock for custody.",
        defaults: {
          capsEnabled: false,
          directSigning: false,
          skillsEnabled: false,
          solana: {
            maxPerTx: DEFAULT_POLICY_CAPS.solana.maxPerTx,
            maxDaily: DEFAULT_POLICY_CAPS.solana.maxDaily,
            allowPrograms: [],
          },
        },
      };
  }
}

export function isWalletToolAllowed(params: {
  config: ResolvedWalletRuntimeConfig;
  requesterAgentId: string | null;
  ownerAgentId: string;
  requesterSkillId?: string | null;
  requestSource?: string | null;
}): { ok: boolean; code?: string } {
  const allowSkills = params.config.toolAccess.allowSkills
    .map((value) => value.trim())
    .filter(Boolean);
  const skillId = params.requesterSkillId?.trim() || null;
  if (!skillId && allowSkills.length > 0) {
    return { ok: false, code: "wallet_tool_skill_context_required" };
  }
  if (skillId) {
    const denySkills = new Set(params.config.toolAccess.denySkills.map((value) => value.trim()));
    if (denySkills.has(skillId)) {
      return { ok: false, code: "wallet_tool_skill_denied" };
    }
    if (allowSkills.length > 0 && !allowSkills.includes(skillId)) {
      return { ok: false, code: "wallet_tool_skill_not_allowlisted" };
    }
  }
  const allowSources = params.config.toolAccess.allowSources
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const source = params.requestSource?.trim().toLowerCase() || null;
  if (!source && allowSources.length > 0) {
    return { ok: false, code: "wallet_tool_source_context_required" };
  }
  if (source) {
    if (allowSources.length > 0 && !allowSources.includes(source)) {
      return { ok: false, code: "wallet_tool_source_not_allowlisted" };
    }
  }
  const mode = params.config.toolAccess.mode;
  if (mode === "all") {
    return { ok: true };
  }
  if (mode === "owner-only") {
    return params.requesterAgentId === params.ownerAgentId
      ? { ok: true }
      : { ok: false, code: "wallet_tool_owner_only" };
  }
  const allow = new Set(params.config.toolAccess.allowAgents.map((value) => value.trim()));
  return params.requesterAgentId && allow.has(params.requesterAgentId)
    ? { ok: true }
    : { ok: false, code: "wallet_tool_not_allowlisted" };
}

export function validateWalletTxPolicy(params: {
  config: ResolvedWalletRuntimeConfig;
  action: "prepare" | "send";
  requireDirectSigning?: boolean;
  chain: "solana";
  amount?: string;
  contract?: string;
  program?: string;
  skipNativeSolanaCaps?: boolean;
  requireSolanaTokenCap?: boolean;
}): { ok: boolean; code?: string; message?: string } {
  if (!params.config.chains.includes(params.chain)) {
    return { ok: false, code: "wallet_chain_disabled", message: `${params.chain} not enabled` };
  }
  const requireDirectSigning = params.requireDirectSigning ?? params.action === "send";
  if (requireDirectSigning && !params.config.policy.directSigning) {
    return {
      ok: false,
      code: "wallet_direct_signing_disabled",
      message: "automated execution disabled by wallet policy",
    };
  }
  const amount = parseValue(params.amount);
  if (amount < 0n) {
    return {
      ok: false,
      code: "wallet_invalid_amount",
      message: "amount must be non-negative",
    };
  }
  const capsEnabled = params.config.policy.capsEnabled;

  const allowPrograms = params.config.policy.solana.allowPrograms;
  if (params.program && allowPrograms.length > 0) {
    const normalized = params.program.trim();
    const allowed = allowPrograms.includes(normalized);
    if (!allowed) {
      return {
        ok: false,
        code: "wallet_program_not_allowed",
        message: "program is not in allowlist",
      };
    }
  }
  const nativeSolanaSend = !String(params.program ?? "").trim();
  if (!capsEnabled) {
    return { ok: true };
  }
  if (!nativeSolanaSend) {
    const mint = String(params.program ?? "").trim();
    const cap = (params.config.policy.solana.tokenCaps ?? {})[mint];
    if (!cap) {
      if (params.requireSolanaTokenCap) {
        return {
          ok: false,
          code: "wallet_token_cap_required",
          message: "SPL token spend requires an explicit per-mint token cap",
        };
      }
      return { ok: true };
    }
    if (amount > cap.maxPerTx) {
      return {
        ok: false,
        code: "wallet_token_cap_per_tx_exceeded",
        message: "SPL token per-transaction cap exceeded",
      };
    }
    return { ok: true };
  }
  if (
    nativeSolanaSend &&
    !params.skipNativeSolanaCaps &&
    amount > params.config.policy.solana.caps.maxPerTx
  ) {
    return {
      ok: false,
      code: "wallet_cap_per_tx_exceeded",
      message: "Solana per-transaction cap exceeded",
    };
  }
  return { ok: true };
}

export function enforceWalletDailyCap(params: {
  config: ResolvedWalletRuntimeConfig;
  chain: "solana";
  amount?: string;
  program?: string;
  tokenMint?: string;
  walletId?: string;
  env?: NodeJS.ProcessEnv;
  skipNativeSolanaCaps?: boolean;
}): { ok: boolean; code?: string; message?: string; spentToday?: string; limit?: string } {
  const preview = checkWalletDailyCap(params);
  if (!preview.ok || !params.config.policy.capsEnabled) {
    return preview;
  }
  const amount = parseValue(params.amount);
  const paths = ensureWalletStateDir(params.env ?? process.env);
  const ledger = loadLedger(paths);
  const today = currentDateKey();
  if (ledger.date !== today) {
    ledger.date = today;
    ledger.wallets = {};
  }
  const bucket = resolveWalletUsageBucket(ledger, params.walletId);

  const tokenMint = String(params.tokenMint ?? params.program ?? "").trim();
  const nativeSolanaSend = !tokenMint;
  if (!nativeSolanaSend || params.skipNativeSolanaCaps) {
    if (!tokenMint || params.skipNativeSolanaCaps) {
      return { ok: true };
    }
    const cap = (params.config.policy.solana.tokenCaps ?? {})[tokenMint];
    if (!cap || cap.maxDaily <= 0n) {
      return { ok: true };
    }
    const spent = parseValue(bucket.solanaTokenSpent[tokenMint]);
    const next = spent + amount;
    if (next > cap.maxDaily) {
      return {
        ok: false,
        code: "wallet_token_cap_daily_exceeded",
        message: "SPL token daily cap exceeded",
        spentToday: spent.toString(),
        limit: cap.maxDaily.toString(),
      };
    }
    bucket.solanaTokenSpent[tokenMint] = next.toString();
    writeLedger(paths, ledger);
    return {
      ok: true,
      spentToday: bucket.solanaTokenSpent[tokenMint],
      limit: cap.maxDaily.toString(),
    };
  }

  const spent = parseValue(bucket.solanaSpent);
  const limit = params.config.policy.solana.caps.maxDaily;
  const next = spent + amount;
  if (next > limit) {
    return {
      ok: false,
      code: "wallet_cap_daily_exceeded",
      message: "Solana daily cap exceeded",
      spentToday: spent.toString(),
      limit: limit.toString(),
    };
  }
  bucket.solanaSpent = next.toString();
  writeLedger(paths, ledger);
  return { ok: true, spentToday: bucket.solanaSpent, limit: limit.toString() };
}

export function checkWalletDailyCap(params: {
  config: ResolvedWalletRuntimeConfig;
  chain: "solana";
  amount?: string;
  program?: string;
  tokenMint?: string;
  walletId?: string;
  env?: NodeJS.ProcessEnv;
  skipNativeSolanaCaps?: boolean;
}): { ok: boolean; code?: string; message?: string; spentToday?: string; limit?: string } {
  const amount = parseValue(params.amount);
  if (!params.config.policy.capsEnabled) {
    return { ok: true };
  }
  const paths = ensureWalletStateDir(params.env ?? process.env);
  const ledger = loadLedger(paths);
  const today = currentDateKey();
  const bucket =
    ledger.date === today
      ? readWalletUsageBucket(ledger, params.walletId)
      : defaultWalletUsageBucket();

  const tokenMint = String(params.tokenMint ?? params.program ?? "").trim();
  const nativeSolanaSend = !tokenMint;
  if (!nativeSolanaSend || params.skipNativeSolanaCaps) {
    if (!tokenMint || params.skipNativeSolanaCaps) {
      return { ok: true };
    }
    const cap = (params.config.policy.solana.tokenCaps ?? {})[tokenMint];
    if (!cap || cap.maxDaily <= 0n) {
      return { ok: true };
    }
    const spent = parseValue(bucket.solanaTokenSpent[tokenMint]);
    const next = spent + amount;
    if (next > cap.maxDaily) {
      return {
        ok: false,
        code: "wallet_token_cap_daily_exceeded",
        message: "SPL token daily cap exceeded",
        spentToday: spent.toString(),
        limit: cap.maxDaily.toString(),
      };
    }
    return {
      ok: true,
      spentToday: next.toString(),
      limit: cap.maxDaily.toString(),
    };
  }

  const spent = parseValue(bucket.solanaSpent);
  const limit = params.config.policy.solana.caps.maxDaily;
  const next = spent + amount;
  if (next > limit) {
    return {
      ok: false,
      code: "wallet_cap_daily_exceeded",
      message: "Solana daily cap exceeded",
      spentToday: spent.toString(),
      limit: limit.toString(),
    };
  }
  return { ok: true, spentToday: next.toString(), limit: limit.toString() };
}

export function resolveWalletPolicyConfig(
  cfg: FasedAgentConfig,
  env: NodeJS.ProcessEnv = process.env,
  walletId?: string,
): ResolvedWalletRuntimeConfig {
  return applyWalletPolicyConfig({
    config: resolveWalletRuntimeConfig(cfg, env),
    cfg,
    env,
    walletId,
  });
}

export function resolveWalletRecurringTransferPolicy(params: {
  cfg: FasedAgentConfig;
  env?: NodeJS.ProcessEnv;
  walletId?: string;
}): WalletRecurringTransferPolicy | null {
  const env = params.env ?? process.env;
  const walletId = resolveEffectiveWalletId({
    walletId: params.walletId,
    cfg: params.cfg,
    env,
  });
  if (!walletId) {
    return null;
  }
  const role = resolveWalletRoleForId({ walletId, cfg: params.cfg, env });
  if (role !== "agent") {
    return null;
  }
  return readWalletPolicyState(env).wallets[walletId]?.recurringTransfer ?? null;
}
