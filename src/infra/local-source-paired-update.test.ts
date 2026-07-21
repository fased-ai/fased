import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateLocalSourceSigner,
  assertLocalSourcePairedGatewayStartAllowed,
  commitLocalSourcePairedUpdate,
  isLocalSourceSignerConfigured,
  markLocalSourceAppActive,
  markLocalSourceGatewayVerified,
  prepareLocalSourcePairedUpdate,
  readLocalSourcePairedUpdateJournal,
  recoverLocalSourcePairedUpdate,
  rollbackLocalSourcePairedUpdate,
  verifyLocalSourceSigner,
} from "./local-source-paired-update.js";

const cleanupRoots: string[] = [];

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function writeRelease(root: string, version: string, distMarker: string) {
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "source-pair-fixture", version, type: "module" })}\n`,
  );
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "marker.txt"), `${distMarker}\n`);
}

function createFixture() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-source-pair-"));
  cleanupRoots.push(fixtureRoot);
  const sourceRoot = path.join(fixtureRoot, "source");
  const stateDir = path.join(fixtureRoot, "state");
  const fakeBin = path.join(fixtureRoot, "bin");
  const signerLog = path.join(fixtureRoot, "signer.log");
  fs.mkdirSync(path.join(sourceRoot, "scripts"), { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, ".gitignore"), "dist/\nnode_modules/\n");
  fs.writeFileSync(path.join(sourceRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  fs.writeFileSync(
    path.join(sourceRoot, "scripts", "fased-managed-updater.mjs"),
    [
      'import { controllerReady } from "./hosted-release-manifest.mjs";',
      'import fs from "node:fs";',
      "if (!controllerReady) process.exit(2);",
      'fs.appendFileSync(process.env.FASED_TEST_SIGNER_LOG, `controller ${process.argv.slice(2).join(" ")}\\n`);',
      'process.stdout.write("{\\"ok\\":true}\\n");',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  fs.writeFileSync(
    path.join(sourceRoot, "scripts", "hosted-release-manifest.mjs"),
    "export const controllerReady = true;\n",
  );
  fs.writeFileSync(path.join(sourceRoot, "scripts", "managed-runtime-layout.mjs"), "export {};\n");
  fs.writeFileSync(
    path.join(sourceRoot, "scripts", "install-fased-signerd.sh"),
    '#!/usr/bin/env bash\nprintf "installer %s\\n" "$*" >>"$FASED_TEST_SIGNER_LOG"\n',
    { mode: 0o700 },
  );
  fs.writeFileSync(
    path.join(fakeBin, "pnpm"),
    '#!/usr/bin/env bash\nprintf "pnpm %s\\n" "$*" >>"$FASED_TEST_SIGNER_LOG"\n',
    { mode: 0o700 },
  );
  writeRelease(sourceRoot, "1.0.0", "dist-v1");
  execFileSync("git", ["init", "-b", "main", sourceRoot]);
  git(sourceRoot, "config", "user.email", "test@example.invalid");
  git(sourceRoot, "config", "user.name", "Fased Test");
  git(sourceRoot, "add", ".");
  git(sourceRoot, "commit", "-m", "v1");
  const previousSha = git(sourceRoot, "rev-parse", "HEAD");
  const env = {
    ...process.env,
    FASED_STATE_DIR: stateDir,
    FASED_TEST_SIGNER_LOG: signerLog,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
  };
  return { sourceRoot, stateDir, signerLog, previousSha, env };
}

function createTarget(sourceRoot: string): string {
  writeRelease(sourceRoot, "1.0.1", "dist-v2");
  git(sourceRoot, "add", "package.json");
  git(sourceRoot, "commit", "-m", "v2");
  return git(sourceRoot, "rev-parse", "HEAD");
}

describe("Local source app/signer paired transaction", () => {
  it("includes registered pre-v2 wallet material in the paired update boundary", async () => {
    const fixture = createFixture();
    const walletDir = path.join(fixture.stateDir, "wallet");
    fs.mkdirSync(walletDir, { recursive: true });
    fs.writeFileSync(path.join(walletDir, "keystore-solana-agent.v1.enc"), "fixture", {
      mode: 0o600,
    });
    await expect(isLocalSourceSignerConfigured(fixture.env)).resolves.toBe(true);
  });

  it("blocks an unpaired Gateway and restores the exact source and signer controller", async () => {
    const fixture = createFixture();
    let journal = await prepareLocalSourcePairedUpdate({
      sourceRoot: fixture.sourceRoot,
      timeoutMs: 10_000,
      env: fixture.env,
    });
    const targetSha = createTarget(fixture.sourceRoot);
    journal = await markLocalSourceAppActive({
      journal,
      targetSha,
      targetVersion: "1.0.1",
      env: fixture.env,
    });

    await expect(
      assertLocalSourcePairedGatewayStartAllowed({
        runtimeRoot: fixture.sourceRoot,
        env: fixture.env,
      }),
    ).rejects.toThrow("Gateway startup is blocked");

    journal = await activateLocalSourceSigner({ journal, timeoutMs: 10_000, env: fixture.env });
    await expect(
      assertLocalSourcePairedGatewayStartAllowed({
        runtimeRoot: fixture.sourceRoot,
        env: fixture.env,
      }),
    ).resolves.toBeUndefined();
    await verifyLocalSourceSigner({ journal, timeoutMs: 10_000, env: fixture.env });
    await rollbackLocalSourcePairedUpdate({ journal, timeoutMs: 10_000, env: fixture.env });

    expect(git(fixture.sourceRoot, "rev-parse", "HEAD")).toBe(fixture.previousSha);
    expect(
      JSON.parse(fs.readFileSync(path.join(fixture.sourceRoot, "package.json"), "utf8")),
    ).toMatchObject({
      version: "1.0.0",
    });
    expect(fs.readFileSync(path.join(fixture.sourceRoot, "dist", "marker.txt"), "utf8")).toBe(
      "dist-v1\n",
    );
    expect(await readLocalSourcePairedUpdateJournal(fixture.env)).toBeNull();
    expect(fs.readFileSync(fixture.signerLog, "utf8")).toContain(
      `installer --version 1.0.1 --expected-commit ${targetSha} --defer-commit`,
    );
    expect(fs.readFileSync(fixture.signerLog, "utf8")).toContain(
      `controller local-signer verify --version 1.0.1 --expected-commit ${targetSha}`,
    );
    expect(fs.readFileSync(fixture.signerLog, "utf8")).toContain(
      "controller local-signer rollback",
    );
    expect(fs.readFileSync(fixture.signerLog, "utf8")).toContain(
      "pnpm install --offline --frozen-lockfile",
    );
  });

  it("repairs the missing v0.1.72 controller dependency from exact tracked bytes", async () => {
    const fixture = createFixture();
    let journal = await prepareLocalSourcePairedUpdate({
      sourceRoot: fixture.sourceRoot,
      timeoutMs: 10_000,
      env: fixture.env,
    });
    const missingDependency = path.join(
      journal.transactionDir,
      "controller",
      "hosted-release-manifest.mjs",
    );
    fs.rmSync(missingDependency);
    const targetSha = createTarget(fixture.sourceRoot);
    journal = await markLocalSourceAppActive({
      journal,
      targetSha,
      targetVersion: "1.0.1",
      env: fixture.env,
    });

    await rollbackLocalSourcePairedUpdate({ journal, timeoutMs: 10_000, env: fixture.env });

    expect(git(fixture.sourceRoot, "rev-parse", "HEAD")).toBe(fixture.previousSha);
    expect(await readLocalSourcePairedUpdateJournal(fixture.env)).toBeNull();
    expect(fs.readFileSync(fixture.signerLog, "utf8")).toContain(
      "controller local-signer rollback",
    );
  });

  it("forward-commits only after the durable Gateway verification decision", async () => {
    const fixture = createFixture();
    let journal = await prepareLocalSourcePairedUpdate({
      sourceRoot: fixture.sourceRoot,
      timeoutMs: 10_000,
      env: fixture.env,
    });
    const targetSha = createTarget(fixture.sourceRoot);
    journal = await markLocalSourceAppActive({
      journal,
      targetSha,
      targetVersion: "1.0.1",
      env: fixture.env,
    });
    journal = await activateLocalSourceSigner({ journal, timeoutMs: 10_000, env: fixture.env });
    journal = await markLocalSourceGatewayVerified(journal, fixture.env);

    await commitLocalSourcePairedUpdate({ journal, timeoutMs: 10_000, env: fixture.env });

    expect(git(fixture.sourceRoot, "rev-parse", "HEAD")).toBe(targetSha);
    expect(await readLocalSourcePairedUpdateJournal(fixture.env)).toBeNull();
    expect(fs.readFileSync(fixture.signerLog, "utf8")).toContain("controller local-signer commit");
  });

  it("recovers pre-verification phases by rollback and post-verification phases by commit", async () => {
    const rollbackFixture = createFixture();
    let rollbackJournal = await prepareLocalSourcePairedUpdate({
      sourceRoot: rollbackFixture.sourceRoot,
      timeoutMs: 10_000,
      env: rollbackFixture.env,
    });
    const rollbackTarget = createTarget(rollbackFixture.sourceRoot);
    rollbackJournal = await markLocalSourceAppActive({
      journal: rollbackJournal,
      targetSha: rollbackTarget,
      targetVersion: "1.0.1",
      env: rollbackFixture.env,
    });
    rollbackJournal = await activateLocalSourceSigner({
      journal: rollbackJournal,
      timeoutMs: 10_000,
      env: rollbackFixture.env,
    });
    expect(
      await recoverLocalSourcePairedUpdate({ timeoutMs: 10_000, env: rollbackFixture.env }),
    ).toBe("rolled-back");
    expect(git(rollbackFixture.sourceRoot, "rev-parse", "HEAD")).toBe(rollbackFixture.previousSha);

    const commitFixture = createFixture();
    let commitJournal = await prepareLocalSourcePairedUpdate({
      sourceRoot: commitFixture.sourceRoot,
      timeoutMs: 10_000,
      env: commitFixture.env,
    });
    const commitTarget = createTarget(commitFixture.sourceRoot);
    commitJournal = await markLocalSourceAppActive({
      journal: commitJournal,
      targetSha: commitTarget,
      targetVersion: "1.0.1",
      env: commitFixture.env,
    });
    commitJournal = await activateLocalSourceSigner({
      journal: commitJournal,
      timeoutMs: 10_000,
      env: commitFixture.env,
    });
    await markLocalSourceGatewayVerified(commitJournal, commitFixture.env);
    expect(
      await recoverLocalSourcePairedUpdate({ timeoutMs: 10_000, env: commitFixture.env }),
    ).toBe("committed");
    expect(git(commitFixture.sourceRoot, "rev-parse", "HEAD")).toBe(commitTarget);
  });
});
