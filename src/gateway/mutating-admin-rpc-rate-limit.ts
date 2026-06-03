import type { GatewayClient } from "./server-methods/types.js";

export type MutatingAdminRpcRateLimitMethod =
  | "chat.inject"
  | "doctor.memory.repair.execute"
  | "push.test"
  | "web.login.start"
  | "web.login.wait";

export type MutatingAdminRpcRateLimitPolicy = {
  maxRequests: number;
  windowMs: number;
  label: string;
};

type Bucket = {
  count: number;
  windowStartMs: number;
};

const MUTATING_ADMIN_RPC_RATE_LIMIT_POLICIES: Record<
  MutatingAdminRpcRateLimitMethod,
  MutatingAdminRpcRateLimitPolicy
> = {
  "chat.inject": { maxRequests: 10, windowMs: 60_000, label: "10 per 60s" },
  "doctor.memory.repair.execute": { maxRequests: 1, windowMs: 300_000, label: "1 per 300s" },
  "push.test": { maxRequests: 3, windowMs: 60_000, label: "3 per 60s" },
  "web.login.start": { maxRequests: 3, windowMs: 300_000, label: "3 per 300s" },
  "web.login.wait": { maxRequests: 12, windowMs: 300_000, label: "12 per 300s" },
};

const mutatingAdminRpcBuckets = new Map<string, Bucket>();

function normalizePart(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

export function isMutatingAdminRpcRateLimitedMethod(
  method: string,
): method is MutatingAdminRpcRateLimitMethod {
  return Object.hasOwn(MUTATING_ADMIN_RPC_RATE_LIMIT_POLICIES, method);
}

export function resolveMutatingAdminRpcRateLimitKey(params: {
  method: MutatingAdminRpcRateLimitMethod;
  client: GatewayClient | null;
}): string {
  const deviceId = normalizePart(params.client?.connect?.device?.id, "unknown-device");
  const clientIp = normalizePart(params.client?.clientIp, "unknown-ip");
  if (deviceId === "unknown-device" && clientIp === "unknown-ip") {
    const connId = normalizePart(params.client?.connId, "");
    if (connId) {
      return `${params.method}|${deviceId}|${clientIp}|conn=${connId}`;
    }
  }
  return `${params.method}|${deviceId}|${clientIp}`;
}

export function consumeMutatingAdminRpcBudget(params: {
  method: string;
  client: GatewayClient | null;
  nowMs?: number;
}):
  | {
      applies: false;
    }
  | {
      applies: true;
      allowed: boolean;
      retryAfterMs: number;
      remaining: number;
      key: string;
      policy: MutatingAdminRpcRateLimitPolicy;
    } {
  if (!isMutatingAdminRpcRateLimitedMethod(params.method)) {
    return { applies: false };
  }
  const nowMs = params.nowMs ?? Date.now();
  const policy = MUTATING_ADMIN_RPC_RATE_LIMIT_POLICIES[params.method];
  const key = resolveMutatingAdminRpcRateLimitKey({
    method: params.method,
    client: params.client,
  });
  const bucket = mutatingAdminRpcBuckets.get(key);

  if (!bucket || nowMs - bucket.windowStartMs >= policy.windowMs) {
    mutatingAdminRpcBuckets.set(key, {
      count: 1,
      windowStartMs: nowMs,
    });
    return {
      applies: true,
      allowed: true,
      retryAfterMs: 0,
      remaining: policy.maxRequests - 1,
      key,
      policy,
    };
  }

  if (bucket.count >= policy.maxRequests) {
    return {
      applies: true,
      allowed: false,
      retryAfterMs: Math.max(0, bucket.windowStartMs + policy.windowMs - nowMs),
      remaining: 0,
      key,
      policy,
    };
  }

  bucket.count += 1;
  return {
    applies: true,
    allowed: true,
    retryAfterMs: 0,
    remaining: Math.max(0, policy.maxRequests - bucket.count),
    key,
    policy,
  };
}

export const __testing = {
  resetMutatingAdminRpcRateLimitState() {
    mutatingAdminRpcBuckets.clear();
  },
};
