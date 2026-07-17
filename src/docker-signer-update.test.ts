import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Docker signer update transaction", () => {
  it("cannot start a new signer until an offline snapshot and its metadata are verified", async () => {
    const script = await readFile(resolve(repoRoot, "scripts/docker-signer-update.sh"), "utf8");
    const transaction = script.slice(script.indexOf('echo "Stopping Gateway'));
    const stop = transaction.indexOf("stop_runtime_for_snapshot");
    const snapshot = transaction.indexOf("snapshot_state_archive");
    const manifest = transaction.indexOf('mv "$manifest_tmp"');
    const verify = transaction.indexOf('verify_snapshot_metadata "$snapshot_dir"');
    const installDefinition = transaction.indexOf('install_target_definition "$snapshot_dir"');
    const bindTarget = transaction.indexOf(
      'assert_target_container_binding "$target_image_id" "$state_volume"',
    );
    const activate = transaction.indexOf("activate_current_runtime");

    expect(stop).toBeGreaterThanOrEqual(0);
    expect(snapshot).toBeGreaterThan(stop);
    expect(manifest).toBeGreaterThan(snapshot);
    expect(verify).toBeGreaterThan(manifest);
    expect(installDefinition).toBeGreaterThan(verify);
    expect(bindTarget).toBeGreaterThan(installDefinition);
    expect(activate).toBeGreaterThan(bindTarget);
    expect(script).toContain("assert_project_signer_stopped");
    expect(script).toContain('extract_target_compose "$target_image_id"');
    expect(script).toContain("fased-docker-signer-snapshot-v3");
    expect(script).toContain("--expected-build-input-digest");
    expect(script).toContain("--expected-development");
    expect(script).toContain("--require-production");
    expect(script).toContain("dst=/signer-state,readonly");
    expect(script).toContain("target image tag must be a unique semantic version");
    expect(script).toContain("--expected-release-commit");
    expect(script).toContain("--expected-signer-build-input-digest");
    expect(script).toContain("does not match verified release metadata");
    expect(script).not.toContain("docker cp");
    expect(script).not.toMatch(/cp[^\n]*state\.db/);

    const rollback = script.slice(
      script.indexOf("rollback_snapshot()"),
      script.indexOf('target_image=""'),
    );
    expect(rollback.indexOf("stop_runtime_for_rollback")).toBeLessThan(
      rollback.indexOf("restore_state_archive"),
    );
    expect(rollback.indexOf("restore_state_archive")).toBeLessThan(
      rollback.indexOf("restore_snapshot_definition"),
    );
    expect(rollback).toContain('[[ "$rollback_id" == "$old_image_id" ]]');
    expect(rollback).toMatch(/activate_current_runtime\s+\\\n\s+"\$old_version"/u);
  });

  it("restores the verified snapshot and exact old image after target health fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "fased-docker-signer-update-"));
    roots.push(root);
    const scriptsDir = join(root, "scripts");
    const binDir = join(root, "bin");
    const snapshotDir = join(root, "backups", "tx-1");
    const logPath = join(root, "docker.log");
    const oldId = `sha256:${"a".repeat(64)}`;
    const targetId = `sha256:${"b".repeat(64)}`;
    const targetImage = "ghcr.io/fased-ai/fased:9.9.9";
    await mkdir(scriptsDir);
    await mkdir(binDir);
    await mkdir(join(root, "backups"));
    await copyFile(
      join(repoRoot, "scripts/docker-signer-update.sh"),
      join(scriptsDir, "docker-signer-update.sh"),
    );
    await chmod(join(scriptsDir, "docker-signer-update.sh"), 0o755);
    await writeFile(join(root, "docker-compose.yml"), "services:\n  old: {}\n");
    await writeFile(
      join(root, ".env"),
      "FASED_IMAGE=ghcr.io/fased-ai/fased:1.2.3\nFASED_GATEWAY_TOKEN=secret\n",
      { mode: 0o600 },
    );
    await writeFile(join(root, "signer.running"), "true\n");
    await writeFile(join(root, "gateway.running"), "true\n");
    await writeFile(logPath, "");

    const dockerStub = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf \'%s\\n\' "$*" >>"$FAKE_LOG"',
      `OLD_ID="${oldId}"`,
      `TARGET_ID="${targetId}"`,
      `TARGET_IMAGE="${targetImage}"`,
      'if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then exit 0; fi',
      'if [[ "${1:-}" == "compose" ]]; then',
      '  args="$*"',
      '  if [[ "$args" == *" ps -a -q fased-signerd"* ]]; then echo signer-cid; exit 0; fi',
      '  if [[ "$args" == *" config --quiet"* ]]; then exit 0; fi',
      '  if [[ "$args" == *" create --force-recreate fased-signerd"* ]]; then exit 0; fi',
      '  if [[ "$args" == *"exec -T fased-gateway node dist/index.js --version"* ]]; then',
      '    if grep -q "$TARGET_ID" "$FAKE_ROOT/.env"; then echo 9.9.9; else echo 1.2.3; fi',
      "    exit 0",
      "  fi",
      '  if [[ "$args" == *" up -d --force-recreate --wait --wait-timeout 60 fased-signerd"* ]]; then',
      '    if grep -q "$TARGET_ID" "$FAKE_ROOT/.env" && [[ "${FAKE_TARGET_HEALTH_OK:-}" != "1" ]]; then exit 42; fi',
      "    printf 'true\\n' >\"$FAKE_ROOT/signer.running\"",
      "    exit 0",
      "  fi",
      '  if [[ "$args" == *" up -d --force-recreate --no-deps --wait --wait-timeout 60 fased-gateway"* ]]; then',
      "    printf 'true\\n' >\"$FAKE_ROOT/gateway.running\"",
      "    exit 0",
      "  fi",
      "  exit 0",
      "fi",
      'if [[ "${1:-}" == "ps" ]]; then',
      '  if [[ "$*" == *"service=fased-signerd"* ]]; then echo signer-cid; fi',
      '  if [[ "$*" == *"service=fased-gateway"* ]]; then echo gateway-cid; fi',
      "  exit 0",
      "fi",
      'if [[ "${1:-}" == "inspect" ]]; then',
      '  target="${@: -1}"',
      '  if [[ "$*" == *"com.docker.compose.project"* ]]; then echo testproject; exit 0; fi',
      '  if [[ "$*" == *"{{.Image}}"* ]]; then',
      '    if grep -q "$TARGET_ID" "$FAKE_ROOT/.env"; then echo "$TARGET_ID"; else echo "$OLD_ID"; fi',
      "    exit 0",
      "  fi",
      '  if [[ "$*" == *".Mounts"* ]]; then echo testproject_fased-signer-state; exit 0; fi',
      '  if [[ "$*" == *".State.Running"* ]]; then',
      '    if [[ "$target" == "signer-cid" ]]; then cat "$FAKE_ROOT/signer.running"; else cat "$FAKE_ROOT/gateway.running"; fi',
      "    exit 0",
      "  fi",
      "fi",
      'if [[ "${1:-}" == "stop" ]]; then',
      '  if [[ "${2:-}" == "signer-cid" ]]; then printf \'false\\n\' >"$FAKE_ROOT/signer.running"; fi',
      '  if [[ "${2:-}" == "gateway-cid" ]]; then printf \'false\\n\' >"$FAKE_ROOT/gateway.running"; fi',
      "  exit 0",
      "fi",
      'if [[ "${1:-}" == "image" && "${2:-}" == "inspect" ]]; then',
      '  ref="${@: -1}"',
      '  if [[ "$ref" == fased-signer-rollback:* && "${FAKE_MISSING_ROLLBACK_IMAGE:-}" == "1" ]]; then exit 44; fi',
      '  if [[ "$ref" == "$TARGET_IMAGE" ]]; then echo "$TARGET_ID"; else echo "$OLD_ID"; fi',
      "  exit 0",
      "fi",
      'if [[ "${1:-}" == "image" && "${2:-}" == "tag" ]]; then exit 0; fi',
      'if [[ "${1:-}" == "pull" ]]; then exit 0; fi',
      'if [[ "${1:-}" == "volume" && "${2:-}" == "inspect" ]]; then exit 0; fi',
      'if [[ "${1:-}" == "run" ]]; then',
      '  if [[ "$*" == *"--rm -i"* ]]; then cat >/dev/null; printf \'yes\\n\' >"$FAKE_ROOT/restored"; exit 0; fi',
      '  if [[ "$*" == *"--entrypoint /usr/local/bin/fased-signerd"* && "$*" == *"--version"* ]]; then',
      '    if [[ "$*" == *"$TARGET_ID"* ]]; then',
      `      echo "fased-signerd 9.9.9 commit=${"c".repeat(40)} buildInputDigest=sha256:${"d".repeat(64)} development=\${FAKE_TARGET_SIGNER_DEVELOPMENT:-false}"`,
      "    else",
      '      echo "fased-signerd 1.2.3 commit=unknown buildInputDigest=unknown development=true"',
      "    fi",
      "    exit 0",
      "  fi",
      '  if [[ "$*" == *"--entrypoint node"* && "$*" == *"/app/dist/index.js --version"* ]]; then',
      '    if [[ "$*" == *"$TARGET_ID"* ]]; then echo 9.9.9; else echo 1.2.3; fi',
      "    exit 0",
      "  fi",
      '  if [[ "$*" == *"--entrypoint /bin/cat"* && "$*" == *"/app/docker-compose.yml"* ]]; then',
      "    printf 'services:\\n  target: {}\\n'",
      "    exit 0",
      "  fi",
      "  printf 'offline-signer-state-v1'",
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n");
    await writeFile(join(binDir, "docker"), dockerStub, { mode: 0o755 });

    const developmentTarget = spawnSync(
      "bash",
      [
        join(scriptsDir, "docker-signer-update.sh"),
        "--image",
        targetImage,
        "--snapshot-dir",
        join(root, "backups", "tx-development"),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          FAKE_LOG: logPath,
          FAKE_ROOT: root,
          FAKE_TARGET_SIGNER_DEVELOPMENT: "true",
        },
        encoding: "utf8",
      },
    );
    expect(developmentTarget.status).toBe(1);
    expect(developmentTarget.stderr).toContain(
      "registry target image contains a development signer identity",
    );
    expect(await readFile(logPath, "utf8")).not.toContain("stop signer-cid");
    await writeFile(logPath, "");

    const mismatchedMetadata = spawnSync(
      "bash",
      [
        join(scriptsDir, "docker-signer-update.sh"),
        "--image",
        targetImage,
        "--snapshot-dir",
        join(root, "backups", "tx-mismatched-metadata"),
        "--expected-release-commit",
        "e".repeat(40),
        "--expected-signer-build-input-digest",
        `sha256:${"d".repeat(64)}`,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          FAKE_LOG: logPath,
          FAKE_ROOT: root,
        },
        encoding: "utf8",
      },
    );
    expect(mismatchedMetadata.status).toBe(1);
    expect(mismatchedMetadata.stderr).toContain(
      "target signer release commit does not match verified release metadata",
    );
    expect(await readFile(logPath, "utf8")).not.toContain("stop signer-cid");
    await writeFile(logPath, "");

    const result = spawnSync(
      "bash",
      [
        join(scriptsDir, "docker-signer-update.sh"),
        "--image",
        targetImage,
        "--snapshot-dir",
        snapshotDir,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          FAKE_LOG: logPath,
          FAKE_ROOT: root,
        },
        encoding: "utf8",
      },
    );

    const dockerLog = await readFile(logPath, "utf8");
    expect(result.status, `${result.stdout}\n${result.stderr}\n${dockerLog}`).toBe(1);
    expect(result.stderr).toContain("target activation failed; automatic rollback is starting");
    expect(result.stderr).toContain("Automatic rollback completed");
    expect(await readFile(join(root, "restored"), "utf8")).toBe("yes\n");
    expect(await readFile(join(root, ".env"), "utf8")).toContain(
      `FASED_IMAGE=fased-signer-rollback:${"a".repeat(64)}`,
    );
    expect(await readFile(join(root, "docker-compose.yml"), "utf8")).toBe("services:\n  old: {}\n");
    expect(await readFile(join(snapshotDir, "docker-compose.target.yml"), "utf8")).toBe(
      "services:\n  target: {}\n",
    );
    expect(await readFile(join(snapshotDir, "signer-state.tar"), "utf8")).toBe(
      "offline-signer-state-v1",
    );
    expect((await stat(join(snapshotDir, "signer-state.tar"))).mode & 0o777).toBe(0o600);

    const log = dockerLog;
    const signerStop = log.indexOf("stop signer-cid");
    const offlineCopy = log.indexOf("dst=/signer-state,readonly");
    const targetStart = log.indexOf(
      "up -d --force-recreate --wait --wait-timeout 60 fased-signerd",
    );
    const restore = log.indexOf("run --rm -i");
    const rollbackStart = log.lastIndexOf(
      "up -d --force-recreate --wait --wait-timeout 60 fased-signerd",
    );
    expect(signerStop).toBeGreaterThanOrEqual(0);
    expect(offlineCopy).toBeGreaterThan(signerStop);
    expect(targetStart).toBeGreaterThan(offlineCopy);
    expect(restore).toBeGreaterThan(targetStart);
    expect(rollbackStart).toBeGreaterThan(restore);

    await writeFile(join(snapshotDir, "signer-state.tar"), "tampered-state");
    await writeFile(logPath, "");
    const tamperedRollback = spawnSync(
      "bash",
      [join(scriptsDir, "docker-signer-update.sh"), "--rollback", snapshotDir],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          FAKE_LOG: logPath,
          FAKE_ROOT: root,
        },
        encoding: "utf8",
      },
    );
    expect(tamperedRollback.status).toBe(1);
    expect(tamperedRollback.stderr).toContain("snapshot checksum verification failed");
    const tamperedLog = await readFile(logPath, "utf8");
    expect(tamperedLog).not.toContain("stop signer-cid");
    expect(tamperedLog).not.toContain("run --rm -i");

    await writeFile(join(snapshotDir, "signer-state.tar"), "offline-signer-state-v1", {
      mode: 0o600,
    });
    await writeFile(logPath, "");
    const missingImageRollback = spawnSync(
      "bash",
      [join(scriptsDir, "docker-signer-update.sh"), "--rollback", snapshotDir],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          FAKE_LOG: logPath,
          FAKE_ROOT: root,
          FAKE_MISSING_ROLLBACK_IMAGE: "1",
        },
        encoding: "utf8",
      },
    );
    expect(missingImageRollback.status).toBe(1);
    expect(missingImageRollback.stderr).toContain("exact rollback image is unavailable");
    const missingImageLog = await readFile(logPath, "utf8");
    expect(missingImageLog).not.toContain("stop signer-cid");
    expect(missingImageLog).not.toContain("run --rm -i");

    const successfulSnapshotDir = join(root, "backups", "tx-2");
    await writeFile(logPath, "");
    const successfulUpdate = spawnSync(
      "bash",
      [
        join(scriptsDir, "docker-signer-update.sh"),
        "--image",
        targetImage,
        "--snapshot-dir",
        successfulSnapshotDir,
        "--expected-release-commit",
        "c".repeat(40),
        "--expected-signer-build-input-digest",
        `sha256:${"d".repeat(64)}`,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          FAKE_LOG: logPath,
          FAKE_ROOT: root,
          FAKE_TARGET_HEALTH_OK: "1",
        },
        encoding: "utf8",
      },
    );
    expect(
      successfulUpdate.status,
      `${successfulUpdate.stdout}\n${successfulUpdate.stderr}\n${await readFile(logPath, "utf8")}`,
    ).toBe(0);
    expect(successfulUpdate.stdout).toContain("Fased version: 9.9.9");
    expect(await readFile(join(root, ".env"), "utf8")).toContain(`FASED_IMAGE=${targetId}`);
    expect(await readFile(join(root, "docker-compose.yml"), "utf8")).toBe(
      "services:\n  target: {}\n",
    );
  });
});
