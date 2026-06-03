import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import * as pluginSdk from "../plugin-sdk/index.js";
import { withEnv } from "../test-utils/env.js";
import { resolveFasedAgentDir } from "./agent-paths.js";
import { resolveAgentDir } from "./agent-scope.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readSource(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf-8");
}

async function sourceExists(relativePath: string): Promise<boolean> {
  return Boolean(await fs.stat(path.join(repoRoot, relativePath)).catch(() => null));
}

async function withTempStateDir(fn: (stateDir: string) => void): Promise<void> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-agent-dir-audit-"));
  try {
    fn(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("Lane 5 agent dir runtime import audit", () => {
  it("maps upstream 23319a3cc2 to absent Codex app-server runtime in Fased", async () => {
    const packageJson = JSON.parse(await readSource("package.json")) as {
      exports?: Record<string, unknown>;
    };
    const tsconfig = JSON.parse(await readSource("tsconfig.json")) as {
      compilerOptions?: { paths?: Record<string, unknown> };
    };

    expect(await sourceExists("extensions/codex/src/app-server/run-attempt.ts")).toBe(false);
    expect(await sourceExists("src/plugin-sdk/agent-runtime.ts")).toBe(false);
    expect(Object.hasOwn(packageJson.exports ?? {}, "./plugin-sdk/agent-runtime")).toBe(false);
    expect(
      Object.hasOwn(tsconfig.compilerOptions?.paths ?? {}, "fased/plugin-sdk/agent-runtime"),
    ).toBe(false);
    expect(Object.hasOwn(pluginSdk, "resolveAgentDir")).toBe(false);
  });

  it("keeps Fased agent-dir resolution owned by config and environment helpers", async () => {
    await withTempStateDir((stateDir) => {
      const configuredAgentDir = path.join(stateDir, "configured", "agent");
      const cfg: FasedAgentConfig = {
        agents: {
          list: [{ id: "work", agentDir: configuredAgentDir }],
        },
      };

      withEnv(
        {
          FASED_STATE_DIR: stateDir,
          FASED_AGENT_DIR: undefined,
          PI_CODING_AGENT_DIR: undefined,
          FASED_HOME: undefined,
        },
        () => {
          expect(resolveFasedAgentDir()).toBe(path.join(stateDir, "agents", "main", "agent"));
          expect(resolveAgentDir({} as FasedAgentConfig, "main")).toBe(
            path.join(stateDir, "agents", "main", "agent"),
          );
          expect(resolveAgentDir(cfg, "work")).toBe(path.resolve(configuredAgentDir));
        },
      );

      const primaryOverride = path.join(stateDir, "primary-agent");
      const piCompatOverride = path.join(stateDir, "pi-compat-agent");

      withEnv(
        {
          FASED_STATE_DIR: undefined,
          FASED_AGENT_DIR: primaryOverride,
          PI_CODING_AGENT_DIR: piCompatOverride,
        },
        () => {
          expect(resolveFasedAgentDir()).toBe(path.resolve(primaryOverride));
        },
      );

      withEnv(
        {
          FASED_STATE_DIR: undefined,
          FASED_AGENT_DIR: undefined,
          PI_CODING_AGENT_DIR: piCompatOverride,
        },
        () => {
          expect(resolveFasedAgentDir()).toBe(path.resolve(piCompatOverride));
        },
      );
    });
  });

  it("keeps config migration, provider auth, and model fallback boundaries separate", async () => {
    const configBarrel = await readSource("src/config/config.ts");
    const gatewayImpl = await readSource("src/gateway/server.impl.ts");
    const runner = await readSource("src/agents/pi-embedded-runner/run.ts");
    const modelFallback = await readSource("src/agents/model-fallback.ts");
    const gatewayModels = await readSource("src/gateway/server-methods/models.ts");

    expect(configBarrel).toContain('export { migrateLegacyConfig } from "./legacy-migrate.js"');
    expect(gatewayImpl).toContain("migrateLegacyConfig(configSnapshot.parsed)");
    expect(gatewayImpl).toContain('startupTrace.measure("config.migrate"');
    expect(gatewayImpl).toContain("writeConfigFile(migrated)");

    expect(runner).toContain('import { resolveFasedAgentAgentDir } from "../agent-paths.js"');
    expect(runner).toContain("const agentDir = params.agentDir ?? resolveFasedAgentAgentDir()");
    expect(runner).toContain("ensureFasedAgentModelsJson(params.config, agentDir)");
    expect(runner).toMatch(/resolveModel\(\s*provider,\s*modelId,\s*agentDir,/);
    expect(runner).toContain("ensureAuthProfileStore(agentDir");

    expect(modelFallback).toContain("runWithModelFallback");
    expect(modelFallback).toContain("resolveCooldownDecision");
    expect(gatewayModels).toContain("authStatus");
    expect(gatewayModels).toContain("unusableKind");
    expect(gatewayModels).toContain('"models.authStatus"');
  });

  it("keeps channel delivery, wallet routing, and session-tool visibility out of scope", async () => {
    const channelRoutingDocs = await readSource("docs/channels/channel-routing.md");
    const walletChatTests = await readSource("src/wallet/chat-command.test.ts");
    const tradeChatTests = await readSource("src/wallet/trade-chat-command.test.ts");
    const statusSessionAudit = await readSource(
      "src/gateway/status-session-runtime-labels.audit.test.ts",
    );
    const sessionToolDocs = await readSource("docs/concepts/session-tool.md");

    expect(channelRoutingDocs).toContain("Fased routes replies back to the surface");
    expect(walletChatTests).toContain("@wallet:agent");
    expect(tradeChatTests).toContain("@trade");
    expect(statusSessionAudit).toContain("@wallet");
    expect(statusSessionAudit).toContain("@trade");
    expect(statusSessionAudit).toContain("@offers");
    expect(statusSessionAudit).toContain("@mining");
    expect(statusSessionAudit).toContain("sessions_list");
    expect(sessionToolDocs).toContain("sessionToolsVisibility");
  });

  it.skip("adds a Fased plugin-sdk agent-runtime subpath only after product review", () => {});
});
