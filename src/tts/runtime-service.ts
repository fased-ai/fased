import type { FasedAgentConfig } from "../config/config.js";
import type { TtsAutoMode } from "../config/types.tts.js";
import {
  requirePluginRuntimeProvider,
  resolvePluginRuntimeProvider,
} from "../plugins/runtime-provider-runtime.js";
import type { SpeechRuntimeProvider } from "../plugins/runtime-provider-types.js";

export type ResolvedTtsConfig = import("./tts.js").ResolvedTtsConfig;
export type TtsResult = import("./tts.js").TtsResult;

const autoModes = new Set<TtsAutoMode>(["off", "always", "inbound", "tagged"]);

export function normalizeTtsAutoMode(value: unknown): TtsAutoMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return autoModes.has(normalized as TtsAutoMode) ? (normalized as TtsAutoMode) : undefined;
}

function disabledTtsConfig(cfg: FasedAgentConfig): ResolvedTtsConfig {
  const raw = cfg.messages?.tts;
  return {
    auto: "off",
    mode: raw?.mode ?? "final",
    provider: raw?.provider ?? "edge",
    providerSource: raw?.provider ? "config" : "default",
    summaryModel: raw?.summaryModel?.trim() || undefined,
    modelOverrides: {
      enabled: false,
      allowText: false,
      allowProvider: false,
      allowVoice: false,
      allowModelId: false,
      allowVoiceSettings: false,
      allowNormalization: false,
      allowSeed: false,
    },
    elevenlabs: {
      apiKey: raw?.elevenlabs?.apiKey,
      baseUrl: raw?.elevenlabs?.baseUrl?.trim() || "",
      voiceId: raw?.elevenlabs?.voiceId ?? "",
      modelId: raw?.elevenlabs?.modelId ?? "",
      seed: raw?.elevenlabs?.seed,
      applyTextNormalization: raw?.elevenlabs?.applyTextNormalization,
      languageCode: raw?.elevenlabs?.languageCode,
      voiceSettings: {
        stability: raw?.elevenlabs?.voiceSettings?.stability ?? 0,
        similarityBoost: raw?.elevenlabs?.voiceSettings?.similarityBoost ?? 0,
        style: raw?.elevenlabs?.voiceSettings?.style ?? 0,
        useSpeakerBoost: raw?.elevenlabs?.voiceSettings?.useSpeakerBoost ?? false,
        speed: raw?.elevenlabs?.voiceSettings?.speed ?? 1,
      },
    },
    openai: {
      apiKey: raw?.openai?.apiKey,
      model: raw?.openai?.model ?? "",
      voice: raw?.openai?.voice ?? "",
    },
    edge: {
      enabled: false,
      voice: raw?.edge?.voice?.trim() || "",
      lang: raw?.edge?.lang?.trim() || "",
      outputFormat: raw?.edge?.outputFormat?.trim() || "",
      outputFormatConfigured: Boolean(raw?.edge?.outputFormat?.trim()),
      pitch: raw?.edge?.pitch?.trim() || undefined,
      rate: raw?.edge?.rate?.trim() || undefined,
      volume: raw?.edge?.volume?.trim() || undefined,
      saveSubtitles: raw?.edge?.saveSubtitles ?? false,
      proxy: raw?.edge?.proxy?.trim() || undefined,
      timeoutMs: raw?.edge?.timeoutMs,
    },
    prefsPath: raw?.prefsPath,
    maxTextLength: raw?.maxTextLength ?? 1500,
    timeoutMs: raw?.timeoutMs ?? 30_000,
  };
}

export function resolveTtsConfig(cfg: FasedAgentConfig): ResolvedTtsConfig {
  return resolvePluginRuntimeProvider("speech")?.resolveTtsConfig(cfg) ?? disabledTtsConfig(cfg);
}

export function resolveTtsPrefsPath(config: ResolvedTtsConfig): string {
  return resolvePluginRuntimeProvider("speech")?.resolveTtsPrefsPath(config) ?? "";
}

export function resolveTtsAutoMode(
  params: Parameters<SpeechRuntimeProvider["resolveTtsAutoMode"]>[0],
): TtsAutoMode {
  return resolvePluginRuntimeProvider("speech")?.resolveTtsAutoMode(params) ?? "off";
}

export function buildTtsSystemPromptHint(cfg: FasedAgentConfig): string | undefined {
  const provider = resolvePluginRuntimeProvider("speech");
  if (provider) {
    return provider.buildTtsSystemPromptHint(cfg);
  }
  if ((normalizeTtsAutoMode(cfg.messages?.tts?.auto) ?? "off") !== "off") {
    requirePluginRuntimeProvider("speech");
  }
  return undefined;
}

export async function maybeApplyTtsToPayload(
  params: Parameters<SpeechRuntimeProvider["maybeApplyTtsToPayload"]>[0],
): ReturnType<SpeechRuntimeProvider["maybeApplyTtsToPayload"]> {
  const provider = resolvePluginRuntimeProvider("speech");
  if (provider) {
    return provider.maybeApplyTtsToPayload(params);
  }
  if ((normalizeTtsAutoMode(params.cfg.messages?.tts?.auto) ?? "off") !== "off") {
    requirePluginRuntimeProvider("speech");
  }
  return params.payload;
}

const speech = () => requirePluginRuntimeProvider("speech");

export const getLastTtsAttempt = (
  ...args: Parameters<SpeechRuntimeProvider["getLastTtsAttempt"]>
) => speech().getLastTtsAttempt(...args);
export const getTtsMaxLength = (...args: Parameters<SpeechRuntimeProvider["getTtsMaxLength"]>) =>
  speech().getTtsMaxLength(...args);
export const getTtsProvider = (...args: Parameters<SpeechRuntimeProvider["getTtsProvider"]>) =>
  speech().getTtsProvider(...args);
export const isSummarizationEnabled = (
  ...args: Parameters<SpeechRuntimeProvider["isSummarizationEnabled"]>
) => speech().isSummarizationEnabled(...args);
export const isTtsEnabled = (...args: Parameters<SpeechRuntimeProvider["isTtsEnabled"]>) =>
  speech().isTtsEnabled(...args);
export const isTtsProviderConfigured = (
  ...args: Parameters<SpeechRuntimeProvider["isTtsProviderConfigured"]>
) => speech().isTtsProviderConfigured(...args);
export const resolveTtsApiKey = (...args: Parameters<SpeechRuntimeProvider["resolveTtsApiKey"]>) =>
  speech().resolveTtsApiKey(...args);
export const setLastTtsAttempt = (
  ...args: Parameters<SpeechRuntimeProvider["setLastTtsAttempt"]>
) => speech().setLastTtsAttempt(...args);
export const setSummarizationEnabled = (
  ...args: Parameters<SpeechRuntimeProvider["setSummarizationEnabled"]>
) => speech().setSummarizationEnabled(...args);
export const setTtsEnabled = (...args: Parameters<SpeechRuntimeProvider["setTtsEnabled"]>) =>
  speech().setTtsEnabled(...args);
export const setTtsMaxLength = (...args: Parameters<SpeechRuntimeProvider["setTtsMaxLength"]>) =>
  speech().setTtsMaxLength(...args);
export const setTtsProvider = (...args: Parameters<SpeechRuntimeProvider["setTtsProvider"]>) =>
  speech().setTtsProvider(...args);
export const textToSpeech = (...args: Parameters<SpeechRuntimeProvider["textToSpeech"]>) =>
  speech().textToSpeech(...args);
export const textToSpeechTelephony = (
  ...args: Parameters<SpeechRuntimeProvider["textToSpeechTelephony"]>
) => speech().textToSpeechTelephony(...args);
