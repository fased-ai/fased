import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadWebMedia } from "../media/runtime-service.js";
import { buildTtsSystemPromptHint, maybeApplyTtsToPayload } from "../tts/runtime-service.js";
import { createEmptyPluginRegistry, createPluginRegistry } from "./registry.js";
import { requirePluginRuntimeProvider } from "./runtime-provider-runtime.js";
import type { MediaRuntimeProvider } from "./runtime-provider-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

function pluginRecord(id: string) {
  return {
    id,
    name: id,
    source: `/tmp/${id}/index.ts`,
    origin: "managed",
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    providerIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpHandlers: 0,
    hookCount: 0,
    configSchema: false,
  } as const;
}

describe("managed optional runtime providers", () => {
  beforeEach(() => resetPluginRuntimeStateForTest());

  it("fails with the exact component identity when a provider is absent", () => {
    expect(() => requirePluginRuntimeProvider("media")).toThrow(
      "UNAVAILABLE: optional component media-runtime is not installed or active",
    );
    expect(() => requirePluginRuntimeProvider("speech")).toThrow(
      "UNAVAILABLE: optional component speech-runtime is not installed or active",
    );
  });

  it("keeps disabled speech dormant and fails enabled speech closed", async () => {
    const payload = { text: "hello" };
    await expect(maybeApplyTtsToPayload({ payload, cfg: {} })).resolves.toBe(payload);
    expect(buildTtsSystemPromptHint({})).toBeUndefined();

    const enabled = { messages: { tts: { auto: "always" as const } } };
    await expect(maybeApplyTtsToPayload({ payload, cfg: enabled })).rejects.toThrow(
      "UNAVAILABLE: optional component speech-runtime is not installed or active",
    );
    expect(() => buildTtsSystemPromptHint(enabled)).toThrow(
      "UNAVAILABLE: optional component speech-runtime is not installed or active",
    );
  });

  it("dispatches media calls through the active provider without importing its implementation", async () => {
    const provider = {
      loadWebMedia: vi.fn(async () => ({
        buffer: Buffer.from("managed-media"),
        contentType: "text/plain",
      })),
    } as unknown as MediaRuntimeProvider;
    const registry = createEmptyPluginRegistry();
    registry.runtimeProviders.media = provider;
    setActivePluginRegistry(registry);

    await expect(loadWebMedia("managed://fixture")).resolves.toMatchObject({
      contentType: "text/plain",
    });
    expect(provider.loadWebMedia).toHaveBeenCalledWith("managed://fixture");
  });

  it("accepts only the exact owning component and rejects duplicate providers", () => {
    const { createApi, registry } = createPluginRegistry({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runtime: {} as never,
    });
    const provider = {} as MediaRuntimeProvider;

    createApi(pluginRecord("not-media-runtime") as never, { config: {} }).registerRuntimeProvider({
      kind: "media",
      provider,
    });
    expect(registry.runtimeProviders.media).toBeUndefined();
    expect(registry.diagnostics.at(-1)?.message).toBe(
      "runtime provider media is not owned by plugin not-media-runtime",
    );

    createApi(pluginRecord("media-runtime") as never, { config: {} }).registerRuntimeProvider({
      kind: "media",
      provider,
    });
    expect(registry.runtimeProviders.media).toEqual(provider);

    createApi(pluginRecord("media-runtime") as never, { config: {} }).registerRuntimeProvider({
      kind: "media",
      provider,
    });
    expect(registry.diagnostics.at(-1)?.message).toBe("runtime provider already registered: media");
  });
});
