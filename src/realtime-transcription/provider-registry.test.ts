import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";

const resolvePluginCapabilityProviders = vi.hoisted(() => vi.fn((): unknown[] => []));

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders,
}));

describe("realtime transcription provider registry", () => {
  beforeEach(() => {
    resolvePluginCapabilityProviders.mockReset();
    resolvePluginCapabilityProviders.mockReturnValue([]);
  });

  it("lists canonical providers once", async () => {
    const { listRealtimeTranscriptionProviders } = await import("./provider-registry.js");
    resolvePluginCapabilityProviders.mockReturnValue([
      {
        id: "deepgram",
        label: "Deepgram",
        aliases: ["dg"],
        isConfigured: () => true,
        createSession: () => ({}) as never,
      } satisfies RealtimeTranscriptionProviderPlugin,
    ]);

    expect(listRealtimeTranscriptionProviders().map((provider) => provider.id)).toEqual([
      "deepgram",
    ]);
  });

  it("resolves aliases to the canonical provider", async () => {
    const { getRealtimeTranscriptionProvider, canonicalizeRealtimeTranscriptionProviderId } =
      await import("./provider-registry.js");
    resolvePluginCapabilityProviders.mockReturnValue([
      {
        id: "deepgram",
        label: "Deepgram",
        aliases: ["dg"],
        isConfigured: () => true,
        createSession: () => ({}) as never,
      } satisfies RealtimeTranscriptionProviderPlugin,
    ]);

    expect(getRealtimeTranscriptionProvider("dg")?.id).toBe("deepgram");
    expect(canonicalizeRealtimeTranscriptionProviderId("dg")).toBe("deepgram");
  });

  it("normalizes ids to lowercase trimmed values", async () => {
    const { normalizeRealtimeTranscriptionProviderId } = await import("./provider-registry.js");
    expect(normalizeRealtimeTranscriptionProviderId("  DeepGram  ")).toBe("deepgram");
    expect(normalizeRealtimeTranscriptionProviderId("   ")).toBeUndefined();
  });
});
