import fs from "node:fs";
import { ensureWalletStateDir } from "./wallet-runtime-config.js";

type WalletObservabilitySnapshot = {
  version: 1;
  updatedAt: string;
  counters: {
    policyReject: Record<string, number>;
    selectionSource: Record<string, number>;
    rpcFailure: Record<string, number>;
  };
};

const OBSERVABILITY_FILENAME = "observability.v1.json";

function nowIso(): string {
  return new Date().toISOString();
}

function observabilityPath(env: NodeJS.ProcessEnv): string {
  const state = ensureWalletStateDir(env);
  return `${state.rootDir}/${OBSERVABILITY_FILENAME}`;
}

function makeDefaultSnapshot(): WalletObservabilitySnapshot {
  return {
    version: 1,
    updatedAt: nowIso(),
    counters: {
      policyReject: {},
      selectionSource: {},
      rpcFailure: {},
    },
  };
}

function sanitizeBucket(input: unknown): Record<string, number> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n < 0) {
      continue;
    }
    out[key] = Math.floor(n);
  }
  return out;
}

function readSnapshot(env: NodeJS.ProcessEnv): WalletObservabilitySnapshot {
  const file = observabilityPath(env);
  if (!fs.existsSync(file)) {
    return makeDefaultSnapshot();
  }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(file, "utf8"),
    ) as Partial<WalletObservabilitySnapshot>;
    if (parsed?.version !== 1) {
      return makeDefaultSnapshot();
    }
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
      counters: {
        policyReject: sanitizeBucket(parsed.counters?.policyReject),
        selectionSource: sanitizeBucket(parsed.counters?.selectionSource),
        rpcFailure: sanitizeBucket(parsed.counters?.rpcFailure),
      },
    };
  } catch {
    return makeDefaultSnapshot();
  }
}

function writeSnapshot(env: NodeJS.ProcessEnv, snapshot: WalletObservabilitySnapshot): void {
  const file = observabilityPath(env);
  fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, {
    mode: 0o600,
    encoding: "utf8",
  });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort
  }
}

export function incrementWalletObservabilityCounter(params: {
  kind: "policyReject" | "selectionSource" | "rpcFailure";
  key: string;
  env?: NodeJS.ProcessEnv;
}): WalletObservabilitySnapshot {
  const env = params.env ?? process.env;
  const key = params.key.trim().toLowerCase();
  if (!key) {
    return readSnapshot(env);
  }
  const snapshot = readSnapshot(env);
  const bucket = snapshot.counters[params.kind];
  bucket[key] = (bucket[key] ?? 0) + 1;
  snapshot.updatedAt = nowIso();
  writeSnapshot(env, snapshot);
  return snapshot;
}

export function readWalletObservabilitySnapshot(env: NodeJS.ProcessEnv = process.env) {
  return readSnapshot(env);
}
