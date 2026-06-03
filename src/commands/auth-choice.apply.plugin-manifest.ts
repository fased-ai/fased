import {
  resolveManifestDeprecatedProviderAuthChoice,
  resolveManifestProviderAuthChoice,
} from "../plugins/provider-auth-choices.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyAuthChoicePluginProvider } from "./auth-choice.apply.plugin-provider.js";

export async function applyAuthChoiceManifestPluginProvider(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  const resolvedChoice =
    resolveManifestProviderAuthChoice(params.authChoice, {
      config: params.config,
      includeUntrustedWorkspacePlugins: false,
    }) ??
    resolveManifestDeprecatedProviderAuthChoice(params.authChoice, {
      config: params.config,
      includeUntrustedWorkspacePlugins: false,
    });

  if (!resolvedChoice) {
    return null;
  }

  return await applyAuthChoicePluginProvider(
    {
      ...params,
      authChoice: resolvedChoice.choiceId,
    },
    {
      authChoice: resolvedChoice.choiceId,
      pluginId: resolvedChoice.pluginId,
      providerId: resolvedChoice.providerId,
      methodId: resolvedChoice.methodId,
      label: resolvedChoice.groupLabel ?? resolvedChoice.choiceLabel,
    },
  );
}
