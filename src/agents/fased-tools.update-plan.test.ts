import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import "./test-helpers/fast-core-tools.js";
import { createFasedCompatTools } from "./fased-tools.compat.js";

describe("fased-tools update_plan gating", () => {
  it("keeps update_plan disabled by default", () => {
    const tools = createFasedCompatTools({
      config: {} as FasedAgentConfig,
    });

    expect(tools.map((tool) => tool.name)).not.toContain("update_plan");
  });

  it("registers update_plan when explicitly enabled", () => {
    const tools = createFasedCompatTools({
      config: {
        tools: {
          experimental: {
            planTool: true,
          },
        },
      } as FasedAgentConfig,
    });

    const updatePlan = tools.find((tool) => tool.name === "update_plan");
    expect(updatePlan?.displaySummary).toBe("Track a short structured work plan.");
  });

  it("auto-enables update_plan for OpenAI-family providers", () => {
    const openaiTools = createFasedCompatTools({
      config: {} as FasedAgentConfig,
      modelProvider: "openai",
    });
    const codexTools = createFasedCompatTools({
      config: {} as FasedAgentConfig,
      modelProvider: "openai-codex",
    });
    const anthropicTools = createFasedCompatTools({
      config: {} as FasedAgentConfig,
      modelProvider: "anthropic",
    });

    expect(openaiTools.map((tool) => tool.name)).toContain("update_plan");
    expect(codexTools.map((tool) => tool.name)).toContain("update_plan");
    expect(anthropicTools.map((tool) => tool.name)).not.toContain("update_plan");
  });
});
