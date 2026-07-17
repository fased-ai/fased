import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Docker initial signer policy helper", () => {
  it("is fail-closed, digest-confirmed, and limited to the initial deny-all transition", async () => {
    const script = await readFile(resolve(repoRoot, "scripts/docker-signer-policy.sh"), "utf8");
    expect(script).toContain('[[ "$initial_install" == "1" ]]');
    expect(script).toContain("REPLACE_WITH_");
    expect(script).toContain('[[ "$confirmed_digest" == "$digest" ]]');
    expect(script).toContain("--expected-version 1");
    expect(script).toContain("docker-signer-health.mjs");
    expect(script).toContain("trap cleanup EXIT");
    expect(script).not.toContain("sudo");
    expect(script).not.toContain("docker.sock");
    expect(script).not.toContain("--privileged");
  });

  it("stages only a fully digest-confirmed version-1 policy through the signer container", async () => {
    const root = await mkdtemp(join(tmpdir(), "fased-docker-policy-"));
    roots.push(root);
    const binDir = join(root, "bin");
    const logPath = join(root, "docker.log");
    const policyPath = join(root, "agent.json");
    await mkdir(binDir);
    await writeFile(
      join(binDir, "docker"),
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$*" >>"$DOCKER_LOG"\n',
      { mode: 0o755 },
    );
    await writeFile(
      policyPath,
      '{"walletId":"agent","role":"agent","operations":[],"programs":[],"assets":[]}\n',
      { mode: 0o600 },
    );
    await chmod(policyPath, 0o600);
    const digest = createHash("sha256")
      .update(await readFile(policyPath))
      .digest("hex");

    const result = spawnSync(
      "bash",
      [
        resolve(repoRoot, "scripts/docker-signer-policy.sh"),
        "--initial-install",
        "--wallet-id",
        "agent",
        "--policy-file",
        policyPath,
        "--confirm-digest",
        digest,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          DOCKER_LOG: logPath,
        },
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("docker-signer-health.mjs /run/fased-signerd/app.sock");
    expect(log).toContain("--control-socket /run/fased-signerd-control/control.sock");
    expect(log).toContain("admin policy get");
    expect(log).toContain("admin policy put");
    expect(log).toContain("--expected-version 1");
    expect(log).toContain("rm -f -- /tmp/fased-owner-policy-agent-");
  });
});
