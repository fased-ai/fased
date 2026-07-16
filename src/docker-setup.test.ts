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
  ports?: string[];
  volumes?: string[];
  cap_drop?: string[];
  security_opt?: string[];
  privileged?: boolean;
  network_mode?: string;
  healthcheck?: { test?: string[] };
};

type ComposeConfig = {
  services?: Record<string, ComposeService>;
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
    "services:\n  fased-gateway:\n    image: noop\n  fased-cli:\n    image: noop\n",
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

  it("keeps Docker services local-only and drops unnecessary privileges", async () => {
    const compose = parse(await readFile(join(repoRoot, "docker-compose.yml"), "utf8")) as
      | ComposeConfig
      | undefined;
    const gateway = compose?.services?.["fased-gateway"];
    const cli = compose?.services?.["fased-cli"];

    expect(gateway?.ports).toEqual([
      "127.0.0.1:${FASED_GATEWAY_PORT:-18789}:18789",
      "127.0.0.1:${FASED_BRIDGE_PORT:-18790}:18790",
    ]);
    expect(gateway?.cap_drop).toContain("ALL");
    expect(cli?.cap_drop).toContain("ALL");
    expect(gateway?.security_opt).toContain("no-new-privileges:true");
    expect(cli?.security_opt).toContain("no-new-privileges:true");
    expect(gateway?.privileged).not.toBe(true);
    expect(cli?.privileged).not.toBe(true);
    expect(gateway?.network_mode).not.toBe("host");
    expect(cli?.network_mode).not.toBe("host");
    expect(JSON.stringify([gateway?.volumes, cli?.volumes])).not.toContain("docker.sock");
    expect(gateway?.healthcheck?.test).toEqual(["CMD", "node", "dist/index.js", "health"]);
  });
});
