import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream, type Model } from "@mariozechner/pi-ai";
import { expect, it } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";

it.each([
  ["off", "LOW"],
  ["minimal", "LOW"],
  ["low", "LOW"],
  ["medium", "MEDIUM"],
  ["high", "HIGH"],
  ["xhigh", "HIGH"],
] as const)(
  "sends supported Gemini 3.8 thinking for %s without a token budget",
  (level, expected) => {
    const payload = { config: { thinkingConfig: { thinkingBudget: 0, thinkingLevel: "MINIMAL" } } };
    const underlying: StreamFn = (_model, _context, options) => {
      void options?.onPayload?.(payload, _model);
      return createAssistantMessageEventStream();
    };
    const agent = { streamFn: underlying };
    const model = {
      id: "gemini-3.8-flash",
      provider: "google",
      api: "google-generative-ai",
    } as Model<"google-generative-ai">;
    applyExtraParamsToAgent(agent, {}, "google", model.id, undefined, level);
    void agent.streamFn(model, { messages: [] });
    expect(payload.config.thinkingConfig).toEqual({ thinkingLevel: expected });
  },
);
