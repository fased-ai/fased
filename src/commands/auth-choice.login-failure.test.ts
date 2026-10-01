import { describe, expect, it, vi } from "vitest";
import { loginAnthropicOAuth } from "./anthropic-oauth.js";
import { applyAuthChoiceAnthropic } from "./auth-choice.apply.anthropic.js";
import type { ApplyAuthChoiceParams } from "./auth-choice.apply.js";
import { applyAuthChoiceOAuth } from "./auth-choice.apply.oauth.js";
import { applyAuthChoiceOpenAI } from "./auth-choice.apply.openai.js";
import { applyAuthChoiceXAI } from "./auth-choice.apply.xai.js";
import { loginChutes } from "./chutes-oauth.js";
import { loginOpenAICodexOAuth } from "./openai-codex-oauth.js";
import { createExitThrowingRuntime, createWizardPrompter } from "./test-wizard-helpers.js";
import { loginXaiOAuth } from "./xai-oauth.js";
vi.mock("./openai-codex-oauth.js", () => ({ loginOpenAICodexOAuth: vi.fn() }));
vi.mock("./anthropic-oauth.js", () => ({ loginAnthropicOAuth: vi.fn() }));
vi.mock("./xai-oauth.js", () => ({ loginXaiOAuth: vi.fn(), loginXaiDeviceCode: vi.fn() }));
vi.mock("./chutes-oauth.js", () => ({ loginChutes: vi.fn() }));
describe("provider login failures", () => {
  it.each([["openai-codex", applyAuthChoiceOpenAI, loginOpenAICodexOAuth]] as const)(
    "does not report %s as successful with unchanged credentials",
    async (authChoice, apply, login) => {
      const failure = new Error("Sign-in callback failed");
      vi.mocked(login).mockRejectedValueOnce(failure);
      const config = {};
      const params = {
        authChoice,
        config,
        prompter: createWizardPrompter(),
        runtime: createExitThrowingRuntime(),
        setDefaultModel: false,
      } as ApplyAuthChoiceParams;
      await expect(apply(params)).rejects.toBe(failure);
      expect(config).toEqual({});
    },
  );
  it.each([
    ["anthropic-oauth", applyAuthChoiceAnthropic, loginAnthropicOAuth],
    ["xai-oauth", applyAuthChoiceXAI, loginXaiOAuth],
  ] as const)(
    "rejects unsupported %s before requesting credentials",
    async (authChoice, apply, login) => {
      vi.mocked(login).mockClear();
      await expect(
        apply({
          authChoice,
          config: {},
          prompter: createWizardPrompter(),
          runtime: createExitThrowingRuntime(),
        } as ApplyAuthChoiceParams),
      ).rejects.toThrow("official");
      expect(login).not.toHaveBeenCalled();
    },
  );
  it("does not report Chutes setup as successful after a failed exchange", async () => {
    const failure = new Error("Token exchange rejected");
    vi.mocked(loginChutes).mockRejectedValueOnce(failure);
    const config = {};
    const prompter = createWizardPrompter({});
    vi.mocked(prompter.text).mockResolvedValue("synthetic-client-id");
    await expect(
      applyAuthChoiceOAuth({
        authChoice: "chutes",
        config,
        prompter,
        runtime: createExitThrowingRuntime(),
        setDefaultModel: false,
      }),
    ).rejects.toBe(failure);
    expect(config).toEqual({});
  });
});
