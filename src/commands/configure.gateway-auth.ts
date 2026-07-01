import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import type { FasedAgentConfig, GatewayAuthConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { promptAuthChoiceGrouped } from "./auth-choice-prompt.js";
import { applyAuthChoice, resolvePreferredProviderForAuthChoice } from "./auth-choice.js";
import {
  applyModelAllowlist,
  applyModelFallbacksFromSelection,
  promptModelAllowlist,
} from "./model-picker.js";
import { promptCustomApiConfig } from "./onboard-custom.js";
import { randomToken } from "./onboard-helpers.js";

type GatewayAuthChoice = "token" | "password" | "trusted-proxy";

/** Reject undefined, empty, and common JS string-coercion artifacts for token auth. */
function sanitizeTokenValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") {
    return undefined;
  }
  return trimmed;
}

const ANTHROPIC_OAUTH_MODEL_KEYS = [
  "anthropic/claude-fable-5",
  "anthropic/claude-opus-4-8",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku-4-5",
];

export function buildGatewayAuthConfig(params: {
  existing?: GatewayAuthConfig;
  mode: GatewayAuthChoice;
  token?: string;
  password?: string;
  trustedProxy?: {
    userHeader: string;
    requiredHeaders?: string[];
    allowUsers?: string[];
  };
}): GatewayAuthConfig | undefined {
  const allowTailscale = params.existing?.allowTailscale;
  const base: GatewayAuthConfig = {};
  if (typeof allowTailscale === "boolean") {
    base.allowTailscale = allowTailscale;
  }

  if (params.mode === "token") {
    // Keep token mode always valid: treat empty/undefined/"undefined"/"null" as missing and generate a token.
    const token = sanitizeTokenValue(params.token) ?? randomToken();
    return { ...base, mode: "token", token };
  }
  if (params.mode === "password") {
    const password = params.password?.trim();
    return { ...base, mode: "password", ...(password && { password }) };
  }
  if (params.mode === "trusted-proxy") {
    if (!params.trustedProxy) {
      throw new Error("trustedProxy config is required when mode is trusted-proxy");
    }
    return { ...base, mode: "trusted-proxy", trustedProxy: params.trustedProxy };
  }
  return base;
}

export async function promptAuthConfig(
  cfg: FasedAgentConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<FasedAgentConfig> {
  const authChoice = await promptAuthChoiceGrouped({
    prompter,
    store: ensureAuthProfileStore(undefined, {
      allowKeychainPrompt: false,
    }),
    includeSkip: true,
  });

  let next = cfg;
  if (authChoice === "custom-api-key") {
    const customResult = await promptCustomApiConfig({ prompter, runtime, config: next });
    next = customResult.config;
  } else if (authChoice === "skip") {
    return next;
  } else {
    const applied = await applyAuthChoice({
      authChoice,
      config: next,
      prompter,
      runtime,
      setDefaultModel: true,
    });
    next = applied.config;
  }

  const anthropicOAuth =
    authChoice === "anthropic-oauth" ||
    authChoice === "setup-token" ||
    authChoice === "token" ||
    authChoice === "oauth";
  const preferredProvider =
    authChoice !== "custom-api-key"
      ? resolvePreferredProviderForAuthChoice(authChoice, { config: next })
      : undefined;

  if (authChoice !== "custom-api-key" && authChoice !== "skip") {
    const allowlistSelection = await promptModelAllowlist({
      config: next,
      prompter,
      allowedKeys: anthropicOAuth ? ANTHROPIC_OAUTH_MODEL_KEYS : undefined,
      initialSelections: anthropicOAuth ? ["anthropic/claude-sonnet-5"] : undefined,
      message: anthropicOAuth ? "Anthropic OAuth models" : undefined,
      preferredProvider,
    });
    if (allowlistSelection.models) {
      next = applyModelAllowlist(next, allowlistSelection.models);
      next = applyModelFallbacksFromSelection(next, allowlistSelection.models);
    }
  }

  return next;
}
