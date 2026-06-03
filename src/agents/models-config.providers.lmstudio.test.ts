import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveImplicitProviders, resolveLmStudioApiBase } from "./models-config.providers.js";

describe("resolveLmStudioApiBase", () => {
  it("adds /v1 when the user enters the local server root", () => {
    expect(resolveLmStudioApiBase("http://127.0.0.1:1234")).toBe("http://127.0.0.1:1234/v1");
  });

  it("keeps /v1 URLs unchanged", () => {
    expect(resolveLmStudioApiBase("http://127.0.0.1:1234/v1")).toBe("http://127.0.0.1:1234/v1");
  });
});

describe("LM Studio provider", () => {
  let originalVitest: string | undefined;
  let originalNodeEnv: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  afterEach(() => {
    if (originalVitest !== undefined) {
      process.env.VITEST = originalVitest;
    } else {
      delete process.env.VITEST;
    }
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
    globalThis.fetch = originalFetch;
    delete process.env.LM_API_TOKEN;
  });

  function setupDiscoveryEnv() {
    originalVitest = process.env.VITEST;
    originalNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    originalFetch = globalThis.fetch;
  }

  it("auto-registers lmstudio when the local model catalog is reachable", async () => {
    setupDiscoveryEnv();
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
      expect(String(url)).toBe("http://127.0.0.1:1234/api/v1/models");
      return {
        ok: true,
        json: async () => ({ data: [{ key: "qwen/qwen3.5-9b", name: "Qwen" }] }),
      };
    }) as typeof fetch;

    const agentDir = mkdtempSync(join(tmpdir(), "fased-test-"));
    const providers = await resolveImplicitProviders({ agentDir });

    expect(providers?.lmstudio).toMatchObject({
      api: "openai-completions",
      apiKey: "lmstudio-local",
      baseUrl: "http://127.0.0.1:1234/v1",
      request: { allowPrivateNetwork: true },
    });
    expect(providers?.lmstudio?.models?.[0]?.id).toBe("qwen/qwen3.5-9b");
  });
});
