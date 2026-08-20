import { describe, expect, it, vi } from "vitest";
import { ttsHandlers } from "../../../extensions/runtime-speech/tts-handlers.js";

const loadConfig = vi.hoisted(() =>
  vi.fn(() => ({
    messages: {
      tts: {
        provider: "openai",
        prefsPath: "/tmp/fased-gateway-tts-personas-test.json",
        openai: {
          apiKey: "secret-openai-key",
          model: "tts-1",
          voice: "nova",
        },
        elevenlabs: {
          apiKey: "secret-eleven-key",
          modelId: "eleven_turbo_v2_5",
          voiceId: "pMsXgVXv3BLzUgSXRplE",
        },
        edge: {
          enabled: true,
          voice: "en-US-AvaNeural",
          lang: "en-US",
        },
      },
    },
  })),
);

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig,
  };
});

async function callTtsHandler(method: keyof typeof ttsHandlers) {
  let response:
    | {
        ok: boolean;
        payload?: unknown;
        error?: unknown;
      }
    | undefined;
  await ttsHandlers[method]?.({
    params: {},
    respond: (ok, payload, error) => {
      response = { ok, payload, error };
    },
  } as Parameters<(typeof ttsHandlers)[typeof method]>[0]);
  if (!response) {
    throw new Error(`handler did not respond: ${String(method)}`);
  }
  return response;
}

describe("tts gateway methods", () => {
  it("lists read-only TTS personas without secrets", async () => {
    const response = await callTtsHandler("tts.personas");

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual(
      expect.objectContaining({
        active: "openai:nova",
        personas: expect.arrayContaining([
          expect.objectContaining({
            id: "openai:nova",
            provider: "openai",
            configured: true,
            active: true,
          }),
          expect.objectContaining({
            id: "elevenlabs:pMsXgVXv3BLzUgSXRplE",
            provider: "elevenlabs",
            configured: true,
          }),
          expect.objectContaining({
            id: "edge:en-US-AvaNeural",
            provider: "edge",
            configured: true,
          }),
        ]),
      }),
    );
    expect(JSON.stringify(response.payload)).not.toContain("secret-openai-key");
    expect(JSON.stringify(response.payload)).not.toContain("secret-eleven-key");
  });
});
