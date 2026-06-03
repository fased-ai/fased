import { beforeEach, describe, expect, it, vi } from "vitest";

const completeSimple = vi.fn();
const getApiKeyForModel = vi.fn();
const requireApiKey = vi.fn();
const loadConfig = vi.fn();
const resolveDefaultAgentId = vi.fn();
const resolveAgentEffectiveModelPrimary = vi.fn();
const resolveAgentDir = vi.fn();
const buildModelAliasIndex = vi.fn();
const resolveModelRefFromString = vi.fn();
const resolveModel = vi.fn();
const logWarn = vi.fn();

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: (...args: unknown[]) => completeSimple(...args),
}));

vi.mock("../../../src/agents/agent-scope.js", () => ({
  resolveDefaultAgentId: (...args: unknown[]) => resolveDefaultAgentId(...args),
  resolveAgentEffectiveModelPrimary: (...args: unknown[]) =>
    resolveAgentEffectiveModelPrimary(...args),
  resolveAgentDir: (...args: unknown[]) => resolveAgentDir(...args),
}));

vi.mock("../../../src/agents/model-auth.js", () => ({
  getApiKeyForModel: (...args: unknown[]) => getApiKeyForModel(...args),
  requireApiKey: (...args: unknown[]) => requireApiKey(...args),
}));

vi.mock("../../../src/agents/model-selection.js", () => ({
  buildModelAliasIndex: (...args: unknown[]) => buildModelAliasIndex(...args),
  resolveModelRefFromString: (...args: unknown[]) => resolveModelRefFromString(...args),
}));

vi.mock("../../../src/agents/pi-embedded-runner/model.js", () => ({
  resolveModel: (...args: unknown[]) => resolveModel(...args),
}));

vi.mock("../../../src/config/config.js", () => ({
  loadConfig: () => loadConfig(),
}));

vi.mock("../../../src/logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    warn: (...args: unknown[]) => logWarn(...args),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
    subsystem: "test",
    isEnabled: vi.fn(),
  }),
}));

describe("computeSkillStrategy", () => {
  beforeEach(() => {
    completeSimple.mockReset();
    getApiKeyForModel.mockReset();
    requireApiKey.mockReset();
    loadConfig.mockReset();
    resolveDefaultAgentId.mockReset();
    resolveAgentEffectiveModelPrimary.mockReset();
    resolveAgentDir.mockReset();
    buildModelAliasIndex.mockReset();
    resolveModelRefFromString.mockReset();
    resolveModel.mockReset();
    logWarn.mockReset();

    loadConfig.mockReturnValue({});
    resolveDefaultAgentId.mockReturnValue("main");
    resolveAgentEffectiveModelPrimary.mockReturnValue("openrouter/openai/gpt-4.1-mini");
    resolveAgentDir.mockReturnValue("/tmp/fased-agent-main");
    buildModelAliasIndex.mockReturnValue({ byAlias: new Map(), byKey: new Map() });
    resolveModelRefFromString.mockReturnValue({
      ref: { provider: "openrouter", model: "openai/gpt-4.1-mini" },
    });
    resolveModel.mockReturnValue({ model: { id: "openrouter/openai/gpt-4.1-mini" } });
    getApiKeyForModel.mockResolvedValue("test-key");
    requireApiKey.mockReturnValue("test-key");
    completeSimple.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            allocationFp: [
              1_000_000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
            rationale: "ok",
          }),
        },
      ],
    });
  });

  it("uses the agent effective model instead of anthropic defaults", async () => {
    const { computeSkillStrategy } = await import("./strategy-skill.js");
    const result = await computeSkillStrategy({
      riskMode: "balanced",
      epochId: 1,
      microRoundId: 1,
      roundOpenTs: 1,
      roundCloseTs: 60,
      useAgentDefaultModel: true,
      maxDecisionLatencyMs: 1000,
      liveContext: {
        currentCycleId: 44,
        participantCount: 2,
        totalCommittedLamports: "6400000000",
        recentOutcomes: [
          {
            cycleId: 43,
            totalSatEarnedRaw: "50730000",
            totalRebateLamports: "424960",
            validParticipation: true,
          },
        ],
      },
    });

    expect(resolveAgentEffectiveModelPrimary).toHaveBeenCalled();
    expect(resolveModelRefFromString).toHaveBeenCalledWith(
      expect.objectContaining({ raw: "openrouter/openai/gpt-4.1-mini" }),
    );
    expect(getApiKeyForModel).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: "/tmp/fased-agent-main" }),
    );
    expect(result.modelId).toBe("openrouter/openai/gpt-4.1-mini");
    expect(String(completeSimple.mock.calls[0]?.[1]?.messages?.[0]?.content ?? "")).toContain(
      '"currentCycleId": 44',
    );
    expect(String(completeSimple.mock.calls[0]?.[1]?.messages?.[0]?.content ?? "")).toContain(
      '"cycleId": 43',
    );
  });

  it("fails early when no preferred or agent default model exists", async () => {
    resolveAgentEffectiveModelPrimary.mockReturnValue(undefined);
    resolveModelRefFromString.mockReturnValue(null);
    const { computeSkillStrategy } = await import("./strategy-skill.js");

    await expect(
      computeSkillStrategy({
        riskMode: "balanced",
        epochId: 1,
        microRoundId: 1,
        roundOpenTs: 1,
        roundCloseTs: 60,
        useAgentDefaultModel: true,
        maxDecisionLatencyMs: 1000,
      }),
    ).rejects.toThrow(/No SAT skill model is configured/);
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it("rejects hidden router aliases and requires the selected concrete model", async () => {
    resolveAgentEffectiveModelPrimary.mockReturnValue("openrouter/openrouter/auto");
    resolveModelRefFromString.mockReturnValue({
      ref: { provider: "openrouter", model: "openrouter/auto" },
    });
    const { computeSkillStrategy } = await import("./strategy-skill.js");

    await expect(
      computeSkillStrategy({
        riskMode: "balanced",
        epochId: 1,
        microRoundId: 1,
        roundOpenTs: 1,
        roundCloseTs: 60,
        useAgentDefaultModel: true,
        maxDecisionLatencyMs: 1000,
      }),
    ).rejects.toThrow(/requires the agent's concrete selected model/i);
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("accepts JSON wrapped in markdown fences", async () => {
    completeSimple.mockResolvedValue({
      content: [
        {
          type: "text",
          text:
            "```json\n" +
            JSON.stringify({
              allocationFp: [
                1_000_000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              ],
              rationale: "wrapped",
            }) +
            "\n```",
        },
      ],
    });
    const { computeSkillStrategy } = await import("./strategy-skill.js");

    const result = await computeSkillStrategy({
      riskMode: "balanced",
      epochId: 1,
      microRoundId: 1,
      roundOpenTs: 1,
      roundCloseTs: 60,
      useAgentDefaultModel: true,
      maxDecisionLatencyMs: 1000,
    });

    expect(result.rationale).toBe("wrapped");
    expect(result.fallbackUsed).toBe(false);
  });

  it("classifies JSON parse failures", async () => {
    completeSimple.mockResolvedValue({
      content: [{ type: "text", text: '{"allocationFp":[1,2,3],"rationale":' }],
    });
    const { computeSkillStrategy } = await import("./strategy-skill.js");

    const result = await computeSkillStrategy({
      riskMode: "balanced",
      epochId: 1,
      microRoundId: 1,
      roundOpenTs: 1,
      roundCloseTs: 60,
      useAgentDefaultModel: true,
      maxDecisionLatencyMs: 1000,
    });

    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackReason).toBe("json-parse");
    expect(logWarn).toHaveBeenCalledWith(
      "skill strategy fallback",
      expect.objectContaining({ reason: "json-parse" }),
    );
  });

  it("classifies timeout failures", async () => {
    completeSimple.mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    );
    const { computeSkillStrategy } = await import("./strategy-skill.js");

    const result = await computeSkillStrategy({
      riskMode: "aggressive",
      epochId: 1,
      microRoundId: 1,
      roundOpenTs: 1,
      roundCloseTs: 60,
      useAgentDefaultModel: true,
      maxDecisionLatencyMs: 1,
    });

    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackReason).toBe("timeout");
    expect(logWarn).toHaveBeenCalledWith(
      "skill strategy fallback",
      expect.objectContaining({ reason: "timeout" }),
    );
  });
});
