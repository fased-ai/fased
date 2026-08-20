import type { FasedAgentConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isBrowserServiceConfigured(cfg: FasedAgentConfig): boolean {
  const browser = cfg.browser;
  if (!browser || browser.enabled === false) {
    return false;
  }
  return (
    browser.enabled === true ||
    Boolean(browser.cdpUrl?.trim()) ||
    Boolean(browser.executablePath?.trim()) ||
    Object.keys(browser.profiles ?? {}).length > 0
  );
}

export function isGmailWatcherConfigured(cfg: FasedAgentConfig): boolean {
  return cfg.hooks?.enabled === true && Boolean(cfg.hooks.gmail?.account?.trim());
}

export function areInternalHooksConfigured(cfg: FasedAgentConfig): boolean {
  return cfg.hooks?.internal?.enabled === true;
}

export function areChannelsConfigured(cfg: FasedAgentConfig): boolean {
  const channels = cfg.channels;
  if (!channels) {
    return false;
  }
  return Object.entries(channels).some(([id, value]) => {
    if (id === "defaults" || id === "modelByChannel" || !isRecord(value)) {
      return false;
    }
    if (value.enabled === false) {
      return false;
    }
    return value.enabled === true || Object.keys(value).some((key) => key !== "enabled");
  });
}

export function isSelectedModelConfigured(cfg: FasedAgentConfig): boolean {
  const model = cfg.agents?.defaults?.model;
  if (typeof model === "string") {
    return Boolean(model.trim());
  }
  return Boolean(model?.primary?.trim());
}

export function isOptionalMemoryBackendConfigured(cfg: FasedAgentConfig): boolean {
  return cfg.memory?.backend === "qmd";
}

export function isCanvasHostConfigured(cfg: FasedAgentConfig): boolean {
  return cfg.canvasHost?.enabled === true;
}

export function isGatewayDiscoveryConfigured(cfg: FasedAgentConfig): boolean {
  return (
    cfg.discovery?.wideArea?.enabled === true ||
    cfg.discovery?.mdns?.mode === "minimal" ||
    cfg.discovery?.mdns?.mode === "full"
  );
}

export function isFederationAutoConnectConfigured(env: NodeJS.ProcessEnv): boolean {
  return isTruthyEnvValue(env.FASED_FEDERATION_AUTO_CONNECT);
}
