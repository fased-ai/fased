import { PublicKey } from "@solana/web3.js";
import { fetchPinnedSolanaRpcRead } from "./solana-rpc-read-fetch.js";

const SOLANA_NATIVE_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const METAPLEX_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

type SolanaRpcTokenAccount = {
  pubkey?: string;
  account?: {
    owner?: string;
    data?: {
      parsed?: {
        info?: {
          mint?: string;
          tokenAmount?: {
            amount?: string;
            decimals?: number;
          };
        };
      };
    };
  };
};

export type SolanaMintInfo = {
  mint: string;
  tokenProgramId: string;
  decimals: number;
};

export type SolanaWalletAsset = {
  id: string;
  chain: "solana";
  kind: "native" | "spl-token";
  symbol: string;
  name: string;
  amountRaw: string;
  amountDisplay: string;
  decimals: number;
  unit: string;
  isNative: boolean;
  address?: string;
  program?: string;
  tokenProgramId?: string;
  metadataUri?: string;
  logoUri?: string;
  verificationStatus?: "verified" | "unverified" | "unknown";
  verificationSource?: "jupiter" | "metadata-uri" | "unknown";
  priceUsd?: number;
  valueUsd?: number;
  tags?: string[];
};

type SolanaFungibleMetadata = {
  symbol: string;
  name: string;
  uri?: string;
};

type SolanaMetadataUriPayload = {
  name?: string;
  symbol?: string;
  image?: string;
  icon?: string;
  logoURI?: string;
};

type SolanaJupiterTokenRecord = {
  symbol?: string;
  name?: string;
  icon?: string;
  tags?: string[];
  usdPrice?: number;
  isVerified?: boolean;
};

type CacheEntry<T> = {
  value: T;
  expiresAtMs: number;
};

type SolanaAssetRpcMethodMetrics = {
  requestsSinceStart: number;
  successesSinceStart: number;
  failuresSinceStart: number;
};

type SolanaRpcAccountValue = {
  owner?: string;
  data?:
    | {
        parsed?: {
          info?: {
            decimals?: number;
            extensions?: unknown[];
          };
        };
      }
    | [string, string]
    | string;
};

const METADATA_URI_CACHE_TTL_MS = 30 * 60 * 1000;
const JUPITER_TOKEN_CACHE_TTL_MS = 10 * 60 * 1000;
const SOLANA_WALLET_BALANCE_CACHE_TTL_MS = readPositiveIntEnv(
  "FASED_SOLANA_WALLET_BALANCE_CACHE_TTL_MS",
  5_000,
);
const SOLANA_TOKEN_ACCOUNTS_CACHE_TTL_MS = readPositiveIntEnv(
  "FASED_SOLANA_TOKEN_ACCOUNTS_CACHE_TTL_MS",
  5_000,
);
const SOLANA_ACCOUNT_INFO_CACHE_TTL_MS = readPositiveIntEnv(
  "FASED_SOLANA_ACCOUNT_INFO_CACHE_TTL_MS",
  10 * 60 * 1000,
);
const METADATA_URI_TIMEOUT_MS = 2_500;
const JUPITER_SEARCH_TIMEOUT_MS = 2_500;
const JUPITER_TOKEN_SEARCH_URL = "https://lite-api.jup.ag/ultra/v1/search";

const metadataUriCache = new Map<string, CacheEntry<SolanaMetadataUriPayload | null>>();
const jupiterTokenCache = new Map<string, CacheEntry<SolanaJupiterTokenRecord | null>>();
const rpcResultCache = new Map<string, CacheEntry<unknown>>();
const rpcInFlight = new Map<string, Promise<unknown>>();
const accountInfoCache = new Map<string, CacheEntry<SolanaRpcAccountValue | null>>();
const tokenAccountsCache = new Map<string, CacheEntry<SolanaRpcTokenAccount[] | null>>();
const solanaAssetRpcStartedAt = new Date().toISOString();
const solanaAssetRpcMetrics = new Map<string, SolanaAssetRpcMethodMetrics>();

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function shortMintLabel(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 12) {
    return trimmed || "TOKEN";
  }
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function fallbackSolanaAssetMetadata(mint: string): SolanaFungibleMetadata {
  return {
    symbol: shortMintLabel(mint).toUpperCase(),
    name: `Token ${shortMintLabel(mint)}`,
  };
}

function sanitizeMetadataText(value: string | null | undefined): string {
  return String(value ?? "")
    .replaceAll("\u0000", "")
    .replace(/\s+/g, " ")
    .trim();
}

function readRecordString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}

function sanitizeUri(value: string | null | undefined): string | undefined {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^https?:\/\//i.test(trimmed) || /^ipfs:\/\//i.test(trimmed) || /^ar:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return undefined;
}

function normalizeExternalAssetUri(value: string | null | undefined): string | undefined {
  const candidate = sanitizeUri(value);
  if (!candidate) {
    return undefined;
  }
  if (candidate.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${candidate.slice("ipfs://".length).replace(/^ipfs\//, "")}`;
  }
  if (candidate.startsWith("ar://")) {
    return `https://arweave.net/${candidate.slice("ar://".length)}`;
  }
  return candidate;
}

function readCacheEntry<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const cached = cache.get(key);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAtMs <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return cached.value;
}

function writeCacheEntry<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
): T {
  cache.set(key, { value, expiresAtMs: Date.now() + ttlMs });
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function rpcCacheKey(rpcUrl: string, method: string, params: unknown[]): string {
  return `${rpcUrl.trim()}|${method}|${stableJson(params)}`;
}

function accountInfoCacheKey(rpcUrl: string, address: string, encoding: string): string {
  return `${rpcUrl.trim()}|${encoding}|${address.trim()}`;
}

function tokenAccountsCacheKey(rpcUrl: string, ownerAddress: string, programId: string): string {
  return `${rpcUrl.trim()}|${ownerAddress.trim()}|${programId.trim()}`;
}

function recordSolanaAssetRpcMethod(method: string, outcome: "success" | "failure"): void {
  const key = method.trim() || "unknown";
  const current = solanaAssetRpcMetrics.get(key) ?? {
    requestsSinceStart: 0,
    successesSinceStart: 0,
    failuresSinceStart: 0,
  };
  current.requestsSinceStart += 1;
  if (outcome === "success") {
    current.successesSinceStart += 1;
  } else {
    current.failuresSinceStart += 1;
  }
  solanaAssetRpcMetrics.set(key, current);
}

async function fetchSolanaRpcCached<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  ttlMs: number,
): Promise<T | null> {
  const key = rpcCacheKey(rpcUrl, method, params);
  const cached = readCacheEntry(rpcResultCache, key);
  if (cached !== undefined) {
    return cached as T | null;
  }
  const inFlight = rpcInFlight.get(key);
  if (inFlight) {
    return (await inFlight) as T | null;
  }
  const request = fetchSolanaRpc<T>(rpcUrl, method, params)
    .then((result) => writeCacheEntry(rpcResultCache, key, result, ttlMs))
    .finally(() => {
      rpcInFlight.delete(key);
    });
  rpcInFlight.set(key, request);
  return (await request) as T | null;
}

async function fetchSolanaAccountInfosViaRpc(params: {
  rpcUrl: string;
  addresses: string[];
  encoding: "jsonParsed" | "base64";
}): Promise<Map<string, SolanaRpcAccountValue | null>> {
  const out = new Map<string, SolanaRpcAccountValue | null>();
  const uniqueAddresses = [
    ...new Set(params.addresses.map((address) => address.trim()).filter(Boolean)),
  ];
  const missing: string[] = [];
  for (const address of uniqueAddresses) {
    const key = accountInfoCacheKey(params.rpcUrl, address, params.encoding);
    const cached = readCacheEntry(accountInfoCache, key);
    if (cached !== undefined) {
      out.set(address, cached);
      continue;
    }
    missing.push(address);
  }
  for (let index = 0; index < missing.length; index += 100) {
    const batch = missing.slice(index, index + 100);
    if (batch.length === 0) {
      continue;
    }
    const result = await fetchSolanaRpc<{
      value?: (SolanaRpcAccountValue | null)[];
    }>(params.rpcUrl, "getMultipleAccounts", [batch, { encoding: params.encoding }]).catch(
      () => null,
    );
    const values = Array.isArray(result?.value) ? result.value : [];
    batch.forEach((address, offset) => {
      const value = values[offset] ?? null;
      writeCacheEntry(
        accountInfoCache,
        accountInfoCacheKey(params.rpcUrl, address, params.encoding),
        value,
        SOLANA_ACCOUNT_INFO_CACHE_TTL_MS,
      );
      out.set(address, value);
    });
  }
  return out;
}

async function fetchSolanaAccountInfoViaRpc(params: {
  rpcUrl: string;
  address: string;
  encoding: "jsonParsed" | "base64";
}): Promise<SolanaRpcAccountValue | null> {
  return (
    (
      await fetchSolanaAccountInfosViaRpc({
        rpcUrl: params.rpcUrl,
        addresses: [params.address],
        encoding: params.encoding,
      })
    ).get(params.address.trim()) ?? null
  );
}

async function fetchSolanaTokenAccountsByOwnerViaRpc(params: {
  rpcUrl: string;
  ownerAddress: string;
  programId: string;
}): Promise<SolanaRpcTokenAccount[]> {
  const key = tokenAccountsCacheKey(params.rpcUrl, params.ownerAddress, params.programId);
  const cached = readCacheEntry(tokenAccountsCache, key);
  if (cached !== undefined) {
    return cached ?? [];
  }
  const result = await fetchSolanaRpcCached<{ value?: SolanaRpcTokenAccount[] }>(
    params.rpcUrl,
    "getTokenAccountsByOwner",
    [params.ownerAddress, { programId: params.programId }, { encoding: "jsonParsed" }],
    SOLANA_TOKEN_ACCOUNTS_CACHE_TTL_MS,
  );
  const entries = Array.isArray(result?.value) ? result.value : null;
  writeCacheEntry(tokenAccountsCache, key, entries, SOLANA_TOKEN_ACCOUNTS_CACHE_TTL_MS);
  return entries ?? [];
}

function toDisplayNumber(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

function normalizeResolvedMetadata(
  candidate: Partial<SolanaFungibleMetadata> | null | undefined,
): SolanaFungibleMetadata | null {
  const name = sanitizeMetadataText(candidate?.name);
  const symbol = sanitizeMetadataText(candidate?.symbol);
  const uri = sanitizeMetadataText(candidate?.uri);
  if (!name && !symbol) {
    return null;
  }
  return {
    name: name || symbol || "Token",
    symbol: symbol || name || "TOKEN",
    uri: uri || undefined,
  };
}

function readBorshString(
  buffer: Buffer,
  offset: number,
): { value: string; nextOffset: number } | null {
  if (offset + 4 > buffer.length) {
    return null;
  }
  const byteLength = buffer.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + byteLength;
  if (end > buffer.length) {
    return null;
  }
  return {
    value: buffer.subarray(start, end).toString("utf8"),
    nextOffset: end,
  };
}

export function parseMetaplexMetadataAccount(base64Data: string): SolanaFungibleMetadata | null {
  try {
    const buffer = Buffer.from(base64Data, "base64");
    if (buffer.length < 65) {
      return null;
    }
    let offset = 1 + 32 + 32;
    const name = readBorshString(buffer, offset);
    if (!name) {
      return null;
    }
    offset = name.nextOffset;
    const symbol = readBorshString(buffer, offset);
    if (!symbol) {
      return null;
    }
    offset = symbol.nextOffset;
    const uri = readBorshString(buffer, offset);
    if (!uri) {
      return null;
    }
    return normalizeResolvedMetadata({
      name: name.value,
      symbol: symbol.value,
      uri: uri.value,
    });
  } catch {
    return null;
  }
}

async function fetchJsonWithTimeout<T>(input: string, timeoutMs: number): Promise<T | null> {
  const response = await fetch(input, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    return null;
  }
  const contentType = String(
    typeof response.headers?.get === "function" ? (response.headers.get("content-type") ?? "") : "",
  ).toLowerCase();
  if (contentType && !contentType.includes("json")) {
    return null;
  }
  return (await response.json()) as T;
}

async function fetchMetadataUriPayload(uri: string): Promise<SolanaMetadataUriPayload | null> {
  const normalizedUri = normalizeExternalAssetUri(uri);
  if (!normalizedUri) {
    return null;
  }
  const cached = readCacheEntry(metadataUriCache, normalizedUri);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const payload = await fetchJsonWithTimeout<Record<string, unknown>>(
      normalizedUri,
      METADATA_URI_TIMEOUT_MS,
    );
    const normalized: SolanaMetadataUriPayload | null = payload
      ? {
          name: typeof payload.name === "string" ? sanitizeMetadataText(payload.name) : undefined,
          symbol:
            typeof payload.symbol === "string" ? sanitizeMetadataText(payload.symbol) : undefined,
          image: normalizeExternalAssetUri(
            typeof payload.image === "string" ? payload.image : undefined,
          ),
          icon: normalizeExternalAssetUri(
            typeof payload.icon === "string" ? payload.icon : undefined,
          ),
          logoURI: normalizeExternalAssetUri(
            typeof payload.logoURI === "string" ? payload.logoURI : undefined,
          ),
        }
      : null;
    return writeCacheEntry(metadataUriCache, normalizedUri, normalized, METADATA_URI_CACHE_TTL_MS);
  } catch {
    return writeCacheEntry(metadataUriCache, normalizedUri, null, METADATA_URI_CACHE_TTL_MS);
  }
}

async function fetchJupiterTokenRecordsByMint(
  mints: string[],
): Promise<Map<string, SolanaJupiterTokenRecord | null>> {
  const out = new Map<string, SolanaJupiterTokenRecord | null>();
  const uniqueMints = [...new Set(mints.map((mint) => mint.trim()).filter(Boolean))];
  const uncached: string[] = [];
  for (const mint of uniqueMints) {
    const cached = readCacheEntry(jupiterTokenCache, mint);
    if (cached !== undefined) {
      out.set(mint, cached);
      continue;
    }
    uncached.push(mint);
  }
  for (let index = 0; index < uncached.length; index += 100) {
    const batch = uncached.slice(index, index + 100);
    if (batch.length === 0) {
      continue;
    }
    try {
      const url = new URL(JUPITER_TOKEN_SEARCH_URL);
      url.searchParams.set("query", batch.join(","));
      const payload = await fetchJsonWithTimeout<unknown[]>(
        url.toString(),
        JUPITER_SEARCH_TIMEOUT_MS,
      );
      const rows = Array.isArray(payload) ? payload : [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (!row || typeof row !== "object") {
          continue;
        }
        const record = row as Record<string, unknown>;
        const mint = readRecordString(record, ["address", "id", "mint"]);
        if (!mint || !batch.includes(mint)) {
          continue;
        }
        seen.add(mint);
        const normalized: SolanaJupiterTokenRecord = {
          symbol:
            typeof record.symbol === "string" ? sanitizeMetadataText(record.symbol) : undefined,
          name: typeof record.name === "string" ? sanitizeMetadataText(record.name) : undefined,
          icon: normalizeExternalAssetUri(
            typeof record.icon === "string"
              ? record.icon
              : typeof record.logoURI === "string"
                ? record.logoURI
                : undefined,
          ),
          tags: Array.isArray(record.tags)
            ? record.tags.filter(
                (tag): tag is string => typeof tag === "string" && tag.trim().length > 0,
              )
            : undefined,
          usdPrice:
            typeof record.usdPrice === "number" && Number.isFinite(record.usdPrice)
              ? record.usdPrice
              : typeof record.priceUsd === "number" && Number.isFinite(record.priceUsd)
                ? record.priceUsd
                : undefined,
          isVerified:
            typeof record.isVerified === "boolean"
              ? record.isVerified
              : Array.isArray(record.tags)
                ? record.tags.some((tag) => String(tag).toLowerCase() === "verified")
                : undefined,
        };
        out.set(
          mint,
          writeCacheEntry(jupiterTokenCache, mint, normalized, JUPITER_TOKEN_CACHE_TTL_MS),
        );
      }
      for (const mint of batch) {
        if (seen.has(mint)) {
          continue;
        }
        out.set(mint, writeCacheEntry(jupiterTokenCache, mint, null, JUPITER_TOKEN_CACHE_TTL_MS));
      }
    } catch {
      for (const mint of batch) {
        out.set(mint, writeCacheEntry(jupiterTokenCache, mint, null, JUPITER_TOKEN_CACHE_TTL_MS));
      }
    }
  }
  return out;
}

function findTokenMetadataCandidate(value: unknown, depth = 0): SolanaFungibleMetadata | null {
  if (!value || depth > 5) {
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findTokenMetadataCandidate(entry, depth + 1);
      if (match) {
        return match;
      }
    }
    return null;
  }
  if (typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const direct = normalizeResolvedMetadata({
    name: typeof record.name === "string" ? record.name : undefined,
    symbol: typeof record.symbol === "string" ? record.symbol : undefined,
    uri: typeof record.uri === "string" ? record.uri : undefined,
  });
  if (direct) {
    return direct;
  }
  for (const key of ["tokenMetadata", "metadata", "state", "value", "info"]) {
    if (key in record) {
      const nested = findTokenMetadataCandidate(record[key], depth + 1);
      if (nested) {
        return nested;
      }
    }
  }
  for (const nestedValue of Object.values(record)) {
    const nested = findTokenMetadataCandidate(nestedValue, depth + 1);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function deriveMetaplexMetadataPda(mint: string): string | null {
  try {
    const metadataProgram = new PublicKey(METAPLEX_METADATA_PROGRAM_ID);
    const mintKey = new PublicKey(mint);
    const [metadataAddress] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), metadataProgram.toBuffer(), mintKey.toBuffer()],
      metadataProgram,
    );
    return metadataAddress.toBase58();
  } catch {
    return null;
  }
}

export function formatTokenAmount(raw: string, decimals: number): string {
  try {
    const base = 10n ** BigInt(Math.max(0, decimals));
    const value = BigInt(String(raw).trim() || "0");
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    const whole = absolute / base;
    const fraction = (absolute % base)
      .toString()
      .padStart(Math.max(0, decimals), "0")
      .replace(/0+$/, "");
    return fraction
      ? `${negative ? "-" : ""}${whole.toString()}.${fraction}`
      : `${negative ? "-" : ""}${whole.toString()}`;
  } catch {
    return "0";
  }
}

export async function fetchSolanaRpc<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<T | null> {
  let release: (() => Promise<void>) | undefined;
  try {
    const guarded = await fetchPinnedSolanaRpcRead({
      rpcUrl,
      timeoutMs: 10_000,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    });
    release = guarded.release;
    const response = guarded.response;
    if (!response.ok) {
      recordSolanaAssetRpcMethod(method, "failure");
      return null;
    }
    const payload = (await response.json()) as {
      result?: T;
      error?: unknown;
    };
    if (payload.error) {
      recordSolanaAssetRpcMethod(method, "failure");
      return null;
    }
    recordSolanaAssetRpcMethod(method, "success");
    return payload.result ?? null;
  } catch {
    recordSolanaAssetRpcMethod(method, "failure");
    return null;
  } finally {
    await release?.();
  }
}

async function fetchSolanaMetadataFromMintViaRpc(params: {
  rpcUrl: string;
  mint: string;
}): Promise<SolanaFungibleMetadata | null> {
  const result = await fetchSolanaAccountInfoViaRpc({
    rpcUrl: params.rpcUrl,
    address: params.mint,
    encoding: "jsonParsed",
  });
  const data = result?.data;
  const extensions =
    typeof data === "object" && !Array.isArray(data) ? data.parsed?.info?.extensions : undefined;
  return findTokenMetadataCandidate(Array.isArray(extensions) ? extensions : null);
}

async function fetchMetaplexMetadataViaRpc(params: {
  rpcUrl: string;
  mint: string;
}): Promise<SolanaFungibleMetadata | null> {
  const metadataAddress = deriveMetaplexMetadataPda(params.mint);
  if (!metadataAddress) {
    return null;
  }
  const result = await fetchSolanaAccountInfoViaRpc({
    rpcUrl: params.rpcUrl,
    address: metadataAddress,
    encoding: "base64",
  });
  const data = result?.data;
  const encoded = Array.isArray(data) ? data[0] : typeof data === "string" ? data : "";
  if (!encoded) {
    return null;
  }
  return parseMetaplexMetadataAccount(encoded);
}

export async function fetchSolanaFungibleMetadataViaRpc(params: {
  rpcUrl: string;
  mint: string;
}): Promise<SolanaFungibleMetadata | null> {
  if (params.mint.trim() === SOLANA_NATIVE_MINT) {
    return { symbol: "SOL", name: "Solana" };
  }
  const metadataFromMint = await fetchSolanaMetadataFromMintViaRpc(params).catch(() => null);
  if (metadataFromMint) {
    return metadataFromMint;
  }
  const metaplexMetadata = await fetchMetaplexMetadataViaRpc(params).catch(() => null);
  if (metaplexMetadata) {
    return metaplexMetadata;
  }
  return null;
}

async function fetchSolanaFungibleMetadataBatchViaRpc(params: {
  rpcUrl: string;
  mints: string[];
}): Promise<Map<string, SolanaFungibleMetadata | null>> {
  const out = new Map<string, SolanaFungibleMetadata | null>();
  const uniqueMints = [...new Set(params.mints.map((mint) => mint.trim()).filter(Boolean))];
  for (const mint of uniqueMints) {
    if (mint === SOLANA_NATIVE_MINT) {
      out.set(mint, { symbol: "SOL", name: "Solana" });
    }
  }
  const mintAccounts = await fetchSolanaAccountInfosViaRpc({
    rpcUrl: params.rpcUrl,
    addresses: uniqueMints.filter((mint) => mint !== SOLANA_NATIVE_MINT),
    encoding: "jsonParsed",
  });
  const metaplexByMint = new Map<string, string>();
  for (const mint of uniqueMints) {
    if (out.has(mint)) {
      continue;
    }
    const data = mintAccounts.get(mint)?.data;
    const extensions =
      typeof data === "object" && !Array.isArray(data) ? data.parsed?.info?.extensions : undefined;
    const metadata = findTokenMetadataCandidate(Array.isArray(extensions) ? extensions : null);
    if (metadata) {
      out.set(mint, metadata);
      continue;
    }
    const metadataAddress = deriveMetaplexMetadataPda(mint);
    if (metadataAddress) {
      metaplexByMint.set(mint, metadataAddress);
    }
  }
  const metaplexAccounts = await fetchSolanaAccountInfosViaRpc({
    rpcUrl: params.rpcUrl,
    addresses: [...metaplexByMint.values()],
    encoding: "base64",
  });
  for (const mint of uniqueMints) {
    if (out.has(mint)) {
      continue;
    }
    const metadataAddress = metaplexByMint.get(mint);
    const data = metadataAddress ? metaplexAccounts.get(metadataAddress)?.data : undefined;
    const encoded = Array.isArray(data) ? data[0] : typeof data === "string" ? data : "";
    out.set(mint, encoded ? parseMetaplexMetadataAccount(encoded) : null);
  }
  return out;
}

export async function fetchSolanaNativeBalanceViaRpc(params: {
  rpcUrl: string;
  ownerAddress: string;
}): Promise<string | null> {
  const result = await fetchSolanaRpcCached<{ value?: number | string }>(
    params.rpcUrl,
    "getBalance",
    [params.ownerAddress],
    SOLANA_WALLET_BALANCE_CACHE_TTL_MS,
  );
  if (result?.value == null) {
    return null;
  }
  return String(result.value);
}

export async function fetchSolanaMintInfoViaRpc(params: {
  rpcUrl: string;
  mint: string;
}): Promise<SolanaMintInfo | null> {
  const value = await fetchSolanaAccountInfoViaRpc({
    rpcUrl: params.rpcUrl,
    address: params.mint,
    encoding: "jsonParsed",
  });
  const owner = String(value?.owner ?? "").trim();
  const data = value?.data;
  const decimals =
    typeof data === "object" && !Array.isArray(data) ? data.parsed?.info?.decimals : undefined;
  if (!owner || !Number.isFinite(decimals)) {
    return null;
  }
  return {
    mint: params.mint,
    tokenProgramId: owner,
    decimals: Math.max(0, Number(decimals)),
  };
}

export async function fetchSolanaTokenBalanceViaRpc(params: {
  rpcUrl: string;
  ownerAddress: string;
  mint: string;
}): Promise<{ amountRaw: string; decimals: number; tokenProgramId: string } | null> {
  let total = 0n;
  let decimals: number | null = null;
  let matchedProgramId: string | null = null;
  const mint = params.mint.trim();
  if (!mint) {
    return null;
  }
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const entries = await fetchSolanaTokenAccountsByOwnerViaRpc({
      rpcUrl: params.rpcUrl,
      ownerAddress: params.ownerAddress,
      programId,
    });
    for (const entry of entries) {
      const info = entry?.account?.data?.parsed?.info;
      if (String(info?.mint ?? "").trim() !== mint) {
        continue;
      }
      const amountRawText = String(info?.tokenAmount?.amount ?? "").trim();
      const tokenDecimals = Number(info?.tokenAmount?.decimals ?? 0);
      if (!amountRawText || !Number.isFinite(tokenDecimals)) {
        continue;
      }
      try {
        total += BigInt(amountRawText);
      } catch {
        continue;
      }
      decimals = Math.max(0, Math.floor(tokenDecimals));
      matchedProgramId = programId;
    }
  }
  if (!matchedProgramId || decimals === null) {
    return null;
  }
  return {
    amountRaw: total.toString(),
    decimals,
    tokenProgramId: matchedProgramId,
  };
}

export async function fetchSolanaWalletAssetsViaRpc(params: {
  rpcUrl: string;
  ownerAddress: string;
  nativeLamports?: string | null;
}): Promise<SolanaWalletAsset[]> {
  const assets = new Map<
    string,
    {
      mint: string;
      tokenProgramId: string;
      decimals: number;
      amountRaw: bigint;
      address?: string;
    }
  >();
  const programIds = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  for (const programId of programIds) {
    const entries = await fetchSolanaTokenAccountsByOwnerViaRpc({
      rpcUrl: params.rpcUrl,
      ownerAddress: params.ownerAddress,
      programId,
    });
    for (const entry of entries) {
      const mint = String(entry?.account?.data?.parsed?.info?.mint ?? "").trim();
      const amountRawText = String(
        entry?.account?.data?.parsed?.info?.tokenAmount?.amount ?? "",
      ).trim();
      const decimals = Number(entry?.account?.data?.parsed?.info?.tokenAmount?.decimals ?? 0);
      if (!mint || !amountRawText || !Number.isFinite(decimals)) {
        continue;
      }
      let amountRaw: bigint;
      try {
        amountRaw = BigInt(amountRawText);
      } catch {
        continue;
      }
      if (amountRaw <= 0n) {
        continue;
      }
      const key = `${programId}:${mint}`;
      const existing = assets.get(key);
      if (existing) {
        existing.amountRaw += amountRaw;
        if (!existing.address && entry?.pubkey) {
          existing.address = entry.pubkey;
        }
        continue;
      }
      assets.set(key, {
        mint,
        tokenProgramId: programId,
        decimals: Math.max(0, Math.floor(decimals)),
        amountRaw,
        address: entry?.pubkey,
      });
    }
  }

  const nativeRaw =
    params.nativeLamports ?? (await fetchSolanaNativeBalanceViaRpc(params).catch(() => null));
  const resolvedMetadata = new Map<string, SolanaFungibleMetadata>();
  const batchedMetadata = await fetchSolanaFungibleMetadataBatchViaRpc({
    rpcUrl: params.rpcUrl,
    mints: [...assets.values()].map((asset) => asset.mint),
  }).catch(() => new Map<string, SolanaFungibleMetadata | null>());
  for (const asset of assets.values()) {
    const metadata = batchedMetadata.get(asset.mint) ?? null;
    resolvedMetadata.set(asset.mint, metadata ?? fallbackSolanaAssetMetadata(asset.mint));
  }
  const metadataUriPayloads = new Map<string, SolanaMetadataUriPayload | null>();
  await Promise.all(
    [...resolvedMetadata.entries()].map(async ([mint, metadata]) => {
      if (!metadata.uri) {
        metadataUriPayloads.set(mint, null);
        return;
      }
      const payload = await fetchMetadataUriPayload(metadata.uri).catch(() => null);
      metadataUriPayloads.set(mint, payload);
    }),
  );
  const jupiterRecords = await fetchJupiterTokenRecordsByMint(
    [...assets.values()].map((asset) => asset.mint),
  );
  const out: SolanaWalletAsset[] = [];
  if (nativeRaw) {
    const nativeAmount = BigInt(nativeRaw);
    const meta = { symbol: "SOL", name: "Solana" };
    out.push({
      id: "solana:native",
      chain: "solana",
      kind: "native",
      symbol: meta.symbol,
      name: meta.name,
      amountRaw: nativeAmount.toString(),
      amountDisplay: formatTokenAmount(nativeAmount.toString(), 9),
      decimals: 9,
      unit: "lamports",
      isNative: true,
      address: params.ownerAddress,
    });
  }
  for (const asset of assets.values()) {
    const meta = resolvedMetadata.get(asset.mint) ?? fallbackSolanaAssetMetadata(asset.mint);
    const metadataUriPayload = metadataUriPayloads.get(asset.mint) ?? null;
    const jupiterRecord = jupiterRecords.get(asset.mint) ?? null;
    const amountDisplay = formatTokenAmount(asset.amountRaw.toString(), asset.decimals);
    const amountNumber = toDisplayNumber(amountDisplay);
    const symbol = jupiterRecord?.symbol || metadataUriPayload?.symbol || meta.symbol;
    const name = jupiterRecord?.name || metadataUriPayload?.name || meta.name;
    const logoUri =
      jupiterRecord?.icon ||
      metadataUriPayload?.logoURI ||
      metadataUriPayload?.icon ||
      metadataUriPayload?.image;
    const priceUsd =
      typeof jupiterRecord?.usdPrice === "number" ? jupiterRecord.usdPrice : undefined;
    out.push({
      id: `solana:spl-token:${asset.mint}`,
      chain: "solana",
      kind: "spl-token",
      symbol,
      name,
      amountRaw: asset.amountRaw.toString(),
      amountDisplay,
      decimals: asset.decimals,
      unit: "raw",
      isNative: false,
      address: asset.address,
      program: asset.mint,
      tokenProgramId: asset.tokenProgramId,
      metadataUri: meta.uri,
      logoUri,
      verificationStatus:
        typeof jupiterRecord?.isVerified === "boolean"
          ? jupiterRecord.isVerified
            ? "verified"
            : "unverified"
          : "unknown",
      verificationSource:
        typeof jupiterRecord?.isVerified === "boolean"
          ? "jupiter"
          : logoUri
            ? "metadata-uri"
            : "unknown",
      priceUsd,
      valueUsd:
        priceUsd !== undefined && amountNumber !== undefined
          ? Number((priceUsd * amountNumber).toFixed(6))
          : undefined,
      tags: jupiterRecord?.tags,
    });
  }
  return out.toSorted((left, right) => {
    if (left.isNative !== right.isNative) {
      return left.isNative ? -1 : 1;
    }
    return left.symbol.localeCompare(right.symbol);
  });
}

export const SOLANA_ASSET_CONSTANTS = {
  nativeMint: SOLANA_NATIVE_MINT,
  tokenProgramId: TOKEN_PROGRAM_ID,
  token2022ProgramId: TOKEN_2022_PROGRAM_ID,
  metaplexMetadataProgramId: METAPLEX_METADATA_PROGRAM_ID,
} as const;

export function invalidateSolanaAssetRpcCaches(): void {
  metadataUriCache.clear();
  jupiterTokenCache.clear();
  rpcResultCache.clear();
  rpcInFlight.clear();
  accountInfoCache.clear();
  tokenAccountsCache.clear();
}

export function summarizeSolanaAssetRpcMetrics(): {
  startedAt: string;
  methods: Array<
    {
      method: string;
    } & SolanaAssetRpcMethodMetrics
  >;
} {
  return {
    startedAt: solanaAssetRpcStartedAt,
    methods: [...solanaAssetRpcMetrics.entries()]
      .map(([method, metrics]) => ({ method, ...metrics }))
      .toSorted((left, right) => left.method.localeCompare(right.method)),
  };
}
