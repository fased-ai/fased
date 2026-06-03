import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadDotEnv, loadWorkspaceDotEnvFile } from "./dotenv.js";

async function writeEnvFile(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

async function withIsolatedEnvAndCwd(run: () => Promise<void>) {
  const prevEnv = { ...process.env };
  const prevCwd = process.cwd();
  try {
    await run();
  } finally {
    vi.restoreAllMocks();
    process.chdir(prevCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in prevEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

type DotEnvFixture = {
  base: string;
  cwdDir: string;
  stateDir: string;
};

async function withDotEnvFixture(run: (fixture: DotEnvFixture) => Promise<void>) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "fased-dotenv-test-"));
  const cwdDir = path.join(base, "cwd");
  const stateDir = path.join(base, "state");
  process.env.FASED_STATE_DIR = stateDir;
  await fs.mkdir(cwdDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await run({ base, cwdDir, stateDir });
}

describe("loadDotEnv", () => {
  it("loads ~/.fased/.env as fallback without overriding CWD .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\nBAR=1\n");
        await writeEnvFile(path.join(cwdDir, ".env"), "FOO=from-cwd\n");

        process.chdir(cwdDir);
        delete process.env.FOO;
        delete process.env.BAR;

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-cwd");
        expect(process.env.BAR).toBe("1");
      });
    });
  });

  it("does not override an already-set env var from the shell", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        process.env.FOO = "from-shell";

        await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\n");
        await writeEnvFile(path.join(cwdDir, ".env"), "FOO=from-cwd\n");

        process.chdir(cwdDir);

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-shell");
      });
    });
  });

  it("loads fallback state .env when CWD .env is missing", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\n");
        process.chdir(cwdDir);
        delete process.env.FOO;

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-global");
      });
    });
  });

  it("loads the gateway.env compatibility fallback after ~/.fased/.env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ base, cwdDir }) => {
        process.env.HOME = base;
        const defaultStateDir = path.join(base, ".fased");
        process.env.FASED_STATE_DIR = defaultStateDir;
        await writeEnvFile(path.join(defaultStateDir, ".env"), "FOO=from-global\n");
        await writeEnvFile(
          path.join(base, ".config", "fased", "gateway.env"),
          ["FOO=from-gateway", "BAR=from-gateway"].join("\n"),
        );

        process.chdir(cwdDir);
        delete process.env.FOO;
        delete process.env.BAR;
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-global");
        expect(process.env.BAR).toBe("from-gateway");
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("Conflicting values in"));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("gateway.env"));
      });
    });
  });

  it("does not warn about dotenv conflicts when the key is already set", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ base, cwdDir, stateDir }) => {
        process.env.HOME = base;
        process.env.FOO = "from-shell";
        await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\n");
        await writeEnvFile(
          path.join(base, ".config", "fased", "gateway.env"),
          "FOO=from-gateway\n",
        );

        process.chdir(cwdDir);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-shell");
        expect(warn).not.toHaveBeenCalled();
      });
    });
  });

  it("blocks dangerous and workspace-control vars from CWD .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "SAFE_KEY=from-cwd",
            "NODE_OPTIONS=--require ./evil.js",
            "FASED_STATE_DIR=./evil-state",
            "FASED_CONFIG_PATH=./evil-config.json",
            "ANTHROPIC_BASE_URL=https://evil.example.com/v1",
            "HTTP_PROXY=http://evil-proxy:8080",
            "FASEDHUB_REGISTRY=https://evil.example.com",
            "FASEDHUB_WORKDIR=./evil-hub",
            "FASEDHUB_CONFIG_PATH=./evil-hub-config.json",
            "UV_PYTHON=./attacker-python",
            "uv_python=./attacker-python-lower",
          ].join("\n"),
        );
        await writeEnvFile(path.join(stateDir, ".env"), "BAR=from-global\n");

        process.chdir(cwdDir);
        delete process.env.SAFE_KEY;
        delete process.env.NODE_OPTIONS;
        delete process.env.FASED_CONFIG_PATH;
        delete process.env.ANTHROPIC_BASE_URL;
        delete process.env.HTTP_PROXY;
        delete process.env.FASEDHUB_REGISTRY;
        delete process.env.FASEDHUB_WORKDIR;
        delete process.env.FASEDHUB_CONFIG_PATH;
        delete process.env.UV_PYTHON;
        delete process.env.uv_python;

        loadDotEnv({ quiet: true });

        expect(process.env.SAFE_KEY).toBe("from-cwd");
        expect(process.env.BAR).toBe("from-global");
        expect(process.env.NODE_OPTIONS).toBeUndefined();
        expect(process.env.FASED_STATE_DIR).toBe(stateDir);
        expect(process.env.FASED_CONFIG_PATH).toBeUndefined();
        expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
        expect(process.env.HTTP_PROXY).toBeUndefined();
        expect(process.env.FASEDHUB_REGISTRY).toBeUndefined();
        expect(process.env.FASEDHUB_WORKDIR).toBeUndefined();
        expect(process.env.FASEDHUB_CONFIG_PATH).toBeUndefined();
        expect(process.env.UV_PYTHON).toBeUndefined();
        expect(process.env.uv_python).toBeUndefined();
      });
    });
  });

  it("blocks credential and gateway auth vars from CWD .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "ANTHROPIC_API_KEY=sk-ant-attacker-key",
            "ANTHROPIC_API_KEY_SECONDARY=sk-ant-secondary",
            "ANTHROPIC_OAUTH_TOKEN=attacker-oauth",
            "OPENAI_API_KEY=sk-openai-attacker-key",
            "OPENAI_API_KEYS=sk-openai-a,sk-openai-b",
            "OPENAI_API_KEY_SECONDARY=sk-openai-secondary",
            "FASED_LIVE_ANTHROPIC_KEY=sk-ant-live",
            "FASED_LIVE_ANTHROPIC_KEYS=sk-ant-live-a,sk-ant-live-b",
            "FASED_LIVE_GEMINI_KEY=sk-gemini-live",
            "FASED_LIVE_OPENAI_KEY=sk-openai-live",
            "FASED_GATEWAY_TOKEN=attacker-token",
            "FASED_GATEWAY_PASSWORD=attacker-password",
            "FASED_GATEWAY_SECRET=attacker-secret",
          ].join("\n"),
        );

        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_API_KEY_SECONDARY;
        delete process.env.ANTHROPIC_OAUTH_TOKEN;
        delete process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEYS;
        delete process.env.OPENAI_API_KEY_SECONDARY;
        delete process.env.FASED_LIVE_ANTHROPIC_KEY;
        delete process.env.FASED_LIVE_ANTHROPIC_KEYS;
        delete process.env.FASED_LIVE_GEMINI_KEY;
        delete process.env.FASED_LIVE_OPENAI_KEY;
        delete process.env.FASED_GATEWAY_TOKEN;
        delete process.env.FASED_GATEWAY_PASSWORD;
        delete process.env.FASED_GATEWAY_SECRET;

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(process.env.ANTHROPIC_API_KEY_SECONDARY).toBeUndefined();
        expect(process.env.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
        expect(process.env.OPENAI_API_KEY).toBeUndefined();
        expect(process.env.OPENAI_API_KEYS).toBeUndefined();
        expect(process.env.OPENAI_API_KEY_SECONDARY).toBeUndefined();
        expect(process.env.FASED_LIVE_ANTHROPIC_KEY).toBeUndefined();
        expect(process.env.FASED_LIVE_ANTHROPIC_KEYS).toBeUndefined();
        expect(process.env.FASED_LIVE_GEMINI_KEY).toBeUndefined();
        expect(process.env.FASED_LIVE_OPENAI_KEY).toBeUndefined();
        expect(process.env.FASED_GATEWAY_TOKEN).toBeUndefined();
        expect(process.env.FASED_GATEWAY_PASSWORD).toBeUndefined();
        expect(process.env.FASED_GATEWAY_SECRET).toBeUndefined();
      });
    });
  });

  it("blocks FASED_STATE_DIR from workspace .env even when unset in process env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          "FASED_STATE_DIR=./evil-state\nFASED_CONFIG_PATH=./evil-config.json\n",
        );

        delete process.env.FASED_STATE_DIR;
        delete process.env.FASED_CONFIG_PATH;

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expect(process.env.FASED_STATE_DIR).toBeUndefined();
        expect(process.env.FASED_CONFIG_PATH).toBeUndefined();
      });
    });
  });

  it("blocks path-override vars from workspace .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ base, cwdDir }) => {
        const bundledPluginsDir = path.join(base, "attacker-bundled");
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "FASED_AGENT_DIR=./evil-agent",
            `FASED_BUNDLED_PLUGINS_DIR=${bundledPluginsDir}`,
            "PI_CODING_AGENT_DIR=./evil-coding",
            "FASED_OAUTH_DIR=./evil-oauth",
          ].join("\n"),
        );

        delete process.env.FASED_AGENT_DIR;
        delete process.env.FASED_BUNDLED_PLUGINS_DIR;
        delete process.env.PI_CODING_AGENT_DIR;
        delete process.env.FASED_OAUTH_DIR;

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expect(process.env.FASED_AGENT_DIR).toBeUndefined();
        expect(process.env.FASED_BUNDLED_PLUGINS_DIR).toBeUndefined();
        expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();
        expect(process.env.FASED_OAUTH_DIR).toBeUndefined();
      });
    });
  });

  it("blocks FASED_TEST_TAILSCALE_BINARY from workspace .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          "FASED_TEST_TAILSCALE_BINARY=/tmp/attacker-tailscale\n",
        );

        delete process.env.FASED_TEST_TAILSCALE_BINARY;

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expect(process.env.FASED_TEST_TAILSCALE_BINARY).toBeUndefined();
      });
    });
  });

  it("blocks pinned helper interpreter vars from workspace .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "FASED_PINNED_PYTHON=./attacker-python",
            "FASED_PINNED_WRITE_PYTHON=./attacker-write-python",
          ].join("\n"),
        );

        delete process.env.FASED_PINNED_PYTHON;
        delete process.env.FASED_PINNED_WRITE_PYTHON;

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expect(process.env.FASED_PINNED_PYTHON).toBeUndefined();
        expect(process.env.FASED_PINNED_WRITE_PYTHON).toBeUndefined();
      });
    });
  });
});
