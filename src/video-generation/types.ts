import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { FasedAgentConfig } from "../config/config.js";

export type GeneratedVideoAsset = {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  metadata?: Record<string, unknown>;
};

export type VideoGenerationResolution = "480P" | "720P" | "768P" | "1080P";

export type VideoGenerationSourceAsset = {
  url?: string;
  buffer?: Buffer;
  mimeType?: string;
  fileName?: string;
  metadata?: Record<string, unknown>;
};

export type VideoGenerationProviderConfiguredContext = {
  cfg?: FasedAgentConfig;
  agentDir?: string;
};

export type VideoGenerationRequest = {
  provider: string;
  model: string;
  prompt: string;
  cfg: FasedAgentConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  timeoutMs?: number;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  audio?: boolean;
  watermark?: boolean;
  inputImages?: VideoGenerationSourceAsset[];
  inputVideos?: VideoGenerationSourceAsset[];
};

export type VideoGenerationResult = {
  videos: GeneratedVideoAsset[];
  model?: string;
  metadata?: Record<string, unknown>;
};

export type VideoGenerationIgnoredOverrideKey =
  | "size"
  | "aspectRatio"
  | "resolution"
  | "audio"
  | "watermark";

export type VideoGenerationIgnoredOverride = {
  key: VideoGenerationIgnoredOverrideKey;
  value: string | boolean;
};

export type VideoGenerationMode = "generate" | "imageToVideo" | "videoToVideo";

export type VideoGenerationModeCapabilities = {
  maxVideos?: number;
  maxInputImages?: number;
  maxInputVideos?: number;
  maxDurationSeconds?: number;
  supportedDurationSeconds?: readonly number[];
  supportedDurationSecondsByModel?: Readonly<Record<string, readonly number[]>>;
  supportsSize?: boolean;
  supportsAspectRatio?: boolean;
  supportsResolution?: boolean;
  supportsAudio?: boolean;
  supportsWatermark?: boolean;
};

export type VideoGenerationTransformCapabilities = VideoGenerationModeCapabilities & {
  enabled: boolean;
};

export type VideoGenerationProviderCapabilities = VideoGenerationModeCapabilities & {
  generate?: VideoGenerationModeCapabilities;
  imageToVideo?: VideoGenerationTransformCapabilities;
  videoToVideo?: VideoGenerationTransformCapabilities;
};

export type VideoGenerationProvider = {
  id: string;
  aliases?: string[];
  label?: string;
  defaultModel?: string;
  models?: string[];
  capabilities: VideoGenerationProviderCapabilities;
  isConfigured?: (ctx: VideoGenerationProviderConfiguredContext) => boolean;
  generateVideo: (req: VideoGenerationRequest) => Promise<VideoGenerationResult>;
};
