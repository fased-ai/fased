import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
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
  timeoutMs: number;
  verify: (stagedPath: string) => Promise<void>;
};

type ReleaseArchiveOptions = {
  cwd: string;
  destination: string;
  entries: string[];
  filter?: ArchiveFilter;
  noMtime?: boolean;
  requiredEntryPrefix: string;
  timeoutMs?: number;
};

const DEFAULT_ARCHIVE_TIMEOUT_MS = 120_000;

function requireTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Release archive timeout must be a positive integer.");
  }
  return value;
}

async function pipelineWithTimeout(
  source: DestroyableByteStream,
  destination: DestroyableByteStream,
  timeoutMs: number,
  label: string,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const transfer = pipeline(source, destination);
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms.`);
      source.destroy(error);
      destination.destroy(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    await Promise.race([transfer, deadline]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function writeStreamAtomically({
  destination,
  source,
  timeoutMs: rawTimeoutMs,
  verify,
}: AtomicStreamOptions): Promise<{ size: number }> {
  const timeoutMs = requireTimeout(rawTimeoutMs);
  const outputDir = path.dirname(destination);
  await fs.mkdir(outputDir, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(outputDir, ".fased-release-archive-"));
  const stagedPath = path.join(stagingDir, path.basename(destination));

  try {
    const output = createWriteStream(stagedPath, { flags: "wx", mode: 0o644 });
    await pipelineWithTimeout(source, output, timeoutMs, `Writing ${path.basename(destination)}`);
    const stat = await fs.stat(stagedPath);
    if (!stat.isFile() || stat.size < 1) {
      throw new Error(`Release archive ${path.basename(destination)} is empty.`);
    }
    await verify(stagedPath);

    // The staging directory lives beside the destination, so a hard link is an
    // atomic no-clobber publication on the same filesystem. EEXIST must fail.
    await fs.link(stagedPath, destination);
    return { size: stat.size };
  } finally {
    await fs.rm(stagingDir, { force: true, recursive: true });
  }
}

export async function writeReleaseArchive({
  cwd,
  destination,
  entries,
  filter,
  noMtime,
  requiredEntryPrefix,
  timeoutMs: rawTimeoutMs = DEFAULT_ARCHIVE_TIMEOUT_MS,
}: ReleaseArchiveOptions): Promise<{ entries: number; size: number }> {
  const timeoutMs = requireTimeout(rawTimeoutMs);
  let archivedEntries = 0;
  let requiredEntryFound = false;
  const source = tar.c({ cwd, filter, gzip: true, noMtime, portable: true, strict: true }, entries);

  const result = await writeStreamAtomically({
    destination,
    source,
    timeoutMs,
    verify: async (stagedPath) => {
      const input = createReadStream(stagedPath);
      const inspector = tar.t({
        gzip: true,
        strict: true,
        onReadEntry: (entry) => {
          archivedEntries += 1;
          if (entry.path.startsWith(requiredEntryPrefix)) {
            requiredEntryFound = true;
          }
        },
      });
      await pipelineWithTimeout(
        input,
        inspector,
        timeoutMs,
        `Verifying ${path.basename(destination)}`,
      );
      if (archivedEntries < 1 || !requiredEntryFound) {
        throw new Error(
          `Release archive ${path.basename(destination)} is missing ${requiredEntryPrefix}.`,
        );
      }
    },
  });

  return { entries: archivedEntries, size: result.size };
}
