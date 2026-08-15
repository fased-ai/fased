import { createReadStream, createWriteStream, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import * as tar from "tar";

type DestroyableByteStream = AsyncIterable<Uint8Array> & {
  destroy(error?: Error): unknown;
};

type ArchiveFilter =
  NonNullable<Parameters<typeof tar.c>[0]> extends infer Options
    ? Options extends { filter?: infer Filter }
      ? Filter
      : never
    : never;

type AtomicStreamOptions = {
  destination: string;
  source: DestroyableByteStream;
  idleTimeoutMs: number;
  verify: (stagedPath: string) => Promise<void>;
};

type TwoPhaseGzipOptions = {
  destination: string;
  source: DestroyableByteStream;
  rawIdleTimeoutMs: number;
  gzipIdleTimeoutMs: number;
  rawOutputTransforms?: Transform[];
  compressionInputTransforms?: Transform[];
  rawProgressReceipt?: (outputBytes: number) => unknown;
  onRawProgress?: (outputBytes: number) => void;
  verifyRaw: (rawPath: string) => Promise<void>;
  verifyCompressed: (compressedPath: string) => Promise<void>;
};

type ReleaseArchiveOptions = {
  cwd: string;
  destination: string;
  entries: string[];
  filter?: ArchiveFilter;
  rawIdleTimeoutMs?: number;
  gzipIdleTimeoutMs?: number;
  noMtime?: boolean;
  rawOutputTransforms?: Transform[];
  requiredEntryPrefix: string;
};

const DEFAULT_RAW_ARCHIVE_IDLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_GZIP_ARCHIVE_IDLE_TIMEOUT_MS = 120_000;

type ReleaseArchiveEntryType = "directory" | "file" | "symlink";
type UnsupportedReleaseArchiveEntryType =
  | "block-device"
  | "character-device"
  | "fifo"
  | "socket"
  | "unknown";

type ReleaseArchiveManifestEntry = {
  path: string;
  size: number;
  stat: Stats;
  type: ReleaseArchiveEntryType;
};

export type ReleaseArchiveProgressReceipt = {
  schemaVersion: 1;
  phase: "raw-tar";
  manifestEntries: number;
  completedEntries: number;
  outputBytes: number;
  activeEntry: {
    path: string;
    type: ReleaseArchiveEntryType;
    size: number;
    entryBytes: number;
  } | null;
};

function requireTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

async function pipelineWithIdleTimeout(
  streams: DestroyableByteStream[],
  idleTimeoutMs: number,
  label: string,
  options: {
    progressReceipt?: (outputBytes: number) => unknown;
    onProgress?: (outputBytes: number) => void;
  } = {},
): Promise<void> {
  if (streams.length < 2) {
    throw new Error("Progress-aware pipeline requires a source and destination.");
  }
  let timeout: NodeJS.Timeout | undefined;
  let transferredBytes = 0;
  let rejectDeadline: ((error: Error) => void) | undefined;
  const armDeadline = () => {
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => {
      const receipt = options.progressReceipt?.(transferredBytes);
      const receiptJson = receipt === undefined ? undefined : JSON.stringify(receipt);
      const error = new Error(
        `${label} timed out after ${idleTimeoutMs}ms without downstream progress; ${transferredBytes} bytes transferred.${receiptJson ? ` progressReceipt=${receiptJson}` : ""}`,
      );
      for (const stream of observedStreams) {
        stream.destroy(error);
      }
      rejectDeadline?.(error);
    }, idleTimeoutMs);
  };
  const progress = new Transform({
    transform(chunk: Uint8Array, _encoding, callback) {
      transferredBytes += chunk.byteLength;
      options.onProgress?.(transferredBytes);
      armDeadline();
      callback(null, chunk);
    },
  });
  const observedStreams = [...streams.slice(0, -1), progress, streams.at(-1)!];
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  armDeadline();
  const transfer = pipeline(observedStreams);

  try {
    await Promise.race([transfer, deadline]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function requireNonemptyFile(filePath: string, label: string): Promise<number> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size < 1) {
    throw new Error(`${label} is empty.`);
  }
  return stat.size;
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await fs.open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishNoClobber(stagedPath: string, destination: string): Promise<void> {
  const outputDir = path.dirname(destination);
  await fs.link(stagedPath, destination);
  try {
    await syncDirectory(outputDir);
  } catch (error) {
    await fs.unlink(destination).catch(() => undefined);
    throw error;
  }
}

export async function writeStreamAtomically({
  destination,
  source,
  idleTimeoutMs: rawIdleTimeoutMs,
  verify,
}: AtomicStreamOptions): Promise<{ size: number }> {
  const idleTimeoutMs = requireTimeout(rawIdleTimeoutMs, "Release archive idle timeout");
  const outputDir = path.dirname(destination);
  await fs.mkdir(outputDir, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(outputDir, ".fased-release-archive-"));
  const stagedPath = path.join(stagingDir, path.basename(destination));

  try {
    const output = createWriteStream(stagedPath, { flags: "wx", mode: 0o644 });
    await pipelineWithIdleTimeout(
      [source, output],
      idleTimeoutMs,
      `Writing ${path.basename(destination)}`,
    );
    const size = await requireNonemptyFile(
      stagedPath,
      `Release archive ${path.basename(destination)}`,
    );
    await syncFile(stagedPath);
    await verify(stagedPath);
    await publishNoClobber(stagedPath, destination);
    return { size };
  } finally {
    await fs.rm(stagingDir, { force: true, recursive: true });
  }
}

export async function writeTwoPhaseGzipAtomically({
  destination,
  source,
  rawIdleTimeoutMs: rawIdleTimeoutInputMs,
  gzipIdleTimeoutMs: gzipIdleTimeoutInputMs,
  rawOutputTransforms = [],
  compressionInputTransforms = [],
  rawProgressReceipt,
  onRawProgress,
  verifyRaw,
  verifyCompressed,
}: TwoPhaseGzipOptions): Promise<{ rawSize: number; size: number }> {
  const rawIdleTimeoutMs = requireTimeout(rawIdleTimeoutInputMs, "Release raw-tar idle timeout");
  const gzipIdleTimeoutMs = requireTimeout(gzipIdleTimeoutInputMs, "Release gzip idle timeout");
  const outputDir = path.dirname(destination);
  const destinationName = path.basename(destination);
  await fs.mkdir(outputDir, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(outputDir, ".fased-release-archive-"));
  const rawPath = path.join(stagingDir, `${destinationName}.raw.tar`);
  const compressedPath = path.join(stagingDir, destinationName);

  try {
    const rawOutput = createWriteStream(rawPath, { flags: "wx", mode: 0o600 });
    await pipelineWithIdleTimeout(
      [source, ...rawOutputTransforms, rawOutput],
      rawIdleTimeoutMs,
      `Creating raw tar for ${destinationName}`,
      { progressReceipt: rawProgressReceipt, onProgress: onRawProgress },
    );
    const rawSize = await requireNonemptyFile(rawPath, `Raw tar for ${destinationName}`);
    await verifyRaw(rawPath);
    await syncFile(rawPath);
    await syncDirectory(stagingDir);

    const rawInput = createReadStream(rawPath);
    const gzip = createGzip();
    const compressedOutput = createWriteStream(compressedPath, { flags: "wx", mode: 0o644 });
    await pipelineWithIdleTimeout(
      [rawInput, ...compressionInputTransforms, gzip, compressedOutput],
      gzipIdleTimeoutMs,
      `Compressing ${destinationName}`,
    );
    const size = await requireNonemptyFile(compressedPath, `Release archive ${destinationName}`);
    await verifyCompressed(compressedPath);
    await syncFile(compressedPath);
    await syncDirectory(stagingDir);
    await publishNoClobber(compressedPath, destination);
    return { rawSize, size };
  } finally {
    await fs.rm(stagingDir, { force: true, recursive: true });
  }
}

function normalizeManifestRoot(entry: string): string {
  if (
    entry.length === 0 ||
    entry !== entry.trim() ||
    entry.includes("\\") ||
    entry.includes("\0") ||
    entry.startsWith("@") ||
    path.posix.isAbsolute(entry)
  ) {
    throw new Error(`Release archive manifest root is invalid: ${JSON.stringify(entry)}`);
  }
  const segments = entry.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Release archive manifest root is invalid: ${JSON.stringify(entry)}`);
  }
  return segments.join("/");
}

function filesystemEntryType(
  stat: Stats,
): ReleaseArchiveEntryType | UnsupportedReleaseArchiveEntryType {
  if (stat.isFile()) {
    return "file";
  }
  if (stat.isDirectory()) {
    return "directory";
  }
  if (stat.isSymbolicLink()) {
    return "symlink";
  }
  if (stat.isFIFO()) {
    return "fifo";
  }
  if (stat.isSocket()) {
    return "socket";
  }
  if (stat.isBlockDevice()) {
    return "block-device";
  }
  if (stat.isCharacterDevice()) {
    return "character-device";
  }
  return "unknown";
}

async function createReleaseArchiveManifest({
  cwd,
  entries,
  filter,
}: Pick<ReleaseArchiveOptions, "cwd" | "entries" | "filter">): Promise<
  ReleaseArchiveManifestEntry[]
> {
  const manifest = new Map<string, ReleaseArchiveManifestEntry>();

  const visit = async (relativePath: string): Promise<void> => {
    if (manifest.has(relativePath)) {
      return;
    }
    const absolutePath = path.join(cwd, ...relativePath.split("/"));
    const stat = await fs.lstat(absolutePath);
    const type = filesystemEntryType(stat);
    if (type !== "file" && type !== "directory" && type !== "symlink") {
      throw new Error(
        `Release archive manifest contains an unsupported filesystem entry: ${JSON.stringify({ path: relativePath, type })}`,
      );
    }
    if (filter && !filter(relativePath, stat)) {
      return;
    }

    manifest.set(relativePath, { path: relativePath, size: stat.size, stat, type });
    if (type !== "directory") {
      return;
    }
    const children = await fs.readdir(absolutePath);
    children.sort();
    for (const child of children) {
      await visit(path.posix.join(relativePath, child));
    }
  };

  const roots = entries.map(normalizeManifestRoot).toSorted();
  for (const root of roots) {
    await visit(root);
  }
  if (manifest.size < 1) {
    throw new Error("Release archive manifest is empty.");
  }
  return [...manifest.values()].toSorted((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

class ReleaseArchiveProgressTracker {
  readonly #manifestByPath: Map<string, ReleaseArchiveManifestEntry>;
  #completedEntries = 0;
  #outputBytes = 0;
  #activeEntry: ReleaseArchiveProgressReceipt["activeEntry"] = null;
  #activeEntryBytes: (() => number) | null = null;

  constructor(manifest: ReleaseArchiveManifestEntry[]) {
    this.#manifestByPath = new Map(manifest.map((entry) => [entry.path, entry]));
  }

  start(entryPath: string, entryBytes: () => number): void {
    const normalizedPath = entryPath.replace(/\/+$/u, "");
    const manifestEntry = this.#manifestByPath.get(normalizedPath);
    if (!manifestEntry) {
      throw new Error(
        `Release archive producer emitted an entry outside its manifest: ${JSON.stringify(normalizedPath)}`,
      );
    }
    this.#activeEntry = {
      path: manifestEntry.path,
      type: manifestEntry.type,
      size: manifestEntry.size,
      entryBytes: 0,
    };
    this.#activeEntryBytes = entryBytes;
  }

  complete(entryPath: string): void {
    const normalizedPath = entryPath.replace(/\/+$/u, "");
    if (this.#activeEntry?.path === normalizedPath) {
      this.#completedEntries += 1;
      this.#activeEntry = null;
      this.#activeEntryBytes = null;
    }
  }

  recordOutput(outputBytes: number): void {
    this.#outputBytes = outputBytes;
  }

  receipt(outputBytes: number): ReleaseArchiveProgressReceipt {
    this.recordOutput(outputBytes);
    if (this.#activeEntry && this.#activeEntryBytes) {
      this.#activeEntry.entryBytes = this.#activeEntryBytes();
    }
    return {
      schemaVersion: 1,
      phase: "raw-tar",
      manifestEntries: this.#manifestByPath.size,
      completedEntries: this.#completedEntries,
      outputBytes: this.#outputBytes,
      activeEntry: this.#activeEntry ? { ...this.#activeEntry } : null,
    };
  }
}

function observeReleaseArchiveProgress(progress: ReleaseArchiveProgressTracker): Transform {
  let observer: Transform;
  const parser = new tar.Parser({
    strict: true,
    onReadEntry: (entry) => {
      progress.start(entry.path, () => Math.max(0, entry.size - entry.remain));
      entry.on("data", () => undefined);
      entry.once("end", () => progress.complete(entry.path));
    },
  });
  parser.on("error", (error) => observer.destroy(error));
  observer = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        parser.write(chunk);
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      parser.once("end", callback);
      parser.end();
    },
  });
  return observer;
}

function createManifestArchiveStream(
  cwd: string,
  manifest: ReleaseArchiveManifestEntry[],
  noMtime: boolean | undefined,
): DestroyableByteStream {
  const statCache = new Map(
    manifest.map((entry) => [path.resolve(cwd, ...entry.path.split("/")), entry.stat]),
  );
  const linkCache = new Map<`${number}:${number}`, string>();

  return Readable.from(
    (async function* () {
      for (const manifestEntry of manifest) {
        const absolute = path.resolve(cwd, ...manifestEntry.path.split("/"));
        const entry = new tar.WriteEntry(manifestEntry.path, {
          absolute,
          cwd,
          linkCache,
          noMtime,
          portable: true,
          statCache,
          strict: true,
        });
        try {
          for await (const chunk of entry) {
            yield chunk;
          }
        } finally {
          entry.destroy();
        }
      }
      yield Buffer.alloc(1_024);
    })(),
    { objectMode: false },
  );
}

async function inspectReleaseArchive(
  archivePath: string,
  gzip: boolean,
  idleTimeoutMs: number,
  requiredEntryPrefix: string,
): Promise<number> {
  let archivedEntries = 0;
  let requiredEntryFound = false;
  const input = createReadStream(archivePath);
  const inspector = tar.t({
    gzip,
    strict: true,
    onReadEntry: (entry) => {
      archivedEntries += 1;
      if (entry.path.startsWith(requiredEntryPrefix)) {
        requiredEntryFound = true;
      }
    },
  });
  await pipelineWithIdleTimeout(
    [input, inspector],
    idleTimeoutMs,
    `Verifying ${path.basename(archivePath)}`,
  );
  if (archivedEntries < 1 || !requiredEntryFound) {
    throw new Error(
      `Release archive ${path.basename(archivePath)} is missing ${requiredEntryPrefix}.`,
    );
  }
  return archivedEntries;
}

export async function writeReleaseArchive({
  cwd,
  destination,
  entries,
  filter,
  rawIdleTimeoutMs: rawIdleTimeoutInputMs = DEFAULT_RAW_ARCHIVE_IDLE_TIMEOUT_MS,
  gzipIdleTimeoutMs: gzipIdleTimeoutInputMs = DEFAULT_GZIP_ARCHIVE_IDLE_TIMEOUT_MS,
  noMtime,
  rawOutputTransforms,
  requiredEntryPrefix,
}: ReleaseArchiveOptions): Promise<{
  entries: number;
  manifestEntries: number;
  rawSize: number;
  size: number;
}> {
  const rawIdleTimeoutMs = requireTimeout(rawIdleTimeoutInputMs, "Release raw-tar idle timeout");
  const gzipIdleTimeoutMs = requireTimeout(gzipIdleTimeoutInputMs, "Release gzip idle timeout");
  const manifest = await createReleaseArchiveManifest({ cwd, entries, filter });
  const progress = new ReleaseArchiveProgressTracker(manifest);
  console.log(
    `release-archive: validated manifest for ${path.basename(destination)} (${manifest.length} entries)`,
  );
  const source = createManifestArchiveStream(cwd, manifest, noMtime);
  let archivedEntries = 0;

  const result = await writeTwoPhaseGzipAtomically({
    destination,
    source,
    rawIdleTimeoutMs,
    gzipIdleTimeoutMs,
    rawOutputTransforms: [...(rawOutputTransforms ?? []), observeReleaseArchiveProgress(progress)],
    onRawProgress: (outputBytes) => progress.recordOutput(outputBytes),
    rawProgressReceipt: (outputBytes) => progress.receipt(outputBytes),
    verifyRaw: async (rawPath) => {
      const rawEntries = await inspectReleaseArchive(
        rawPath,
        false,
        rawIdleTimeoutMs,
        requiredEntryPrefix,
      );
      console.log(
        `release-archive: verified raw tar for ${path.basename(destination)} (${rawEntries} entries); starting gzip`,
      );
    },
    verifyCompressed: async (compressedPath) => {
      archivedEntries = await inspectReleaseArchive(
        compressedPath,
        true,
        gzipIdleTimeoutMs,
        requiredEntryPrefix,
      );
      console.log(
        `release-archive: verified gzip ${path.basename(destination)} (${archivedEntries} entries)`,
      );
    },
  });

  console.log(
    `release-archive: completionReceipt=${JSON.stringify({
      schemaVersion: 1,
      destination: path.basename(destination),
      manifestEntries: manifest.length,
      archivedEntries,
      rawBytes: result.rawSize,
      compressedBytes: result.size,
    })}`,
  );
  return {
    entries: archivedEntries,
    manifestEntries: manifest.length,
    rawSize: result.rawSize,
    size: result.size,
  };
}
