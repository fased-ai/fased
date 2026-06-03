import { describe, expect, it } from "vitest";
import {
  isCacheTtlEligibleProvider,
  shouldAppendCacheTtlTimestampAfterAttempt,
} from "./cache-ttl.js";

describe("isCacheTtlEligibleProvider", () => {
  it("allows anthropic", () => {
    expect(isCacheTtlEligibleProvider("anthropic", "claude-sonnet-4-20250514")).toBe(true);
  });

  it("allows moonshot and zai providers", () => {
    expect(isCacheTtlEligibleProvider("moonshot", "kimi-k2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("zai", "glm-5")).toBe(true);
  });

  it("is case-insensitive for native providers", () => {
    expect(isCacheTtlEligibleProvider("Moonshot", "Kimi-K2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("ZAI", "GLM-5")).toBe(true);
  });

  it("allows openrouter cache-ttl models", () => {
    expect(isCacheTtlEligibleProvider("openrouter", "anthropic/claude-sonnet-4")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "moonshotai/kimi-k2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "moonshot/kimi-k2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "zai/glm-5")).toBe(true);
  });

  it("rejects unsupported providers and models", () => {
    expect(isCacheTtlEligibleProvider("openai", "gpt-4o")).toBe(false);
    expect(isCacheTtlEligibleProvider("openrouter", "openai/gpt-4o")).toBe(false);
  });
});

describe("shouldAppendCacheTtlTimestampAfterAttempt", () => {
  const base = {
    timedOutDuringCompaction: false,
    compactionOccurredThisAttempt: false,
    contextPruningMode: "cache-ttl",
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
  };

  it("allows eligible completed attempts with cache-ttl pruning enabled", () => {
    expect(shouldAppendCacheTtlTimestampAfterAttempt(base)).toBe(true);
  });

  it("does not append a cache-ttl marker after compaction happened in this attempt", () => {
    expect(
      shouldAppendCacheTtlTimestampAfterAttempt({
        ...base,
        compactionOccurredThisAttempt: true,
      }),
    ).toBe(false);
  });

  it("does not append a cache-ttl marker after compaction timeout", () => {
    expect(
      shouldAppendCacheTtlTimestampAfterAttempt({
        ...base,
        timedOutDuringCompaction: true,
      }),
    ).toBe(false);
  });

  it("requires cache-ttl mode and an eligible provider", () => {
    expect(
      shouldAppendCacheTtlTimestampAfterAttempt({
        ...base,
        contextPruningMode: "off",
      }),
    ).toBe(false);
    expect(
      shouldAppendCacheTtlTimestampAfterAttempt({
        ...base,
        provider: "openai",
        modelId: "gpt-5.2",
      }),
    ).toBe(false);
  });
});
