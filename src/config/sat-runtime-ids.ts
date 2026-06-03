import fs from "node:fs";
import path from "node:path";

export const SAT_RUNTIME_ENV_KEYS = {
  programId: "FASED_SAT_PROGRAM_ID",
  bondProgramId: "FASED_SAT_BOND_PROGRAM_ID",
  mintAddress: "FASED_SAT_MINT_ADDRESS",
  mintProgramId: "FASED_SAT_MINT_PROGRAM_ID",
} as const;

export type SatRuntimeIds = {
  programId: string;
  bondProgramId: string;
  mintAddress: string;
  mintProgramId: string;
};

const MISSING_SAT_RUNTIME_IDS_MESSAGE =
  "SAT runtime IDs are not configured. Use Mining Sync after mainnet launch or set the complete SAT runtime env tuple for an explicit test network.";

function readExplicitSatRuntimeIds(env: NodeJS.ProcessEnv): SatRuntimeIds | null {
  const programId = String(env[SAT_RUNTIME_ENV_KEYS.programId] ?? "").trim();
  const bondProgramId = String(env[SAT_RUNTIME_ENV_KEYS.bondProgramId] ?? "").trim();
  const mintAddress = String(env[SAT_RUNTIME_ENV_KEYS.mintAddress] ?? "").trim();
  const mintProgramId = String(env[SAT_RUNTIME_ENV_KEYS.mintProgramId] ?? "").trim();
  if (!programId || !bondProgramId || !mintAddress || !mintProgramId) {
    return null;
  }
  return {
    programId,
    bondProgramId,
    mintAddress,
    mintProgramId,
  };
}

function parseEnvFile(raw: string): Partial<SatRuntimeIds> {
  const values: Partial<SatRuntimeIds> = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    switch (key) {
      case SAT_RUNTIME_ENV_KEYS.programId:
        values.programId = value;
        break;
      case SAT_RUNTIME_ENV_KEYS.bondProgramId:
        values.bondProgramId = value;
        break;
      case SAT_RUNTIME_ENV_KEYS.mintAddress:
        values.mintAddress = value;
        break;
      case SAT_RUNTIME_ENV_KEYS.mintProgramId:
        values.mintProgramId = value;
        break;
      default:
        break;
    }
  }
  return values;
}

export function resolveSatRuntimeDefaultsFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = String(env.FASED_SAT_RUNTIME_ENV_FILE ?? "").trim();
  const candidates = explicit
    ? [explicit]
    : [
        path.resolve(process.cwd(), "config", "sat-runtime.env"),
        path.resolve(import.meta.dirname, "..", "..", "config", "sat-runtime.env"),
        path.resolve(import.meta.dirname, "..", "..", "..", "config", "sat-runtime.env"),
      ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveWritableSatRuntimeDefaultsFile(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = String(env.FASED_SAT_RUNTIME_ENV_FILE ?? "").trim();
  return explicit || path.resolve(process.cwd(), "config", "sat-runtime.env");
}

function loadSatRuntimeDefaults(env: NodeJS.ProcessEnv = process.env): SatRuntimeIds | null {
  const explicit = readExplicitSatRuntimeIds(env);
  if (explicit) {
    return explicit;
  }
  const file = resolveSatRuntimeDefaultsFile(env);
  if (!file) {
    return null;
  }
  const parsed = parseEnvFile(fs.readFileSync(file, "utf8"));
  if (!parsed.programId || !parsed.bondProgramId || !parsed.mintAddress || !parsed.mintProgramId) {
    return null;
  }
  return {
    programId: parsed.programId,
    bondProgramId: parsed.bondProgramId,
    mintAddress: parsed.mintAddress,
    mintProgramId: parsed.mintProgramId,
  };
}

export const SAT_RUNTIME_DEFAULTS = loadSatRuntimeDefaults();

function readSatRuntimeEnvOrDefault(
  env: NodeJS.ProcessEnv,
  key: keyof typeof SAT_RUNTIME_ENV_KEYS,
): string | null {
  const envKey = SAT_RUNTIME_ENV_KEYS[key];
  const value = String(env[envKey] ?? "").trim();
  if (value) {
    return value;
  }
  return SAT_RUNTIME_DEFAULTS?.[key] ?? null;
}

export function tryResolveSatRuntimeIds(
  env: NodeJS.ProcessEnv = process.env,
): SatRuntimeIds | null {
  const programId = readSatRuntimeEnvOrDefault(env, "programId");
  const bondProgramId = readSatRuntimeEnvOrDefault(env, "bondProgramId");
  const mintAddress = readSatRuntimeEnvOrDefault(env, "mintAddress");
  const mintProgramId = readSatRuntimeEnvOrDefault(env, "mintProgramId");
  if (!programId || !bondProgramId || !mintAddress || !mintProgramId) {
    return null;
  }
  return {
    programId,
    bondProgramId,
    mintAddress,
    mintProgramId,
  };
}

export function resolveSatRuntimeIds(env: NodeJS.ProcessEnv = process.env): SatRuntimeIds {
  const ids = tryResolveSatRuntimeIds(env);
  if (!ids) {
    throw new Error(MISSING_SAT_RUNTIME_IDS_MESSAGE);
  }
  return ids;
}

export function resolveSatProgramIdFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return resolveSatRuntimeIds(env).programId;
}

export function tryResolveSatBondProgramIdOverrideFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = String(env[SAT_RUNTIME_ENV_KEYS.bondProgramId] ?? "").trim();
  return value || null;
}

export function hasDedicatedSatBondProgramId(env: NodeJS.ProcessEnv = process.env): boolean {
  return tryResolveSatBondProgramIdOverrideFromEnv(env) != null;
}

export function resolveSatBondProgramIdFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return resolveSatRuntimeIds(env).bondProgramId;
}

export function resolveSatMintAddressFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return resolveSatRuntimeIds(env).mintAddress;
}

export function resolveSatMintProgramIdFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return resolveSatRuntimeIds(env).mintProgramId;
}
