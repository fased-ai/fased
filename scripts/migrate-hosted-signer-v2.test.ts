import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __testing } from "./migrate-hosted-signer-v2.mjs";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-signer-migration-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fsp.rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("hosted signer v2 migration", () => {
  it("defers destructive legacy quarantine until the cross-user transaction commits", () => {
    expect(__testing.deferLegacyQuarantine({ FASED_DEFER_LEGACY_QUARANTINE: "1" })).toBe(true);
    expect(__testing.deferLegacyQuarantine({})).toBe(false);
  });

  it("requires explicit fail-closed wallet policy fields", () => {
    expect(() =>
      __testing.assertWalletEntry({
        expectedPublicKey: "11111111111111111111111111111111",
        keystorePath: "/home/app/.fased/wallet/keystore-agent.v1.enc",
        passphrasePath: "/home/app/.fased/wallet/passphrase",
        policy: {
          assets: [],
          operations: ["agentSendNativeSol"],
          programs: ["11111111111111111111111111111111"],
          role: "agent",
        },
        walletId: "agent",
      }),
    ).toThrow("policy assets and positive caps must be explicit");
  });

  it("normalizes policy ordering for safe idempotent migration", () => {
    const first = {
      role: "MINING",
      operations: ["satClaim", "satCommit"],
      programs: ["sat-program", "system-program"],
      assets: [
        {
          asset: "SAT",
          destinations: ["destination-b", "destination-a"],
          maxPerTx: "10",
          maxDaily: "100",
        },
      ],
    };
    const second = {
      ...first,
      role: "mining",
      operations: first.operations.toReversed(),
      programs: first.programs.toReversed(),
      assets: [{ ...first.assets[0], destinations: first.assets[0].destinations.toReversed() }],
    };
    expect(__testing.comparablePolicy(first)).toBe(__testing.comparablePolicy(second));
  });

  it("rejects symlinks, hard links and group-readable legacy material", async () => {
    const directory = await temporaryDirectory();
    const source = path.join(directory, "keystore.enc");
    const alias = path.join(directory, "keystore-link.enc");
    const symlink = path.join(directory, "keystore-symlink.enc");
    await fsp.writeFile(source, "secret", { mode: 0o600 });
    await fsp.link(source, alias);
    await fsp.symlink(source, symlink);
    const allowedUids = new Set([process.getuid?.() ?? fs.statSync(source).uid]);

    await expect(
      __testing.openVerifiedSourceFile(source, [directory], allowedUids, "legacy material"),
    ).rejects.toThrow("single-link");
    await fsp.unlink(alias);
    await expect(
      __testing.openVerifiedSourceFile(symlink, [directory], allowedUids, "legacy material"),
    ).rejects.toThrow();
    await fsp.chmod(source, 0o640);
    await expect(
      __testing.openVerifiedSourceFile(source, [directory], allowedUids, "legacy material"),
    ).rejects.toThrow("group or others");
  });

  it("copies from the verified descriptor even after the source pathname changes", async () => {
    const directory = await temporaryDirectory();
    const source = path.join(directory, "passphrase");
    const moved = path.join(directory, "passphrase-original");
    const destination = path.join(directory, "staged-passphrase");
    await fsp.writeFile(source, "verified-secret", { mode: 0o600 });
    const stat = await fsp.stat(source);
    const handle = await __testing.openVerifiedSourceFile(
      source,
      [directory],
      new Set([stat.uid]),
      "legacy material",
    );
    try {
      await fsp.rename(source, moved);
      await fsp.writeFile(source, "replacement", { mode: 0o600 });
      await __testing.copySignerOwned(handle, destination, stat.uid, stat.gid);
      await expect(fsp.readFile(destination, "utf8")).resolves.toBe("verified-secret");
    } finally {
      await handle.close();
    }
  });

  it("locks and quarantines the verified legacy inode before removing its source name", async () => {
    const directory = await temporaryDirectory();
    const source = path.join(directory, "keystore-agent.v1.enc");
    const destination = `${source}.migrated-v2`;
    await fsp.writeFile(source, "encrypted-secret", { mode: 0o600 });
    const stat = await fsp.stat(source);
    const owner = { uid: stat.uid, gid: stat.gid };

    await expect(
      __testing.quarantineLegacyFile(source, [directory], new Set([stat.uid]), owner),
    ).resolves.toBe(destination);
    await expect(fsp.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    const quarantined = await fsp.lstat(destination);
    expect(quarantined.size).toBe(Buffer.byteLength("encrypted-secret"));
    expect(quarantined.mode & 0o777).toBe(0);
    expect(quarantined.nlink).toBe(1);

    await expect(
      __testing.quarantineLegacyFile(source, [directory], new Set([stat.uid]), owner),
    ).resolves.toBe(destination);
  });

  it("resumes the durable two-link quarantine state after an interrupted cleanup", async () => {
    const directory = await temporaryDirectory();
    const source = path.join(directory, "passphrase");
    const destination = `${source}.migrated-v2`;
    await fsp.writeFile(source, "legacy-passphrase", { mode: 0o600 });
    const stat = await fsp.stat(source);
    const owner = { uid: stat.uid, gid: stat.gid };
    await fsp.chmod(source, 0o000);
    await fsp.link(source, destination);

    await expect(
      __testing.quarantineLegacyFile(source, [directory], new Set([stat.uid]), owner),
    ).resolves.toBe(destination);
    await expect(fsp.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    const quarantined = await fsp.lstat(destination);
    expect(quarantined.nlink).toBe(1);
    expect(quarantined.mode & 0o777).toBe(0);
  });

  it("refuses to overwrite an unrelated quarantine destination", async () => {
    const directory = await temporaryDirectory();
    const source = path.join(directory, "keystore-vault.v1.enc");
    const destination = `${source}.migrated-v2`;
    await fsp.writeFile(source, "encrypted-secret", { mode: 0o600 });
    await fsp.writeFile(destination, "collision", { mode: 0o000 });
    const stat = await fsp.stat(source);

    await expect(
      __testing.quarantineLegacyFile(source, [directory], new Set([stat.uid]), {
        uid: stat.uid,
        gid: stat.gid,
      }),
    ).rejects.toThrow("destination already exists");
    await expect(fsp.readFile(source, "utf8")).resolves.toBe("encrypted-secret");
  });
});
