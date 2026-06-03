import { beforeEach, describe, expect, it, vi } from "vitest";
import { voicewakeHandlers } from "./voicewake.js";

const loadVoiceWakeConfig = vi.hoisted(() => vi.fn(async () => ({ triggers: ["fased"] })));
const setVoiceWakeTriggers = vi.hoisted(() => vi.fn(async (triggers: string[]) => ({ triggers })));

vi.mock("../../infra/voicewake.js", () => ({
  loadVoiceWakeConfig,
  setVoiceWakeTriggers,
}));

async function callVoiceWakeHandler(method: keyof typeof voicewakeHandlers, params = {}) {
  const broadcastVoiceWakeChanged = vi.fn();
  let response:
    | {
        ok: boolean;
        payload?: unknown;
        error?: unknown;
      }
    | undefined;
  await voicewakeHandlers[method]?.({
    params,
    respond: (ok: boolean, payload: unknown, error: unknown) => {
      response = { ok, payload, error };
    },
    context: { broadcastVoiceWakeChanged },
  } as unknown as Parameters<(typeof voicewakeHandlers)[typeof method]>[0]);
  if (!response) {
    throw new Error(`handler did not respond: ${String(method)}`);
  }
  return { response, broadcastVoiceWakeChanged };
}

describe("voicewake gateway methods", () => {
  beforeEach(() => {
    loadVoiceWakeConfig.mockClear();
    setVoiceWakeTriggers.mockClear();
  });

  it("serves voicewake.routing.get as a read alias", async () => {
    const { response } = await callVoiceWakeHandler("voicewake.routing.get");

    expect(response).toEqual({ ok: true, payload: { triggers: ["fased"] } });
    expect(loadVoiceWakeConfig).toHaveBeenCalledTimes(1);
  });

  it("serves voicewake.routing.set as a write alias", async () => {
    const { response, broadcastVoiceWakeChanged } = await callVoiceWakeHandler(
      "voicewake.routing.set",
      { triggers: ["hello fased"] },
    );

    expect(response).toEqual({ ok: true, payload: { triggers: ["hello fased"] } });
    expect(setVoiceWakeTriggers).toHaveBeenCalledWith(["hello fased"]);
    expect(broadcastVoiceWakeChanged).toHaveBeenCalledWith(["hello fased"]);
  });

  it("uses the routing method name in routing validation errors", async () => {
    const { response } = await callVoiceWakeHandler("voicewake.routing.set", {});

    expect(response.ok).toBe(false);
    expect(JSON.stringify(response.error)).toContain("voicewake.routing.set requires triggers");
  });
});
