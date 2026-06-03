import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { applyModelOverrideToSessionEntry } from "./model-overrides.js";

function createEntry(): SessionEntry {
  return {
    sessionId: "sess-1",
    updatedAt: 1,
  };
}

describe("applyModelOverrideToSessionEntry", () => {
  it("tracks user-selected overrides and marks live switching when requested", () => {
    const entry = createEntry();

    const result = applyModelOverrideToSessionEntry({
      entry,
      selection: { provider: "openai", model: "gpt-5" },
      selectionSource: "user",
      markLiveSwitchPending: true,
    });

    expect(result.updated).toBe(true);
    expect(entry.providerOverride).toBe("openai");
    expect(entry.modelOverride).toBe("gpt-5");
    expect(entry.modelOverrideSource).toBe("user");
    expect(entry.liveModelSwitchPending).toBe(true);
  });

  it("clears stale runtime model fields, context window, and fallback notices", () => {
    const entry: SessionEntry = {
      ...createEntry(),
      providerOverride: "anthropic",
      modelOverride: "claude-old",
      modelOverrideSource: "user",
      model: "claude-old",
      modelProvider: "anthropic",
      contextTokens: 32000,
      fallbackNoticeSelectedModel: "claude-old",
      fallbackNoticeActiveModel: "claude-fallback",
      fallbackNoticeReason: "temporary",
    };

    const result = applyModelOverrideToSessionEntry({
      entry,
      selection: { provider: "openai", model: "gpt-5" },
      selectionSource: "user",
    });

    expect(result.updated).toBe(true);
    expect(entry.model).toBeUndefined();
    expect(entry.modelProvider).toBeUndefined();
    expect(entry.contextTokens).toBeUndefined();
    expect(entry.fallbackNoticeSelectedModel).toBeUndefined();
    expect(entry.fallbackNoticeActiveModel).toBeUndefined();
    expect(entry.fallbackNoticeReason).toBeUndefined();
  });

  it("clears override source when returning to the default model", () => {
    const entry: SessionEntry = {
      ...createEntry(),
      providerOverride: "openai",
      modelOverride: "gpt-5",
      modelOverrideSource: "user",
    };

    const result = applyModelOverrideToSessionEntry({
      entry,
      selection: { provider: "anthropic", model: "claude-default", isDefault: true },
    });

    expect(result.updated).toBe(true);
    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverride).toBeUndefined();
    expect(entry.modelOverrideSource).toBeUndefined();
  });
});
