import http from "node:http";
import https from "node:https";
import { fetchWithSsrFGuard, redactSensitiveUrlLikeString } from "fased/plugin-sdk/sat-runtime";

export type MiningReadRpcConfig = {
  primaryUrl: string;
  secondaryUrl: string | null;
};

export type MiningReadConnectionLike = {
  rpcEndpoint: string;
  secondaryRpcEndpoint: string | null;
  getAccountInfo: (...args: unknown[]) => Promise<unknown>;
  getProgramAccounts: (...args: unknown[]) => Promise<unknown>;
  getMinimumBalanceForRentExemption: (...args: unknown[]) => Promise<unknown>;
};

export type MiningSolanaModuleLike = {
  Connection: new (
    rpcEndpoint: string,
    config: { disableRetryOnRateLimit: boolean; fetch: typeof globalThis.fetch },
  ) => MiningReadConnectionLike;
};

type EndpointState = {
  consecutiveFailures: number;
  backoffUntilMs: number;
  quotaLikely: boolean;
  lastError: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
};

type RuntimeState = {
  lastMode: "primary" | "fallback" | "unavailable";
  fallbackCount: number;
  lastError: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastRpcUrl: string | null;
  quotaLikely: boolean;
};

type MethodBucket = { requests: number; successes: number; failures: number };
type MethodMetric = {
  requestsSinceStart: number;
  successesSinceStart: number;
  failuresSinceStart: number;
  lastRequestAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  buckets: Map<number, MethodBucket>;
};
type AccountReadMetric = {
  requestsSinceStart: number;
  successesSinceStart: number;
  nullsSinceStart: number;
  failuresSinceStart: number;
  lastRequestAt: string | null;
  lastSuccessAt: string | null;
  lastNullAt: string | null;
  lastFailureAt: string | null;
};

const METHOD_BUCKET_MS = 60 * 60_000;
const METHOD_RETENTION_MS = 24 * 60 * 60_000;
const QUOTA_BACKOFF_MS = 30_000;
const FAILURE_BACKOFF_THRESHOLD = 2;
const FAILURE_BACKOFF_BASE_MS = 5_000;
const FAILURE_BACKOFF_MAX_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const runtimeState: RuntimeState = {
  lastMode: "unavailable",
  fallbackCount: 0,
  lastError: null,
  lastFailureAt: null,
  lastSuccessAt: null,
  lastRpcUrl: null,
  quotaLikely: false,
};
const endpointStates = new Map<string, EndpointState>();
const methodMetrics = new Map<string, MethodMetric>();
const accountReadMetrics = new Map<string, AccountReadMetric>();

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function requestTimeoutMs(): number {
  return readPositiveIntEnv("FASED_SAT_RPC_REQUEST_TIMEOUT_MS", 10_000);
}

export function normalizeMiningReadRpcConfig(
  rpc: string | MiningReadRpcConfig,
): MiningReadRpcConfig {
  return typeof rpc === "string" ? { primaryUrl: rpc, secondaryUrl: null } : rpc;
}

export function normalizeMiningRpcUrlForComparison(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim().replace(/\/$/, "");
  }
}

export function resolveDefaultSolanaPublicReadFallbackUrl(params: {
  network?: string;
  primaryUrl?: string;
}): string {
  const network = String(params.network ?? "").trim();
  const primaryUrl = String(params.primaryUrl ?? "").trim();
  const fallbackUrl =
    network === "devnet"
      ? "https://api.devnet.solana.com"
      : network === "mainnet-beta"
        ? "https://api.mainnet-beta.solana.com"
        : "";
  if (!fallbackUrl) return "";
  return primaryUrl &&
    normalizeMiningRpcUrlForComparison(primaryUrl) ===
      normalizeMiningRpcUrlForComparison(fallbackUrl)
    ? ""
    : fallbackUrl;
}

function getEndpointState(rpcUrl: string): EndpointState {
  const key = normalizeMiningRpcUrlForComparison(rpcUrl);
  const existing = endpointStates.get(key);
  if (existing) return existing;
  const created: EndpointState = {
    consecutiveFailures: 0,
    backoffUntilMs: 0,
    quotaLikely: false,
    lastError: null,
    lastFailureAt: null,
    lastSuccessAt: null,
  };
  endpointStates.set(key, created);
  return created;
}

function currentBackoffMs(rpcUrl: string, nowMs = Date.now()): number {
  const state = endpointStates.get(normalizeMiningRpcUrlForComparison(rpcUrl));
  return state ? Math.max(0, state.backoffUntilMs - nowMs) : 0;
}

function quotaLikely(value: unknown): boolean {
  const message = String(value ?? "").toLowerCase();
  return (
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("quota") ||
    message.includes("credit") ||
    message.includes("credits exhausted") ||
    message.includes("resource exhausted")
  );
}

function markEndpointSuccess(rpcUrl: string): void {
  const state = getEndpointState(rpcUrl);
  state.consecutiveFailures = 0;
  state.backoffUntilMs = 0;
  state.quotaLikely = false;
  state.lastError = null;
  state.lastSuccessAt = new Date().toISOString();
}

function markEndpointFailure(rpcUrl: string, error: unknown): void {
  const state = getEndpointState(rpcUrl);
  const message = error instanceof Error ? error.message : String(error);
  state.consecutiveFailures += 1;
  state.quotaLikely = quotaLikely(message);
  state.lastError = message;
  state.lastFailureAt = new Date().toISOString();
  if (state.quotaLikely) {
    state.backoffUntilMs = Date.now() + QUOTA_BACKOFF_MS;
  } else if (state.consecutiveFailures >= FAILURE_BACKOFF_THRESHOLD) {
    const exponent = state.consecutiveFailures - FAILURE_BACKOFF_THRESHOLD;
    state.backoffUntilMs =
      Date.now() + Math.min(FAILURE_BACKOFF_MAX_MS, FAILURE_BACKOFF_BASE_MS * 2 ** exponent);
  }
}

function markSuccess(mode: "primary" | "fallback", rpcUrl: string): void {
  markEndpointSuccess(rpcUrl);
  runtimeState.lastMode = mode;
  runtimeState.lastRpcUrl = rpcUrl;
  runtimeState.lastSuccessAt = new Date().toISOString();
  if (mode === "primary") {
    runtimeState.lastError = null;
    runtimeState.quotaLikely = false;
  } else runtimeState.fallbackCount += 1;
}

function markFailure(error: unknown, rpcUrl: string): void {
  const message = error instanceof Error ? error.message : String(error);
  markEndpointFailure(rpcUrl, error);
  runtimeState.lastMode = "unavailable";
  runtimeState.lastError = message;
  runtimeState.lastFailureAt = new Date().toISOString();
  runtimeState.quotaLikely = runtimeState.quotaLikely || quotaLikely(message);
}

function backoffError(method: string, remainingMs: number): Error {
  return new Error(
    `rpc ${method} skipped during endpoint circuit backoff; retry in ${Math.ceil(remainingMs / 1000)}s`,
  );
}

function methodMetric(method: string): MethodMetric {
  const name = String(method ?? "").trim() || "unknown";
  const existing = methodMetrics.get(name);
  if (existing) return existing;
  const created: MethodMetric = {
    requestsSinceStart: 0,
    successesSinceStart: 0,
    failuresSinceStart: 0,
    lastRequestAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    buckets: new Map(),
  };
  methodMetrics.set(name, created);
  return created;
}

function updateMethodMetric(method: string, outcome: "request" | "success" | "failure"): void {
  const entry = methodMetric(method);
  const nowMs = Date.now();
  const bucketStartMs = nowMs - (nowMs % METHOD_BUCKET_MS);
  const bucket = entry.buckets.get(bucketStartMs) ?? { requests: 0, successes: 0, failures: 0 };
  const at = new Date(nowMs).toISOString();
  if (outcome === "request") {
    entry.requestsSinceStart += 1;
    entry.lastRequestAt = at;
    bucket.requests += 1;
  } else if (outcome === "success") {
    entry.successesSinceStart += 1;
    entry.lastSuccessAt = at;
    bucket.successes += 1;
  } else {
    entry.failuresSinceStart += 1;
    entry.lastFailureAt = at;
    bucket.failures += 1;
  }
  entry.buckets.set(bucketStartMs, bucket);
  for (const start of entry.buckets.keys())
    if (start < nowMs - METHOD_RETENTION_MS) entry.buckets.delete(start);
}

export function recordMiningRpcAccountRead(
  label: string | undefined,
  outcome: "request" | "success" | "null" | "failure",
): void {
  const normalized = String(label ?? "").trim() || "unlabeled";
  const entry = accountReadMetrics.get(normalized) ?? {
    requestsSinceStart: 0,
    successesSinceStart: 0,
    nullsSinceStart: 0,
    failuresSinceStart: 0,
    lastRequestAt: null,
    lastSuccessAt: null,
    lastNullAt: null,
    lastFailureAt: null,
  };
  accountReadMetrics.set(normalized, entry);
  const at = new Date().toISOString();
  if (outcome === "request") {
    entry.requestsSinceStart += 1;
    entry.lastRequestAt = at;
  } else if (outcome === "success") {
    entry.successesSinceStart += 1;
    entry.lastSuccessAt = at;
  } else if (outcome === "null") {
    entry.nullsSinceStart += 1;
    entry.lastNullAt = at;
  } else {
    entry.failuresSinceStart += 1;
    entry.lastFailureAt = at;
  }
}

function createAbortableFetch(): typeof globalThis.fetch {
  return (async (input, init) => {
    const timeoutMs = requestTimeoutMs();
    const requestStartedAtMs = Date.now();
    const requestUrl =
      typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    let release: (() => Promise<void>) | undefined;
    let released = false;
    let releaseTimer: NodeJS.Timeout | undefined;
    const releaseOnce = async () => {
      if (released) return;
      released = true;
      if (releaseTimer) clearTimeout(releaseTimer);
      await release?.();
    };
    try {
      const guardedFetch = await fetchWithSsrFGuard({
        url: requestUrl,
        init,
        timeoutMs,
        signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
        policy: { allowPrivateNetwork: true },
        auditContext: "sat-mining-read-rpc",
      });
      release = guardedFetch.release;
      if (!guardedFetch.response.body) {
        await releaseOnce();
        return new Response(null, {
          headers: guardedFetch.response.headers,
          status: guardedFetch.response.status,
          statusText: guardedFetch.response.statusText,
        });
      }
      const reader = guardedFetch.response.body.getReader();
      const remainingTimeoutMs = Math.max(0, timeoutMs - (Date.now() - requestStartedAtMs));
      releaseTimer = setTimeout(() => {
        void reader
          .cancel(new Error(`rpc fetch timed out after ${timeoutMs}ms`))
          .finally(releaseOnce);
      }, remainingTimeoutMs);
      releaseTimer.unref?.();
      let responseBytes = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              await releaseOnce();
              return;
            }
            responseBytes += value.byteLength;
            if (responseBytes > MAX_RESPONSE_BYTES) {
              const error = new Error("rpc response exceeded size limit");
              await reader.cancel(error);
              controller.error(error);
              await releaseOnce();
              return;
            }
            controller.enqueue(value);
          } catch (error) {
            controller.error(error);
            await releaseOnce();
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            await releaseOnce();
          }
        },
      });
      return new Response(body, {
        headers: guardedFetch.response.headers,
        status: guardedFetch.response.status,
        statusText: guardedFetch.response.statusText,
      });
    } catch (error) {
      await releaseOnce();
      const reason = redactSensitiveUrlLikeString(
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
      throw new Error(
        `rpc fetch failed after at most ${timeoutMs}ms (${redactSensitiveUrlLikeString(requestUrl)}): ${reason}`,
      );
    }
  }) as typeof globalThis.fetch;
}

async function withTimeout<T>(task: Promise<T>, method: string, rpcUrl: string): Promise<T> {
  const timeoutMs = requestTimeoutMs();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `rpc ${method} timed out after ${timeoutMs}ms (${redactSensitiveUrlLikeString(rpcUrl)})`,
              ),
            ),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function requestOnce<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  updateMethodMetric(method, "request");
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const target = new URL(rpcUrl);
    const transport = target.protocol === "https:" ? https : http;
    const payload = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const rejectOnce = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      const req = transport.request(
        target,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let responseBytes = 0;
          res.on("data", (chunk) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            responseBytes += buffer.length;
            if (responseBytes > MAX_RESPONSE_BYTES)
              req.destroy(new Error(`rpc ${method} response exceeded size limit`));
            else chunks.push(buffer);
          });
          res.on("end", () => {
            if (settled) return;
            const text = Buffer.concat(chunks).toString("utf8");
            if ((res.statusCode ?? 500) >= 400)
              rejectOnce(new Error(text || `rpc ${method} failed`));
            else {
              settled = true;
              resolve(text);
            }
          });
        },
      );
      req.setTimeout(requestTimeoutMs(), () =>
        req.destroy(
          new Error(
            `rpc ${method} timed out after ${requestTimeoutMs()}ms (${redactSensitiveUrlLikeString(rpcUrl)})`,
          ),
        ),
      );
      req.on("error", (error) => rejectOnce(error));
      req.write(body);
      req.end();
    });
    const parsed = JSON.parse(payload) as { result?: T; error?: { message?: string } };
    if (parsed.error) throw new Error(parsed.error.message || `rpc ${method} failed`);
    updateMethodMetric(method, "success");
    return parsed.result as T;
  } catch (error) {
    updateMethodMetric(method, "failure");
    throw error;
  }
}

export async function miningRpcRequest<T>(
  rpc: string | MiningReadRpcConfig,
  method: string,
  params: unknown[],
): Promise<T> {
  const config = normalizeMiningReadRpcConfig(rpc);
  const primaryBackoff = currentBackoffMs(config.primaryUrl);
  const secondaryBackoff = config.secondaryUrl ? currentBackoffMs(config.secondaryUrl) : 0;
  if (primaryBackoff > 0 && (!config.secondaryUrl || secondaryBackoff > 0))
    throw backoffError(method, Math.min(primaryBackoff, secondaryBackoff || primaryBackoff));
  const call = async (mode: "primary" | "fallback", url: string) => {
    try {
      const result = await requestOnce<T>(url, method, params);
      markSuccess(mode, url);
      return result;
    } catch (error) {
      markFailure(error, url);
      throw error;
    }
  };
  if (primaryBackoff > 0 && config.secondaryUrl) return await call("fallback", config.secondaryUrl);
  try {
    return await call("primary", config.primaryUrl);
  } catch (primaryError) {
    if (!config.secondaryUrl) throw primaryError;
    const fallbackBackoff = currentBackoffMs(config.secondaryUrl);
    if (fallbackBackoff > 0) throw backoffError(method, fallbackBackoff);
    try {
      return await call("fallback", config.secondaryUrl);
    } catch (secondaryError) {
      const primaryMessage = redactSensitiveUrlLikeString(
        primaryError instanceof Error ? primaryError.message : String(primaryError),
      );
      const secondaryMessage = redactSensitiveUrlLikeString(
        secondaryError instanceof Error ? secondaryError.message : String(secondaryError),
      );
      throw new Error(
        `rpc ${method} failed on primary (${primaryMessage}) and fallback (${secondaryMessage})`,
      );
    }
  }
}

export function createMiningReadConnection(
  solana: MiningSolanaModuleLike,
  rpc: MiningReadRpcConfig,
): MiningReadConnectionLike {
  const primary = new solana.Connection(rpc.primaryUrl, {
    disableRetryOnRateLimit: true,
    fetch: createAbortableFetch(),
  });
  const secondary = rpc.secondaryUrl
    ? new solana.Connection(rpc.secondaryUrl, {
        disableRetryOnRateLimit: true,
        fetch: createAbortableFetch(),
      })
    : null;
  const withFallback =
    (
      method: keyof Pick<
        MiningReadConnectionLike,
        "getAccountInfo" | "getProgramAccounts" | "getMinimumBalanceForRentExemption"
      >,
    ) =>
    async (...args: unknown[]) => {
      const primaryBackoff = currentBackoffMs(rpc.primaryUrl);
      const secondaryBackoff = rpc.secondaryUrl ? currentBackoffMs(rpc.secondaryUrl) : 0;
      const call = async (
        connection: MiningReadConnectionLike,
        mode: "primary" | "fallback",
        url: string,
      ) => {
        updateMethodMetric(method, "request");
        try {
          const result = await withTimeout(connection[method](...args), method, url);
          updateMethodMetric(method, "success");
          markSuccess(mode, url);
          return result;
        } catch (error) {
          updateMethodMetric(method, "failure");
          markFailure(error, url);
          throw error;
        }
      };
      if (primaryBackoff > 0) {
        if (!secondary || !rpc.secondaryUrl || secondaryBackoff > 0)
          throw backoffError(method, Math.min(primaryBackoff, secondaryBackoff || primaryBackoff));
        return await call(secondary, "fallback", rpc.secondaryUrl);
      }
      try {
        return await call(primary, "primary", rpc.primaryUrl);
      } catch (primaryError) {
        if (!secondary || !rpc.secondaryUrl) throw primaryError;
        const fallbackBackoff = currentBackoffMs(rpc.secondaryUrl);
        if (fallbackBackoff > 0) throw backoffError(method, fallbackBackoff);
        try {
          return await call(secondary, "fallback", rpc.secondaryUrl);
        } catch (secondaryError) {
          const primaryMessage = redactSensitiveUrlLikeString(
            primaryError instanceof Error ? primaryError.message : String(primaryError),
          );
          const secondaryMessage = redactSensitiveUrlLikeString(
            secondaryError instanceof Error ? secondaryError.message : String(secondaryError),
          );
          throw new Error(
            `rpc ${method} failed on primary (${primaryMessage}) and fallback (${secondaryMessage})`,
          );
        }
      }
    };
  return {
    rpcEndpoint: rpc.primaryUrl,
    secondaryRpcEndpoint: rpc.secondaryUrl,
    getAccountInfo: withFallback("getAccountInfo"),
    getProgramAccounts: withFallback("getProgramAccounts"),
    getMinimumBalanceForRentExemption: withFallback("getMinimumBalanceForRentExemption"),
  };
}

export function inspectMiningRpcDiagnostics(rpc: MiningReadRpcConfig) {
  const endpoints = [rpc.primaryUrl, rpc.secondaryUrl]
    .filter((url): url is string => Boolean(url))
    .map((url) => {
      const state = endpointStates.get(normalizeMiningRpcUrlForComparison(url));
      return {
        rpcUrl: redactSensitiveUrlLikeString(url),
        consecutiveFailures: state?.consecutiveFailures ?? 0,
        backoffRemainingMs: currentBackoffMs(url),
        quotaLikely: state?.quotaLikely ?? false,
        lastError: state?.lastError ? redactSensitiveUrlLikeString(state.lastError) : null,
        lastFailureAt: state?.lastFailureAt ?? null,
        lastSuccessAt: state?.lastSuccessAt ?? null,
      };
    });
  const nowMs = Date.now();
  const methods = [...methodMetrics.entries()]
    .map(([method, entry]) => {
      let requestsLastHour = 0,
        successesLastHour = 0,
        failuresLastHour = 0,
        requestsLast24Hours = 0,
        successesLast24Hours = 0,
        failuresLast24Hours = 0;
      for (const [start, bucket] of entry.buckets) {
        if (start < nowMs - METHOD_RETENTION_MS) {
          entry.buckets.delete(start);
          continue;
        }
        if (start >= nowMs - METHOD_RETENTION_MS) {
          requestsLast24Hours += bucket.requests;
          successesLast24Hours += bucket.successes;
          failuresLast24Hours += bucket.failures;
        }
        if (start >= nowMs - METHOD_BUCKET_MS) {
          requestsLastHour += bucket.requests;
          successesLastHour += bucket.successes;
          failuresLastHour += bucket.failures;
        }
      }
      return {
        method,
        requestsSinceStart: entry.requestsSinceStart,
        successesSinceStart: entry.successesSinceStart,
        failuresSinceStart: entry.failuresSinceStart,
        requestsLastHour,
        successesLastHour,
        failuresLastHour,
        requestsLast24Hours,
        successesLast24Hours,
        failuresLast24Hours,
        lastRequestAt: entry.lastRequestAt,
        lastSuccessAt: entry.lastSuccessAt,
        lastFailureAt: entry.lastFailureAt,
      };
    })
    .sort((left, right) => right.requestsLast24Hours - left.requestsLast24Hours);
  return {
    rpcState: {
      ...runtimeState,
      lastError: runtimeState.lastError
        ? redactSensitiveUrlLikeString(runtimeState.lastError)
        : null,
      lastRpcUrl: runtimeState.lastRpcUrl
        ? redactSensitiveUrlLikeString(runtimeState.lastRpcUrl)
        : null,
      quotaLikely: runtimeState.quotaLikely || quotaLikely(runtimeState.lastError),
      endpoints,
    },
    rpcMetrics: {
      windowLastHourMs: METHOD_BUCKET_MS,
      windowLast24HoursMs: METHOD_RETENTION_MS,
      methods,
      accountReads: [...accountReadMetrics.entries()]
        .map(([label, entry]) => ({ label, ...entry }))
        .sort((left, right) => right.requestsSinceStart - left.requestsSinceStart),
    },
  };
}
