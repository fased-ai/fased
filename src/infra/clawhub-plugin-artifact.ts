import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolvePreferredFasedAgentTmpDir } from "./tmp-fased-dir.js";

const DEFAULT_ALLOWED_CLAWHUB_ORIGINS = ["https://clawhub.com"];
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ClawHubArtifactVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClawHubArtifactVerificationError";
  }
}

export type ClawHubArtifactQuarantineResult = {
  artifactPath: string;
  quarantineDir: string;
  sha256: string;
  integrity: string;
  size: number;
  cleanup: () => Promise<void>;
};

function normalizeOrigin(value?: string): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function normalizeAllowedOrigins(values: readonly string[]): Set<string> {
  return new Set(
    values
      .map((origin) => normalizeOrigin(origin))
      .filter((origin): origin is string => Boolean(origin)),
  );
}

function sanitizeArtifactFileName(record: PluginInstallRecord): string {
  const packageLabel = (record.clawhubPackage || "plugin")
    .replace(/^@/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const versionLabel = (record.version || "artifact")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const extension = record.artifactFormat === "tgz" ? "tgz" : "zip";
  return `${packageLabel || "plugin"}-${versionLabel || "artifact"}.${extension}`;
}

async function createQuarantineTarget(
  record: PluginInstallRecord,
): Promise<{ dir: string; path: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(
    path.join(resolvePreferredFasedAgentTmpDir(), "clawhub-plugin-quarantine-"),
  );
  return {
    dir,
    path: path.join(dir, sanitizeArtifactFileName(record)),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function parseExpectedIntegrity(
  integrity?: string,
): { algorithm: string; digest: string } | undefined {
  if (!integrity?.trim()) {
    return undefined;
  }
  const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/=]+)$/u.exec(integrity.trim());
  if (!match) {
    throw new ClawHubArtifactVerificationError(
      `unsupported ClawHub artifact integrity format: ${integrity}`,
    );
  }
  return { algorithm: match[1], digest: match[2] };
}

function verifyIntegrity(bytes: Uint8Array, expectedIntegrity?: string): string {
  const expected = parseExpectedIntegrity(expectedIntegrity);
  if (!expected) {
    throw new ClawHubArtifactVerificationError(
      "ClawHub artifact integrity is required before download",
    );
  }
  const actual = createHash(expected.algorithm).update(bytes).digest("base64");
  if (actual !== expected.digest) {
    throw new ClawHubArtifactVerificationError(
      `ClawHub artifact integrity mismatch: expected ${expectedIntegrity}, got ${expected.algorithm}-${actual}`,
    );
  }
  return `${expected.algorithm}-${actual}`;
}

function normalizeSha256(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^[a-f0-9]{64}$/iu.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (trimmed.startsWith("sha256-")) {
    const digest = Buffer.from(trimmed.slice("sha256-".length), "base64").toString("hex");
    if (/^[a-f0-9]{64}$/iu.test(digest)) {
      return digest.toLowerCase();
    }
  }
  return undefined;
}

function verifySha256(bytes: Uint8Array, expectedSha256?: string): string {
  const actual = createHash("sha256").update(bytes).digest("hex");
  const expected = normalizeSha256(expectedSha256);
  if (!expected) {
    throw new ClawHubArtifactVerificationError(
      "ClawHub artifact sha256 metadata is required before download",
    );
  }
  if (actual !== expected) {
    throw new ClawHubArtifactVerificationError(
      `ClawHub artifact sha256 mismatch: expected ${expected}, got ${actual}`,
    );
  }
  return actual;
}

function assertAllowedOrigin(params: {
  record: PluginInstallRecord;
  allowedOrigins: readonly string[];
}): URL {
  if (params.record.source !== "clawhub") {
    throw new ClawHubArtifactVerificationError(
      `ClawHub artifact resolver requires source=clawhub, got ${params.record.source}`,
    );
  }
  if (!params.record.clawhubArtifactUrl) {
    throw new ClawHubArtifactVerificationError("ClawHub artifact URL is required");
  }
  const registryOrigin = normalizeOrigin(params.record.clawhubUrl);
  let artifactUrl: URL;
  try {
    artifactUrl = new URL(params.record.clawhubArtifactUrl);
  } catch {
    throw new ClawHubArtifactVerificationError("ClawHub artifact URL is invalid");
  }
  if (artifactUrl.protocol !== "https:") {
    throw new ClawHubArtifactVerificationError("ClawHub artifact URL must use HTTPS");
  }
  const allowed = normalizeAllowedOrigins(params.allowedOrigins);
  if (registryOrigin && !allowed.has(registryOrigin)) {
    throw new ClawHubArtifactVerificationError(
      `ClawHub registry is not allowlisted: ${registryOrigin}`,
    );
  }
  if (!allowed.has(artifactUrl.origin)) {
    throw new ClawHubArtifactVerificationError(
      `ClawHub artifact origin is not allowlisted: ${artifactUrl.origin}`,
    );
  }
  if (registryOrigin && artifactUrl.origin !== registryOrigin) {
    throw new ClawHubArtifactVerificationError(
      `ClawHub artifact origin does not match registry: ${artifactUrl.origin}`,
    );
  }
  return artifactUrl;
}

async function fetchArtifactBytes(params: {
  artifactUrl: URL;
  fetchImpl?: FetchLike;
  timeoutMs: number;
}): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new Error(`ClawHub artifact download timed out after ${params.timeoutMs}ms`),
      ),
    params.timeoutMs,
  );
  try {
    const response = await (params.fetchImpl ?? fetch)(params.artifactUrl, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ClawHubArtifactVerificationError(
        `ClawHub artifact download failed (${response.status})`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveClawHubPluginArtifactToQuarantine(params: {
  install: PluginInstallRecord;
  allowedOrigins?: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubArtifactQuarantineResult> {
  const artifactUrl = assertAllowedOrigin({
    record: params.install,
    allowedOrigins: params.allowedOrigins ?? DEFAULT_ALLOWED_CLAWHUB_ORIGINS,
  });
  const bytes = await fetchArtifactBytes({
    artifactUrl,
    fetchImpl: params.fetchImpl,
    timeoutMs: params.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  });
  const maxBytes = params.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  if (bytes.byteLength > maxBytes) {
    throw new ClawHubArtifactVerificationError(
      `ClawHub artifact exceeds maximum size: ${bytes.byteLength} > ${maxBytes}`,
    );
  }
  if (
    typeof params.install.clawpackSize === "number" &&
    bytes.byteLength !== params.install.clawpackSize
  ) {
    throw new ClawHubArtifactVerificationError(
      `ClawHub artifact size mismatch: expected ${params.install.clawpackSize}, got ${bytes.byteLength}`,
    );
  }

  const integrity = verifyIntegrity(bytes, params.install.integrity);
  const expectedSha256 =
    params.install.clawpackSha256 ??
    (params.install.integrity?.startsWith("sha256-") ? params.install.integrity : undefined);
  const sha256 = verifySha256(bytes, expectedSha256);
  const target = await createQuarantineTarget(params.install);
  try {
    await fs.writeFile(target.path, bytes, { mode: 0o600 });
    return {
      artifactPath: target.path,
      quarantineDir: target.dir,
      sha256,
      integrity,
      size: bytes.byteLength,
      cleanup: target.cleanup,
    };
  } catch (error) {
    await target.cleanup();
    throw error;
  }
}
