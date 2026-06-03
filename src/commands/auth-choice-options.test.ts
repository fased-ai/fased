import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import {
  buildAuthChoiceGroups,
  buildAuthChoiceOptions,
  formatAuthChoiceChoicesForCli,
} from "./auth-choice-options.js";

const EMPTY_STORE: AuthProfileStore = { version: 1, profiles: {} };

function getOptions(includeSkip = false) {
  return buildAuthChoiceOptions({
    store: EMPTY_STORE,
    includeSkip,
  });
}

describe("buildAuthChoiceOptions", () => {
  it("includes core and provider-specific auth choices", () => {
    const options = getOptions();

    for (const value of [
      "github-copilot",
      "anthropic-oauth",
      "token",
      "zai-api-key",
      "qianfan-api-key",
      "copilot-proxy",
      "xiaomi-api-key",
      "minimax-api",
      "minimax-api-key-cn",
      "minimax-api-lightning",
      "moonshot-api-key",
      "moonshot-api-key-cn",
      "kimi-code-api-key",
      "gemini-api-key",
      "google-gemini-cli",
      "together-api-key",
      "ai-gateway-api-key",
      "cloudflare-ai-gateway-api-key",
      "synthetic-api-key",
      "chutes",
      "chutes-api-key",
      "qwen-coding-plan-api-key",
      "qwen-api-key",
      "xai-oauth",
      "xai-device-code",
      "xai-api-key",
      "mistral-api-key",
      "volcengine-api-key",
      "byteplus-api-key",
      "vllm",
    ]) {
      expect(options.some((opt) => opt.value === value)).toBe(true);
    }
  });

  it("builds cli help choices from the same catalog", () => {
    const options = getOptions(true);
    const cliChoices = formatAuthChoiceChoicesForCli({
      includeLegacyAliases: false,
      includeSkip: true,
    }).split("|");

    for (const option of options) {
      expect(cliChoices).toContain(option.value);
    }
  });

  it("can include legacy aliases in cli help choices", () => {
    const cliChoices = formatAuthChoiceChoicesForCli({
      includeLegacyAliases: true,
      includeSkip: true,
    }).split("|");

    expect(cliChoices).toContain("setup-token");
    expect(cliChoices).toContain("oauth");
    expect(cliChoices).toContain("claude-cli");
    expect(cliChoices).toContain("codex-cli");
  });

  it("shows Chutes in grouped provider selection", () => {
    const { groups } = buildAuthChoiceGroups({
      store: EMPTY_STORE,
      includeSkip: false,
    });
    const chutesGroup = groups.find((group) => group.value === "chutes");

    expect(chutesGroup).toBeDefined();
    expect(chutesGroup?.options.some((opt) => opt.value === "chutes")).toBe(true);
    expect(chutesGroup?.options.some((opt) => opt.value === "chutes-api-key")).toBe(true);
  });

  it("shows Moonshot/Kimi methods from the shared provider manifest", () => {
    const { groups } = buildAuthChoiceGroups({
      store: EMPTY_STORE,
      includeSkip: false,
    });
    const moonshotGroup = groups.find((group) => group.value === "moonshot");

    expect(moonshotGroup).toBeDefined();
    expect(moonshotGroup?.label).toBe("Moonshot AI");
    expect(moonshotGroup?.options.map((opt) => opt.value)).toEqual([
      "moonshot-api-key",
      "moonshot-api-key-cn",
      "kimi-code-api-key",
    ]);
    expect(moonshotGroup?.options.map((opt) => opt.label)).toEqual([
      "Kimi API key (.ai)",
      "Kimi API key (.cn)",
      "Kimi Code API key (subscription)",
    ]);
  });

  it("shows Google methods from the shared provider manifest", () => {
    const { groups } = buildAuthChoiceGroups({
      store: EMPTY_STORE,
      includeSkip: false,
    });
    const googleGroup = groups.find((group) => group.value === "google");

    expect(googleGroup).toBeDefined();
    expect(googleGroup?.label).toBe("Google");
    expect(googleGroup?.options.map((opt) => opt.value)).toEqual([
      "gemini-api-key",
      "google-gemini-cli",
    ]);
    expect(googleGroup?.options.map((opt) => opt.label)).toEqual([
      "Gemini API key",
      "Sign in (Gemini CLI)",
    ]);
    expect(googleGroup?.options[1]?.hint).toContain("account-risk");
  });

  it("shows xAI in grouped provider selection from the shared manifest", () => {
    const { groups } = buildAuthChoiceGroups({
      store: EMPTY_STORE,
      includeSkip: false,
    });
    const xaiGroup = groups.find((group) => group.value === "xai");

    expect(xaiGroup).toBeDefined();
    expect(xaiGroup?.label).toBe("xAI (Grok)");
    expect(xaiGroup?.options.map((opt) => opt.value)).toEqual([
      "xai-oauth",
      "xai-device-code",
      "xai-api-key",
    ]);
    expect(xaiGroup?.options.map((opt) => opt.label)).toEqual([
      "xAI sign-in",
      "xAI device code",
      "xAI API key",
    ]);
  });

  it("shows Mistral in grouped provider selection from the shared manifest", () => {
    const { groups } = buildAuthChoiceGroups({
      store: EMPTY_STORE,
      includeSkip: false,
    });
    const mistralGroup = groups.find((group) => group.value === "mistral");

    expect(mistralGroup).toBeDefined();
    expect(mistralGroup?.label).toBe("Mistral AI");
    expect(mistralGroup?.options.map((opt) => opt.value)).toEqual(["mistral-api-key"]);
    expect(mistralGroup?.options[0]?.label).toBe("Mistral API key");
  });

  it("shows Qwen in grouped provider selection from the shared manifest", () => {
    const { groups } = buildAuthChoiceGroups({
      store: EMPTY_STORE,
      includeSkip: false,
    });
    const qwenGroup = groups.find((group) => group.value === "qwen");

    expect(qwenGroup).toBeDefined();
    expect(qwenGroup?.label).toBe("Qwen");
    expect(qwenGroup?.options.map((opt) => opt.value)).toEqual([
      "qwen-coding-plan-api-key",
      "qwen-api-key",
    ]);
    expect(qwenGroup?.options.map((opt) => opt.label)).toEqual([
      "Coding Plan API key",
      "DashScope API key",
    ]);
  });

  it("shows Z.AI endpoint choices from the shared provider manifest", () => {
    const { groups } = buildAuthChoiceGroups({
      store: EMPTY_STORE,
      includeSkip: false,
    });
    const zaiGroup = groups.find((group) => group.value === "zai");

    expect(zaiGroup).toBeDefined();
    expect(zaiGroup?.label).toBe("Z.AI");
    expect(zaiGroup?.options.map((opt) => opt.value)).toEqual([
      "zai-coding-global",
      "zai-coding-cn",
      "zai-global",
      "zai-cn",
    ]);
    expect(zaiGroup?.options.map((opt) => opt.label)).toEqual([
      "Coding-Plan-Global",
      "Coding-Plan-CN",
      "Global",
      "CN",
    ]);
  });

  it("shows Qianfan in grouped provider selection from the shared manifest", () => {
    const { groups } = buildAuthChoiceGroups({
      store: EMPTY_STORE,
      includeSkip: false,
    });
    const qianfanGroup = groups.find((group) => group.value === "qianfan");

    expect(qianfanGroup).toBeDefined();
    expect(qianfanGroup?.label).toBe("Qianfan");
    expect(qianfanGroup?.options.map((opt) => opt.value)).toEqual(["qianfan-api-key"]);
    expect(qianfanGroup?.options[0]?.label).toBe("Qianfan API key");
  });

  it("shows Copilot in grouped provider selection from the shared manifest", () => {
    const { groups } = buildAuthChoiceGroups({
      store: EMPTY_STORE,
      includeSkip: false,
    });
    const copilotGroup = groups.find((group) => group.value === "copilot");

    expect(copilotGroup).toBeDefined();
    expect(copilotGroup?.label).toBe("Copilot");
    expect(copilotGroup?.options.map((opt) => opt.value)).toEqual([
      "github-copilot",
      "copilot-proxy",
    ]);
    expect(copilotGroup?.options.map((opt) => opt.label)).toEqual([
      "GitHub sign in",
      "Proxy sign in",
    ]);
  });

  it("shows vLLM in grouped provider selection", () => {
    const { groups } = buildAuthChoiceGroups({
      store: EMPTY_STORE,
      includeSkip: false,
    });
    const vllmGroup = groups.find((group) => group.value === "vllm");

    expect(vllmGroup).toBeDefined();
    expect(vllmGroup?.label).toBe("vLLM-compatible");
    expect(vllmGroup?.options.map((opt) => opt.value)).toEqual(["vllm"]);
    expect(vllmGroup?.options[0]?.label).toBe("vLLM-compatible URL + model");
  });

  it("shows MiniMax in grouped provider selection from the shared manifest", () => {
    const { groups } = buildAuthChoiceGroups({
      store: EMPTY_STORE,
      includeSkip: false,
    });
    const minimaxGroup = groups.find((group) => group.value === "minimax");

    expect(minimaxGroup).toBeDefined();
    expect(minimaxGroup?.label).toBe("MiniMax");
    expect(minimaxGroup?.options.map((opt) => opt.value)).toEqual([
      "minimax-portal",
      "minimax-api",
      "minimax-api-key-cn",
      "minimax-api-lightning",
    ]);
    expect(minimaxGroup?.options.map((opt) => opt.label)).toEqual([
      "Sign in",
      "API key",
      "API key (CN)",
      "Highspeed API key",
    ]);
  });
});
