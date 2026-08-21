import {
  createAssistantMessageEventStream,
  getApiProvider,
  resetApiProviders,
  unregisterApiProviders,
} from "@mariozechner/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureCustomApiRegistered, getCustomApiRegistrySourceId } from "./custom-api-registry.js";
import { getEnvApiKey } from "./pi-ai-compat-runtime.js";

const FIRST_API = "test-custom-api";
const DELEGATE_API = "test-custom-api-delegate";

describe("ensureCustomApiRegistered", () => {
  afterEach(() => {
    unregisterApiProviders(getCustomApiRegistrySourceId(FIRST_API));
    unregisterApiProviders(getCustomApiRegistrySourceId(DELEGATE_API));
    resetApiProviders();
  });

  it("queues a custom api provider once and activates it only with the compat runtime", async () => {
    const streamFn = vi.fn(() => createAssistantMessageEventStream());

    expect(ensureCustomApiRegistered(FIRST_API, streamFn)).toBe(true);
    expect(ensureCustomApiRegistered(FIRST_API, streamFn)).toBe(false);
    expect(getApiProvider(FIRST_API)).toBeUndefined();

    await getEnvApiKey("custom", {});
    const provider = getApiProvider(FIRST_API);
    expect(provider).toBeDefined();
  });

  it("delegates both stream entrypoints to the provided stream function", async () => {
    const stream = createAssistantMessageEventStream();
    const streamFn = vi.fn(() => stream);
    ensureCustomApiRegistered(DELEGATE_API, streamFn);
    await getEnvApiKey("custom", {});

    const provider = getApiProvider(DELEGATE_API);
    expect(provider).toBeDefined();

    const model = { api: DELEGATE_API, provider: "custom", id: "m" };
    const context = { messages: [] };
    const options = { maxTokens: 32 };

    expect(provider?.stream(model as never, context as never, options as never)).toBe(stream);
    expect(provider?.streamSimple(model as never, context as never, options as never)).toBe(stream);
    expect(streamFn).toHaveBeenCalledTimes(2);
  });
});
