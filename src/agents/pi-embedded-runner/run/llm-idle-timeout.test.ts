import { describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../../../config/config.js";
import {
  DEFAULT_LLM_IDLE_TIMEOUT_MS,
  resolveLlmIdleTimeoutMs,
  streamWithIdleTimeout,
} from "./llm-idle-timeout.js";

describe("resolveLlmIdleTimeoutMs", () => {
  it("returns default when config is undefined", () => {
    expect(resolveLlmIdleTimeoutMs()).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("returns default when llm config is missing", () => {
    const cfg = { agents: {} } as FasedAgentConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("returns default when idleTimeoutSeconds is not set", () => {
    const cfg = { agents: { defaults: {} } } as FasedAgentConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("returns 0 when idleTimeoutSeconds is 0", () => {
    const cfg = {
      agents: { defaults: { llm: { idleTimeoutSeconds: 0 } } },
    } as FasedAgentConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(0);
  });

  it("returns configured value in milliseconds", () => {
    const cfg = {
      agents: { defaults: { llm: { idleTimeoutSeconds: 30 } } },
    } as FasedAgentConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(30_000);
  });

  it("caps at max safe timeout", () => {
    const cfg = {
      agents: { defaults: { llm: { idleTimeoutSeconds: 10_000_000 } } },
    } as FasedAgentConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(2_147_000_000);
  });

  it("falls back to agents.defaults.timeoutSeconds", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 300 } } } as FasedAgentConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(300_000);
  });

  it("prefers llm.idleTimeoutSeconds over agents.defaults.timeoutSeconds", () => {
    const cfg = {
      agents: { defaults: { timeoutSeconds: 300, llm: { idleTimeoutSeconds: 120 } } },
    } as FasedAgentConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(120_000);
  });

  it("keeps idleTimeoutSeconds=0 disabled even when timeoutSeconds is set", () => {
    const cfg = {
      agents: { defaults: { timeoutSeconds: 300, llm: { idleTimeoutSeconds: 0 } } },
    } as FasedAgentConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(0);
  });

  it("disables the default idle timeout for cron when no timeout is configured", () => {
    expect(resolveLlmIdleTimeoutMs({ trigger: "cron" })).toBe(0);
  });

  it("uses agents.defaults.timeoutSeconds for cron before disabling default timeout", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 300 } } } as FasedAgentConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg, trigger: "cron" })).toBe(300_000);
  });
});

describe("streamWithIdleTimeout", () => {
  function createMockAsyncIterable<T>(chunks: T[]): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            if (index < chunks.length) {
              return { done: false, value: chunks[index++] };
            }
            return { done: true, value: undefined };
          },
          async return() {
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  it("wraps stream function", () => {
    const mockStream = createMockAsyncIterable([]);
    const baseFn = vi.fn().mockReturnValue(mockStream);
    const wrapped = streamWithIdleTimeout(baseFn, 1000);
    expect(typeof wrapped).toBe("function");
  });

  it("passes through model, context, and options", () => {
    const mockStream = createMockAsyncIterable([]);
    const baseFn = vi.fn().mockReturnValue(mockStream);
    const wrapped = streamWithIdleTimeout(baseFn, 1000);

    const model = { api: "openai" } as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    void wrapped(model, context, options);
    expect(baseFn).toHaveBeenCalledWith(model, context, options);
  });

  it("throws on idle timeout", async () => {
    const slowStream: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return new Promise<IteratorResult<unknown>>(() => {});
          },
        };
      },
    };

    const baseFn = vi.fn().mockReturnValue(slowStream);
    const wrapped = streamWithIdleTimeout(baseFn, 50);

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    const stream = wrapped(model, context, options) as AsyncIterable<unknown>;
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/LLM idle timeout/);
  });

  it("resets timer on each chunk", async () => {
    const chunks = [{ text: "a" }, { text: "b" }, { text: "c" }];
    const mockStream = createMockAsyncIterable(chunks);
    const baseFn = vi.fn().mockReturnValue(mockStream);
    const wrapped = streamWithIdleTimeout(baseFn, 1000);

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    const stream = wrapped(model, context, options) as AsyncIterable<unknown>;
    const results: unknown[] = [];
    for await (const chunk of stream) {
      results.push(chunk);
    }

    expect(results).toEqual(chunks);
  });

  it("calls timeout hook on idle timeout", async () => {
    const slowStream: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return new Promise<IteratorResult<unknown>>(() => {});
          },
        };
      },
    };

    const baseFn = vi.fn().mockReturnValue(slowStream);
    const onIdleTimeout = vi.fn();
    const wrapped = streamWithIdleTimeout(baseFn, 50, onIdleTimeout);

    const model = {} as Parameters<typeof baseFn>[0];
    const context = {} as Parameters<typeof baseFn>[1];
    const options = {} as Parameters<typeof baseFn>[2];

    const stream = wrapped(model, context, options) as AsyncIterable<unknown>;
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow(/LLM idle timeout/);
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
  });
});
