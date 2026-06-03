import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { parseModelRef } from "../agents/model-selection.js";
import type { FasedAgentConfig } from "../config/config.js";
import { createModelListAuthIndex } from "./models/list.auth-index.js";

const mocks = vi.hoisted(() => ({
  getCustomProviderApiKey: vi.fn(),
  resolveAwsSdkEnvVarName: vi.fn(),
  resolveEnvApiKey: vi.fn(),
}));

vi.mock("../agents/model-auth.js", () => ({
  getCustomProviderApiKey: mocks.getCustomProviderApiKey,
  resolveAwsSdkEnvVarName: mocks.resolveAwsSdkEnvVarName,
  resolveEnvApiKey: mocks.resolveEnvApiKey,
}));

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readSource(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf-8");
}

async function sourceExists(relativePath: string): Promise<boolean> {
  return Boolean(await fs.stat(path.join(repoRoot, relativePath)).catch(() => null));
}

describe("Lane 3 legacy Codex route doctor audit", () => {
  it("maps upstream 623757011e to absent FasedAgent doctor route repair modules", async () => {
    expect(await sourceExists("src/commands/doctor/shared/codex-route-warnings.ts")).toBe(false);
    expect(await sourceExists("src/commands/doctor/repair-sequencing.ts")).toBe(false);
    expect(await sourceExists("src/config/model-refs.ts")).toBe(false);

    const doctorSource = await readSource("src/commands/doctor.ts");
    const doctorAuthSource = await readSource("src/commands/doctor-auth.ts");
    const doctorConfigSource = await readSource("src/commands/doctor-config-flow.ts");

    expect(doctorSource).toContain("noteAuthProfileHealth");
    expect(doctorSource).toContain("maybeRepairAnthropicOAuthProfileId");
    expect(doctorSource).toContain("maybeRemoveDeprecatedCliAuthProfiles");
    expect(doctorSource).not.toContain("maybeRepairCodexRoutes");
    expect(doctorSource).not.toContain("repairCodexSession");
    expect(doctorSource).not.toContain("codex-route-warnings");

    expect(doctorAuthSource).toContain("openai-codex");
    expect(doctorAuthSource).toContain("models auth login --provider openai-codex");
    expect(doctorAuthSource).not.toContain("agentRuntime");
    expect(doctorAuthSource).not.toContain("maybeRepairCodexRoutes");

    expect(doctorConfigSource).toContain("loadAndMaybeMigrateDoctorConfig");
    expect(doctorConfigSource).not.toContain("openai-codex");
    expect(doctorConfigSource).not.toContain("agentRuntime.id");
  });

  it("keeps OpenAI Codex as a Fased provider auth route instead of an OpenAI repair alias", () => {
    mocks.getCustomProviderApiKey.mockReturnValue(undefined);
    mocks.resolveAwsSdkEnvVarName.mockReturnValue(undefined);
    mocks.resolveEnvApiKey.mockReturnValue(null);

    expect(parseModelRef("openai-codex/gpt-5.3-codex", "openai")).toEqual({
      provider: "openai-codex",
      model: "gpt-5.3-codex",
    });
    expect(parseModelRef("gpt-5.3-codex", "openai")).toEqual({
      provider: "openai-codex",
      model: "gpt-5.3-codex",
    });

    const authStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "codex-access",
          refresh: "codex-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    const index = createModelListAuthIndex({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai-codex/gpt-5.3-codex" },
          },
        },
      } as FasedAgentConfig,
      authStore,
    });

    expect(index.hasProviderAuth("openai-codex")).toBe(true);
    expect(index.hasProviderAuth("openai")).toBe(false);
  });

  it("keeps provider auth status and model fallback ownership separate from doctor repair", async () => {
    const modelsStatusSource = await readSource("src/commands/models/list.status-command.ts");
    const gatewayModelsSource = await readSource("src/gateway/server-methods/models.ts");
    const modelFallbackSource = await readSource("src/agents/model-fallback.ts");

    expect(modelsStatusSource).toContain("resolveProviderAuthOverview");
    expect(modelsStatusSource).toContain("providerAuth");
    expect(modelsStatusSource).toContain("const unusableProfiles");
    expect(modelsStatusSource).toContain("unusableProfiles,");
    expect(modelsStatusSource).not.toContain("maybeRepairCodexRoutes");

    expect(gatewayModelsSource).toContain("authStatus");
    expect(gatewayModelsSource).toContain('"models.authStatus"');
    expect(gatewayModelsSource).not.toContain("codex-route-warnings");

    expect(modelFallbackSource).toContain("runWithModelFallback");
    expect(modelFallbackSource).toContain("resolveCooldownDecision");
    expect(modelFallbackSource).not.toContain("repairCodex");
  });
});
