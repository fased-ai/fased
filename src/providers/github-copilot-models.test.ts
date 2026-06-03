import { describe, expect, it } from "vitest";
import {
  buildCopilotModelDefinition,
  buildCopilotProxyModelDefinition,
  getDefaultCopilotModelIds,
  getDefaultCopilotProxyModelIds,
} from "./github-copilot-models.js";

describe("github-copilot-models", () => {
  describe("getDefaultCopilotModelIds", () => {
    it("includes claude-sonnet-4.6", () => {
      expect(getDefaultCopilotModelIds()).toContain("claude-sonnet-4.6");
    });

    it("includes current OpenAI, Anthropic, and Google Copilot models", () => {
      expect(getDefaultCopilotModelIds()).toContain("gpt-5.5");
      expect(getDefaultCopilotModelIds()).toContain("claude-opus-4.7");
      expect(getDefaultCopilotModelIds()).toContain("claude-opus-4.6-fast");
      expect(getDefaultCopilotModelIds()).toContain("gemini-3.1-pro");
      expect(getDefaultCopilotModelIds()).toContain("raptor-mini");
      expect(getDefaultCopilotModelIds()).not.toContain("gpt-5.4-nano");
    });

    it("returns a mutable copy", () => {
      const a = getDefaultCopilotModelIds();
      const b = getDefaultCopilotModelIds();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe("getDefaultCopilotProxyModelIds", () => {
    it("uses the curated Copilot Proxy defaults", () => {
      expect(getDefaultCopilotProxyModelIds()).toContain("gpt-5.5");
      expect(getDefaultCopilotProxyModelIds()).toContain("grok-code-fast-1");
      expect(getDefaultCopilotProxyModelIds()).toContain("goldeneye");
      expect(getDefaultCopilotProxyModelIds()).not.toContain("gpt-4o");
    });
  });

  describe("buildCopilotModelDefinition", () => {
    it("builds a valid definition for claude-sonnet-4.6", () => {
      const def = buildCopilotModelDefinition("claude-sonnet-4.6");
      expect(def.id).toBe("claude-sonnet-4.6");
      expect(def.api).toBe("openai-responses");
    });

    it("trims whitespace from model id", () => {
      const def = buildCopilotModelDefinition("  gpt-5.5  ");
      expect(def.id).toBe("gpt-5.5");
    });

    it("throws on empty model id", () => {
      expect(() => buildCopilotModelDefinition("")).toThrow("Model id required");
      expect(() => buildCopilotModelDefinition("  ")).toThrow("Model id required");
    });

    it("uses chat completions for the local proxy route", () => {
      const def = buildCopilotProxyModelDefinition("gpt-5.5");
      expect(def.id).toBe("gpt-5.5");
      expect(def.api).toBe("openai-completions");
      expect(def.capabilities?.thinkingMode).toBe("openai-reasoning-effort");
    });

    it("derives model-family capabilities", () => {
      expect(buildCopilotModelDefinition("claude-opus-4.7").capabilities).toMatchObject({
        tools: true,
        json: true,
        thinkingMode: "anthropic-adaptive",
      });
      expect(buildCopilotModelDefinition("gemini-3.1-pro").capabilities).toMatchObject({
        tools: true,
        json: true,
        thinkingMode: "google-thinking-budget",
      });
      expect(buildCopilotModelDefinition("grok-code-fast-1").capabilities).toMatchObject({
        tools: true,
        json: true,
      });
    });
  });
});
