import { beforeEach, describe, expect, it, vi } from "vitest";

const upsertAuthProfileWithLock = vi.hoisted(() => vi.fn(async () => ({ profiles: {} })));

vi.mock("../agents/auth-profiles.js", () => ({ upsertAuthProfileWithLock }));

import {
  configureLmStudioProvider,
  configureOllamaProvider,
  configureVllmProvider,
  normalizeLocalProviderModelId,
} from "./vllm-setup.js";

describe("local provider setup", () => {
  beforeEach(() => {
    upsertAuthProfileWithLock.mockClear();
  });

  it("accepts raw and provider-qualified model IDs without duplicating the provider", () => {
    expect(normalizeLocalProviderModelId("ollama", "qwen3:4b")).toBe("qwen3:4b");
    expect(normalizeLocalProviderModelId("ollama", "ollama/qwen3:4b")).toBe("qwen3:4b");
    expect(normalizeLocalProviderModelId("ollama", "ollama/ollama/qwen3:4b")).toBe("qwen3:4b");
    expect(normalizeLocalProviderModelId("vllm", "meta-llama/Llama-3")).toBe("meta-llama/Llama-3");
  });

  it("stores canonical Ollama model IDs and the native API route", async () => {
    const result = await configureOllamaProvider({
      cfg: {},
      baseUrl: "http://172.28.64.1:11434/v1",
      modelId: "ollama/qwen3:4b",
    });

    expect(result.modelId).toBe("qwen3:4b");
    expect(result.modelRef).toBe("ollama/qwen3:4b");
    expect(result.config.models?.providers?.ollama).toMatchObject({
      baseUrl: "http://172.28.64.1:11434",
      api: "ollama",
      apiKey: "ollama-local",
      models: [{ id: "qwen3:4b" }],
    });
  });

  it("normalizes qualified model IDs for LM Studio and vLLM", async () => {
    const lmstudio = await configureLmStudioProvider({
      cfg: {},
      baseUrl: "http://127.0.0.1:1234",
      modelId: "lmstudio/qwen3.5-9b",
    });
    const vllm = await configureVllmProvider({
      cfg: {},
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "vllm-local",
      modelId: "vllm/meta-llama/Llama-3",
    });

    expect(lmstudio.modelRef).toBe("lmstudio/qwen3.5-9b");
    expect(lmstudio.config.models?.providers?.lmstudio?.models?.[0]?.id).toBe("qwen3.5-9b");
    expect(vllm.modelRef).toBe("vllm/meta-llama/Llama-3");
    expect(vllm.config.models?.providers?.vllm?.models?.[0]?.id).toBe("meta-llama/Llama-3");
  });
});
