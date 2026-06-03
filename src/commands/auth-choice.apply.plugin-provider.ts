import { resolveFasedAgentAgentDir } from "../agents/agent-paths.js";
import {
  resolveDefaultAgentId,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { pickAuthMethod, resolveProviderMatch } from "../plugins/provider-auth-choice-helpers.js";
import {
  applyPluginProviderAuthRunResult,
  createPluginProviderAuthContext,
  runInteractivePluginProviderOAuthDeviceAuth,
} from "../plugins/provider-auth-runtime.js";
import { resolvePluginProviders } from "../plugins/providers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";

export type PluginProviderAuthChoiceOptions = {
  authChoice: string;
  pluginId: string;
  providerId: string;
  methodId?: string;
  label: string;
};

export async function applyAuthChoicePluginProvider(
  params: ApplyAuthChoiceParams,
  options: PluginProviderAuthChoiceOptions,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== options.authChoice) {
    return null;
  }

  const enableResult = enablePluginInConfig(params.config, options.pluginId);
  let nextConfig = enableResult.config;
  if (!enableResult.enabled) {
    await params.prompter.note(
      `${options.label} plugin is disabled (${enableResult.reason ?? "blocked"}).`,
      options.label,
    );
    return { config: nextConfig };
  }

  const agentId = params.agentId ?? resolveDefaultAgentId(nextConfig);
  const defaultAgentId = resolveDefaultAgentId(nextConfig);
  const agentDir =
    params.agentDir ??
    (agentId === defaultAgentId
      ? resolveFasedAgentAgentDir()
      : resolveAgentDir(nextConfig, agentId));
  const workspaceDir =
    resolveAgentWorkspaceDir(nextConfig, agentId) ?? resolveDefaultAgentWorkspaceDir();

  const providers = resolvePluginProviders({ config: nextConfig, workspaceDir });
  const provider = resolveProviderMatch(providers, options.providerId);
  if (!provider) {
    await params.prompter.note(
      `${options.label} auth plugin is not available. Enable it and re-run the wizard.`,
      options.label,
    );
    return { config: nextConfig };
  }

  const method = pickAuthMethod(provider, options.methodId) ?? provider.auth[0];
  if (!method) {
    await params.prompter.note(`${options.label} auth method missing.`, options.label);
    return { config: nextConfig };
  }

  const interactiveResult = await runInteractivePluginProviderOAuthDeviceAuth({
    config: nextConfig,
    method,
    agentDir,
    workspaceDir,
    prompter: params.prompter,
    runtime: params.runtime,
    setDefaultModel: params.setDefaultModel,
    oauthBrowserMode: params.oauthBrowserMode,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.openUrl ? { openUrl: params.openUrl } : {}),
  });
  if (interactiveResult) {
    return interactiveResult;
  }

  const result = await method.run(
    createPluginProviderAuthContext({
      config: nextConfig,
      agentDir,
      workspaceDir,
      prompter: params.prompter,
      runtime: params.runtime,
      oauthBrowserMode: params.oauthBrowserMode,
      ...(params.openUrl ? { openUrl: params.openUrl } : {}),
    }),
  );

  return await applyPluginProviderAuthRunResult({
    config: nextConfig,
    result,
    agentDir,
    prompter: params.prompter,
    setDefaultModel: params.setDefaultModel,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
}
