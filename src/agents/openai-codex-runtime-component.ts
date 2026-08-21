import { installCapabilityComponent } from "../capabilities/install.js";
import type { FasedAgentConfig } from "../config/config.js";
import { resolveOpenAICodexExecutable } from "./openai-codex-app-server.js";

export const OPENAI_RUNTIME_COMPONENT_ID = "openai-runtime";

export function hasConfiguredOpenAICodexProfile(config: FasedAgentConfig): boolean {
  return Object.values(config.auth?.profiles ?? {}).some(
    (profile) => profile?.provider === "openai-codex",
  );
}

export async function ensureOpenAICodexRuntimeComponent(params: {
  config: FasedAgentConfig;
  resolveExecutable?: () => string | null;
  installComponent?: typeof installCapabilityComponent;
}): Promise<{
  config: FasedAgentConfig;
  executable: string;
  installed: boolean;
  slotWarnings: string[];
}> {
  const resolveExecutable = params.resolveExecutable ?? resolveOpenAICodexExecutable;
  const existing = resolveExecutable();
  if (existing) {
    return {
      config: params.config,
      executable: existing,
      installed: false,
      slotWarnings: [],
    };
  }

  const installed = await (params.installComponent ?? installCapabilityComponent)({
    id: OPENAI_RUNTIME_COMPONENT_ID,
    config: params.config,
  });
  const executable = resolveExecutable();
  if (!executable) {
    throw new Error(
      "The signed OpenAI runtime component did not provide its executable. Reinstall openai-runtime through `fased components install` and retry.",
    );
  }
  return {
    config: installed.config,
    executable,
    installed: true,
    slotWarnings: installed.slotWarnings,
  };
}
