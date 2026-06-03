import { describe, expect, it, vi } from "vitest";

const { agentCtor } = vi.hoisted(() => ({
  agentCtor: vi.fn(function MockAgent(this: { options: unknown }, options: unknown) {
    this.options = options;
  }),
}));

vi.mock("undici", () => ({
  Agent: agentCtor,
}));

import { closeDispatcher, createPinnedDispatcher, type PinnedHostname } from "./ssrf.js";

describe("createPinnedDispatcher", () => {
  it("uses pinned lookup without overriding global family policy", () => {
    const lookup = vi.fn() as unknown as PinnedHostname["lookup"];
    const pinned: PinnedHostname = {
      hostname: "api.telegram.org",
      addresses: ["149.154.167.220"],
      lookup,
    };

    const dispatcher = createPinnedDispatcher(pinned);

    expect(dispatcher).toBeDefined();
    expect(agentCtor).toHaveBeenCalledWith({
      connect: {
        lookup,
      },
    });
    const firstCallArg = agentCtor.mock.calls[0]?.[0] as
      | { connect?: Record<string, unknown> }
      | undefined;
    expect(firstCallArg?.connect?.autoSelectFamily).toBeUndefined();
  });
});

describe("closeDispatcher", () => {
  it("bounds stalled close calls and destroys the dispatcher", async () => {
    const destroy = vi.fn();
    const dispatcher = {
      close: vi.fn(() => new Promise<void>(() => {})),
      destroy,
    };

    const outcome = await Promise.race([
      closeDispatcher(dispatcher as never).then(() => "closed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 250)),
    ]);

    expect(outcome).toBe("closed");
    expect(dispatcher.close).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
