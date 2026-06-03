import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";

describe("strict-agentic config schema", () => {
  it("accepts explicit task model slots", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        taskModels: {
          cheapCheck: "openrouter/my-cheap-model",
          strong: "openrouter/my-strong-model",
          escalation: "openrouter/my-escalation-model",
          coding: "openai/my-coding-model",
          summarizer: "openai/my-summarizer-model",
        },
      }),
    ).not.toThrow();
    expect(() =>
      AgentEntrySchema.parse({
        id: "research",
        taskModels: {
          cheapCheck: "openrouter/agent-cheap-model",
          escalation: "openrouter/agent-escalation-model",
        },
      }),
    ).not.toThrow();
  });

  it("rejects more than one agent model fallback", () => {
    expect(() =>
      AgentEntrySchema.parse({
        id: "research",
        model: {
          primary: "openai/primary",
          fallbacks: ["openai/a", "openai/b"],
        },
      }),
    ).toThrow();
  });

  it("accepts legacy provider-scoped agent model settings for migration", () => {
    expect(() =>
      AgentEntrySchema.parse({
        id: "research",
        activeModelProvider: "openrouter",
        modelProviders: {
          openrouter: {
            profileId: "openrouter:work",
            primary: "openrouter/qwen/qwen3.6-flash",
            fallbacks: ["openrouter/z-ai/glm-5.1"],
            taskModels: {
              cheapCheck: "openrouter/cheap",
              escalation: "openrouter/strong",
            },
          },
        },
      }),
    ).not.toThrow();
  });

  it("accepts warning-only defaults and per-agent overrides", () => {
    expect(() => AgentDefaultsSchema.parse({ strictAgentic: { mode: "warn" } })).not.toThrow();
    expect(() =>
      AgentEntrySchema.parse({
        id: "ops",
        strictAgentic: { mode: "off" },
      }),
    ).not.toThrow();
  });

  it("rejects strict-agentic enforcement in public config", () => {
    expect(() => AgentDefaultsSchema.parse({ strictAgentic: { mode: "enforce" } })).toThrow();
    expect(() =>
      AgentEntrySchema.parse({
        id: "ops",
        strictAgentic: { mode: "enforce" },
      }),
    ).toThrow();
  });
});
