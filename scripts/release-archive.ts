import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
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
  compressionInputTransforms?: Transform[];
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
  requiredEntryPrefix: string;
};

const DEFAULT_RAW_ARCHIVE_IDLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_GZIP_ARCHIVE_IDLE_TIMEOUT_MS = 120_000;

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
      const error = new Error(
        `${label} timed out after ${idleTimeoutMs}ms without downstream progress; ${transferredBytes} bytes transferred.`,
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
  compressionInputTransforms = [],
  verifyRaw,
  verifyCompressed,
}: TwoPhaseGzipOptions): Promise<{ size: number }> {
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
      [source, rawOutput],
      rawIdleTimeoutMs,
      `Creating raw tar for ${destinationName}`,
    );
    await requireNonemptyFile(rawPath, `Raw tar for ${destinationName}`);
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
    return { size };
  } finally {
    await fs.rm(stagingDir, { force: true, recursive: true });
  }
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
  requiredEntryPrefix,
}: ReleaseArchiveOptions): Promise<{ entries: number; size: number }> {
  const rawIdleTimeoutMs = requireTimeout(rawIdleTimeoutInputMs, "Release raw-tar idle timeout");
  const gzipIdleTimeoutMs = requireTimeout(gzipIdleTimeoutInputMs, "Release gzip idle timeout");
  const source = tar.c(
    { cwd, filter, gzip: false, noMtime, portable: true, strict: true },
    entries,
  );
  let archivedEntries = 0;

  const result = await writeTwoPhaseGzipAtomically({
    destination,
    source,
    rawIdleTimeoutMs,
    gzipIdleTimeoutMs,
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

  return { entries: archivedEntries, size: result.size };
}
