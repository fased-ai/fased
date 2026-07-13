import { ensureOpenAICodexRuntimeComponent } from "../agents/openai-codex-runtime-component.js";
import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import {
  createAuthChoiceAgentModelNoter,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeSecretInputModeInput,
} from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import { isRemoteEnvironment } from "./oauth-env.js";
import { applyAuthProfileConfig, setOpenaiApiKey, writeOAuthCredentials } from "./onboard-auth.js";
import { openUrl } from "./onboard-helpers.js";
import {
  applyOpenAICodexModelDefault,
  discoverOpenAICodexDefaultModel,
} from "./openai-codex-model-default.js";
import { loginOpenAICodexOAuth } from "./openai-codex-oauth.js";
import {
  applyOpenAIConfig,
  applyOpenAIProviderConfig,
  OPENAI_DEFAULT_MODEL,
} from "./openai-model-default.js";

async function openOAuthUrl(url: string): Promise<void> {
  await openUrl(url);
}

export async function applyAuthChoiceOpenAI(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
  const noteAgentModel = createAuthChoiceAgentModelNoter(params);
  let authChoice = params.authChoice;
  if (authChoice === "apiKey" && params.opts?.tokenProvider === "openai") {
    authChoice = "openai-api-key";
  }

  if (authChoice === "openai-api-key") {
    let nextConfig = params.config;
    let agentModelOverride: string | undefined;

    const applyOpenAiDefaultModelChoice = async (): Promise<ApplyAuthChoiceResult> => {
      const applied = await applyDefaultModelChoice({
        config: nextConfig,
        setDefaultModel: params.setDefaultModel,
        defaultModel: OPENAI_DEFAULT_MODEL,
        applyDefaultConfig: applyOpenAIConfig,
        applyProviderConfig: applyOpenAIProviderConfig,
        noteDefault: OPENAI_DEFAULT_MODEL,
        noteAgentModel,
        prompter: params.prompter,
      });
      nextConfig = applied.config;
      agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
      return { config: nextConfig, agentModelOverride };
    };

    await ensureApiKeyFromOptionEnvOrPrompt({
      token: params.opts?.token,
      tokenProvider: params.opts?.tokenProvider,
      secretInputMode: requestedSecretInputMode,
      config: nextConfig,
      expectedProviders: ["openai"],
      provider: "openai",
      envLabel: "OPENAI_API_KEY",
      promptMessage: "Enter OpenAI API key",
      normalize: normalizeApiKeyInput,
      validate: validateApiKeyInput,
      prompter: params.prompter,
      setCredential: async (apiKey, mode) =>
        setOpenaiApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
    });
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "openai:default",
      provider: "openai",
      mode: "api_key",
    });
    return await applyOpenAiDefaultModelChoice();
  }

  if (params.authChoice === "openai-codex") {
    let nextConfig = params.config;
    let agentModelOverride: string | undefined;

    let creds;
    try {
      creds = await loginOpenAICodexOAuth({
        prompter: params.prompter,
        runtime: params.runtime,
        isRemote: params.oauthBrowserMode === "local" ? false : isRemoteEnvironment(),
        openUrl: params.openUrl ?? openOAuthUrl,
        localBrowserMessage: "Complete sign-in in browser…",
      });
    } catch {
      // The helper already surfaces the error to the user.
      // Keep onboarding flow alive and return unchanged config.
      return { config: nextConfig, agentModelOverride };
    }
    if (creds) {
      const runtimeComponent = await ensureOpenAICodexRuntimeComponent({ config: nextConfig });
      nextConfig = runtimeComponent.config;
      for (const warning of runtimeComponent.slotWarnings) {
        await params.prompter.note(warning, "OpenAI runtime warning");
      }
      if (runtimeComponent.installed) {
        await params.prompter.note(
          "Installed the managed OpenAI sign-in runtime for authenticated model discovery and execution.",
          "OpenAI runtime ready",
        );
      }
      const profileId = await writeOAuthCredentials("openai-codex", creds, params.agentDir, {
        syncSiblingAgents: true,
      });
      nextConfig = applyAuthProfileConfig(nextConfig, {
        profileId,
        provider: "openai-codex",
        mode: "oauth",
      });
      const discoveredModel = await discoverOpenAICodexDefaultModel({
        config: nextConfig,
        agentDir: params.agentDir,
      });
      if (params.setDefaultModel && discoveredModel) {
        const applied = applyOpenAICodexModelDefault(nextConfig, discoveredModel);
        nextConfig = applied.next;
        if (applied.changed) {
          await params.prompter.note(`Default model set to ${discoveredModel}`, "Model configured");
        }
      } else if (!params.setDefaultModel && discoveredModel) {
        agentModelOverride = discoveredModel;
        await noteAgentModel(discoveredModel);
      } else if (!discoveredModel) {
        await params.prompter.note(
          "Sign-in completed, but the authenticated runtime did not return an executable model. Refresh Agent > Models or run `fased models list --all --provider openai-codex`.",
          "No sign-in model available",
        );
      }
    }
    return { config: nextConfig, agentModelOverride };
  }

  return null;
}
