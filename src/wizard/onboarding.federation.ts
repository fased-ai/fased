import type { FasedAgentConfig } from "../config/config.js";
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
  const currentBaseUrl = resolveFederationBaseUrl(env);
  const currentHandle = resolveFederationHandle({ env });
  const autoConnectRaw = String(env.FASED_FEDERATION_AUTO_CONNECT ?? "")
    .trim()
    .toLowerCase();
  const alreadyJoined = Boolean(
    currentBaseUrl || currentHandle || autoConnectRaw === "1" || autoConnectRaw === "true",
  );

  const enabled = await prompter.confirm({
    message: alreadyJoined
      ? "Keep Fased Network enabled?"
      : "Join Fased Network? (Enables cross-agent collaboration)",
    initialValue: true,
  });

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

  const defaultHandle = currentHandle;
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
