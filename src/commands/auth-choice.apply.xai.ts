import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import {
  createAuthChoiceAgentModelNoter,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeSecretInputModeInput,
} from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import { isRemoteEnvironment } from "./oauth-env.js";
import {
  applyAuthProfileConfig,
  applyXaiConfig,
  applyXaiProviderConfig,
  setXaiApiKey,
  writeOAuthCredentials,
  XAI_DEFAULT_MODEL_REF,
} from "./onboard-auth.js";
import { openUrl } from "./onboard-helpers.js";
import { loginXaiDeviceCode, loginXaiOAuth } from "./xai-oauth.js";

export async function applyAuthChoiceXAI(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice === "xai-oauth" || params.authChoice === "xai-device-code") {
    let nextConfig = params.config;
    let agentModelOverride: string | undefined;
    const noteAgentModel = createAuthChoiceAgentModelNoter(params);
    const login = params.authChoice === "xai-oauth" ? loginXaiOAuth : loginXaiDeviceCode;
    let creds;
    try {
      creds = await login({
        prompter: params.prompter,
        runtime: params.runtime,
        isRemote: params.oauthBrowserMode === "local" ? false : isRemoteEnvironment(),
        openUrl: async (url) => {
          await (params.openUrl ?? openUrl)(url);
        },
      });
    } catch {
      return { config: nextConfig, agentModelOverride };
    }
    if (creds) {
      const profileId = await writeOAuthCredentials("xai", creds, params.agentDir, {
        syncSiblingAgents: true,
      });
      nextConfig = applyAuthProfileConfig(nextConfig, {
        profileId,
        provider: "xai",
        mode: "oauth",
      });
      const applied = await applyDefaultModelChoice({
        config: nextConfig,
        setDefaultModel: params.setDefaultModel,
        defaultModel: XAI_DEFAULT_MODEL_REF,
        applyDefaultConfig: applyXaiConfig,
        applyProviderConfig: applyXaiProviderConfig,
        noteDefault: XAI_DEFAULT_MODEL_REF,
        noteAgentModel,
        prompter: params.prompter,
      });
      nextConfig = applied.config;
      agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
    }
    return { config: nextConfig, agentModelOverride };
  }

  if (params.authChoice !== "xai-api-key") {
    return null;
  }

  let nextConfig = params.config;
  let agentModelOverride: string | undefined;
  const noteAgentModel = createAuthChoiceAgentModelNoter(params);
  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
  await ensureApiKeyFromOptionEnvOrPrompt({
    token: params.opts?.xaiApiKey,
    tokenProvider: "xai",
    secretInputMode: requestedSecretInputMode,
    config: nextConfig,
    expectedProviders: ["xai"],
    provider: "xai",
    envLabel: "XAI_API_KEY",
    promptMessage: "Enter xAI API key",
    normalize: normalizeApiKeyInput,
    validate: validateApiKeyInput,
    prompter: params.prompter,
    setCredential: async (apiKey, mode) =>
      setXaiApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
  });

  nextConfig = applyAuthProfileConfig(nextConfig, {
    profileId: "xai:default",
    provider: "xai",
    mode: "api_key",
  });
  {
    const applied = await applyDefaultModelChoice({
      config: nextConfig,
      setDefaultModel: params.setDefaultModel,
      defaultModel: XAI_DEFAULT_MODEL_REF,
      applyDefaultConfig: applyXaiConfig,
      applyProviderConfig: applyXaiProviderConfig,
      noteDefault: XAI_DEFAULT_MODEL_REF,
      noteAgentModel,
      prompter: params.prompter,
    });
    nextConfig = applied.config;
    agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
  }

  return { config: nextConfig, agentModelOverride };
}
