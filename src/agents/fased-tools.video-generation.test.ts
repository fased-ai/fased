import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import * as videoGenerationRuntime from "../video-generation/runtime.js";
import { createFasedCompatTools } from "./fased-tools.compat.js";

vi.mock("../plugins/tools.js", () => ({
  resolvePluginTools: () => [],
  copyPluginToolMeta: () => undefined,
  getPluginToolMeta: () => undefined,
}));

function asConfig(value: unknown): FasedAgentConfig {
  return value as FasedAgentConfig;
}

function stubVideoGenerationProviders() {
  vi.spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders").mockReturnValue([
    {
      id: "qwen",
      defaultModel: "wan2.6-t2v",
      models: ["wan2.6-t2v"],
      capabilities: {
        maxVideos: 1,
        maxInputImages: 1,
        maxInputVideos: 4,
        maxDurationSeconds: 10,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsAudio: true,
        supportsWatermark: true,
      },
      generateVideo: vi.fn(async () => {
        throw new Error("not used");
      }),
    },
  ]);
}

describe("fased tools video generation registration", () => {
  beforeEach(() => {
    vi.stubEnv("QWEN_API_KEY", "");
    vi.stubEnv("MODELSTUDIO_API_KEY", "");
    vi.stubEnv("DASHSCOPE_API_KEY", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("registers video_generate when video-generation config is present", () => {
    const tools = createFasedCompatTools({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: {
              primary: "qwen/wan2.6-t2v",
            },
          },
        },
      }),
      agentDir: "/tmp/fased-agent-main",
    });

    expect(tools.map((tool) => tool.name)).toContain("video_generate");
  });

  it("registers video_generate when a compatible provider has env-backed auth", () => {
    stubVideoGenerationProviders();
    vi.stubEnv("QWEN_API_KEY", "qwen-test");

    const tools = createFasedCompatTools({
      config: asConfig({}),
      agentDir: "/tmp/fased-agent-main",
    });

    expect(tools.map((tool) => tool.name)).toContain("video_generate");
  });

  it("omits video_generate when config is absent and no compatible provider auth exists", () => {
    stubVideoGenerationProviders();

    const tools = createFasedCompatTools({
      config: asConfig({}),
      agentDir: "/tmp/fased-agent-main",
    });

    expect(tools.map((tool) => tool.name)).not.toContain("video_generate");
  });
});
