import { resolveFasedAgentAgentDir } from "../agents/agent-paths.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import type { FasedAgentConfig, GatewayAuthConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { promptAuthChoiceGrouped } from "./auth-choice-prompt.js";
import { applyAuthChoice, resolvePreferredProviderForAuthChoice } from "./auth-choice.js";
import {
  applyModelAllowlist,
  applyModelFallbacksFromSelection,
  applyPrimaryModel,
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
  const agentDir = resolveFasedAgentAgentDir();
  const authChoice = await promptAuthChoiceGrouped({
    prompter,
    store: ensureAuthProfileStore(agentDir, {
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
      setDefaultModel: false,
      agentDir,
    });
    next = applied.config;
  }

  const preferredProvider =
    authChoice !== "custom-api-key"
      ? resolvePreferredProviderForAuthChoice(authChoice, { config: next })
      : undefined;

  if (authChoice !== "custom-api-key" && authChoice !== "skip") {
    const allowlistSelection = await promptModelAllowlist({
      config: next,
      prompter,
      preferredProvider,
      agentDir,
    });
    if (allowlistSelection.models) {
      const selectedModels = allowlistSelection.models;
      if (selectedModels[0]) {
        next = applyPrimaryModel(next, selectedModels[0]);
      }
      next = applyModelAllowlist(next, selectedModels);
      next = applyModelFallbacksFromSelection(next, selectedModels);
    }
  }

  return next;
}
