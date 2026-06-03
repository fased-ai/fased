import type { FasedAgentConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoiceAnthropic } from "./auth-choice.apply.anthropic.js";
import { applyAuthChoiceApiProviders } from "./auth-choice.apply.api-providers.js";
import { applyAuthChoiceBytePlus } from "./auth-choice.apply.byteplus.js";
import { applyAuthChoiceCopilotProxy } from "./auth-choice.apply.copilot-proxy.js";
import { applyAuthChoiceGitHubCopilot } from "./auth-choice.apply.github-copilot.js";
import { applyAuthChoiceGoogleGeminiCli } from "./auth-choice.apply.google-gemini-cli.js";
import { applyAuthChoiceMiniMax } from "./auth-choice.apply.minimax.js";
import { applyAuthChoiceOAuth } from "./auth-choice.apply.oauth.js";
import { applyAuthChoiceOpenAI } from "./auth-choice.apply.openai.js";
import { applyAuthChoiceManifestPluginProvider } from "./auth-choice.apply.plugin-manifest.js";
import { applyAuthChoiceVllm } from "./auth-choice.apply.vllm.js";
import { applyAuthChoiceVolcengine } from "./auth-choice.apply.volcengine.js";
import { applyAuthChoiceXAI } from "./auth-choice.apply.xai.js";
import type { AuthChoice, OnboardOptions } from "./onboard-types.js";

export type ApplyAuthChoiceParams = {
  authChoice: AuthChoice;
  config: FasedAgentConfig;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  openUrl?: (url: string) => Promise<void>;
  agentDir?: string;
  setDefaultModel: boolean;
  agentId?: string;
  oauthBrowserMode?: "environment" | "local";
  opts?: Partial<OnboardOptions>;
};

export type ApplyAuthChoiceResult = {
  config: FasedAgentConfig;
  agentModelOverride?: string;
};

export async function applyAuthChoice(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult> {
  const handlers: Array<(p: ApplyAuthChoiceParams) => Promise<ApplyAuthChoiceResult | null>> = [
    applyAuthChoiceAnthropic,
    applyAuthChoiceVllm,
    applyAuthChoiceOpenAI,
    applyAuthChoiceOAuth,
    applyAuthChoiceApiProviders,
    applyAuthChoiceMiniMax,
    applyAuthChoiceGitHubCopilot,
    applyAuthChoiceGoogleGeminiCli,
    applyAuthChoiceCopilotProxy,
    applyAuthChoiceXAI,
    applyAuthChoiceVolcengine,
    applyAuthChoiceBytePlus,
    applyAuthChoiceManifestPluginProvider,
  ];

  for (const handler of handlers) {
    const result = await handler(params);
    if (result) {
      return result;
    }
  }

  throw new Error(`Unsupported provider auth choice: ${params.authChoice}`);
}
