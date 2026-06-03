import { upsertAuthProfile } from "../agents/auth-profiles.js";
import { isRemoteEnvironment } from "../commands/oauth-env.js";
import { createVpsAwareOAuthHandlers } from "../commands/oauth-flow.js";
import { openUrl } from "../commands/onboard-helpers.js";
import type { FasedAgentConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyDefaultModel, mergeConfigPatch } from "./provider-auth-choice-helpers.js";
import { applyAuthProfileConfig } from "./provider-auth-storage.js";
import type { ProviderAuthContext, ProviderAuthMethod, ProviderAuthResult } from "./types.js";

export type AppliedPluginProviderAuthResult = {
  config: FasedAgentConfig;
  agentModelOverride?: string;
};

export function createPluginProviderAuthContext(params: {
  config: FasedAgentConfig;
  agentDir?: string;
  workspaceDir?: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  openUrl?: (url: string) => Promise<void>;
  oauthBrowserMode?: "environment" | "local";
}): ProviderAuthContext {
  const isRemote = params.oauthBrowserMode === "local" ? false : isRemoteEnvironment();
  return {
    config: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    prompter: params.prompter,
    runtime: params.runtime,
    isRemote,
    openUrl: async (url) => {
      await (params.openUrl ?? openUrl)(url);
    },
    oauth: {
      createVpsAwareHandlers: (opts) => createVpsAwareOAuthHandlers(opts),
    },
  };
}

export async function applyPluginProviderAuthRunResult(params: {
  config: FasedAgentConfig;
  result: ProviderAuthResult;
  agentDir?: string;
  prompter: WizardPrompter;
  setDefaultModel: boolean;
  agentId?: string;
}): Promise<AppliedPluginProviderAuthResult> {
  let nextConfig = params.config;

  if (params.result.configPatch) {
    nextConfig = mergeConfigPatch(nextConfig, params.result.configPatch);
  }

  for (const profile of params.result.profiles) {
    upsertAuthProfile({
      profileId: profile.profileId,
      credential: profile.credential,
      agentDir: params.agentDir,
    });

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: profile.profileId,
      provider: profile.credential.provider,
      mode: profile.credential.type === "token" ? "token" : profile.credential.type,
      ...("email" in profile.credential && profile.credential.email
        ? { email: profile.credential.email }
        : {}),
    });
  }

  let agentModelOverride: string | undefined;
  if (params.result.defaultModel) {
    if (params.setDefaultModel) {
      nextConfig = applyDefaultModel(nextConfig, params.result.defaultModel);
      await params.prompter.note(
        `Default model set to ${params.result.defaultModel}`,
        "Model configured",
      );
    } else if (params.agentId) {
      agentModelOverride = params.result.defaultModel;
      await params.prompter.note(
        `Default model set to ${params.result.defaultModel} for agent "${params.agentId}".`,
        "Model configured",
      );
    }
  }

  if (params.result.notes && params.result.notes.length > 0) {
    await params.prompter.note(params.result.notes.join("\n"), "Provider notes");
  }

  return { config: nextConfig, agentModelOverride };
}

export async function runInteractivePluginProviderOAuthDeviceAuth(params: {
  config: FasedAgentConfig;
  method: ProviderAuthMethod;
  agentDir?: string;
  workspaceDir?: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  openUrl?: (url: string) => Promise<void>;
  oauthBrowserMode?: "environment" | "local";
  setDefaultModel: boolean;
  agentId?: string;
}): Promise<AppliedPluginProviderAuthResult | null> {
  if (params.method.kind !== "oauth" && params.method.kind !== "device_code") {
    return null;
  }

  const result = await params.method.run(
    createPluginProviderAuthContext({
      config: params.config,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      prompter: params.prompter,
      runtime: params.runtime,
      oauthBrowserMode: params.oauthBrowserMode,
      ...(params.openUrl ? { openUrl: params.openUrl } : {}),
    }),
  );

  return await applyPluginProviderAuthRunResult({
    config: params.config,
    result,
    agentDir: params.agentDir,
    prompter: params.prompter,
    setDefaultModel: params.setDefaultModel,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
}
