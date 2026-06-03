import { afterEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-core-tools.js";
import { createFasedAgentTools } from "./fased-tools.js";

describe("fased tools wallet integration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("includes wallet tool when wallet runtime is enabled", () => {
    vi.stubEnv("FASED_GATEWAY_MODE", "managed");
    const tools = createFasedAgentTools({
      config: {
        agents: {
          list: [{ id: "owner", default: true }],
        },
        wallet: {
          runtime: {
            enabled: true,
          },
        },
      },
      agentSessionKey: "agent:owner:main",
    });
    expect(tools.some((tool) => tool.name === "wallet")).toBe(true);
  });

  it("omits wallet tool when wallet runtime is disabled", () => {
    const tools = createFasedAgentTools({
      config: {
        agents: {
          list: [{ id: "owner", default: true }],
        },
        wallet: {
          runtime: {
            enabled: false,
          },
        },
      },
      agentSessionKey: "agent:owner:main",
    });
    expect(tools.some((tool) => tool.name === "wallet")).toBe(false);
  });
});
