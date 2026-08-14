import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Transform } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { writeReleaseArchive, writeStreamAtomically } from "./release-archive.js";

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
    ).rejects.toThrow("timed out after 25ms without progress; 0 bytes transferred");

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

  it("measures raw-source progress while a downstream transform buffers output", async () => {
    const root = await fixture();
    const output = path.join(root, "output");
    const destination = path.join(output, "runtime.tar.gz");
    const source = new PassThrough();
    const bufferedChunks: Buffer[] = [];
    const bufferingTransform = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bufferedChunks.push(chunk);
        callback();
      },
      flush(callback) {
        this.push(Buffer.concat([Buffer.from("transformed:"), ...bufferedChunks]));
        callback();
      },
    });
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
      transforms: [bufferingTransform],
      idleTimeoutMs: 75,
      verify: async () => undefined,
    });
    await producer;

    expect(result.size).toBe(18);
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("transformed:012345");
    expect(await fs.readdir(output)).toEqual(["runtime.tar.gz"]);
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
      writeStreamAtomically({
        destination,
        source: createReadStream(replacement),
        idleTimeoutMs: 5_000,
        verify: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });

    await expect(fs.readFile(destination, "utf8")).resolves.toBe("trusted-existing-bytes");
    expect(await fs.readdir(output)).toEqual(["runtime.tar.gz"]);
  });
});
