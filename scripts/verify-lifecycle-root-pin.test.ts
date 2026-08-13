import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyLifecycleRootPin } from "./verify-lifecycle-root-pin.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fased-root-pin-test-"));
  roots.push(directory);
  const rootPath = path.join(directory, "root.json");
  const pinPath = path.join(directory, "root.sha256");
  const body = Buffer.from('{"signed":{"schemaVersion":1}}\n');
  const digest = createHash("sha256").update(body).digest("hex");
  await fs.writeFile(rootPath, body);
  await fs.writeFile(pinPath, `${digest}\n`);
  return { digest, directory, pinPath, rootPath };
}

describe("lifecycle root pin", () => {
  it("accepts the exact checked-in root digest", async () => {
    const fixtureFiles = await fixture();
    await expect(verifyLifecycleRootPin(fixtureFiles)).resolves.toBe(fixtureFiles.digest);
  });

  it("rejects a stale digest", async () => {
    const fixtureFiles = await fixture();
    await fs.writeFile(fixtureFiles.pinPath, `${"0".repeat(64)}\n`);
    await expect(verifyLifecycleRootPin(fixtureFiles)).rejects.toThrow(
      "lifecycle root pin mismatch",
    );
  });

  it("rejects a symlinked pin", async () => {
    const fixtureFiles = await fixture();
    const target = path.join(fixtureFiles.directory, "target.sha256");
    await fs.rename(fixtureFiles.pinPath, target);
    await fs.symlink(target, fixtureFiles.pinPath);
    await expect(verifyLifecycleRootPin(fixtureFiles)).rejects.toThrow(
      "lifecycle root pin is not a safe regular file",
    );
  });
});
