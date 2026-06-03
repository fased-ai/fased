import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveUserPath } from "../utils.js";
import { type ArchiveLogger, extractArchive, fileExists, resolvePackedRootDir } from "./archive.js";
import { withTempDir } from "./install-source-utils.js";

export type ExistingInstallPathResult =
  | {
      ok: true;
      resolvedPath: string;
      stat: Stats;
    }
  | {
      ok: false;
      error: string;
    };

export async function resolveExistingInstallPath(
  inputPath: string,
): Promise<ExistingInstallPathResult> {
  const resolvedPath = resolveUserPath(inputPath);
  if (!(await fileExists(resolvedPath))) {
    return { ok: false, error: `path not found: ${resolvedPath}` };
  }
  const stat = await fs.stat(resolvedPath);
  return { ok: true, resolvedPath, stat };
}

export async function withExtractedArchiveRoot<TResult extends { ok: boolean }>(params: {
  archivePath: string;
  tempDirPrefix: string;
  timeoutMs: number;
  rootMarkers?: string[];
  logger?: ArchiveLogger;
  onExtracted: (rootDir: string) => Promise<TResult>;
}): Promise<TResult | { ok: false; error: string }> {
  return await withTempDir(params.tempDirPrefix, async (tmpDir) => {
    const extractDir = path.join(tmpDir, "extract");
    await fs.mkdir(extractDir, { recursive: true });

    params.logger?.info?.(`Extracting ${params.archivePath}…`);
    try {
      await extractArchive({
        archivePath: params.archivePath,
        destDir: extractDir,
        timeoutMs: params.timeoutMs,
        logger: params.logger,
      });
    } catch (err) {
      return { ok: false, error: `failed to extract archive: ${String(err)}` };
    }

    let rootDir = "";
    try {
      rootDir = await resolveInstallRootDir(extractDir, params.rootMarkers);
    } catch (err) {
      return { ok: false, error: String(err) };
    }
    return await params.onExtracted(rootDir);
  });
}

async function hasAnyRootMarker(rootDir: string, rootMarkers: string[]): Promise<boolean> {
  for (const marker of rootMarkers) {
    if (!marker || path.isAbsolute(marker) || marker.includes("..")) {
      continue;
    }
    if (await fileExists(path.join(rootDir, marker))) {
      return true;
    }
  }
  return false;
}

async function resolveInstallRootDir(extractDir: string, rootMarkers?: string[]): Promise<string> {
  const markers = rootMarkers?.filter(Boolean) ?? [];
  if (markers.length === 0) {
    return await resolvePackedRootDir(extractDir);
  }

  if (await hasAnyRootMarker(extractDir, markers)) {
    return extractDir;
  }

  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  const markerDirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(extractDir, entry.name);
    if (await hasAnyRootMarker(candidate, markers)) {
      markerDirs.push(entry.name);
    }
  }
  if (markerDirs.length === 1) {
    return path.join(extractDir, markerDirs[0]);
  }
  if (markerDirs.length > 1) {
    throw new Error(`unexpected archive layout (marker dirs: ${markerDirs.join(", ")})`);
  }

  return await resolvePackedRootDir(extractDir);
}
