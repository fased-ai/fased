import { describe, expect, it } from "vitest";
import {
  areChannelsConfigured,
  areInternalHooksConfigured,
  isBrowserServiceConfigured,
  isCanvasHostConfigured,
  isFederationAutoConnectConfigured,
  isGatewayDiscoveryConfigured,
  isGmailWatcherConfigured,
  isOptionalMemoryBackendConfigured,
  isSelectedModelConfigured,
} from "./startup-selection.js";

describe("gateway optional startup selection", () => {
  it("keeps an unconfigured core startup free of optional services", () => {
    expect(isBrowserServiceConfigured({})).toBe(false);
    expect(isGmailWatcherConfigured({})).toBe(false);
    expect(areInternalHooksConfigured({})).toBe(false);
    expect(areChannelsConfigured({})).toBe(false);
    expect(isSelectedModelConfigured({})).toBe(false);
    expect(isOptionalMemoryBackendConfigured({})).toBe(false);
    expect(isCanvasHostConfigured({})).toBe(false);
    expect(isGatewayDiscoveryConfigured({})).toBe(false);
    expect(isFederationAutoConnectConfigured({})).toBe(false);
  });

  it("selects only explicitly configured optional components", () => {
    const cfg = {
      browser: { enabled: true },
      hooks: {
        enabled: true,
        gmail: { account: "operator@example.com" },
        internal: { enabled: true },
      },
      channels: {
        defaults: { groupPolicy: "allowlist" as const },
        telegram: { enabled: true },
      },
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      memory: { backend: "qmd" as const },
      canvasHost: { enabled: true },
      discovery: { mdns: { mode: "minimal" as const } },
    };
    expect(isBrowserServiceConfigured(cfg)).toBe(true);
    expect(isGmailWatcherConfigured(cfg)).toBe(true);
    expect(areInternalHooksConfigured(cfg)).toBe(true);
    expect(areChannelsConfigured(cfg)).toBe(true);
    expect(isSelectedModelConfigured(cfg)).toBe(true);
    expect(isOptionalMemoryBackendConfigured(cfg)).toBe(true);
    expect(isCanvasHostConfigured(cfg)).toBe(true);
    expect(isGatewayDiscoveryConfigured(cfg)).toBe(true);
    expect(isFederationAutoConnectConfigured({ FASED_FEDERATION_AUTO_CONNECT: "1" })).toBe(true);
  });

  it("does not treat defaults, disabled entries, or unrelated config as a channel", () => {
    expect(areChannelsConfigured({ channels: { defaults: { groupPolicy: "allowlist" } } })).toBe(
      false,
    );
    expect(areChannelsConfigured({ channels: { telegram: { enabled: false, token: "x" } } })).toBe(
      false,
    );
    expect(isBrowserServiceConfigured({ browser: { enabled: false, cdpUrl: "http://x" } })).toBe(
      false,
    );
    expect(
      isGmailWatcherConfigured({ hooks: { enabled: false, gmail: { account: "x@example.com" } } }),
    ).toBe(false);
    expect(isCanvasHostConfigured({ canvasHost: { enabled: false } })).toBe(false);
    expect(isGatewayDiscoveryConfigured({ discovery: { mdns: { mode: "off" } } })).toBe(false);
    expect(isGatewayDiscoveryConfigured({ discovery: { wideArea: { enabled: true } } })).toBe(true);
  });
});
