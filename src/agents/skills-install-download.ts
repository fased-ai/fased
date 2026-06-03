import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  isWindowsDrivePath,
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "../infra/archive-path.js";
import { extractArchive as extractArchiveSafe } from "../infra/archive.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { isWithinDir } from "../infra/path-safety.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { ensureDir, resolveUserPath } from "../utils.js";
import { formatInstallFailureMessage } from "./skills-install-output.js";
import type { SkillInstallResult } from "./skills-install.js";
import type { SkillEntry, SkillInstallSpec } from "./skills.js";
import { hasBinary } from "./skills.js";
import { resolveSkillToolsRootDir } from "./skills/tools-dir.js";

const TAR_SPECIAL_TYPE_CHARS = new Set(["l", "h", "p", "b", "c", "s"]);
const TAR_MONTH_TOKENS = new Set([
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]);
const DEFAULT_TAR_ENTRY_BYTES_LIMIT = 256 * 1024 * 1024;
const SUPPORTED_INTEGRITY_ALGORITHMS = new Set(["sha256", "sha384", "sha512"]);

function isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return Boolean(value && typeof (value as NodeJS.ReadableStream).pipe === "function");
}

function resolveDownloadTargetDir(entry: SkillEntry, spec: SkillInstallSpec): string {
  const safeRoot = resolveSkillToolsRootDir(entry);
  const raw = spec.targetDir?.trim();
  if (!raw) {
    return safeRoot;
  }

  // Treat non-absolute paths as relative to the per-skill tools root.
  const resolved =
    raw.startsWith("~") || path.isAbsolute(raw) || isWindowsDrivePath(raw)
      ? resolveUserPath(raw)
      : path.resolve(safeRoot, raw);

  if (!isWithinDir(safeRoot, resolved)) {
    throw new Error(
      `Refusing to install outside the skill tools directory. targetDir="${raw}" resolves to "${resolved}". Allowed root: "${safeRoot}".`,
    );
  }
  return resolved;
}

function resolveArchiveType(spec: SkillInstallSpec, filename: string): string | undefined {
  const explicit = spec.archive?.trim().toLowerCase();
  if (explicit) {
    return explicit;
  }
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    return "tar.gz";
  }
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) {
    return "tar.bz2";
  }
  if (lower.endsWith(".zip")) {
    return "zip";
  }
  return undefined;
}

async function downloadFile(
  url: string,
  destPath: string,
  timeoutMs: number,
): Promise<{ bytes: number }> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    timeoutMs: Math.max(1_000, timeoutMs),
  });
  try {
    if (!response.ok || !response.body) {
      throw new Error(`Download failed (${response.status} ${response.statusText})`);
    }
    await ensureDir(path.dirname(destPath));
    const file = fs.createWriteStream(destPath);
    const body = response.body as unknown;
    const readable = isNodeReadableStream(body)
      ? body
      : Readable.fromWeb(body as NodeReadableStream);
    await pipeline(readable, file);
    const stat = await fs.promises.stat(destPath);
    return { bytes: stat.size };
  } finally {
    await release();
  }
}

function normalizeHex(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/u, "")
    .replace(/[^a-f0-9]/gu, "");
}

async function digestFile(
  filePath: string,
  algorithm: "sha1" | "sha256" | "sha384" | "sha512",
  encoding: "base64" | "hex",
): Promise<string> {
  const hash = createHash(algorithm);
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest(encoding);
}

async function verifyDownloadIntegrity(
  archivePath: string,
  spec: SkillInstallSpec,
): Promise<string | undefined> {
  const sha256 = spec.sha256?.trim();
  if (sha256) {
    const actual = await digestFile(archivePath, "sha256", "hex");
    const expected = normalizeHex(sha256);
    if (!expected || actual !== expected) {
      return `download sha256 mismatch: expected ${expected || sha256}, got ${actual}`;
    }
  }

  const shasum = spec.shasum?.trim();
  if (shasum) {
    const actual = await digestFile(archivePath, "sha1", "hex");
    const expected = shasum.toLowerCase().replace(/[^a-f0-9]/gu, "");
    if (!expected || actual !== expected) {
      return `download shasum mismatch: expected ${expected || shasum}, got ${actual}`;
    }
  }

  const integrity = spec.integrity?.trim();
  if (!integrity) {
    return undefined;
  }
  for (const token of integrity.split(/\s+/u).filter(Boolean)) {
    const separator = token.indexOf("-");
    if (separator <= 0) {
      return `unsupported integrity token: ${token}`;
    }
    const algorithm = token.slice(0, separator);
    const expected = token.slice(separator + 1);
    if (!SUPPORTED_INTEGRITY_ALGORITHMS.has(algorithm) || !expected) {
      return `unsupported integrity token: ${token}`;
    }
    const actual = await digestFile(
      archivePath,
      algorithm as "sha256" | "sha384" | "sha512",
      "base64",
    );
    if (actual !== expected) {
      return `download integrity mismatch for ${algorithm}`;
    }
  }
  return undefined;
}

async function extractArchive(params: {
  archivePath: string;
  archiveType: string;
  targetDir: string;
  stripComponents?: number;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const { archivePath, archiveType, targetDir, stripComponents, timeoutMs } = params;
  const strip =
    typeof stripComponents === "number" && Number.isFinite(stripComponents)
      ? Math.max(0, Math.floor(stripComponents))
      : 0;

  try {
    if (archiveType === "zip") {
      await extractArchiveSafe({
        archivePath,
        destDir: targetDir,
        timeoutMs,
        kind: "zip",
        stripComponents: strip,
      });
      return { stdout: "", stderr: "", code: 0 };
    }

    if (archiveType === "tar.gz") {
      await extractArchiveSafe({
        archivePath,
        destDir: targetDir,
        timeoutMs,
        kind: "tar",
        stripComponents: strip,
        tarGzip: true,
      });
      return { stdout: "", stderr: "", code: 0 };
    }

    if (archiveType === "tar.bz2") {
      if (!hasBinary("tar")) {
        return { stdout: "", stderr: "tar not found on PATH", code: null };
      }

      const readArchiveFingerprint = async () => {
        const stat = await fs.promises.stat(archivePath);
        return { size: stat.size, mtimeMs: stat.mtimeMs };
      };
      const hasArchiveChanged = (
        before: { size: number; mtimeMs: number },
        after: { size: number; mtimeMs: number },
      ) => before.size !== after.size || before.mtimeMs !== after.mtimeMs;
      const assertNoTarSymlinkTraversal = async (relPath: string, originalPath: string) => {
        const parts = relPath.split("/").filter(Boolean);
        let current = path.resolve(targetDir);
        for (const part of parts) {
          current = path.join(current, part);
          try {
            const stat = await fs.promises.lstat(current);
            if (stat.isSymbolicLink()) {
              throw new Error(`archive entry traverses symlink in destination: ${originalPath}`);
            }
          } catch (err) {
            const error = err as NodeJS.ErrnoException;
            if (error?.code === "ENOENT") {
              continue;
            }
            throw err;
          }
        }
      };
      const readTarVerboseSize = (line: string): number | null => {
        const tokens = line.trim().split(/\s+/);
        const monthIndex = tokens.findIndex((token) => TAR_MONTH_TOKENS.has(token));
        if (monthIndex <= 0) {
          return null;
        }
        const sizeToken = tokens[monthIndex - 1];
        if (!sizeToken || !/^\d+$/.test(sizeToken)) {
          return null;
        }
        return Number(sizeToken);
      };
      const fingerprintBefore = await readArchiveFingerprint();

      // Preflight list to prevent zip-slip style traversal before extraction.
      const listResult = await runCommandWithTimeout(["tar", "tf", archivePath], { timeoutMs });
      if (listResult.code !== 0) {
        return {
          stdout: listResult.stdout,
          stderr: listResult.stderr || "tar list failed",
          code: listResult.code,
        };
      }
      const fingerprintAfterList = await readArchiveFingerprint();
      if (hasArchiveChanged(fingerprintBefore, fingerprintAfterList)) {
        return {
          stdout: listResult.stdout,
          stderr: "archive changed during safety preflight",
          code: 1,
        };
      }
      const entries = listResult.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      const verboseResult = await runCommandWithTimeout(["tar", "tvf", archivePath], { timeoutMs });
      if (verboseResult.code !== 0) {
        return {
          stdout: verboseResult.stdout,
          stderr: verboseResult.stderr || "tar verbose list failed",
          code: verboseResult.code,
        };
      }
      const fingerprintAfterVerbose = await readArchiveFingerprint();
      if (hasArchiveChanged(fingerprintBefore, fingerprintAfterVerbose)) {
        return {
          stdout: verboseResult.stdout,
          stderr: "archive changed during safety preflight",
          code: 1,
        };
      }
      for (const line of verboseResult.stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const typeChar = trimmed[0];
        if (TAR_SPECIAL_TYPE_CHARS.has(typeChar) || trimmed.includes(" -> ")) {
          return {
            stdout: verboseResult.stdout,
            stderr: "tar archive contains link or special entries; refusing to extract for safety",
            code: 1,
          };
        }
        const extractedSize = readTarVerboseSize(trimmed);
        if (typeof extractedSize === "number" && extractedSize > DEFAULT_TAR_ENTRY_BYTES_LIMIT) {
          return {
            stdout: verboseResult.stdout,
            stderr: "archive entry extracted size exceeds limit",
            code: 1,
          };
        }
      }

      for (const entry of entries) {
        validateArchiveEntryPath(entry, { escapeLabel: "targetDir" });
        const relPath = stripArchivePath(entry, strip);
        if (!relPath) {
          continue;
        }
        validateArchiveEntryPath(relPath, { escapeLabel: "targetDir" });
        resolveArchiveOutputPath({
          rootDir: targetDir,
          relPath,
          originalPath: entry,
          escapeLabel: "targetDir",
        });
        await assertNoTarSymlinkTraversal(relPath, entry);
      }

      const argv = ["tar", "xf", archivePath, "-C", targetDir];
      if (strip > 0) {
        argv.push("--strip-components", String(strip));
      }
      return await runCommandWithTimeout(argv, { timeoutMs });
    }

    return { stdout: "", stderr: `unsupported archive type: ${archiveType}`, code: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { stdout: "", stderr: message, code: 1 };
  }
}

export async function installDownloadSpec(params: {
  entry: SkillEntry;
  spec: SkillInstallSpec;
  timeoutMs: number;
}): Promise<SkillInstallResult> {
  const { entry, spec, timeoutMs } = params;
  const url = spec.url?.trim();
  if (!url) {
    return {
      ok: false,
      message: "missing download url",
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  let filename = "";
  try {
    const parsed = new URL(url);
    filename = path.basename(parsed.pathname);
  } catch {
    filename = path.basename(url);
  }
  if (!filename) {
    filename = "download";
  }

  let targetDir = "";
  try {
    targetDir = resolveDownloadTargetDir(entry, spec);
    await ensureDir(targetDir);
    const stat = await fs.promises.lstat(targetDir);
    if (stat.isSymbolicLink()) {
      throw new Error(`targetDir is a symlink: ${targetDir}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`targetDir is not a directory: ${targetDir}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message, stdout: "", stderr: message, code: null };
  }

  const archivePath = path.join(targetDir, filename);
  let downloaded = 0;
  try {
    const result = await downloadFile(url, archivePath, timeoutMs);
    downloaded = result.bytes;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message, stdout: "", stderr: message, code: null };
  }
  const integrityError = await verifyDownloadIntegrity(archivePath, spec);
  if (integrityError) {
    return {
      ok: false,
      message: integrityError,
      stdout: `downloaded=${downloaded}`,
      stderr: integrityError,
      code: null,
    };
  }

  const archiveType = resolveArchiveType(spec, filename);
  const shouldExtract = spec.extract ?? Boolean(archiveType);
  if (!shouldExtract) {
    return {
      ok: true,
      message: `Downloaded to ${archivePath}`,
      stdout: `downloaded=${downloaded}`,
      stderr: "",
      code: 0,
    };
  }

  if (!archiveType) {
    return {
      ok: false,
      message: "extract requested but archive type could not be detected",
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  const extractResult = await extractArchive({
    archivePath,
    archiveType,
    targetDir,
    stripComponents: spec.stripComponents,
    timeoutMs,
  });
  const success = extractResult.code === 0;
  return {
    ok: success,
    message: success
      ? `Downloaded and extracted to ${targetDir}`
      : formatInstallFailureMessage(extractResult),
    stdout: extractResult.stdout.trim(),
    stderr: extractResult.stderr.trim(),
    code: extractResult.code,
  };
}
