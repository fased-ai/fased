import { PublicKey } from "@solana/web3.js";
import {
  fetchSolanaFungibleMetadataViaRpc,
  fetchSolanaMintInfoViaRpc,
  fetchSolanaRpc,
  formatTokenAmount,
  SOLANA_ASSET_CONSTANTS,
} from "./solana-assets.js";

const JUPITER_TOKEN_SEARCH_URL = "https://lite-api.jup.ag/ultra/v1/search";
const JUPITER_TOKEN_SEARCH_TIMEOUT_MS = 2_500;

export type SolanaResolvedToken = {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUri?: string;
  verified?: boolean;
  source: "native" | "mint" | "jupiter" | "metaplex" | "das";
};

export type SolanaTokenSearchResult = {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUri?: string;
  verified?: boolean;
  source: "native" | "jupiter" | "mint";
  exactMint: boolean;
};

type JupiterTokenRecord = {
  mint: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  logoUri?: string;
  verified?: boolean;
};

type DasTokenRecord = {
  symbol?: string;
  name?: string;
  decimals?: number;
  logoUri?: string;
};

function sanitizeText(value: unknown): string {
  const raw =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";
  return raw.replaceAll("\u0000", "").replace(/\s+/g, " ").trim();
}

function normalizeExternalAssetUri(value: unknown): string | undefined {
  const raw = sanitizeText(value);
  if (!raw) {
    return undefined;
  }
  if (raw.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${raw.slice("ipfs://".length).replace(/^ipfs\//, "")}`;
  }
  if (raw.startsWith("ar://")) {
    return `https://arweave.net/${raw.slice("ar://".length)}`;
  }
  return /^https?:\/\//i.test(raw) ? raw : undefined;
}

function shortMintLabel(value: string): string {
  const mint = value.trim();
  return mint.length <= 12 ? mint || "TOKEN" : `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function isValidSolanaAddress(value: string): boolean {
  try {
    return new PublicKey(value).toBase58() === value.trim();
  } catch {
    return false;
  }
}

function readRecordString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
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
  return (await response.json().catch(() => null)) as T | null;
}

async function fetchJupiterTokenSearch(query: string): Promise<JupiterTokenRecord[]> {
  const url = new URL(JUPITER_TOKEN_SEARCH_URL);
  url.searchParams.set("query", query);
  const rows = await fetchJsonWithTimeout<unknown[]>(
    url.toString(),
    JUPITER_TOKEN_SEARCH_TIMEOUT_MS,
  );
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows
    .map((row): JupiterTokenRecord | null => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        return null;
      }
      const record = row as Record<string, unknown>;
      const mint = readRecordString(record, ["address", "id", "mint"]);
      if (!mint || !isValidSolanaAddress(mint)) {
        return null;
      }
      const tags = Array.isArray(record.tags) ? record.tags.map((tag) => String(tag)) : [];
      return {
        mint,
        symbol: sanitizeText(record.symbol) || undefined,
        name: sanitizeText(record.name) || undefined,
        decimals:
          typeof record.decimals === "number" && Number.isFinite(record.decimals)
            ? Math.max(0, Math.floor(record.decimals))
            : undefined,
        logoUri:
          normalizeExternalAssetUri(record.icon) ?? normalizeExternalAssetUri(record.logoURI),
        verified:
          typeof record.isVerified === "boolean"
            ? record.isVerified
            : tags.some((tag) => tag.toLowerCase() === "verified"),
      };
    })
    .filter((row): row is JupiterTokenRecord => Boolean(row));
}

async function fetchDasTokenMetadata(params: {
  rpcUrl?: string;
  mint: string;
}): Promise<DasTokenRecord | null> {
  if (!params.rpcUrl?.trim()) {
    return null;
  }
  const result = await fetchSolanaRpc<Record<string, unknown>>(params.rpcUrl, "getAsset", [
    { id: params.mint },
  ]).catch(() => null);
  if (!result || typeof result !== "object") {
    return null;
  }
  const content =
    result.content && typeof result.content === "object" && !Array.isArray(result.content)
      ? (result.content as Record<string, unknown>)
      : {};
  const metadata =
    content.metadata && typeof content.metadata === "object" && !Array.isArray(content.metadata)
      ? (content.metadata as Record<string, unknown>)
      : {};
  const links =
    content.links && typeof content.links === "object" && !Array.isArray(content.links)
      ? (content.links as Record<string, unknown>)
      : {};
  const tokenInfo =
    result.token_info && typeof result.token_info === "object" && !Array.isArray(result.token_info)
      ? (result.token_info as Record<string, unknown>)
      : {};
  const symbol = sanitizeText(metadata.symbol);
  const name = sanitizeText(metadata.name);
  const logoUri = normalizeExternalAssetUri(links.image) ?? normalizeExternalAssetUri(links.icon);
  const decimals =
    typeof tokenInfo.decimals === "number" && Number.isFinite(tokenInfo.decimals)
      ? Math.max(0, Math.floor(tokenInfo.decimals))
      : undefined;
  if (!symbol && !name && !logoUri && decimals === undefined) {
    return null;
  }
  return { symbol: symbol || undefined, name: name || undefined, logoUri, decimals };
}

function pickUnambiguousToken(params: {
  query: string;
  records: JupiterTokenRecord[];
}): JupiterTokenRecord | null {
  const normalized = params.query.trim().toLowerCase();
  const exact = params.records.filter(
    (record) =>
      record.symbol?.trim().toLowerCase() === normalized ||
      record.name?.trim().toLowerCase() === normalized,
  );
  const candidates = exact.length > 0 ? exact : params.records;
  const verified = candidates.filter((record) => record.verified === true);
  if (verified.length === 1) {
    return verified[0] ?? null;
  }
  if (candidates.length === 1) {
    return candidates[0] ?? null;
  }
  return null;
}

export function normalizeTokenAmountToBaseUnits(params: {
  amountRaw: string | undefined;
  amountFormat: "base" | "human";
  decimals: number;
  symbol?: string;
}): string {
  const raw = params.amountRaw?.trim();
  if (!raw) {
    throw new Error("amount required");
  }
  if (params.amountFormat === "base") {
    const parsed = BigInt(raw);
    if (parsed <= 0n) {
      throw new Error("amount must be positive base units");
    }
    return parsed.toString();
  }
  if (!/^[0-9]+(\.[0-9]+)?$/.test(raw)) {
    throw new Error("human amount must be a positive decimal number");
  }
  const decimals = Math.max(0, Math.floor(params.decimals));
  const [wholePart, fracPartRaw = ""] = raw.split(".");
  if (fracPartRaw.length > decimals) {
    throw new Error(
      `${params.symbol ?? "token"} amount supports at most ${String(decimals)} decimals`,
    );
  }
  return (
    BigInt(wholePart || "0") * 10n ** BigInt(decimals) +
    BigInt(fracPartRaw.padEnd(decimals, "0"))
  ).toString();
}

export function formatResolvedTokenAmount(
  raw: string,
  token: Pick<SolanaResolvedToken, "decimals">,
) {
  return formatTokenAmount(raw, token.decimals);
}

function jupiterRecordToSearchResult(
  record: JupiterTokenRecord,
  query: string,
): SolanaTokenSearchResult {
  const normalizedQuery = query.trim().toLowerCase();
  return {
    mint: record.mint,
    symbol: record.symbol || shortMintLabel(record.mint).toUpperCase(),
    name: record.name || `Token ${shortMintLabel(record.mint)}`,
    decimals: Number.isFinite(record.decimals) ? Math.max(0, Math.floor(record.decimals ?? 0)) : 0,
    logoUri: record.logoUri,
    verified: record.verified,
    source: "jupiter",
    exactMint:
      record.mint === query.trim() || record.symbol?.trim().toLowerCase() === normalizedQuery,
  };
}

export async function searchSolanaTokens(params: {
  query: string;
  rpcUrl?: string;
  limit?: number;
}): Promise<SolanaTokenSearchResult[]> {
  const raw = params.query.trim();
  if (!raw) {
    return [];
  }
  const limit = Math.max(1, Math.min(25, Math.floor(params.limit ?? 12)));
  if (raw.toLowerCase() === "sol" || raw === SOLANA_ASSET_CONSTANTS.nativeMint) {
    return [
      {
        mint: SOLANA_ASSET_CONSTANTS.nativeMint,
        symbol: "SOL",
        name: "Solana",
        decimals: 9,
        verified: true,
        source: "native",
        exactMint: true,
      },
    ];
  }

  const records = await fetchJupiterTokenSearch(raw).catch(() => []);
  const results = records.map((record) => jupiterRecordToSearchResult(record, raw));
  if (isValidSolanaAddress(raw) && !results.some((result) => result.mint === raw)) {
    const resolved = await resolveSolanaToken({ mint: raw, rpcUrl: params.rpcUrl }).catch(
      () => null,
    );
    if (resolved) {
      results.unshift({
        mint: resolved.mint,
        symbol: resolved.symbol,
        name: resolved.name,
        decimals: resolved.decimals,
        logoUri: resolved.logoUri,
        verified: resolved.verified,
        source: resolved.source === "native" ? "native" : "mint",
        exactMint: true,
      });
    }
  }

  const seen = new Set<string>();
  return results
    .filter((result) => {
      if (seen.has(result.mint)) {
        return false;
      }
      seen.add(result.mint);
      return true;
    })
    .slice(0, limit);
}

export async function resolveSolanaToken(params: {
  query?: string;
  mint?: string;
  rpcUrl?: string;
}): Promise<SolanaResolvedToken> {
  const raw = (params.mint || params.query || "").trim();
  if (!raw || raw.toLowerCase() === "sol" || raw === SOLANA_ASSET_CONSTANTS.nativeMint) {
    return {
      mint: SOLANA_ASSET_CONSTANTS.nativeMint,
      symbol: "SOL",
      name: "Solana",
      decimals: 9,
      source: "native",
      verified: true,
    };
  }

  let jupiter: JupiterTokenRecord | null = null;
  if (isValidSolanaAddress(raw)) {
    jupiter =
      (await fetchJupiterTokenSearch(raw).catch(() => [])).find((record) => record.mint === raw) ??
      null;
  } else {
    const records = await fetchJupiterTokenSearch(raw).catch(() => []);
    jupiter = pickUnambiguousToken({ query: raw, records });
    if (!jupiter) {
      throw new Error(
        records.length > 1
          ? `token symbol/name is ambiguous: ${raw}; use the exact mint`
          : `token not found: ${raw}; use the exact mint`,
      );
    }
  }

  const mint = jupiter?.mint ?? raw;
  if (!isValidSolanaAddress(mint)) {
    throw new Error(`invalid Solana token mint: ${raw}`);
  }

  const [mintInfo, rpcMetadata, dasMetadata] = await Promise.all([
    params.rpcUrl
      ? fetchSolanaMintInfoViaRpc({ rpcUrl: params.rpcUrl, mint }).catch(() => null)
      : Promise.resolve(null),
    params.rpcUrl
      ? fetchSolanaFungibleMetadataViaRpc({ rpcUrl: params.rpcUrl, mint }).catch(() => null)
      : Promise.resolve(null),
    fetchDasTokenMetadata({ rpcUrl: params.rpcUrl, mint }).catch(() => null),
  ]);
  const symbol =
    jupiter?.symbol ||
    dasMetadata?.symbol ||
    rpcMetadata?.symbol ||
    shortMintLabel(mint).toUpperCase();
  const name =
    jupiter?.name || dasMetadata?.name || rpcMetadata?.name || `Token ${shortMintLabel(mint)}`;
  const decimals = jupiter?.decimals ?? dasMetadata?.decimals ?? mintInfo?.decimals;
  return {
    mint,
    symbol,
    name,
    decimals: Number.isFinite(decimals) ? Math.max(0, Math.floor(decimals ?? 0)) : 0,
    logoUri: jupiter?.logoUri || dasMetadata?.logoUri,
    verified: jupiter?.verified,
    source: jupiter ? "jupiter" : dasMetadata ? "das" : rpcMetadata ? "metaplex" : "mint",
  };
}
