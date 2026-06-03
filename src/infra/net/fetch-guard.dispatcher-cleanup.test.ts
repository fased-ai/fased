import { describe, expect, it, vi } from "vitest";

const { agentClose, agentDestroy, agentCtor, envHttpProxyAgentCtor } = vi.hoisted(() => {
  const agentClose = vi.fn();
  const agentDestroy = vi.fn();
  const agentCtor = vi.fn(function MockAgent(
    this: {
      close: typeof agentClose;
      destroy: typeof agentDestroy;
      options: unknown;
    },
    options: unknown,
  ) {
    this.options = options;
    this.close = agentClose;
    this.destroy = agentDestroy;
  });
  const envHttpProxyAgentCtor = vi.fn(function MockEnvHttpProxyAgent(
    this: {
      close: typeof agentClose;
      destroy: typeof agentDestroy;
      options: unknown;
    },
    options: unknown,
  ) {
    this.options = options;
    this.close = agentClose;
    this.destroy = agentDestroy;
  });
  return { agentClose, agentDestroy, agentCtor, envHttpProxyAgentCtor };
});

vi.mock("undici", () => ({
  Agent: agentCtor,
  EnvHttpProxyAgent: envHttpProxyAgentCtor,
}));

import { fetchWithSsrFGuard } from "./fetch-guard.js";

type LookupFn = NonNullable<Parameters<typeof fetchWithSsrFGuard>[0]["lookupFn"]>;

function createPublicLookup(): LookupFn {
  return vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;
}

describe("fetchWithSsrFGuard dispatcher cleanup", () => {
  it("rejects timed-out fetches even when dispatcher close stalls", async () => {
    agentClose.mockImplementationOnce(() => new Promise<void>(() => {}));
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(init.signal?.reason ?? new Error("aborted"));
            },
            { once: true },
          );
        }),
    );

    const fetchPromise = fetchWithSsrFGuard({
      url: "https://public.example/resource",
      fetchImpl,
      lookupFn: createPublicLookup(),
      timeoutMs: 1,
    });

    const outcome = await Promise.race([
      fetchPromise.then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.name : "rejected"),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 250)),
    ]);

    expect(outcome).not.toBe("hung");
    expect(agentCtor).toHaveBeenCalledOnce();
    expect(agentDestroy).toHaveBeenCalledOnce();
  });
});
