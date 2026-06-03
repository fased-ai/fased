import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePreferredFasedAgentTmpDir } from "./tmp-fased-dir.js";

const DEFAULT_CLAWHUB_REGISTRY = "https://clawhub.com";
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export type FasedHubSkillSearchResult = {
  score: number;
  slug: string;
  displayName: string;
  summary?: string;
  version?: string;
  updatedAt?: number;
};

export type FasedHubSkillDetail = {
  skill: {
    slug: string;
    displayName: string;
    summary?: string;
    tags?: Record<string, string>;
    createdAt: number;
    updatedAt: number;
  } | null;
  latestVersion?: {
    version: string;
    createdAt: number;
    changelog?: string;
  } | null;
  metadata?: {
    os?: string[] | null;
    systems?: string[] | null;
  } | null;
  owner?: {
    handle?: string | null;
    displayName?: string | null;
    image?: string | null;
  } | null;
};

export type FasedHubSkillListResponse = {
  items: Array<{
    slug: string;
    displayName: string;
    summary?: string;
    tags?: Record<string, string>;
    latestVersion?: {
      version: string;
      createdAt: number;
      changelog?: string;
    } | null;
    metadata?: {
      os?: string[] | null;
      systems?: string[] | null;
    } | null;
    createdAt: number;
    updatedAt: number;
  }>;
  nextCursor?: string | null;
};

export type FasedHubDownloadResult = {
  archivePath: string;
  integrity: string;
  cleanup: () => Promise<void>;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type FasedHubRequestParams = {
  baseUrl?: string;
  path: string;
  token?: string;
  timeoutMs?: number;
  search?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
};

type FasedHubConfigLike = {
  token?: unknown;
  accessToken?: unknown;
  authToken?: unknown;
  apiToken?: unknown;
  auth?: FasedHubConfigLike | null;
  session?: FasedHubConfigLike | null;
  credentials?: FasedHubConfigLike | null;
  user?: FasedHubConfigLike | null;
};

export class FasedHubRequestError extends Error {
  readonly status: number;
  readonly requestPath: string;
  readonly responseBody: string;

  constructor(params: { path: string; status: number; body: string }) {
    super(`ClawHub ${params.path} failed (${params.status}): ${params.body}`);
    this.name = "ClawHubRequestError";
    this.status = params.status;
    this.requestPath = params.path;
    this.responseBody = params.body;
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeBaseUrl(baseUrl?: string): string {
  const envValue =
    normalizeOptionalString(process.env.CLAWHUB_REGISTRY) ||
    normalizeOptionalString(process.env.FASED_CLAWHUB_REGISTRY) ||
    normalizeOptionalString(process.env.CLAWHUB_URL) ||
    normalizeOptionalString(process.env.FASED_CLAWHUB_URL) ||
    normalizeOptionalString(process.env.FASEDHUB_REGISTRY) ||
    normalizeOptionalString(process.env.FASEDHUB_URL) ||
    DEFAULT_CLAWHUB_REGISTRY;
  const value = (normalizeOptionalString(baseUrl) || envValue).replace(/\/+$/, "");
  return value || DEFAULT_CLAWHUB_REGISTRY;
}

export function resolveFasedHubBaseUrl(baseUrl?: string): string {
  return normalizeBaseUrl(baseUrl);
}

export function resolveFasedHubWorkdir(cwd = process.cwd()): string {
  return path.resolve(
    normalizeOptionalString(process.env.CLAWHUB_WORKDIR) ||
      normalizeOptionalString(process.env.FASED_CLAWHUB_WORKDIR) ||
      normalizeOptionalString(process.env.FASEDHUB_WORKDIR) ||
      cwd,
  );
}

function extractTokenFromFasedHubConfig(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as FasedHubConfigLike;
  return (
    normalizeOptionalString(record.accessToken) ??
    normalizeOptionalString(record.authToken) ??
    normalizeOptionalString(record.apiToken) ??
    normalizeOptionalString(record.token) ??
    extractTokenFromFasedHubConfig(record.auth) ??
    extractTokenFromFasedHubConfig(record.session) ??
    extractTokenFromFasedHubConfig(record.credentials) ??
    extractTokenFromFasedHubConfig(record.user)
  );
}

export function resolveFasedHubConfigPaths(): string[] {
  const explicit =
    normalizeOptionalString(process.env.CLAWHUB_CONFIG_PATH) ||
    normalizeOptionalString(process.env.FASED_CLAWHUB_CONFIG_PATH) ||
    normalizeOptionalString(process.env.FASEDHUB_CONFIG_PATH) ||
    normalizeOptionalString(process.env.CLAWDHUB_CONFIG_PATH);
  if (explicit) {
    return [explicit];
  }

  const xdgConfigHome = normalizeOptionalString(process.env.XDG_CONFIG_HOME);
  const configHome =
    xdgConfigHome && xdgConfigHome.length > 0 ? xdgConfigHome : path.join(os.homedir(), ".config");
  const legacyClawHubXdgPath = path.join(configHome, "clawhub", "config.json");
  const fasedHubXdgPath = path.join(configHome, "fasedhub", "config.json");

  if (process.platform === "darwin") {
    return [
      path.join(os.homedir(), "Library", "Application Support", "clawhub", "config.json"),
      legacyClawHubXdgPath,
      path.join(os.homedir(), "Library", "Application Support", "fasedhub", "config.json"),
      fasedHubXdgPath,
    ];
  }

  return [legacyClawHubXdgPath, fasedHubXdgPath];
}

export async function resolveFasedHubAuthToken(): Promise<string | undefined> {
  const envToken =
    normalizeOptionalString(process.env.CLAWHUB_TOKEN) ||
    normalizeOptionalString(process.env.CLAWHUB_AUTH_TOKEN) ||
    normalizeOptionalString(process.env.FASED_CLAWHUB_TOKEN) ||
    normalizeOptionalString(process.env.FASEDHUB_TOKEN) ||
    normalizeOptionalString(process.env.FASEDHUB_AUTH_TOKEN);
  if (envToken) {
    return envToken;
  }

  for (const configPath of resolveFasedHubConfigPaths()) {
    try {
      const raw = await fs.readFile(configPath, "utf8");
      const token = extractTokenFromFasedHubConfig(JSON.parse(raw));
      if (token) {
        return token;
      }
    } catch {
      // Try the next candidate path.
    }
  }
  return undefined;
}

function buildUrl(params: Pick<FasedHubRequestParams, "baseUrl" | "path" | "search">): URL {
  const url = new URL(params.path, `${normalizeBaseUrl(params.baseUrl)}/`);
  for (const [key, value] of Object.entries(params.search ?? {})) {
    if (!value) {
      continue;
    }
    url.searchParams.set(key, value);
  }
  return url;
}

async function fasedHubRequest(
  params: FasedHubRequestParams,
): Promise<{ response: Response; url: URL }> {
  const url = buildUrl(params);
  const token = normalizeOptionalString(params.token) || (await resolveFasedHubAuthToken());
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new Error(
          `ClawHub request timed out after ${params.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS}ms`,
        ),
      ),
    params.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await (params.fetchImpl ?? fetch)(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: controller.signal,
    });
    return { response, url };
  } finally {
    clearTimeout(timeout);
  }
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text || response.statusText || `HTTP ${response.status}`;
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}

async function fetchJson<T>(params: FasedHubRequestParams): Promise<T> {
  const { response, url } = await fasedHubRequest(params);
  if (!response.ok) {
    throw new FasedHubRequestError({
      path: url.pathname,
      status: response.status,
      body: await readErrorBody(response),
    });
  }
  return (await response.json()) as T;
}

function formatSha256Integrity(bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest("base64");
  return `sha256-${digest}`;
}

function sanitizeTempFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const normalized = base.replace(/^-+|-+$/g, "");
  return normalized || "download.bin";
}

async function createTempDownloadTarget(params: {
  prefix: string;
  fileName: string;
}): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(resolvePreferredFasedAgentTmpDir(), `${params.prefix}-`));
  return {
    path: path.join(dir, sanitizeTempFileName(params.fileName)),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

export async function searchFasedHubSkills(params: {
  query: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  limit?: number;
}): Promise<FasedHubSkillSearchResult[]> {
  const result = await fetchJson<{ results: FasedHubSkillSearchResult[] }>({
    baseUrl: params.baseUrl,
    path: "/api/v1/search",
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: {
      q: params.query.trim(),
      limit: params.limit ? String(params.limit) : undefined,
    },
  });
  return result.results ?? [];
}

export async function fetchFasedHubSkillDetail(params: {
  slug: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<FasedHubSkillDetail> {
  return await fetchJson<FasedHubSkillDetail>({
    baseUrl: params.baseUrl,
    path: `/api/v1/skills/${encodeURIComponent(params.slug)}`,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
}

export async function listFasedHubSkills(params: {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  limit?: number;
}): Promise<FasedHubSkillListResponse> {
  return await fetchJson<FasedHubSkillListResponse>({
    baseUrl: params.baseUrl,
    path: "/api/v1/skills",
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: {
      limit: params.limit ? String(params.limit) : undefined,
    },
  });
}

export async function downloadFasedHubSkillArchive(params: {
  slug: string;
  version?: string;
  tag?: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<FasedHubDownloadResult> {
  const { response, url } = await fasedHubRequest({
    baseUrl: params.baseUrl,
    path: "/api/v1/download",
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: {
      slug: params.slug,
      version: params.version,
      tag: params.version ? undefined : params.tag,
    },
  });
  if (!response.ok) {
    throw new FasedHubRequestError({
      path: url.pathname,
      status: response.status,
      body: await readErrorBody(response),
    });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const target = await createTempDownloadTarget({
    prefix: "clawhub-skill",
    fileName: `${params.slug}.zip`,
  });
  await fs.writeFile(target.path, bytes);
  return {
    archivePath: target.path,
    integrity: formatSha256Integrity(bytes),
    cleanup: target.cleanup,
  };
}

export type ClawHubSkillSearchResult = FasedHubSkillSearchResult;
export type ClawHubSkillDetail = FasedHubSkillDetail;
export type ClawHubSkillListResponse = FasedHubSkillListResponse;
export type ClawHubDownloadResult = FasedHubDownloadResult;

export const resolveClawHubBaseUrl = resolveFasedHubBaseUrl;
export const resolveClawHubAuthToken = resolveFasedHubAuthToken;
export const searchClawHubSkills = searchFasedHubSkills;
export const fetchClawHubSkillDetail = fetchFasedHubSkillDetail;
export const listClawHubSkills = listFasedHubSkills;
export const downloadClawHubSkillArchive = downloadFasedHubSkillArchive;
