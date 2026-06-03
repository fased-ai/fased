import { upsertAuthProfile } from "../agents/auth-profiles.js";
import { loginAnthropicOAuth } from "./anthropic-oauth.js";
import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import {
  normalizeSecretInputModeInput,
  ensureApiKeyFromOptionEnvOrPrompt,
} from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { buildTokenProfileId, validateAnthropicSetupToken } from "./auth-token.js";
import { isRemoteEnvironment } from "./oauth-env.js";
import { applyAgentDefaultModelPrimary } from "./onboard-auth.config-shared.js";
import {
  applyAuthProfileConfig,
  setAnthropicApiKey,
  writeOAuthCredentials,
} from "./onboard-auth.js";
import { openUrl } from "./onboard-helpers.js";

const DEFAULT_ANTHROPIC_MODEL = "anthropic/claude-sonnet-4-6";

async function openOAuthUrl(url: string): Promise<void> {
  await openUrl(url);
}

export async function applyAuthChoiceAnthropic(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
  if (params.authChoice === "anthropic-oauth" || params.authChoice === "oauth") {
    let nextConfig = params.config;
    let creds;
    try {
      creds = await loginAnthropicOAuth({
        prompter: params.prompter,
        runtime: params.runtime,
        isRemote: params.oauthBrowserMode === "local" ? false : isRemoteEnvironment(),
        openUrl: params.openUrl ?? openOAuthUrl,
        localBrowserMessage: "Complete Anthropic sign-in in browser...",
      });
    } catch {
      return { config: nextConfig };
    }
    if (creds) {
      const profileId = await writeOAuthCredentials("anthropic", creds, params.agentDir, {
        syncSiblingAgents: true,
      });
      nextConfig = applyAuthProfileConfig(nextConfig, {
        profileId,
        provider: "anthropic",
        mode: "oauth",
      });
      if (params.setDefaultModel) {
        nextConfig = applyAgentDefaultModelPrimary(nextConfig, DEFAULT_ANTHROPIC_MODEL);
      }
    }
    return { config: nextConfig };
  }

  if (params.authChoice === "setup-token" || params.authChoice === "token") {
    let nextConfig = params.config;
    await params.prompter.note(
      ["Run `claude setup-token` in your terminal.", "Then paste the generated token below."].join(
        "\n",
      ),
      "Anthropic setup-token",
    );

    const tokenRaw = await params.prompter.text({
      message: "Paste Anthropic setup-token",
      validate: (value) => validateAnthropicSetupToken(String(value ?? "")),
    });
    const token = String(tokenRaw ?? "").trim();

    const profileNameRaw = await params.prompter.text({
      message: "Token name (blank = default)",
      placeholder: "default",
    });
    const provider = "anthropic";
    const namedProfileId = buildTokenProfileId({
      provider,
      name: String(profileNameRaw ?? ""),
    });

    upsertAuthProfile({
      profileId: namedProfileId,
      agentDir: params.agentDir,
      credential: {
        type: "token",
        provider,
        token,
      },
    });

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: namedProfileId,
      provider,
      mode: "token",
    });
    if (params.setDefaultModel) {
      nextConfig = applyAgentDefaultModelPrimary(nextConfig, DEFAULT_ANTHROPIC_MODEL);
    }
    return { config: nextConfig };
  }

  if (params.authChoice === "apiKey") {
    if (params.opts?.tokenProvider && params.opts.tokenProvider !== "anthropic") {
      return null;
    }

    let nextConfig = params.config;
    await ensureApiKeyFromOptionEnvOrPrompt({
      token: params.opts?.token,
      tokenProvider: params.opts?.tokenProvider ?? "anthropic",
      secretInputMode: requestedSecretInputMode,
      config: nextConfig,
      expectedProviders: ["anthropic"],
      provider: "anthropic",
      envLabel: "ANTHROPIC_API_KEY",
      promptMessage: "Enter Anthropic API key",
      normalize: normalizeApiKeyInput,
      validate: validateApiKeyInput,
      prompter: params.prompter,
      setCredential: async (apiKey, mode) =>
        setAnthropicApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
    });
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "anthropic:default",
      provider: "anthropic",
      mode: "api_key",
    });
    if (params.setDefaultModel) {
      nextConfig = applyAgentDefaultModelPrimary(nextConfig, DEFAULT_ANTHROPIC_MODEL);
    }
    return { config: nextConfig };
  }

  return null;
}
