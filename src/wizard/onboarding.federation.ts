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
  const { baseConfig, prompter } = params;

  const env = { ...process.env, ...baseConfig.env?.vars };
  const explicitBaseUrl =
    env.FASED_FEDERATION_BASE_URL?.trim() || env.FASED_FEDERATION_URL?.trim() || "";
  const explicitHandle = env.FASED_A2A_HANDLE?.trim() || env.FASED_FEDERATION_HANDLE?.trim() || "";
  const currentBaseUrl = resolveFederationBaseUrl(env);
  const currentHandle = explicitHandle ? resolveFederationHandle({ env }) : "";
  const autoConnectRaw = String(env.FASED_FEDERATION_AUTO_CONNECT ?? "")
    .trim()
    .toLowerCase();
  const autoConnectConfigured = autoConnectRaw === "1" || autoConnectRaw === "true";
  const persistedToken = await loadPersistedFederationToken(env).catch(() => null);
  const alreadyJoined = Boolean(persistedToken?.tokenId);
  const alreadyConfigured = Boolean(explicitBaseUrl || explicitHandle || autoConnectConfigured);

  const promptMessage = alreadyJoined
    ? "Keep Fased Network joined?"
    : alreadyConfigured
      ? "Keep Fased Network auto-connect enabled? (not joined yet)"
      : "Enable Fased Network auto-connect? (registers after the Gateway starts)";
  const enabled = await prompter.confirm({
    message: promptMessage,
    initialValue: true,
  });

  if (!alreadyJoined && enabled) {
    await prompter.note(
      [
        "Fased Network auto-connect is enabled.",
        "Joining is complete only after a network token is issued and shown as joined/trusted in readiness.",
      ].join("\n"),
      "Fased Network",
    );
  }

  if (!enabled) {
    return { enabled: false };
  }

  const defaultBaseUrl = currentBaseUrl || DEFAULT_FEDERATION_BASE_URL;
  const baseUrl =
    params.flow === "quickstart"
      ? defaultBaseUrl
      : await prompter.text({
          message: "Fased Network Server",
          initialValue: defaultBaseUrl,
          placeholder: "Fased Network (ff1.fased.app)",
        });

  const defaultHandle = currentHandle || persistedToken?.handle || "";
  const handle =
    params.flow === "quickstart"
      ? defaultHandle
      : await prompter.text({
          message: "Desired Handle",
          initialValue: defaultHandle,
          placeholder: "@your-agent@domain",
        });

  return {
    enabled: true,
    handle: handle || undefined,
    baseUrl: baseUrl || undefined,
  };
}
