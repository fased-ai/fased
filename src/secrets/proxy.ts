import type { FasedAgentConfig } from "../config/config.js";
import type { SecretRef } from "../config/types.secrets.js";
import { secretRefKey } from "./ref-contract.js";
import { resolveSecretRefString, type SecretRefResolveCache } from "./resolve.js";

export type SecretProxyAudit = {
  refKey: string;
  source: SecretRef["source"];
  provider: string;
  id: string;
  purpose: string;
  consumer: string;
};

export type SecretProxyExecutionContext = {
  secret: string;
  audit: SecretProxyAudit;
};

export type SecretProxyResult<T> = {
  ok: true;
  value: T;
  audit: SecretProxyAudit;
};

function resultContainsSecret(value: unknown, secret: string): boolean {
  if (!secret) {
    return false;
  }
  const seen = new WeakSet<object>();
  const visit = (entry: unknown): boolean => {
    if (typeof entry === "string") {
      return entry.includes(secret);
    }
    if (
      entry == null ||
      typeof entry === "number" ||
      typeof entry === "bigint" ||
      typeof entry === "boolean" ||
      typeof entry === "function" ||
      typeof entry === "symbol"
    ) {
      return false;
    }
    if (seen.has(entry)) {
      return false;
    }
    seen.add(entry);
    if (Array.isArray(entry)) {
      return entry.some((item) => visit(item));
    }
    for (const nested of Object.values(entry as Record<string, unknown>)) {
      if (visit(nested)) {
        return true;
      }
    }
    return false;
  };
  return visit(value);
}

/**
 * Resolve a SecretRef for one bounded operation without returning the raw secret.
 *
 * The callback receives the secret because the actual provider/API call needs it,
 * but the returned value is checked so accidental key echoes do not cross the
 * proxy boundary.
 */
export async function runSecretProxyCall<T>(params: {
  config: FasedAgentConfig;
  ref: SecretRef;
  purpose: string;
  consumer: string;
  env?: NodeJS.ProcessEnv;
  cache?: SecretRefResolveCache;
  allowSecretInResult?: boolean;
  execute: (context: SecretProxyExecutionContext) => Promise<T> | T;
}): Promise<SecretProxyResult<T>> {
  const audit: SecretProxyAudit = {
    refKey: secretRefKey(params.ref),
    source: params.ref.source,
    provider: params.ref.provider,
    id: params.ref.id,
    purpose: params.purpose.trim() || "unspecified",
    consumer: params.consumer.trim() || "unspecified",
  };
  const secret = await resolveSecretRefString(params.ref, {
    config: params.config,
    env: params.env,
    cache: params.cache,
  });
  const value = await params.execute({ secret, audit });
  if (!params.allowSecretInResult && resultContainsSecret(value, secret)) {
    throw new Error(
      `Secret proxy blocked result leak for ${audit.consumer} (${audit.purpose}): ${audit.refKey}`,
    );
  }
  return { ok: true, value, audit };
}
