import type { FasedAgentConfig } from "../config/config.js";
import { loadPersistedFederationToken } from "../federation/access-token.js";
import {
  DEFAULT_FEDERATION_BASE_URL,
  resolveFederationBaseUrl,
  resolveFederationHandle,
} from "../federation/runtime.js";
import type { FederationWizardSettings, HostSetupProfile } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";

export async function configureFederationForOnboarding(params: {
  flow: "quickstart" | "advanced";
  hostProfile?: HostSetupProfile;
  baseConfig: FasedAgentConfig;
  prompter: WizardPrompter;
}): Promise<FederationWizardSettings> {
  const { baseConfig } = params;

  const env = { ...process.env, ...baseConfig.env?.vars };
  const explicitHandle = env.FASED_A2A_HANDLE?.trim() || env.FASED_FEDERATION_HANDLE?.trim() || "";
  const currentBaseUrl = resolveFederationBaseUrl(env);
  const currentHandle = explicitHandle ? resolveFederationHandle({ env }) : "";
  const autoConnectRaw = String(env.FASED_FEDERATION_AUTO_CONNECT ?? "")
    .trim()
    .toLowerCase();
  const persistedToken = await loadPersistedFederationToken(env).catch(() => null);

  if (autoConnectRaw === "0" || autoConnectRaw === "false" || autoConnectRaw === "off") {
    return { enabled: false };
  }

  const defaultBaseUrl = currentBaseUrl || DEFAULT_FEDERATION_BASE_URL;
  const defaultHandle = currentHandle || persistedToken?.handle || "";

  return {
    enabled: true,
    handle: defaultHandle || undefined,
    baseUrl: defaultBaseUrl || undefined,
  };
}
