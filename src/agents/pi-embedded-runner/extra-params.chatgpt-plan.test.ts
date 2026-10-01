import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream, type Model } from "@mariozechner/pi-ai";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ store: vi.fn(), plan: vi.fn() }));
vi.mock("../auth-profiles.js", async (original) => ({
  ...(await original<typeof import("../auth-profiles.js")>()),
  ensureAuthProfileStore: mocks.store,
}));
vi.mock("../chatgpt-plan-stream.js", () => ({ createChatGptPlanStream: mocks.plan }));
import { applyExtraParamsToAgent } from "./extra-params.js";
it("uses the exact resolved plan account before any legacy transport, rather than the first stored account", () => {
  mocks.store.mockReturnValue({
    version: 1,
    profiles: {
      first: {
        type: "oauth",
        provider: "openai-codex",
        access: "other-account",
        chatgptPlan: true,
        clientId: "oaiapp_other",
        subject: "other",
      },
      chosen: {
        type: "oauth",
        provider: "openai-codex",
        access: "chosen-account",
        chatgptPlan: true,
        clientId: "oaiapp_chosen",
        subject: "owner",
      },
    },
  });
  mocks.plan.mockReturnValue(() => createAssistantMessageEventStream());
  const underlying = vi.fn<StreamFn>();
  const agent = { streamFn: underlying };
  const model = {
    id: "gpt-test",
    api: "openai-codex-responses",
    provider: "openai-codex",
  } as Model<"openai-codex-responses">;
  applyExtraParamsToAgent(
    agent,
    {},
    "openai-codex",
    "gpt-test",
    undefined,
    undefined,
    undefined,
    "/tmp/test-agent",
    model,
    "chosen-account",
  );
  void agent.streamFn(model, { messages: [] });
  expect(mocks.plan).toHaveBeenCalledWith({ token: "chosen-account" });
  expect(underlying).not.toHaveBeenCalled();
});
