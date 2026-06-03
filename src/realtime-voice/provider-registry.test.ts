import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";

const resolvePluginCapabilityProviders = vi.hoisted(() => vi.fn((): unknown[] => []));

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders,
}));

describe("realtime voice provider registry", () => {
  beforeEach(() => {
    resolvePluginCapabilityProviders.mockReset();
    resolvePluginCapabilityProviders.mockReturnValue([]);
  });

  it("lists canonical providers once", async () => {
    const { listRealtimeVoiceProviders } = await import("./provider-registry.js");
    resolvePluginCapabilityProviders.mockReturnValue([
      {
        id: "openai-realtime",
        label: "OpenAI Realtime",
        aliases: ["oai-rt"],
        isConfigured: () => true,
        createBridge: () => ({}) as never,
      } satisfies RealtimeVoiceProviderPlugin,
    ]);

    expect(listRealtimeVoiceProviders().map((provider) => provider.id)).toEqual([
      "openai-realtime",
    ]);
  });

  it("resolves aliases to the canonical provider", async () => {
    const { getRealtimeVoiceProvider, canonicalizeRealtimeVoiceProviderId } =
      await import("./provider-registry.js");
    resolvePluginCapabilityProviders.mockReturnValue([
      {
        id: "openai-realtime",
        label: "OpenAI Realtime",
        aliases: ["oai-rt"],
        isConfigured: () => true,
        createBridge: () => ({}) as never,
      } satisfies RealtimeVoiceProviderPlugin,
    ]);

    expect(getRealtimeVoiceProvider("oai-rt")?.id).toBe("openai-realtime");
    expect(canonicalizeRealtimeVoiceProviderId("oai-rt")).toBe("openai-realtime");
  });

  it("normalizes ids to lowercase trimmed values", async () => {
    const { normalizeRealtimeVoiceProviderId } = await import("./provider-registry.js");
    expect(normalizeRealtimeVoiceProviderId("  OpenAI-Realtime  ")).toBe("openai-realtime");
    expect(normalizeRealtimeVoiceProviderId("   ")).toBeUndefined();
  });
});
