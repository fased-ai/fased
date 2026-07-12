import { ensureAuthProfileStore, listProfilesForProvider } from "../agents/auth-profiles.js";
import { getCustomProviderApiKey, resolveEnvApiKey } from "../agents/model-auth.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import type { FasedAgentConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export async function warnIfModelConfigLooksOff(
  config: FasedAgentConfig,
  prompter: WizardPrompter,
  options?: { agentId?: string; agentDir?: string },
) {
  const ref = resolveDefaultModelForAgent({
    cfg: config,
    agentId: options?.agentId,
  });
  const warnings: string[] = [];
  const catalog = await loadModelCatalog({
    config,
    useCache: false,
  });
  if (catalog.length > 0) {
    const known = catalog.some(
      (entry) => entry.provider === ref.provider && entry.id === ref.model,
    );
    if (!known) {
      warnings.push(
        `Model not found: ${ref.provider}/${ref.model}. Update agents.defaults.model or run /models list.`,
      );
    }
  }

  const store = ensureAuthProfileStore(options?.agentDir);
  const hasProfile = listProfilesForProvider(store, ref.provider).length > 0;
  const envKey = resolveEnvApiKey(ref.provider);
  const customKey = getCustomProviderApiKey(config, ref.provider);
  if (!hasProfile && !envKey && !customKey) {
    warnings.push(
      `No auth configured for provider "${ref.provider}". The agent may fail until credentials are added.`,
    );
  }

  if (ref.provider === "openai") {
    const hasCodex = listProfilesForProvider(store, "openai-codex").length > 0;
    if (hasCodex) {
      warnings.push(
        "Detected OpenAI sign-in. Choose a model returned by `fased models list --all --provider openai-codex`.",
      );
    }
  }

  if (warnings.length > 0) {
    await prompter.note(warnings.join("\n"), "Model check");
  }
}
