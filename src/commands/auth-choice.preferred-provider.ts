import type { FasedAgentConfig } from "../config/config.js";
import {
  resolveManifestDeprecatedProviderAuthChoice,
  resolveManifestProviderAuthChoice,
} from "../plugins/provider-auth-choices.js";
import type { AuthChoice } from "./onboard-types.js";

const PREFERRED_PROVIDER_BY_AUTH_CHOICE: Partial<Record<AuthChoice, string>> = {
  oauth: "anthropic",
  "anthropic-oauth": "anthropic",
  "setup-token": "anthropic",
  "claude-cli": "anthropic",
  token: "anthropic",
  apiKey: "anthropic",
  vllm: "vllm",
  "openai-codex": "openai-codex",
  "codex-cli": "openai-codex",
  chutes: "chutes",
  "openai-api-key": "openai",
  "openrouter-api-key": "openrouter",
  "ai-gateway-api-key": "vercel-ai-gateway",
  "cloudflare-ai-gateway-api-key": "cloudflare-ai-gateway",
  "moonshot-api-key": "moonshot",
  "moonshot-api-key-cn": "moonshot",
  "kimi-code-api-key": "kimi-coding",
  "gemini-api-key": "google",
  "google-gemini-cli": "google-gemini-cli",
  "mistral-api-key": "mistral",
  "zai-api-key": "zai",
  "zai-coding-global": "zai",
  "zai-coding-cn": "zai",
  "zai-global": "zai",
  "zai-cn": "zai",
  "xiaomi-api-key": "xiaomi",
  "synthetic-api-key": "synthetic",
  "venice-api-key": "venice",
  "together-api-key": "together",
  "huggingface-api-key": "huggingface",
  "github-copilot": "github-copilot",
  "copilot-proxy": "copilot-proxy",
  "minimax-cloud": "minimax",
  "minimax-api": "minimax",
  "minimax-api-key-cn": "minimax-cn",
  "minimax-api-lightning": "minimax",
  minimax: "minimax-portal",
  "opencode-zen": "opencode",
  "xai-oauth": "xai",
  "xai-device-code": "xai",
  "xai-api-key": "xai",
  "litellm-api-key": "litellm",
  "volcengine-api-key": "volcengine",
  "byteplus-api-key": "byteplus",
  "minimax-portal": "minimax-portal",
  "qianfan-api-key": "qianfan",
  "custom-api-key": "custom",
};

export function resolvePreferredProviderForAuthChoice(
  choice: AuthChoice,
  params?: {
    config?: FasedAgentConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  },
): string | undefined {
  const preferred = PREFERRED_PROVIDER_BY_AUTH_CHOICE[choice];
  if (preferred) {
    return preferred;
  }

  const manifestChoice =
    resolveManifestProviderAuthChoice(choice, {
      config: params?.config,
      workspaceDir: params?.workspaceDir,
      env: params?.env,
      includeUntrustedWorkspacePlugins: false,
    }) ??
    resolveManifestDeprecatedProviderAuthChoice(choice, {
      config: params?.config,
      workspaceDir: params?.workspaceDir,
      env: params?.env,
      includeUntrustedWorkspacePlugins: false,
    });

  return manifestChoice?.providerId;
}
