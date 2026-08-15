import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Transform } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  writeReleaseArchive,
  writeStreamAtomically,
  writeTwoPhaseGzipAtomically,
} from "./release-archive.js";

const gunzipAsync = promisify(gunzip);
const execFileAsync = promisify(execFile);

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-release-archive-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("release archive writer", () => {
  it("publishes a complete verified gzip archive without partial output", async () => {
    const root = await fixture();
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    const destination = path.join(output, "runtime.tar.gz");
    await fs.mkdir(path.join(source, "package"), { recursive: true });
    await fs.writeFile(path.join(source, "package", "version.txt"), "fixture-version\n");
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await writeReleaseArchive({
      cwd: source,
      destination,
      entries: ["package"],
      requiredEntryPrefix: "package/",
      rawIdleTimeoutMs: 5_000,
      gzipIdleTimeoutMs: 5_000,
    });

    expect(result.entries).toBeGreaterThan(1);
    expect(result.manifestEntries).toBe(result.entries);
    expect(result.rawSize).toBeGreaterThan(0);
    expect(result.size).toBeGreaterThan(0);
    const completion = logs.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.startsWith("release-archive: completionReceipt="));
    if (!completion) {
      throw new Error("Release archive completion receipt was not logged.");
    }
    expect(JSON.parse(completion.slice(completion.indexOf("=") + 1))).toEqual({
      schemaVersion: 1,
      destination: "runtime.tar.gz",
      manifestEntries: result.manifestEntries,
      archivedEntries: result.entries,
      rawBytes: result.rawSize,
      compressedBytes: result.size,
    });
    expect(await fs.readdir(output)).toEqual(["runtime.tar.gz"]);

    const extracted = path.join(root, "extracted");
    await fs.mkdir(extracted);
    await tar.x({ cwd: extracted, file: destination, strict: true });
    await expect(fs.readFile(path.join(extracted, "package", "version.txt"), "utf8")).resolves.toBe(
      "fixture-version\n",
    );
  });

  it("archives an explicit deterministic manifest independent of creation order", async () => {
    const root = await fixture();
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    const destination = path.join(output, "runtime.tar.gz");
    await fs.mkdir(path.join(source, "package"), { recursive: true });
    for (const name of ["z-last.txt", "m-middle.txt", "a-first.txt"]) {
      await fs.writeFile(path.join(source, "package", name), `${name}\n`);
    }

    await writeReleaseArchive({
      cwd: source,
      destination,
      entries: ["package"],
      requiredEntryPrefix: "package/",
      rawIdleTimeoutMs: 5_000,
      gzipIdleTimeoutMs: 5_000,
    });

    const archivedPaths: string[] = [];
    await tar.t({
      file: destination,
      gzip: true,
      strict: true,
      onReadEntry: (entry) => archivedPaths.push(entry.path),
    });
    expect(archivedPaths).toEqual([
      "package/",
      "package/a-first.txt",
      "package/m-middle.txt",
      "package/z-last.txt",
    ]);
  });

  it("streams thousands of hard-linked manifest entries without a pack scheduler", async () => {
    const root = await fixture();
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    const destination = path.join(output, "runtime.tar.gz");
    const packageRoot = path.join(source, "package");
    const seed = path.join(packageRoot, "seed.txt");
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(seed, "shared hard-link fixture\n");

    const linkedEntries = 4_096;
    for (let offset = 0; offset < linkedEntries; offset += 128) {
      await Promise.all(
        Array.from({ length: Math.min(128, linkedEntries - offset) }, (_, index) =>
          fs.link(
            seed,
            path.join(packageRoot, `linked-${String(offset + index).padStart(4, "0")}.txt`),
          ),
        ),
      );
    }

    const result = await writeReleaseArchive({
      cwd: source,
      destination,
      entries: ["package"],
      requiredEntryPrefix: "package/",
      rawIdleTimeoutMs: 5_000,
      gzipIdleTimeoutMs: 5_000,
    });

    expect(result.manifestEntries).toBe(linkedEntries + 2);
    expect(result.entries).toBe(result.manifestEntries);
    expect(result.rawSize).toBeGreaterThan(0);

    const archivedFileTypes = new Map<string, string>();
    await tar.t({
      file: destination,
      gzip: true,
      strict: true,
      onReadEntry: (entry) => {
        if (entry.path.endsWith(".txt")) {
          archivedFileTypes.set(entry.path, entry.type);
        }
      },
    });
    expect(archivedFileTypes.size).toBe(linkedEntries + 1);
    expect(new Set(archivedFileTypes.values())).toEqual(new Set(["File"]));
  });

  it("rejects roots that can escape or reinterpret the explicit manifest", async () => {
    const root = await fixture();
    const source = path.join(root, "source");
    const destination = path.join(root, "output", "runtime.tar.gz");
    await fs.mkdir(path.join(source, "package"), { recursive: true });

    for (const invalidRoot of ["../package", "/package", "@paths.txt", "package\\child"]) {
      await expect(
        writeReleaseArchive({
          cwd: source,
          destination,
          entries: [invalidRoot],
          requiredEntryPrefix: "package/",
          rawIdleTimeoutMs: 5_000,
          gzipIdleTimeoutMs: 5_000,
        }),
      ).rejects.toThrow(`Release archive manifest root is invalid: ${JSON.stringify(invalidRoot)}`);
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects unsupported filesystem entries with their exact manifest identity",
    async () => {
      const root = await fixture();
      const source = path.join(root, "source");
      const output = path.join(root, "output");
      const destination = path.join(output, "runtime.tar.gz");
      const unsupportedPath = path.join(source, "package", "runtime.pipe");
      await fs.mkdir(path.dirname(unsupportedPath), { recursive: true });
      await execFileAsync("mkfifo", [unsupportedPath]);

      await expect(
        writeReleaseArchive({
          cwd: source,
          destination,
          entries: ["package"],
          requiredEntryPrefix: "package/",
          rawIdleTimeoutMs: 5_000,
          gzipIdleTimeoutMs: 5_000,
        }),
      ).rejects.toThrow(
        'Release archive manifest contains an unsupported filesystem entry: {"path":"package/runtime.pipe","type":"fifo"}',
      );

      await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("times out a stream that never completes and removes every partial file", async () => {
    const root = await fixture();
    const output = path.join(root, "output");
    const destination = path.join(output, "runtime.tar.gz");
    const source = new PassThrough();

    await expect(
      writeStreamAtomically({
        destination,
        source,
        idleTimeoutMs: 25,
        verify: async () => undefined,
      }),
    ).rejects.toThrow("timed out after 25ms without downstream progress; 0 bytes transferred");

    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(output)).toEqual([]);
  });

  it("allows total transfer time to exceed the timeout while bytes keep moving", async () => {
    const root = await fixture();
    const output = path.join(root, "output");
    const destination = path.join(output, "runtime.tar.gz");
    const source = new PassThrough();
    const producer = (async () => {
      for (let index = 0; index < 6; index += 1) {
        source.write(Buffer.from(String(index)));
        await delay(25);
      }
      source.end();
    })();

    const result = await writeStreamAtomically({
      destination,
      source,
      idleTimeoutMs: 100,
      verify: async () => undefined,
    });
    await producer;

    expect(result.size).toBe(6);
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("012345");
    expect(await fs.readdir(output)).toEqual(["runtime.tar.gz"]);
  });

  it("tracks gzip output while upstream is idle under downstream backpressure", async () => {
    const root = await fixture();
    const output = path.join(root, "output");
    const destination = path.join(output, "runtime.tar.gz");
    const source = new PassThrough();
    const input = Buffer.alloc(512 * 1024);
    let state = 0x9e3779b9;
    for (let index = 0; index < input.length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      input[index] = state & 0xff;
    }
    source.end(input);
    let rawVerified = false;
    const bufferedChunks: Buffer[] = [];
    const downstreamProgress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bufferedChunks.push(chunk);
        callback();
      },
      flush(callback) {
        const buffered = Buffer.concat(bufferedChunks);
        let offset = 0;
        const emitNext = () => {
          if (offset >= buffered.length) {
            callback();
            return;
          }
          const end = Math.min(offset + 64 * 1024, buffered.length);
          this.push(buffered.subarray(offset, end));
          offset = end;
          setTimeout(emitNext, 25);
        };
        emitNext();
      },
    });
    const startedAt = Date.now();

    const result = await writeTwoPhaseGzipAtomically({
      destination,
      source,
      rawIdleTimeoutMs: 75,
      gzipIdleTimeoutMs: 75,
      compressionInputTransforms: [downstreamProgress],
      verifyRaw: async (rawPath) => {
        rawVerified = true;
        await expect(fs.readFile(rawPath)).resolves.toEqual(input);
      },
      verifyCompressed: async (compressedPath) => {
        const compressed = await fs.readFile(compressedPath);
        expect(await gunzipAsync(compressed)).toEqual(input);
      },
    });

    expect(rawVerified).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(175);
    expect(result.size).toBeGreaterThan(0);
    expect(await fs.readdir(output)).toEqual(["runtime.tar.gz"]);
  });

  it("allows raw creation to remain quiet longer than the gzip inactivity budget", async () => {
    const root = await fixture();
    const output = path.join(root, "output");
    const destination = path.join(output, "runtime.tar.gz");
    const source = new PassThrough();
    const producer = (async () => {
      source.write("first raw bytes");
      await delay(75);
      source.end("last raw bytes");
    })();

    const result = await writeTwoPhaseGzipAtomically({
      destination,
      source,
      rawIdleTimeoutMs: 1_000,
      gzipIdleTimeoutMs: 25,
      verifyRaw: async () => undefined,
      verifyCompressed: async () => undefined,
    });
    await producer;

    expect(result.size).toBeGreaterThan(0);
    expect(await fs.readdir(output)).toEqual(["runtime.tar.gz"]);
  });

  it("fails and cleans both phases when gzip makes no downstream progress", async () => {
    const root = await fixture();
    const output = path.join(root, "output");
    const destination = path.join(output, "runtime.tar.gz");
    const source = new PassThrough();
    source.end("raw archive bytes");
    const stalledTransform = new Transform({
      transform(_chunk: Buffer, _encoding, _callback) {},
    });

    await expect(
      writeTwoPhaseGzipAtomically({
        destination,
        source,
        rawIdleTimeoutMs: 500,
        gzipIdleTimeoutMs: 25,
        compressionInputTransforms: [stalledTransform],
        verifyRaw: async () => undefined,
        verifyCompressed: async () => undefined,
      }),
    ).rejects.toThrow(
      "Compressing runtime.tar.gz timed out after 25ms without downstream progress; 0 bytes transferred",
    );

    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(output)).toEqual([]);
  });

  it("includes an active-entry progress receipt when raw creation stops", async () => {
    const root = await fixture();
    const output = path.join(root, "output");
    const destination = path.join(output, "runtime.tar.gz");
    const source = new PassThrough();
    source.write("partial raw bytes");

    await expect(
      writeTwoPhaseGzipAtomically({
        destination,
        source,
        rawIdleTimeoutMs: 25,
        gzipIdleTimeoutMs: 500,
        rawProgressReceipt: () => ({
          schemaVersion: 1,
          phase: "raw-tar",
          manifestEntries: 3,
          completedEntries: 1,
          outputBytes: 17,
          activeEntry: {
            path: "package/blocked.bin",
            type: "file",
            size: 42,
            entryBytes: 7,
          },
        }),
        verifyRaw: async () => undefined,
        verifyCompressed: async () => undefined,
      }),
    ).rejects.toThrow(
      'progressReceipt={"schemaVersion":1,"phase":"raw-tar","manifestEntries":3,"completedEntries":1,"outputBytes":17,"activeEntry":{"path":"package/blocked.bin","type":"file","size":42,"entryBytes":7}}',
    );

    source.destroy();
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(output)).toEqual([]);
  });

  it("reports the active manifest entry when the real tar producer stops", async () => {
    const root = await fixture();
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    const destination = path.join(output, "runtime.tar.gz");
    await fs.mkdir(path.join(source, "package"), { recursive: true });
    await fs.writeFile(path.join(source, "package", "payload.bin"), Buffer.alloc(4_096, 0x61));
    let rawChunks = 0;
    const stalledRawOutput = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        rawChunks += 1;
        if (rawChunks <= 2) {
          callback(null, chunk);
          return;
        }
        this.push(chunk.subarray(0, Math.min(chunk.byteLength, 512)));
      },
    });

    await expect(
      writeReleaseArchive({
        cwd: source,
        destination,
        entries: ["package"],
        rawOutputTransforms: [stalledRawOutput],
        requiredEntryPrefix: "package/",
        rawIdleTimeoutMs: 25,
        gzipIdleTimeoutMs: 500,
      }),
    ).rejects.toThrow(
      /progressReceipt=.*"manifestEntries":2.*"activeEntry":\{"path":"package\/payload\.bin","type":"file","size":4096,"entryBytes":512\}/u,
    );

    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(output)).toEqual([]);
  });

  it("removes both private phases when compression fails", async () => {
    const root = await fixture();
    const output = path.join(root, "output");
    const destination = path.join(output, "runtime.tar.gz");
    const source = new PassThrough();
    source.end("raw archive bytes");
    const failingTransform = new Transform({
      transform(_chunk: Buffer, _encoding, callback) {
        callback(new Error("fixture compressor failed"));
      },
    });

    await expect(
      writeTwoPhaseGzipAtomically({
        destination,
        source,
        rawIdleTimeoutMs: 500,
        gzipIdleTimeoutMs: 500,
        compressionInputTransforms: [failingTransform],
        verifyRaw: async () => undefined,
        verifyCompressed: async () => undefined,
      }),
    ).rejects.toThrow("fixture compressor failed");

    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(output)).toEqual([]);
  });

  it("never overwrites an existing release asset", async () => {
    const root = await fixture();
    const output = path.join(root, "output");
    const destination = path.join(output, "runtime.tar.gz");
    const replacement = path.join(root, "replacement");
    await fs.mkdir(output);
    await fs.writeFile(destination, "trusted-existing-bytes");
    await fs.writeFile(replacement, "replacement-bytes");

    await expect(
      writeTwoPhaseGzipAtomically({
        destination,
        source: createReadStream(replacement),
        rawIdleTimeoutMs: 5_000,
        gzipIdleTimeoutMs: 5_000,
        verifyRaw: async () => undefined,
        verifyCompressed: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });

    await expect(fs.readFile(destination, "utf8")).resolves.toBe("trusted-existing-bytes");
    expect(await fs.readdir(output)).toEqual(["runtime.tar.gz"]);
  });
});
