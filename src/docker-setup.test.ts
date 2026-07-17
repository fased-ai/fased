import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

type DockerSetupSandbox = {
  rootDir: string;
  scriptPath: string;
  logPath: string;
  binDir: string;
};

type ComposeService = {
  user?: string;
  profiles?: string[];
  environment?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  cap_drop?: string[];
  security_opt?: string[];
  privileged?: boolean;
  network_mode?: string;
  read_only?: boolean;
  restart?: string;
  depends_on?: Record<string, { condition?: string; restart?: boolean }>;
  entrypoint?: string[];
  command?: string[];
  healthcheck?: { test?: string[] };
};

type ComposeConfig = {
  services?: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
};

async function writeDockerStub(binDir: string, logPath: string) {
  const stub = `#!/usr/bin/env bash
set -euo pipefail
log="$DOCKER_STUB_LOG"
if [[ "\${1:-}" == "compose" && "\${2:-}" == "version" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "build" ]]; then
  echo "build $*" >>"$log"
  exit 0
fi
if [[ "\${1:-}" == "compose" ]]; then
  echo "compose $*" >>"$log"
  if [[ "\${DOCKER_STUB_FAIL_SIGNER:-}" == "1" && "$*" == *"up -d --force-recreate --wait --wait-timeout 60 fased-signerd"* ]]; then
    exit 1
  fi
  exit 0
fi
echo "unknown $*" >>"$log"
exit 0
`;

  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "docker"), stub, { mode: 0o755 });
  await writeFile(logPath, "");
}

async function createDockerSetupSandbox(): Promise<DockerSetupSandbox> {
  const rootDir = await mkdtemp(join(tmpdir(), "fased-docker-setup-"));
  const scriptPath = join(rootDir, "docker-setup.sh");
  const dockerfilePath = join(rootDir, "Dockerfile");
  const composePath = join(rootDir, "docker-compose.yml");
  const binDir = join(rootDir, "bin");
  const logPath = join(rootDir, "docker-stub.log");

  await copyFile(join(repoRoot, "docker-setup.sh"), scriptPath);
  await chmod(scriptPath, 0o755);
  await writeFile(dockerfilePath, "FROM scratch\n");
  await writeFile(
    composePath,
    "services:\n  fased-signerd:\n    image: noop\n  fased-gateway:\n    image: noop\n  fased-cli:\n    image: noop\n",
  );
  await writeDockerStub(binDir, logPath);

  return { rootDir, scriptPath, logPath, binDir };
}

function createEnv(
  sandbox: DockerSetupSandbox,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: `${sandbox.binDir}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME ?? sandbox.rootDir,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TMPDIR: process.env.TMPDIR,
    DOCKER_STUB_LOG: sandbox.logPath,
    FASED_GATEWAY_TOKEN: "test-token",
    FASED_CONFIG_DIR: join(sandbox.rootDir, "config"),
    FASED_WORKSPACE_DIR: join(sandbox.rootDir, "fased"),
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function requireSandbox(sandbox: DockerSetupSandbox | null): DockerSetupSandbox {
  if (!sandbox) {
    throw new Error("sandbox missing");
  }
  return sandbox;
}

function runDockerSetup(
  sandbox: DockerSetupSandbox,
  overrides: Record<string, string | undefined> = {},
) {
  return spawnSync("bash", [sandbox.scriptPath], {
    cwd: sandbox.rootDir,
    env: createEnv(sandbox, overrides),
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function resolveBashForCompatCheck(): string | null {
  for (const candidate of ["/bin/bash", "bash"]) {
    const probe = spawnSync(candidate, ["-c", "exit 0"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }

  return null;
}

describe("docker-setup.sh", () => {
  let sandbox: DockerSetupSandbox | null = null;

  beforeAll(async () => {
    sandbox = await createDockerSetupSandbox();
  });

  afterAll(async () => {
    if (!sandbox) {
      return;
    }
    await rm(sandbox.rootDir, { recursive: true, force: true });
    sandbox = null;
  });

  it("handles env defaults, home-volume mounts, and apt build args", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      FASED_DOCKER_APT_PACKAGES: "ffmpeg build-essential",
      FASED_EXTRA_MOUNTS: undefined,
      FASED_HOME_VOLUME: "fased-home",
    });
    expect(result.status).toBe(0);
    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("FASED_DOCKER_APT_PACKAGES=ffmpeg build-essential");
    expect(envFile).toContain("FASED_EXTRA_MOUNTS=");
    expect(envFile).toContain("FASED_HOME_VOLUME=fased-home");
    const envFileStat = await stat(join(activeSandbox.rootDir, ".env"));
    expect(envFileStat.mode & 0o777).toBe(0o600);
    const extraCompose = await readFile(
      join(activeSandbox.rootDir, "docker-compose.extra.yml"),
      "utf8",
    );
    expect(extraCompose).toContain("fased-home:/home/node");
    expect(extraCompose).toContain("volumes:");
    expect(extraCompose).toContain("fased-home:");
    const log = await readFile(activeSandbox.logPath, "utf8");
    expect(log).toContain("--build-arg FASED_DOCKER_APT_PACKAGES=ffmpeg build-essential");
  });

  it("precreates config identity dir for CLI device auth writes", async () => {
    const activeSandbox = requireSandbox(sandbox);
    const configDir = join(activeSandbox.rootDir, "config-identity");
    const workspaceDir = join(activeSandbox.rootDir, "workspace-identity");

    const result = runDockerSetup(activeSandbox, {
      FASED_CONFIG_DIR: configDir,
      FASED_WORKSPACE_DIR: workspaceDir,
    });

    expect(result.status).toBe(0);
    const identityDirStat = await stat(join(configDir, "identity"));
    expect(identityDirStat.isDirectory()).toBe(true);
  });

  it("reuses existing config token when FASED_GATEWAY_TOKEN is unset", async () => {
    const activeSandbox = requireSandbox(sandbox);
    const configDir = join(activeSandbox.rootDir, "config-token-reuse");
    const workspaceDir = join(activeSandbox.rootDir, "workspace-token-reuse");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "fased.json"),
      JSON.stringify({ gateway: { auth: { mode: "token", token: "config-token-123" } } }),
    );

    const result = runDockerSetup(activeSandbox, {
      FASED_GATEWAY_TOKEN: undefined,
      FASED_CONFIG_DIR: configDir,
      FASED_WORKSPACE_DIR: workspaceDir,
    });

    expect(result.status).toBe(0);
    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("FASED_GATEWAY_TOKEN=config-token-123");
  });

  it("rejects injected multiline FASED_EXTRA_MOUNTS values", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      FASED_EXTRA_MOUNTS: "/tmp:/tmp\n  evil-service:\n    image: alpine",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("FASED_EXTRA_MOUNTS cannot contain control characters");
  });

  it("rejects invalid FASED_EXTRA_MOUNTS mount format", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      FASED_EXTRA_MOUNTS: "bad mount spec",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid mount format");
  });

  it("rejects invalid FASED_HOME_VOLUME names", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      FASED_HOME_VOLUME: "bad name",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("FASED_HOME_VOLUME must match");
  });

  it("rejects invalid host ports", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      FASED_GATEWAY_PORT: "0",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("FASED_GATEWAY_PORT must be an integer between 1 and 65535");
  });

  it("rejects gateway tokens that can alter the generated env file", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      FASED_GATEWAY_TOKEN: "token\nFASED_IMAGE=attacker/image",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("FASED_GATEWAY_TOKEN must be a non-empty token");
  });

  it("rejects container-engine socket mounts", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      FASED_EXTRA_MOUNTS: "/var/run/docker.sock:/var/run/docker.sock",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Container-engine sockets cannot be mounted");
  });

  it("avoids associative arrays so the script remains Bash 3.2-compatible", async () => {
    const script = await readFile(join(repoRoot, "docker-setup.sh"), "utf8");
    expect(script).not.toMatch(/^\s*declare -A\b/m);

    const systemBash = resolveBashForCompatCheck();
    if (!systemBash) {
      return;
    }

    const assocCheck = spawnSync(systemBash, ["-c", "declare -A _t=()"], {
      encoding: "utf8",
    });
    if (assocCheck.status === 0 || assocCheck.status === null) {
      // Skip runtime check when system bash supports associative arrays
      // (not Bash 3.2) or when /bin/bash is unavailable (e.g. Windows).
      return;
    }

    const syntaxCheck = spawnSync(systemBash, ["-n", join(repoRoot, "docker-setup.sh")], {
      encoding: "utf8",
    });

    expect(syntaxCheck.status).toBe(0);
    expect(syntaxCheck.stderr).not.toContain("declare: -A: invalid option");
  });

  it("keeps docker-compose gateway command in sync", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose).not.toContain("gateway-daemon");
    expect(compose).toContain('"gateway"');
  });

  it("starts the signer before onboarding and recreates both long-running services", async () => {
    const activeSandbox = requireSandbox(sandbox);
    const result = runDockerSetup(activeSandbox, {
      FASED_CONFIG_DIR: join(activeSandbox.rootDir, "config-order"),
      FASED_WORKSPACE_DIR: join(activeSandbox.rootDir, "workspace-order"),
    });
    expect(result.status).toBe(0);

    const log = await readFile(activeSandbox.logPath, "utf8");
    const gatewayStop = log.lastIndexOf("stop fased-gateway");
    const signerStart = log.lastIndexOf(
      "up -d --force-recreate --wait --wait-timeout 60 fased-signerd",
    );
    const onboarding = log.lastIndexOf("run --rm fased-cli onboard --no-install-daemon");
    const gatewayStart = log.lastIndexOf(
      "up -d --force-recreate --no-deps --wait --wait-timeout 60 fased-gateway",
    );
    expect(gatewayStop).toBeGreaterThanOrEqual(0);
    expect(signerStart).toBeGreaterThan(gatewayStop);
    expect(signerStart).toBeGreaterThanOrEqual(0);
    expect(onboarding).toBeGreaterThan(signerStart);
    expect(gatewayStart).toBeGreaterThan(onboarding);
  });

  it("stops before wallet onboarding when the native signer is missing or unhealthy", async () => {
    const activeSandbox = requireSandbox(sandbox);
    const result = runDockerSetup(activeSandbox, {
      DOCKER_STUB_FAIL_SIGNER: "1",
      FASED_CONFIG_DIR: join(activeSandbox.rootDir, "config-missing-signer"),
      FASED_WORKSPACE_DIR: join(activeSandbox.rootDir, "workspace-missing-signer"),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("fased-signerd did not become healthy");
    const log = await readFile(activeSandbox.logPath, "utf8");
    const failedSignerStart = log.lastIndexOf(
      "up -d --force-recreate --wait --wait-timeout 60 fased-signerd",
    );
    expect(failedSignerStart).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("run --rm fased-cli onboard", failedSignerStart)).toBe(-1);
  });

  it("builds a deterministic multi-architecture native signer into the application image", async () => {
    const dockerfile = await readFile(join(repoRoot, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(
      /^FROM golang:1\.25\.7-bookworm@sha256:[a-f0-9]{64} AS signer-builder$/m,
    );
    expect(dockerfile).toContain("ARG TARGETOS=linux");
    expect(dockerfile).toContain("ARG TARGETARCH=amd64");
    expect(dockerfile).toContain('CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH"');
    expect(dockerfile).toContain("-buildvcs=false -trimpath");
    expect(dockerfile).toContain("COPY --from=signer-builder");
    expect(dockerfile).toContain("/usr/local/bin/fased-signerd");
    expect(dockerfile).toContain(
      "ln /usr/local/bin/fased-signerd /usr/local/bin/fased-signer-enroll",
    );
  });

  it("keeps Docker services local-only and drops unnecessary privileges", async () => {
    const compose = parse(await readFile(join(repoRoot, "docker-compose.yml"), "utf8")) as
      | ComposeConfig
      | undefined;
    const gateway = compose?.services?.["fased-gateway"];
    const cli = compose?.services?.["fased-cli"];
    const signer = compose?.services?.["fased-signerd"];
    const enrollment = compose?.services?.["fased-signer-enroll"];

    expect(gateway?.ports).toEqual([
      "127.0.0.1:${FASED_GATEWAY_PORT:-18789}:18789",
      "127.0.0.1:${FASED_BRIDGE_PORT:-18790}:18790",
    ]);
    expect(gateway?.cap_drop).toContain("ALL");
    expect(cli?.cap_drop).toContain("ALL");
    expect(signer?.cap_drop).toContain("ALL");
    expect(enrollment?.cap_drop).toContain("ALL");
    expect(gateway?.security_opt).toContain("no-new-privileges:true");
    expect(cli?.security_opt).toContain("no-new-privileges:true");
    expect(signer?.security_opt).toContain("no-new-privileges:true");
    expect(enrollment?.security_opt).toContain("no-new-privileges:true");
    expect(gateway?.privileged).not.toBe(true);
    expect(cli?.privileged).not.toBe(true);
    expect(signer?.privileged).not.toBe(true);
    expect(enrollment?.privileged).not.toBe(true);
    expect(gateway?.network_mode).not.toBe("host");
    expect(cli?.network_mode).not.toBe("host");
    expect(signer?.network_mode).not.toBe("host");
    expect(enrollment?.network_mode).not.toBe("host");
    expect(
      JSON.stringify([gateway?.volumes, cli?.volumes, signer?.volumes, enrollment?.volumes]),
    ).not.toContain("docker.sock");
    expect(signer?.user).toBe("node");
    expect(signer?.read_only).toBe(true);
    expect(enrollment?.read_only).toBe(true);
    expect(enrollment?.profiles).toEqual(["signer-admin"]);
    expect(enrollment?.ports).toEqual(["127.0.0.1:18791:18792"]);
    expect(gateway?.healthcheck?.test).toEqual(["CMD", "node", "dist/index.js", "health"]);
  });

  it("persists signer state privately and shares only its Unix-socket volume", async () => {
    const compose = parse(await readFile(join(repoRoot, "docker-compose.yml"), "utf8")) as
      | ComposeConfig
      | undefined;
    const gateway = compose?.services?.["fased-gateway"];
    const cli = compose?.services?.["fased-cli"];
    const signer = compose?.services?.["fased-signerd"];
    const enrollment = compose?.services?.["fased-signer-enroll"];

    expect(compose?.volumes).toHaveProperty("fased-signer-run");
    expect(compose?.volumes).toHaveProperty("fased-signer-state");
    expect(signer?.volumes).toContain("fased-signer-run:/run/fased-signerd");
    expect(signer?.volumes).toContain("fased-signer-state:/var/lib/fased-signerd");
    expect(signer?.command).toContain("/var/lib/fased-signerd/state.db");
    expect(signer?.command).toContain("/var/lib/fased-signerd/master.key");
    expect(signer?.command).toContain("/var/lib/fased-signerd/fased-signerd.pid");
    expect(signer?.command).toContain("/var/lib/fased-signerd/audit.jsonl");
    expect(gateway?.volumes).toContain("fased-signer-run:/run/fased-signerd");
    expect(cli?.volumes).toContain("fased-signer-run:/run/fased-signerd");
    expect(gateway?.volumes).not.toContain("fased-signer-state:/var/lib/fased-signerd");
    expect(cli?.volumes).not.toContain("fased-signer-state:/var/lib/fased-signerd");
    expect(enrollment?.volumes).not.toContain("fased-signer-state:/var/lib/fased-signerd");
    expect(signer?.restart).toBe("unless-stopped");
    expect(gateway?.depends_on?.["fased-signerd"]?.condition).toBe("service_healthy");
    expect(cli?.depends_on?.["fased-signerd"]?.condition).toBe("service_healthy");
    expect(gateway?.environment?.FASED_WALLET_LOCAL_SIGNER_LIFECYCLE).toBe("external");
    expect(cli?.environment?.FASED_WALLET_LOCAL_SIGNER_LIFECYCLE).toBe("external");
    expect(signer?.healthcheck?.test).toEqual([
      "CMD",
      "node",
      "/app/scripts/docker-signer-health.mjs",
      "/run/fased-signerd/app.sock",
    ]);
  });
});
