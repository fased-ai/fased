import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Transform } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
  writeReleaseArchive,
  writeStreamAtomically,
  writeTwoPhaseGzipAtomically,
} from "./release-archive.js";

const gunzipAsync = promisify(gunzip);

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-release-archive-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
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

    const result = await writeReleaseArchive({
      cwd: source,
      destination,
      entries: ["package"],
      requiredEntryPrefix: "package/",
      idleTimeoutMs: 5_000,
    });

    expect(result.entries).toBeGreaterThan(1);
    expect(result.size).toBeGreaterThan(0);
    expect(await fs.readdir(output)).toEqual(["runtime.tar.gz"]);

    const extracted = path.join(root, "extracted");
    await fs.mkdir(extracted);
    await tar.x({ cwd: extracted, file: destination, strict: true });
    await expect(fs.readFile(path.join(extracted, "package", "version.txt"), "utf8")).resolves.toBe(
      "fixture-version\n",
    );
  });

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
      idleTimeoutMs: 75,
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
        idleTimeoutMs: 25,
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
        idleTimeoutMs: 500,
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
        idleTimeoutMs: 5_000,
        verifyRaw: async () => undefined,
        verifyCompressed: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });

    await expect(fs.readFile(destination, "utf8")).resolves.toBe("trusted-existing-bytes");
    expect(await fs.readdir(output)).toEqual(["runtime.tar.gz"]);
  });
});
