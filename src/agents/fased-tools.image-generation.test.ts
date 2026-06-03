import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import * as imageGenerationRuntime from "../image-generation/runtime.js";
import { createFasedCompatTools } from "./fased-tools.compat.js";

vi.mock("../plugins/tools.js", () => ({
  resolvePluginTools: () => [],
  copyPluginToolMeta: () => undefined,
  getPluginToolMeta: () => undefined,
}));

function asConfig(value: unknown): FasedAgentConfig {
  return value as FasedAgentConfig;
}

function stubImageGenerationProviders() {
  vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
    {
      id: "openai",
      defaultModel: "gpt-image-1",
      models: ["gpt-image-1"],
      capabilities: {
        generate: {
          supportsSize: true,
        },
        edit: {
          enabled: false,
        },
        geometry: {
          sizes: ["1024x1024"],
        },
      },
      generateImage: vi.fn(async () => {
        throw new Error("not used");
      }),
    },
  ]);
}

describe("fased tools image generation registration", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEYS", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEYS", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("registers image_generate when image-generation config is present", () => {
    const tools = createFasedCompatTools({
      config: asConfig({
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "openai/gpt-image-1",
            },
          },
        },
      }),
      agentDir: "/tmp/fased-agent-main",
    });

    expect(tools.map((tool) => tool.name)).toContain("image_generate");
  });

  it("registers image_generate when a compatible provider has env-backed auth", () => {
    stubImageGenerationProviders();
    vi.stubEnv("OPENAI_API_KEY", "openai-test");

    const tools = createFasedCompatTools({
      config: asConfig({}),
      agentDir: "/tmp/fased-agent-main",
    });

    expect(tools.map((tool) => tool.name)).toContain("image_generate");
  });

  it("omits image_generate when config is absent and no compatible provider auth exists", () => {
    stubImageGenerationProviders();

    const tools = createFasedCompatTools({
      config: asConfig({}),
      agentDir: "/tmp/fased-agent-main",
    });

    expect(tools.map((tool) => tool.name)).not.toContain("image_generate");
  });
});
