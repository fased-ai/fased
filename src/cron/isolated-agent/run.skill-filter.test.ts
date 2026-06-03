import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";

// ---------- mocks ----------

const buildWorkspaceSkillSnapshotMock = vi.fn();
const resolveAgentConfigMock = vi.fn();
const resolveAgentEffectiveModelPrimaryMock = vi.fn(
  (_cfg: unknown, _agentId?: string): string | undefined => {
    const agentConfig = resolveAgentConfigMock();
    const model = (agentConfig as { model?: unknown } | undefined)?.model;
    if (typeof model === "string") {
      return model.trim() || undefined;
    }
    if (model && typeof model === "object" && !Array.isArray(model)) {
      const primary = (model as { primary?: unknown }).primary;
      return typeof primary === "string" ? primary.trim() || undefined : undefined;
    }
    return undefined;
  },
);
const resolveAgentModelFallbacksOverrideMock = vi.fn().mockReturnValue(undefined);
const resolveAgentSkillsFilterMock = vi.fn();
const getModelRefStatusMock = vi.fn().mockReturnValue({ allowed: false });
const isCliProviderMock = vi.fn().mockReturnValue(false);
const resolveAllowedModelRefMock = vi.fn();
const resolveConfiguredModelRefMock = vi.fn();
const resolveHooksGmailModelMock = vi.fn();
const resolveThinkingDefaultMock = vi.fn();
const logWarnMock = vi.fn();
const createFasedAgentCodingToolsMock = vi.fn();
const deriveSessionTotalTokensMock = vi.fn().mockReturnValue(30);
const hasNonzeroUsageMock = vi.fn().mockReturnValue(false);
const deliverOutboundPayloadsMock = vi.fn();
const resolveCronDeliveryPlanMock = vi.fn();
const resolveDeliveryTargetMock = vi.fn();

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentEntries: (cfg: { agents?: { list?: unknown[] } }) =>
    Array.isArray(cfg.agents?.list) ? cfg.agents.list : [],
  resolveAgentConfig: resolveAgentConfigMock,
  resolveAgentDir: vi.fn().mockReturnValue("/tmp/agent-dir"),
  resolveAgentEffectiveModelPrimary: resolveAgentEffectiveModelPrimaryMock,
  resolveAgentModelFallbacksOverride: resolveAgentModelFallbacksOverrideMock,
  resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/workspace"),
  resolveDefaultAgentId: vi.fn().mockReturnValue("default"),
  resolveSessionAgentId: vi.fn().mockReturnValue("default"),
  resolveAgentSkillsFilter: resolveAgentSkillsFilterMock,
}));

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: buildWorkspaceSkillSnapshotMock,
}));

vi.mock("../../agents/skills/refresh.js", () => ({
  getSkillsSnapshotVersion: vi.fn().mockReturnValue(42),
}));

vi.mock("../../agents/workspace.js", () => ({
  DEFAULT_IDENTITY_FILENAME: "IDENTITY.md",
  DEFAULT_AGENT_WORKSPACE_DIR: "/tmp/workspace",
  ensureAgentWorkspace: vi.fn().mockResolvedValue({ dir: "/tmp/workspace" }),
}));

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn().mockResolvedValue({ models: [] }),
}));

vi.mock("../../agents/model-selection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/model-selection.js")>();
  return {
    ...actual,
    getModelRefStatus: getModelRefStatusMock,
    isCliProvider: isCliProviderMock,
    resolveAllowedModelRef: resolveAllowedModelRefMock,
    resolveConfiguredModelRef: resolveConfiguredModelRefMock,
    resolveHooksGmailModel: resolveHooksGmailModelMock,
    resolveThinkingDefault: resolveThinkingDefaultMock,
  };
});

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: vi.fn().mockResolvedValue({
    result: {
      payloads: [{ text: "test output" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    },
    provider: "openai",
    model: "gpt-4",
  }),
}));

const runWithModelFallbackMock = vi.mocked(runWithModelFallback);

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: vi.fn().mockResolvedValue({
    payloads: [{ text: "test output" }],
    meta: { agentMeta: { usage: { input: 10, output: 20 } } },
  }),
}));

vi.mock("../../agents/pi-tools.js", () => ({
  createFasedAgentCodingTools: createFasedAgentCodingToolsMock,
}));

const runEmbeddedPiAgentMock = vi.mocked(runEmbeddedPiAgent);

vi.mock("../../agents/context.js", () => ({
  lookupContextTokens: vi.fn().mockReturnValue(128000),
}));

vi.mock("../../agents/date-time.js", () => ({
  formatUserTime: vi.fn().mockReturnValue("2026-02-10 12:00"),
  resolveUserTimeFormat: vi.fn().mockReturnValue("24h"),
  resolveUserTimezone: vi.fn().mockReturnValue("UTC"),
}));

vi.mock("../../agents/timeout.js", () => ({
  resolveAgentTimeoutMs: vi.fn().mockReturnValue(60_000),
}));

vi.mock("../../agents/usage.js", () => ({
  deriveSessionTotalTokens: deriveSessionTotalTokensMock,
  hasNonzeroUsage: hasNonzeroUsageMock,
}));

vi.mock("../../agents/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: vi.fn(),
}));

vi.mock("../../agents/cli-session.js", () => ({
  getCliSessionId: vi.fn().mockReturnValue(undefined),
  setCliSessionId: vi.fn(),
}));

vi.mock("../../auto-reply/thinking.js", () => ({
  normalizeThinkLevel: vi.fn().mockReturnValue(undefined),
  normalizeVerboseLevel: vi.fn().mockReturnValue("off"),
  supportsXHighThinking: vi.fn().mockReturnValue(false),
}));

vi.mock("../../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: vi.fn().mockReturnValue({}),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveAgentMainSessionKey: vi.fn().mockReturnValue("main:default"),
  resolveSessionTranscriptPath: vi.fn().mockReturnValue("/tmp/transcript.jsonl"),
  setSessionRuntimeModel: vi.fn(),
  updateSessionStore: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../routing/session-key.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../routing/session-key.js")>();
  return {
    ...actual,
    buildAgentMainSessionKey: vi.fn().mockReturnValue("agent:default:cron:test"),
    normalizeAgentId: vi.fn((id: string) => id),
  };
});

vi.mock("../../infra/agent-events.js", () => ({
  registerAgentRunContext: vi.fn(),
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsMock,
}));

vi.mock("../../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: vi.fn().mockReturnValue({}),
}));

vi.mock("../../logger.js", () => ({
  logWarn: (...args: unknown[]) => logWarnMock(...args),
}));

vi.mock("../../security/external-content.js", () => ({
  buildSafeExternalPrompt: vi.fn().mockReturnValue("safe prompt"),
  detectSuspiciousPatterns: vi.fn().mockReturnValue([]),
  getHookType: vi.fn().mockReturnValue("unknown"),
  isExternalHookSession: vi.fn().mockReturnValue(false),
  wrapExternalContent: vi.fn((content: string) => content),
  wrapWebContent: vi.fn((content: string) => content),
}));

vi.mock("../delivery.js", () => ({
  resolveCronDeliveryPlan: resolveCronDeliveryPlanMock,
}));

vi.mock("./delivery-target.js", () => ({
  resolveDeliveryTarget: resolveDeliveryTargetMock,
}));

vi.mock("./helpers.js", () => ({
  isHeartbeatOnlyResponse: vi.fn().mockReturnValue(false),
  pickLastDeliverablePayload: vi.fn().mockReturnValue(undefined),
  pickLastNonEmptyTextFromPayloads: vi.fn().mockReturnValue("test output"),
  pickSummaryFromOutput: vi.fn().mockReturnValue("summary"),
  pickSummaryFromPayloads: vi.fn().mockReturnValue("summary"),
  resolveHeartbeatAckMaxChars: vi.fn().mockReturnValue(100),
}));

const resolveCronSessionMock = vi.fn();
vi.mock("./session.js", () => ({
  resolveCronSession: resolveCronSessionMock,
}));

vi.mock("../../agents/defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 128000,
  DEFAULT_MODEL: "gpt-4",
  DEFAULT_PROVIDER: "openai",
}));

const { runCronIsolatedAgentTurn } = await import("./run.js");
const { runSubagentAnnounceFlow } = await import("../../agents/subagent-announce.js");

// ---------- helpers ----------

function makeJob(overrides?: Record<string, unknown>) {
  return {
    id: "test-job",
    name: "Test Job",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "test" },
    ...overrides,
  } as never;
}

function makeParams(overrides?: Record<string, unknown>) {
  return {
    cfg: {},
    deps: {} as never,
    job: makeJob(),
    message: "test",
    sessionKey: "cron:test",
    ...overrides,
  };
}

// ---------- tests ----------

describe("runCronIsolatedAgentTurn — skill filter", () => {
  let previousFastTestEnv: string | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    previousFastTestEnv = process.env.FASED_TEST_FAST;
    delete process.env.FASED_TEST_FAST;
    buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "<available_skills></available_skills>",
      resolvedSkills: [],
      version: 42,
    });
    resolveAgentConfigMock.mockReturnValue(undefined);
    resolveAgentModelFallbacksOverrideMock.mockReturnValue(undefined);
    resolveAgentSkillsFilterMock.mockReturnValue(undefined);
    resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-4" });
    resolveAllowedModelRefMock.mockReturnValue({ ref: { provider: "openai", model: "gpt-4" } });
    resolveHooksGmailModelMock.mockReturnValue(null);
    resolveThinkingDefaultMock.mockReturnValue(undefined);
    getModelRefStatusMock.mockReturnValue({ allowed: false });
    isCliProviderMock.mockReturnValue(false);
    createFasedAgentCodingToolsMock.mockReturnValue([]);
    deriveSessionTotalTokensMock.mockReturnValue(30);
    hasNonzeroUsageMock.mockReturnValue(false);
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "telegram", messageId: "msg-1" }]);
    resolveCronDeliveryPlanMock.mockReturnValue({ requested: false });
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: false,
      channel: "discord",
      to: undefined,
      accountId: undefined,
      error: { message: "delivery not requested" },
    });
    logWarnMock.mockReset();
    // Fresh session object per test — prevents mutation leaking between tests
    resolveCronSessionMock.mockReturnValue({
      storePath: "/tmp/store.json",
      store: {},
      sessionEntry: {
        sessionId: "test-session-id",
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: undefined,
      },
      systemSent: false,
      isNewSession: true,
    });
  });

  afterEach(() => {
    if (previousFastTestEnv == null) {
      delete process.env.FASED_TEST_FAST;
      return;
    }
    process.env.FASED_TEST_FAST = previousFastTestEnv;
  });

  it("passes agent-level skillFilter to buildWorkspaceSkillSnapshot", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue(["meme-factory", "weather"]);

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: { agents: { list: [{ id: "scout", skills: ["meme-factory", "weather"] }] } },
        agentId: "scout",
      }),
    );

    expect(result.status).toBe("ok");
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
    expect(buildWorkspaceSkillSnapshotMock.mock.calls[0][1]).toHaveProperty("skillFilter", [
      "meme-factory",
      "weather",
    ]);
  });

  it("omits skillFilter when agent has no skills config", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue(undefined);

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: { agents: { list: [{ id: "general" }] } },
        agentId: "general",
      }),
    );

    expect(result.status).toBe("ok");
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
    // When no skills config, skillFilter should be undefined (no filtering applied)
    expect(buildWorkspaceSkillSnapshotMock.mock.calls[0][1].skillFilter).toBeUndefined();
  });

  it("passes empty skillFilter when agent explicitly disables all skills", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue([]);

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: { agents: { list: [{ id: "silent", skills: [] }] } },
        agentId: "silent",
      }),
    );

    expect(result.status).toBe("ok");
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
    // Explicit empty skills list should forward [] to filter out all skills
    expect(buildWorkspaceSkillSnapshotMock.mock.calls[0][1]).toHaveProperty("skillFilter", []);
  });

  it("uses task selected-skill policy over agent skill filter", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue(["agent-default"]);

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({
          executionPolicy: {
            executionMode: "agent-turn",
            skillScope: "selected",
            allowedSkills: ["wallet", "search"],
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
    expect(buildWorkspaceSkillSnapshotMock.mock.calls[0][1]).toHaveProperty("skillFilter", [
      "wallet",
      "search",
    ]);
  });

  it("disables all tools when task policy sets skill scope to none", async () => {
    runWithModelFallbackMock.mockImplementationOnce(async (args) => {
      const result = await args.run("openai", "gpt-4");
      return { result, provider: "openai", model: "gpt-4" } as never;
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({
          executionPolicy: {
            executionMode: "agent-turn",
            skillScope: "none",
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
    expect(buildWorkspaceSkillSnapshotMock.mock.calls[0][1]).toHaveProperty("skillFilter", []);
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toMatchObject({ disableTools: true });
  });

  it("skips model execution for no-model task policy", async () => {
    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({
          executionPolicy: {
            executionMode: "no-model",
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(result.outputText).toBe("test");
    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
    expect(buildWorkspaceSkillSnapshotMock).not.toHaveBeenCalled();
    expect(result.policy).toMatchObject({
      requestedExecutionMode: "no-model",
      effectiveExecutionMode: "no-model",
    });
  });

  it("runs auto task policy as an agent turn until planner routing exists", async () => {
    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({
          executionPolicy: {
            executionMode: "auto",
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(result.policy).toMatchObject({
      requestedExecutionMode: "auto",
      effectiveExecutionMode: "agent-turn",
    });
  });

  it("rejects skill-only tasks without an explicit deterministic tool action", async () => {
    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({
          executionPolicy: {
            executionMode: "skill-only",
            skillScope: "selected",
            allowedSkills: ["wallet"],
          },
        }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("skillAction.toolName");
    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
  });

  it("runs explicit skill-only tool action without invoking a model", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "wallet balance ok" }],
      details: { ok: true },
    });
    createFasedAgentCodingToolsMock.mockReturnValue([{ name: "wallet", label: "Wallet", execute }]);

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({
          executionPolicy: {
            executionMode: "skill-only",
            skillScope: "selected",
            allowedSkills: ["wallet"],
            skillAction: {
              toolName: "wallet",
              input: { action: "balance" },
            },
            modelPolicy: { mode: "none" },
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(result.outputText).toBe("wallet balance ok");
    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      "cron:test-job:skill-only",
      { action: "balance" },
      undefined,
    );
    expect(createFasedAgentCodingToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({ senderIsOwner: true }),
    );
  });

  it("formats wallet skill-only results and delivers them directly without an announce model turn", async () => {
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      channel: "telegram",
      to: "397848047",
      accountId: "bot",
    });
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "397848047",
      accountId: "bot",
    });
    const execute = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            result: {
              walletId: "solana-2",
              walletName: "Solana 2",
              balances: {
                solana: {
                  ok: true,
                  assets: [
                    {
                      kind: "native",
                      symbol: "SOL",
                      amountDisplay: "1.14994",
                    },
                  ],
                },
              },
            },
          }),
        },
      ],
      details: {
        ok: true,
        result: {
          walletId: "solana-2",
          walletName: "Solana 2",
          balances: {
            solana: {
              ok: true,
              assets: [
                {
                  kind: "native",
                  symbol: "SOL",
                  amountDisplay: "1.14994",
                },
              ],
            },
          },
        },
      },
    });
    createFasedAgentCodingToolsMock.mockReturnValue([{ name: "wallet", label: "Wallet", execute }]);

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({
          delivery: { mode: "announce", channel: "telegram", to: "397848047", accountId: "bot" },
          executionPolicy: {
            executionMode: "skill-only",
            skillScope: "selected",
            allowedSkills: ["wallet"],
            skillAction: {
              toolName: "wallet",
              input: { action: "balance", walletHandle: "@wallet:solana-2" },
            },
            modelPolicy: { mode: "none" },
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(result.delivered).toBe(true);
    expect(result.outputText).toContain("Wallet: Solana 2");
    expect(result.outputText).toContain("SOL: 1.14994 SOL");
    expect(result.policy).toMatchObject({
      resultSource: "direct-tool",
      resultAdapter: "wallet",
      modelUsed: false,
    });
    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(deliverOutboundPayloadsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "397848047",
        payloads: [{ text: expect.stringContaining("Wallet: Solana 2") }],
      }),
    );
  });

  it("passes hard memory isolation to embedded model runs", async () => {
    runWithModelFallbackMock.mockImplementationOnce(async (args) => {
      const result = await args.run("openai", "gpt-4");
      return { result, provider: "openai", model: "gpt-4" } as never;
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({
          executionPolicy: {
            executionMode: "agent-turn",
            memoryScope: "none",
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toMatchObject({
      omitPriorMessages: true,
      senderIsOwner: true,
      disabledToolNames: expect.arrayContaining([
        "memory_search",
        "memory_get",
        "sessions_history",
      ]),
    });
  });

  it("limits pinned memory tasks to direct memory lookup and local context", async () => {
    runWithModelFallbackMock.mockImplementationOnce(async (args) => {
      const result = await args.run("openai", "gpt-4");
      return { result, provider: "openai", model: "gpt-4" } as never;
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({
          executionPolicy: {
            executionMode: "agent-turn",
            memoryScope: "pinned",
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toMatchObject({
      omitPriorMessages: false,
      disabledToolNames: expect.arrayContaining(["memory_search", "sessions_history"]),
    });
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0].disabledToolNames).not.toContain("memory_get");
  });

  it("applies task model override and escalation fallback policy", async () => {
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      const [provider, ...modelParts] = raw.split("/");
      return { ref: { provider, model: modelParts.join("/") } };
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({
          executionPolicy: {
            executionMode: "agent-turn",
            modelPolicy: {
              mode: "task-override",
              model: "openrouter/cheap",
              escalationModel: "openai/strong",
            },
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(runWithModelFallbackMock.mock.calls[0]?.[0]).toMatchObject({
      provider: "openrouter",
      model: "cheap",
      fallbacksOverride: ["openai/strong"],
    });
    expect(result.policy).toMatchObject({
      requestedExecutionMode: "agent-turn",
      effectiveExecutionMode: "agent-turn",
      modelPolicyMode: "task-override",
      modelOverride: "openrouter/cheap",
      escalationModel: "openai/strong",
    });
  });

  it("uses the escalation model and prompt when evaluator follow-up is pending", async () => {
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      const [provider, ...modelParts] = raw.split("/");
      return { ref: { provider, model: modelParts.join("/") } };
    });
    runWithModelFallbackMock.mockImplementationOnce(async (args) => {
      const result = await args.run("openai", "strong");
      return { result, provider: "openai", model: "strong" } as never;
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({
          state: {
            pendingEscalation: {
              reason: "Matched signal",
              signal: "Needs deeper analysis: yes",
              createdAtMs: 2_000,
              sourceRunAtMs: 2_000,
            },
          },
          executionPolicy: {
            executionMode: "agent-turn",
            planner: {
              source: "heuristic",
              strategy: "cheap-model",
              rationale: "monitor",
            },
            modelPolicy: {
              mode: "auto",
              escalationModel: "openai/strong",
            },
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(runWithModelFallbackMock.mock.calls[0]?.[0]).toMatchObject({
      provider: "openai",
      model: "strong",
    });
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    const prompt = runEmbeddedPiAgentMock.mock.calls[0]?.[0].prompt;
    expect(prompt).toContain("Escalation follow-up");
    expect(prompt).toContain("Evaluator cue: Needs deeper analysis: yes");
    expect(prompt).toContain("Keep the final response under 180 words");
    expect(prompt).not.toContain("[cron:");
  });

  it("uses a compact cheap-check prompt and configured cheap task model", async () => {
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      const [provider, ...modelParts] = raw.split("/");
      return { ref: { provider, model: modelParts.join("/") } };
    });
    runWithModelFallbackMock.mockImplementationOnce(async (args) => {
      const result = await args.run("openrouter", "google/gemini-2.5-flash-lite");
      return { result, provider: "openrouter", model: "google/gemini-2.5-flash-lite" } as never;
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "openrouter/auto" },
              taskModels: { cheapCheck: "openrouter/google/gemini-2.5-flash-lite" },
            },
          },
        },
        message:
          "Check market risk with a cheap check first and escalate only if deeper analysis is needed.",
        job: makeJob({
          executionPolicy: {
            executionMode: "agent-turn",
            memoryScope: "none",
            skillScope: "selected",
            allowedSkills: ["web_search"],
            planner: {
              source: "heuristic",
              strategy: "cheap-model",
              rationale: "monitor",
            },
            modelPolicy: {
              mode: "auto",
            },
            evaluator: {
              escalateOnSignal: true,
              signalIncludes: ["Needs deeper analysis: yes"],
              maxEscalations: 1,
            },
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(runWithModelFallbackMock.mock.calls[0]?.[0]).toMatchObject({
      provider: "openrouter",
      model: "google/gemini-2.5-flash-lite",
    });
    expect(result.policy?.modelSource).toBe("Global cheap/check role");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    const prompt = runEmbeddedPiAgentMock.mock.calls[0]?.[0].prompt;
    expect(prompt).toContain("Cheap check output rules:");
    expect(prompt).toContain("First line exactly");
    expect(prompt).toContain("Do not retrieve memory");
    expect(prompt).not.toContain("[cron:");
  });

  it("uses Agent task role models and Agent fallbacks for task runs", async () => {
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      const [provider, ...modelParts] = raw.split("/");
      return { ref: { provider, model: modelParts.join("/") } };
    });
    resolveAgentModelFallbacksOverrideMock.mockReturnValue(["openrouter/fallback"]);
    runWithModelFallbackMock.mockImplementationOnce(async (args) => {
      const result = await args.run("openrouter", "cheap-agent");
      return { result, provider: "openrouter", model: "cheap-agent" } as never;
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "openrouter/global-default" },
              taskModels: { cheapCheck: "openrouter/global-cheap" },
            },
            list: [
              {
                id: "analyst",
                model: {
                  primary: "openrouter/agent-default",
                  fallbacks: ["openrouter/fallback"],
                },
                taskModels: {
                  cheapCheck: "openrouter/cheap-agent",
                  escalation: "openrouter/strong-agent",
                },
              },
            ],
          },
        },
        message: "Use a cheap check first and escalate only if deeper analysis is needed.",
        job: makeJob({
          agentId: "analyst",
          executionPolicy: {
            executionMode: "agent-turn",
            memoryScope: "none",
            planner: {
              source: "heuristic",
              strategy: "cheap-model",
              rationale: "monitor",
            },
            modelPolicy: {
              mode: "auto",
            },
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(runWithModelFallbackMock.mock.calls[0]?.[0]).toMatchObject({
      provider: "openrouter",
      model: "cheap-agent",
      fallbacksOverride: ["openrouter/fallback"],
    });
    expect(result.policy?.modelSource).toBe("Agent cheap/check role");
  });

  it("uses the escalation model when source verification finds a conflict", async () => {
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      const [provider, ...modelParts] = raw.split("/");
      return { ref: { provider, model: modelParts.join("/") } };
    });
    runWithModelFallbackMock.mockImplementationOnce(async (args) => {
      const result = await args.run("openai", "strong");
      return { result, provider: "openai", model: "strong" } as never;
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({
          executionPolicy: {
            executionMode: "agent-turn",
            modelPolicy: {
              mode: "auto",
              model: "openrouter/cheap",
              escalationModel: "openai/strong",
            },
          },
        }),
        graphContext: [
          {
            nodeId: "source-fetch-web-fetch",
            nodeKind: "tool",
            label: "Fetch source URL",
            sourceRole: "primary",
            status: "ok",
            toolName: "web_fetch",
            outputText: "market_status: green",
            sourceQualityScore: 0.91,
            sourceQualityBand: "high",
            sourceAuthority: "direct",
          },
          {
            nodeId: "source-fetch-web-search",
            nodeKind: "tool",
            label: "Search live source",
            sourceRole: "verification",
            status: "ok",
            toolName: "web_search",
            outputText: "market_status: red",
            sourceQualityScore: 0.77,
            sourceQualityBand: "high",
            sourceAuthority: "live",
          },
          {
            nodeId: "source-verify",
            nodeKind: "validation",
            label: "Source verification",
            status: "ok",
            summary: "Source verification: conflict suspected (2 issues).",
            outputText:
              "Conflicts\n- source-fetch-market vs source-fetch-market-verification: up/down",
            verificationStatus: "conflict_suspected",
            sourceConflictCount: 2,
            needsReview: true,
            evaluatorSignal: "source_conflict",
          },
        ],
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(runWithModelFallbackMock.mock.calls[0]?.[0]).toMatchObject({
      provider: "openai",
      model: "strong",
    });
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0].prompt).toContain(
      "Source verification found conflicting evidence",
    );
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0].prompt).toContain("quality high 0.91");
    expect(result.policy).toMatchObject({
      sourceVerificationStatus: "conflict_suspected",
      sourceConflictCount: 2,
      needsSourceReview: true,
      escalatedBecause: "source_conflict",
      sourceQuality: {
        bestSourceId: "source-fetch-web-fetch",
        bestScore: 0.91,
        lowQualityCount: 0,
        unavailableCount: 0,
      },
    });
  });

  it("rejects invalid task policy model overrides instead of silently falling back", async () => {
    resolveAllowedModelRefMock.mockReturnValueOnce({
      error: "model not allowed: openrouter/not-real",
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({
          executionPolicy: {
            executionMode: "agent-turn",
            modelPolicy: {
              mode: "task-override",
              model: "openrouter/not-real",
            },
          },
        }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toBe("model not allowed: openrouter/not-real");
    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it("keeps legacy payload model fallback behavior for invalid payload model hints", async () => {
    resolveAllowedModelRefMock.mockReturnValueOnce({
      error: "model not allowed: openrouter/not-real",
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({
          payload: { kind: "agentTurn", message: "test", model: "openrouter/not-real" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(logWarnMock).toHaveBeenCalledWith(
      "cron: payload.model 'openrouter/not-real' not allowed, falling back to agent defaults",
    );
  });

  it("skips model execution when token budget is zero", async () => {
    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({
          executionPolicy: {
            executionMode: "agent-turn",
            budget: { maxTokensPerRun: 0 },
          },
        }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("budget is 0");
    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
  });

  it("fails the run when token budget is exceeded by model usage", async () => {
    hasNonzeroUsageMock.mockReturnValue(true);
    deriveSessionTotalTokensMock.mockReturnValue(30);

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        job: makeJob({
          executionPolicy: {
            executionMode: "agent-turn",
            budget: { maxTokensPerRun: 20 },
          },
        }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toBe("Task token budget exceeded: used 30, limit 20.");
    expect(result.usage).toMatchObject({ total_tokens: 30 });
  });

  it("fails the run when cost budget is exceeded by model usage", async () => {
    hasNonzeroUsageMock.mockReturnValue(true);

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          models: {
            providers: {
              openai: {
                models: [
                  {
                    id: "gpt-4",
                    cost: { input: 10_000, output: 10_000, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
        },
        job: makeJob({
          executionPolicy: {
            executionMode: "agent-turn",
            budget: { maxCostUsdPerRun: 0.0001 },
          },
        }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toBe("Task cost budget exceeded: estimated $0.3000, limit $0.0001.");
  });

  it("refreshes cached snapshot when skillFilter changes without version bump", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue(["weather"]);
    resolveCronSessionMock.mockReturnValue({
      storePath: "/tmp/store.json",
      store: {},
      sessionEntry: {
        sessionId: "test-session-id",
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: {
          prompt: "<available_skills><skill>meme-factory</skill></available_skills>",
          skills: [{ name: "meme-factory" }],
          version: 42,
        },
      },
      systemSent: false,
      isNewSession: true,
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: { agents: { list: [{ id: "weather-bot", skills: ["weather"] }] } },
        agentId: "weather-bot",
      }),
    );

    expect(result.status).toBe("ok");
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
    expect(buildWorkspaceSkillSnapshotMock.mock.calls[0][1]).toHaveProperty("skillFilter", [
      "weather",
    ]);
  });

  it("forces a fresh session for isolated cron runs", async () => {
    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    expect(resolveCronSessionMock).toHaveBeenCalledOnce();
    expect(resolveCronSessionMock.mock.calls[0]?.[0]).toMatchObject({
      forceNew: true,
    });
  });

  it("reuses cached snapshot when version and normalized skillFilter are unchanged", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue([" weather ", "meme-factory", "weather"]);
    resolveCronSessionMock.mockReturnValue({
      storePath: "/tmp/store.json",
      store: {},
      sessionEntry: {
        sessionId: "test-session-id",
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: {
          prompt: "<available_skills><skill>weather</skill></available_skills>",
          skills: [{ name: "weather" }],
          skillFilter: ["meme-factory", "weather"],
          version: 42,
        },
      },
      systemSent: false,
      isNewSession: true,
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: { agents: { list: [{ id: "weather-bot", skills: ["weather", "meme-factory"] }] } },
        agentId: "weather-bot",
      }),
    );

    expect(result.status).toBe("ok");
    expect(buildWorkspaceSkillSnapshotMock).not.toHaveBeenCalled();
  });

  describe("model fallbacks", () => {
    const defaultFallbacks = [
      "anthropic/claude-opus-4-6",
      "google-gemini-cli/gemini-3-pro-preview",
      "nvidia/deepseek-ai/deepseek-v3.2",
    ];

    async function expectPrimaryOverridePreservesDefaults(modelOverride: unknown) {
      resolveAgentConfigMock.mockReturnValue({ model: modelOverride });
      const result = await runCronIsolatedAgentTurn(
        makeParams({
          cfg: {
            agents: {
              defaults: {
                model: { primary: "openai-codex/gpt-5.3-codex", fallbacks: defaultFallbacks },
              },
            },
          },
          agentId: "scout",
        }),
      );

      expect(result.status).toBe("ok");
      expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
      const callCfg = runWithModelFallbackMock.mock.calls[0][0].cfg;
      const model = callCfg?.agents?.defaults?.model as
        | { primary?: string; fallbacks?: string[] }
        | undefined;
      expect(model?.primary).toBe("anthropic/claude-sonnet-4-5");
      expect(model?.fallbacks).toEqual(defaultFallbacks);
    }

    it("preserves defaults when agent overrides primary as string", async () => {
      await expectPrimaryOverridePreservesDefaults("anthropic/claude-sonnet-4-5");
    });

    it("preserves defaults when agent overrides primary in object form", async () => {
      await expectPrimaryOverridePreservesDefaults({ primary: "anthropic/claude-sonnet-4-5" });
    });

    it("applies payload.model override when model is allowed", async () => {
      resolveAllowedModelRefMock.mockReturnValueOnce({
        ref: { provider: "anthropic", model: "claude-sonnet-4-6" },
      });

      const result = await runCronIsolatedAgentTurn(
        makeParams({
          job: makeJob({
            payload: { kind: "agentTurn", message: "test", model: "anthropic/claude-sonnet-4-6" },
          }),
        }),
      );

      expect(result.status).toBe("ok");
      expect(logWarnMock).not.toHaveBeenCalled();
      expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
      const runParams = runWithModelFallbackMock.mock.calls[0][0];
      expect(runParams.provider).toBe("anthropic");
      expect(runParams.model).toBe("claude-sonnet-4-6");
    });

    it("falls back to agent defaults when payload.model is not allowed", async () => {
      resolveAllowedModelRefMock.mockReturnValueOnce({
        error: "model not allowed: anthropic/claude-sonnet-4-6",
      });

      const result = await runCronIsolatedAgentTurn(
        makeParams({
          cfg: {
            agents: {
              defaults: {
                model: { primary: "openai-codex/gpt-5.3-codex", fallbacks: defaultFallbacks },
              },
            },
          },
          job: makeJob({
            payload: { kind: "agentTurn", message: "test", model: "anthropic/claude-sonnet-4-6" },
          }),
        }),
      );

      expect(result.status).toBe("ok");
      expect(logWarnMock).toHaveBeenCalledWith(
        "cron: payload.model 'anthropic/claude-sonnet-4-6' not allowed, falling back to agent defaults",
      );
      expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
      const callCfg = runWithModelFallbackMock.mock.calls[0][0].cfg;
      const model = callCfg?.agents?.defaults?.model as
        | { primary?: string; fallbacks?: string[] }
        | undefined;
      expect(model?.primary).toBe("openai-codex/gpt-5.3-codex");
      expect(model?.fallbacks).toEqual(defaultFallbacks);
    });

    it("returns an error when payload.model is invalid", async () => {
      resolveAllowedModelRefMock.mockReturnValueOnce({
        error: "invalid model: openai/",
      });

      const result = await runCronIsolatedAgentTurn(
        makeParams({
          job: makeJob({
            payload: { kind: "agentTurn", message: "test", model: "openai/" },
          }),
        }),
      );

      expect(result.status).toBe("error");
      expect(result.error).toBe("invalid model: openai/");
      expect(logWarnMock).not.toHaveBeenCalled();
      expect(runWithModelFallbackMock).not.toHaveBeenCalled();
    });
  });
});
