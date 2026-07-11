import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DEFAULT_HOSTED_RELEASE_BASE_URL =
  "https://github.com/fased-ai/fased/releases/download";

export type HostedRuntimeArtifactDescriptor = {
  version: string;
  assetName: string;
  assetUrl: string;
  checksumUrl: string;
};

export type HostedRuntimeLayeredArtifactDescriptor = HostedRuntimeArtifactDescriptor & {
  layer: "app" | "dependencies";
};

export type HostedRuntimeArtifactDownload =
  | {
      kind: "downloaded";
      descriptor: HostedRuntimeArtifactDescriptor;
      archivePath: string;
    }
  | {
      kind: "unavailable";
      reason: string;
    }
  | {
      kind: "error";
      reason: string;
    };

function normalizeBaseUrl(value?: string | null): string {
  const normalized = value?.trim().replace(/\/+$/, "");
  return normalized || DEFAULT_HOSTED_RELEASE_BASE_URL;
}

export function resolveHostedRuntimeArtifact(params: {
  version: string;
  platform?: NodeJS.Platform;
  arch?: string;
  baseUrl?: string | null;
}): HostedRuntimeArtifactDescriptor | null {
  const platform = params.platform ?? process.platform;
  const arch = params.arch ?? process.arch;
  if (platform !== "linux" || (arch !== "x64" && arch !== "arm64")) {
    return null;
  }

  const version = params.version.trim().replace(/^v/, "");
  if (!version) {
    return null;
  }
  const assetName = `fased-hosted-linux-${arch}-v${version}.tar.gz`;
  const assetUrl = `${normalizeBaseUrl(params.baseUrl)}/v${version}/${assetName}`;
  return {
    version,
    assetName,
    assetUrl,
    checksumUrl: `${assetUrl}.sha256`,
  };
}

export function resolveHostedRuntimeAppArtifact(params: {
  version: string;
  platform?: NodeJS.Platform;
  arch?: string;
  baseUrl?: string | null;
}): HostedRuntimeLayeredArtifactDescriptor | null {
  const base = resolveHostedRuntimeArtifact(params);
  if (!base) {
    return null;
  }
  const assetName = `fased-hosted-app-linux-${params.arch ?? process.arch}-v${base.version}.tar.gz`;
  const assetUrl = `${normalizeBaseUrl(params.baseUrl)}/v${base.version}/${assetName}`;
  return { ...base, layer: "app", assetName, assetUrl, checksumUrl: `${assetUrl}.sha256` };
}

export function resolveHostedRuntimeDependencyArtifact(params: {
  version: string;
  dependencyHash: string;
  platform?: NodeJS.Platform;
  arch?: string;
  baseUrl?: string | null;
}): HostedRuntimeLayeredArtifactDescriptor | null {
  const base = resolveHostedRuntimeArtifact(params);
  const dependencyHash = params.dependencyHash.trim().toLowerCase();
  if (!base || !/^[a-f0-9]{64}$/.test(dependencyHash)) {
    return null;
  }
  const assetName = `fased-hosted-deps-linux-${params.arch ?? process.arch}-${dependencyHash}.tar.gz`;
  const assetUrl = `${normalizeBaseUrl(params.baseUrl)}/v${base.version}/${assetName}`;
  return {
    ...base,
    layer: "dependencies",
    assetName,
    assetUrl,
    checksumUrl: `${assetUrl}.sha256`,
  };
}

function checksumForAsset(contents: string, assetName: string): string | null {
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
    if (match?.[2] === assetName) {
      return match[1]?.toLowerCase() ?? null;
    }
  }
  return null;
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function writeResponseBody(response: Response, destination: string): Promise<void> {
  if (!response.body) {
    throw new Error("hosted runtime response had no body");
  }
  const source = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
  await pipeline(source, createWriteStream(destination, { mode: 0o600 }));
}

export async function downloadHostedRuntimeArtifact(params: {
  version: string;
  destinationDir: string;
  fetchImpl: typeof fetch;
  baseUrl?: string | null;
  platform?: NodeJS.Platform;
  arch?: string;
}): Promise<HostedRuntimeArtifactDownload> {
  const descriptor = resolveHostedRuntimeArtifact(params);
  return await downloadHostedRuntimeDescriptor({
    descriptor,
    destinationDir: params.destinationDir,
    fetchImpl: params.fetchImpl,
  });
}

export async function downloadHostedRuntimeDescriptor(params: {
  descriptor: HostedRuntimeArtifactDescriptor | null;
  destinationDir: string;
  fetchImpl: typeof fetch;
}): Promise<HostedRuntimeArtifactDownload> {
  const descriptor = params.descriptor;
  if (!descriptor) {
    return { kind: "unavailable", reason: "unsupported hosted runtime platform" };
  }

  let checksumResponse: Response;
  try {
    checksumResponse = await params.fetchImpl(descriptor.checksumUrl, { redirect: "follow" });
  } catch (error) {
    return { kind: "unavailable", reason: `checksum download failed: ${String(error)}` };
  }
  if (!checksumResponse.ok) {
    return {
      kind: "unavailable",
      reason: `checksum unavailable (${checksumResponse.status})`,
    };
  }
  const expectedChecksum = checksumForAsset(await checksumResponse.text(), descriptor.assetName);
  if (!expectedChecksum) {
    return { kind: "error", reason: "release checksum did not name the hosted runtime asset" };
  }

  let artifactResponse: Response;
  try {
    artifactResponse = await params.fetchImpl(descriptor.assetUrl, { redirect: "follow" });
  } catch (error) {
    return { kind: "unavailable", reason: `artifact download failed: ${String(error)}` };
  }
  if (!artifactResponse.ok) {
    return {
      kind: "unavailable",
      reason: `hosted runtime artifact unavailable (${artifactResponse.status})`,
    };
  }

  await fs.mkdir(params.destinationDir, { recursive: true });
  const archivePath = path.join(params.destinationDir, descriptor.assetName);
  try {
    await writeResponseBody(artifactResponse, archivePath);
  } catch (error) {
    return { kind: "unavailable", reason: `artifact download failed: ${String(error)}` };
  }

  const actualChecksum = await sha256(archivePath);
  if (actualChecksum !== expectedChecksum) {
    await fs.rm(archivePath, { force: true });
    return {
      kind: "error",
      reason: `hosted runtime checksum mismatch for ${descriptor.assetName}`,
    };
  }

  return { kind: "downloaded", descriptor, archivePath };
}
