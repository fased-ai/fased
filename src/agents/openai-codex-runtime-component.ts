import { installCapabilityComponent } from "../capabilities/install.js";
import type { FasedAgentConfig } from "../config/config.js";
import { VERSION } from "../version.js";
import { resolveOpenAICodexExecutable } from "./openai-codex-app-server.js";

export const OPENAI_RUNTIME_COMPONENT_ID = "openai-runtime";

export function hasConfiguredOpenAICodexProfile(config: FasedAgentConfig): boolean {
  return Object.values(config.auth?.profiles ?? {}).some(
    (profile) => profile?.provider === "openai-codex",
  );
}

export async function ensureOpenAICodexRuntimeComponent(params: {
  config: FasedAgentConfig;
  version?: string;
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
    packageSpec: `@fased/openai-runtime@${params.version ?? VERSION}`,
  });
  const executable = resolveExecutable();
  if (!executable) {
    throw new Error(
      "OpenAI sign-in runtime installation completed without an executable. Run `fased components install openai-runtime` and retry.",
    );
  }
  return {
    config: installed.config,
    executable,
    installed: true,
    slotWarnings: installed.slotWarnings,
  };
}
