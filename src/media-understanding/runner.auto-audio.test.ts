import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import { buildProviderRegistry, runCapability } from "./runner.js";
import { withAudioFixture } from "./runner.test-utils.js";

function createOpenAiAudioProvider(
  transcribeAudio: (req: { model?: string }) => Promise<{ text: string; model: string }>,
) {
  return buildProviderRegistry({
    openai: {
      id: "openai",
      capabilities: ["audio"],
      transcribeAudio,
    },
  });
}

function createOpenAiAudioCfg(extra?: Partial<FasedAgentConfig>): FasedAgentConfig {
  return {
    models: {
      providers: {
        openai: {
          apiKey: "test-key",
          models: [],
        },
      },
    },
    ...extra,
  } as unknown as FasedAgentConfig;
}

async function runAutoAudioCase(params: {
  transcribeAudio: (req: { model?: string }) => Promise<{ text: string; model: string }>;
  cfgExtra?: Partial<FasedAgentConfig>;
}) {
  let runResult: Awaited<ReturnType<typeof runCapability>> | undefined;
  await withAudioFixture("fased-auto-audio", async ({ ctx, media, cache }) => {
    const providerRegistry = createOpenAiAudioProvider(params.transcribeAudio);
    const cfg = createOpenAiAudioCfg(params.cfgExtra);
    runResult = await runCapability({
      capability: "audio",
      cfg,
      ctx,
      attachments: cache,
      media,
      providerRegistry,
    });
  });
  if (!runResult) {
    throw new Error("Expected auto audio case result");
  }
  return runResult;
}

describe("runCapability auto audio entries", () => {
  it("uses provider keys to auto-enable audio transcription", async () => {
    let seenModel: string | undefined;
    const result = await runAutoAudioCase({
      transcribeAudio: async (req) => {
        seenModel = req.model;
        return { text: "ok", model: req.model ?? "unknown" };
      },
    });
    expect(result.outputs[0]?.text).toBe("ok");
    expect(seenModel).toBe("gpt-4o-mini-transcribe");
    expect(result.decision.outcome).toBe("success");
  });

  it("uses the provider audio default instead of the active Codex chat model", async () => {
    let runResult: Awaited<ReturnType<typeof runCapability>> | undefined;
    let seenModel: string | undefined;

    await withAudioFixture("fased-auto-audio-codex", async ({ ctx, media, cache }) => {
      const providerRegistry = buildProviderRegistry({
        "openai-codex": {
          id: "openai-codex",
          capabilities: ["audio"],
          transcribeAudio: async (req) => {
            seenModel = req.model;
            return { text: "codex audio", model: req.model ?? "unknown" };
          },
        },
      });
      const cfg = {
        models: {
          providers: {
            "openai-codex": {
              apiKey: "codex-test-key", // pragma: allowlist secret
              models: [],
            },
          },
        },
      } as unknown as FasedAgentConfig;

      runResult = await runCapability({
        capability: "audio",
        cfg,
        ctx,
        attachments: cache,
        media,
        providerRegistry,
        activeModel: { provider: "openai-codex", model: "gpt-5.3-codex" },
      });
    });

    expect(runResult?.outputs[0]).toMatchObject({
      provider: "openai-codex",
      model: "gpt-4o-mini-transcribe",
      text: "codex audio",
    });
    expect(seenModel).toBe("gpt-4o-mini-transcribe");
  });

  it("skips auto audio when disabled", async () => {
    const result = await runAutoAudioCase({
      transcribeAudio: async () => ({
        text: "ok",
        model: "whisper-1",
      }),
      cfgExtra: {
        tools: {
          media: {
            audio: {
              enabled: false,
            },
          },
        },
      },
    });
    expect(result.outputs).toHaveLength(0);
    expect(result.decision.outcome).toBe("disabled");
  });

  it("prefers explicitly configured audio model entries", async () => {
    let seenModel: string | undefined;
    const result = await runAutoAudioCase({
      transcribeAudio: async (req) => {
        seenModel = req.model;
        return { text: "ok", model: req.model ?? "unknown" };
      },
      cfgExtra: {
        tools: {
          media: {
            audio: {
              models: [{ provider: "openai", model: "whisper-1" }],
            },
          },
        },
      },
    });

    expect(result.outputs[0]?.text).toBe("ok");
    expect(seenModel).toBe("whisper-1");
  });

  it("uses mistral when only mistral key is configured", async () => {
    const priorEnv: Record<string, string | undefined> = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      GROQ_API_KEY: process.env.GROQ_API_KEY,
      DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.GEMINI_API_KEY;
    process.env.MISTRAL_API_KEY = "mistral-test-key";
    let runResult: Awaited<ReturnType<typeof runCapability>> | undefined;
    try {
      await withAudioFixture("fased-auto-audio-mistral", async ({ ctx, media, cache }) => {
        const providerRegistry = buildProviderRegistry({
          openai: {
            id: "openai",
            capabilities: ["audio"],
            transcribeAudio: async () => ({ text: "openai", model: "gpt-4o-mini-transcribe" }),
          },
          mistral: {
            id: "mistral",
            capabilities: ["audio"],
            transcribeAudio: async (req) => ({ text: "mistral", model: req.model ?? "unknown" }),
          },
        });
        const cfg = {
          models: {
            providers: {
              mistral: {
                apiKey: "mistral-test-key",
                models: [],
              },
            },
          },
          tools: {
            media: {
              audio: {
                enabled: true,
              },
            },
          },
        } as unknown as FasedAgentConfig;

        runResult = await runCapability({
          capability: "audio",
          cfg,
          ctx,
          attachments: cache,
          media,
          providerRegistry,
        });
      });
    } finally {
      for (const [key, value] of Object.entries(priorEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
    if (!runResult) {
      throw new Error("Expected auto audio mistral result");
    }
    expect(runResult.decision.outcome).toBe("success");
    expect(runResult.outputs[0]?.provider).toBe("mistral");
    expect(runResult.outputs[0]?.model).toBe("voxtral-mini-latest");
    expect(runResult.outputs[0]?.text).toBe("mistral");
  });
});
