import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/types.fased.js";
import { resolveStrictAgenticPolicyStatus } from "./status.strict-agentic.js";

function config(agents: FasedAgentConfig["agents"]): Pick<FasedAgentConfig, "agents"> {
  return { agents };
}

describe("resolveStrictAgenticPolicyStatus", () => {
  it("reports implicit off mode when config and env do not opt in", () => {
    const status = resolveStrictAgenticPolicyStatus(
      config({ list: [{ id: "main" }, { id: "ops" }] }),
      ["main", "ops"],
      {},
    );

    expect(status).toMatchObject({
      mode: "off",
      source: "implicit-default",
      envFlagSet: false,
      enforcementAvailable: false,
      warningAgents: 0,
      totalAgents: 2,
    });
    expect(status.agents).toEqual([
      { agentId: "main", mode: "off", source: "implicit-default", override: false },
      { agentId: "ops", mode: "off", source: "implicit-default", override: false },
    ]);
  });

  it("reports default warning policy and per-agent overrides", () => {
    const status = resolveStrictAgenticPolicyStatus(
      config({
        defaults: { strictAgentic: { mode: "warn" } },
        list: [{ id: "main" }, { id: "ops", strictAgentic: { mode: "off" } }],
      }),
      ["ops", "main"],
      {},
    );

    expect(status.mode).toBe("warn");
    expect(status.source).toBe("default-config");
    expect(status.warningAgents).toBe(1);
    expect(status.agents).toEqual([
      { agentId: "main", mode: "warn", source: "default-config", override: false },
      { agentId: "ops", mode: "off", source: "agent-config", override: true },
    ]);
  });

  it("uses the environment warning mode when config has no policy", () => {
    const status = resolveStrictAgenticPolicyStatus(config({ list: [{ id: "main" }] }), ["main"], {
      FASED_STRICT_AGENTIC_MODE: "warn",
    });

    expect(status.mode).toBe("warn");
    expect(status.source).toBe("environment");
    expect(status.envFlagSet).toBe(true);
    expect(status.warningAgents).toBe(1);
  });

  it("keeps config policy stronger than the environment fallback", () => {
    const status = resolveStrictAgenticPolicyStatus(
      config({
        defaults: { strictAgentic: { mode: "off" } },
        list: [{ id: "main" }],
      }),
      ["main"],
      { FASED_STRICT_AGENTIC_MODE: "warn" },
    );

    expect(status.mode).toBe("off");
    expect(status.source).toBe("default-config");
    expect(status.envFlagSet).toBe(true);
    expect(status.warningAgents).toBe(0);
  });

  it("does not advertise unsupported enforcement mode from env", () => {
    const status = resolveStrictAgenticPolicyStatus(config({ list: [{ id: "main" }] }), ["main"], {
      FASED_STRICT_AGENTIC_MODE: "enforce",
    });

    expect(status).toMatchObject({
      mode: "off",
      source: "environment",
      envFlagSet: true,
      enforcementAvailable: false,
      warningAgents: 0,
    });
  });
});
