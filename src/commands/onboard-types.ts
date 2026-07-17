import type { ChannelId } from "../channels/plugins/types.js";
import type {
  WalletRuntimeKind,
  WalletRuntimeMode,
  WalletProviderId,
  WalletToolAccessMode,
} from "../config/types.wallet.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

export type OnboardMode = "local" | "remote";
export type SecretInputMode = "plaintext" | "ref";
export type KnownAuthChoice =
  // Legacy short alias for Anthropic OAuth (kept for backwards CLI compatibility).
  | "oauth"
  | "anthropic-oauth"
  | "setup-token"
  | "claude-cli"
  | "token"
  | "chutes"
  | "chutes-api-key"
  | "vllm"
  | "openai-codex"
  | "openai-api-key"
  | "openrouter-api-key"
  | "litellm-api-key"
  | "ai-gateway-api-key"
  | "cloudflare-ai-gateway-api-key"
  | "moonshot-api-key"
  | "moonshot-api-key-cn"
  | "kimi-code-api-key"
  | "synthetic-api-key"
  | "venice-api-key"
  | "together-api-key"
  | "huggingface-api-key"
  | "codex-cli"
  | "apiKey"
  | "gemini-api-key"
  | "google-gemini-cli"
  | "zai-api-key"
  | "zai-coding-global"
  | "zai-coding-cn"
  | "zai-global"
  | "zai-cn"
  | "xiaomi-api-key"
  | "minimax-cloud"
  | "minimax"
  | "minimax-api"
  | "minimax-api-key-cn"
  | "minimax-api-lightning"
  | "minimax-portal"
  | "opencode-zen"
  | "github-copilot"
  | "copilot-proxy"
  | "qwen-api-key"
  | "qwen-coding-plan-api-key"
  | "xai-oauth"
  | "xai-device-code"
  | "xai-api-key"
  | "qianfan-api-key"
  | "custom-api-key"
  | "skip";
export type AuthChoice = KnownAuthChoice | (string & {});
export type KnownAuthChoiceGroupId =
  | "openai"
  | "anthropic"
  | "chutes"
  | "vllm"
  | "google"
  | "copilot"
  | "openrouter"
  | "litellm"
  | "ai-gateway"
  | "cloudflare-ai-gateway"
  | "moonshot"
  | "zai"
  | "xiaomi"
  | "opencode-zen"
  | "minimax"
  | "synthetic"
  | "venice"
  | "qwen"
  | "together"
  | "huggingface"
  | "qianfan"
  | "xai"
  | "custom";
export type AuthChoiceGroupId = KnownAuthChoiceGroupId | (string & {});
export type GatewayAuthChoice = "token" | "password";
export type ResetScope = "config" | "config+creds+sessions" | "full";
export type OnboardRepairScope = "sessions" | "auth" | "auth+sessions";
export type GatewayBind = "loopback" | "lan" | "auto" | "custom" | "tailnet";
export type TailscaleMode = "off" | "serve" | "funnel";
export type NodeManagerChoice = "npm" | "pnpm" | "bun";
export type ChannelChoice = ChannelId;
// Legacy alias (pre-rename).
export type ProviderChoice = ChannelChoice;

export type OnboardOptions = {
  hostProfile?: "local" | "hosting";
  /** Internal flag set by root-started installer sessions that already provisioned host-maintenance capability. */
  hostSecurityCapable?: boolean;
  /** Internal flag for post-bootstrap hosted reruns from the app user over Tailscale. */
  hostMaintenanceSession?: boolean;
  /** Internal flag for root-only host security preflight/prep flows. */
  hostSecurityOnly?: boolean;
  allowInsecure?: boolean;
  swapGb?: number;
  mode?: OnboardMode;
  /** "manual" is an alias for "advanced". */
  flow?: "quickstart" | "advanced" | "manual";
  workspace?: string;
  nonInteractive?: boolean;
  /** Required for non-interactive onboarding; skips the interactive risk prompt when true. */
  acceptRisk?: boolean;
  reset?: boolean;
  resetScope?: OnboardRepairScope;
  authChoice?: AuthChoice;
  /** Used when `authChoice=token` in non-interactive mode. */
  tokenProvider?: string;
  /** Used when `authChoice=token` in non-interactive mode. */
  token?: string;
  /** Used when `authChoice=token` in non-interactive mode. */
  tokenProfileId?: string;
  /** Used when `authChoice=token` in non-interactive mode. */
  tokenExpiresIn?: string;
  /** Store prompted credentials as plaintext config value or SecretRef. */
  secretInputMode?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openrouterApiKey?: string;
  mistralApiKey?: string;
  litellmApiKey?: string;
  aiGatewayApiKey?: string;
  cloudflareAiGatewayAccountId?: string;
  cloudflareAiGatewayGatewayId?: string;
  cloudflareAiGatewayApiKey?: string;
  moonshotApiKey?: string;
  kimiCodeApiKey?: string;
  geminiApiKey?: string;
  zaiApiKey?: string;
  xiaomiApiKey?: string;
  minimaxApiKey?: string;
  syntheticApiKey?: string;
  veniceApiKey?: string;
  togetherApiKey?: string;
  huggingfaceApiKey?: string;
  byteplusApiKey?: string;
  volcengineApiKey?: string;
  opencodeZenApiKey?: string;
  xaiApiKey?: string;
  qianfanApiKey?: string;
  qwenApiKey?: string;
  qwenCodingPlanApiKey?: string;
  customBaseUrl?: string;
  customApiKey?: string;
  customModelId?: string;
  customProviderId?: string;
  customCompatibility?: "openai" | "anthropic";
  allowPrivateNetwork?: boolean;
  gatewayPort?: number;
  gatewayBind?: GatewayBind;
  gatewayAuth?: GatewayAuthChoice;
  gatewayToken?: string;
  gatewayPassword?: string;
  tailscale?: TailscaleMode;
  tailscaleResetOnExit?: boolean;
  installDaemon?: boolean;
  daemonRuntime?: GatewayDaemonRuntime;
  skipChannels?: boolean;
  /** @deprecated Legacy alias for `skipChannels`. */
  skipProviders?: boolean;
  skipSkills?: boolean;
  skipHealth?: boolean;
  /** Use a short-circuit health check path when gateway is already healthy. */
  fastHealth?: boolean;
  skipUi?: boolean;
  nodeManager?: NodeManagerChoice;
  remoteUrl?: string;
  remoteToken?: string;
  walletEnabled?: boolean;
  walletMode?: WalletRuntimeMode;
  walletRuntime?: WalletRuntimeKind;
  walletProviders?: string;
  walletDefaultProvider?: WalletProviderId;
  walletChains?: string;
  walletHost?: string;
  walletPort?: number;
  walletInstallEnabled?: boolean;
  walletInstallVersion?: string;
  walletDirectSigning?: boolean;
  walletSolanaAllowPrograms?: string;
  walletSolanaMaxPerTx?: string;
  walletSolanaMaxDaily?: string;
  walletToolAccessMode?: WalletToolAccessMode;
  walletToolAccessAllowAgents?: string;
  json?: boolean;
  [key: string]: unknown;
};
