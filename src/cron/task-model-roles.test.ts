import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import {
  plannerStrategyModelRole,
  resolveTaskModelRole,
  taskExplicitModelRef,
} from "./task-model-roles.js";
import type { CronJob } from "./types.js";

function config(overrides: FasedAgentConfig = {}): FasedAgentConfig {
  return {
    agents: {
      defaults: {
        taskModels: {
          cheapCheck: "openrouter/global-cheap",
          strong: "openrouter/global-strong",
        },
      },
      list: [
        {
          id: "research",
          taskModels: {
            cheapCheck: "openrouter/research-cheap",
            escalation: "openrouter/research-escalation",
          },
        },
      ],
    },
    ...overrides,
  };
}

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "task-1",
    name: "Task",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: "Check this",
    },
    state: {},
    ...overrides,
  };
}

describe("task model roles", () => {
  it("resolves agent task model roles before global defaults", () => {
    expect(
      resolveTaskModelRole({
        cfg: config(),
        agentId: "research",
        role: "cheapCheck",
      }),
    ).toMatchObject({
      model: "openrouter/research-cheap",
      source: "agent",
      label: "Agent cheap/check role",
    });
  });

  it("prefers flat agent task model roles before provider-scoped migration roles", () => {
    expect(
      resolveTaskModelRole({
        cfg: config({
          agents: {
            defaults: {
              taskModels: {
                cheapCheck: "openrouter/global-cheap",
              },
            },
            list: [
              {
                id: "research",
                activeModelProvider: "openrouter",
                taskModels: {
                  cheapCheck: "openrouter/flat-cheap",
                },
                modelProviders: {
                  openrouter: {
                    primary: "openrouter/default",
                    taskModels: {
                      cheapCheck: "openrouter/provider-cheap",
                      escalation: "openrouter/provider-escalation",
                    },
                  },
                },
              },
            ],
          },
        }),
        agentId: "research",
        role: "cheapCheck",
      }),
    ).toMatchObject({
      model: "openrouter/flat-cheap",
      source: "agent",
      label: "Agent cheap/check role",
    });
  });

  it("uses provider-scoped roles as migration fallback when flat agent role is absent", () => {
    expect(
      resolveTaskModelRole({
        cfg: config({
          agents: {
            defaults: {
              taskModels: {
                cheapCheck: "openrouter/global-cheap",
              },
            },
            list: [
              {
                id: "research",
                activeModelProvider: "openrouter",
                modelProviders: {
                  openrouter: {
                    profileId: "openrouter:default",
                    primary: "openrouter/default",
                  },
                  openai: {
                    profileId: "openai:default",
                    primary: "openai/default",
                    taskModels: {
                      cheapCheck: "openai/cheap",
                    },
                  },
                },
              },
            ],
          },
        }),
        agentId: "research",
        role: "cheapCheck",
      }),
    ).toMatchObject({
      model: "openai/cheap",
      source: "agent",
      label: "Agent cheap/check role",
      providerId: "openai",
      providerSource: "attached-provider",
    });
  });

  it("keeps active legacy provider roles ahead of other migration provider roles", () => {
    expect(
      resolveTaskModelRole({
        cfg: config({
          agents: {
            list: [
              {
                id: "research",
                activeModelProvider: "openrouter",
                modelProviders: {
                  openrouter: {
                    taskModels: {
                      summarizer: "openrouter/summarizer",
                    },
                  },
                  openai: {
                    taskModels: {
                      summarizer: "openai/summarizer",
                    },
                  },
                },
              },
            ],
          },
        }),
        agentId: "research",
        role: "summarizer",
      }),
    ).toMatchObject({
      model: "openrouter/summarizer",
      providerId: "openrouter",
      providerSource: "active-provider",
    });
  });

  it("uses flat agent roles when provider-scoped roles are absent", () => {
    expect(
      resolveTaskModelRole({
        cfg: config({
          agents: {
            list: [
              {
                id: "research",
                activeModelProvider: "openrouter",
                taskModels: {
                  cheapCheck: "openrouter/flat-cheap",
                },
                modelProviders: {
                  openrouter: {
                    primary: "openrouter/default",
                  },
                },
              },
            ],
          },
        }),
        agentId: "research",
        role: "cheapCheck",
      }),
    ).toMatchObject({
      model: "openrouter/flat-cheap",
      source: "agent",
    });
  });

  it("uses flat roles per role when provider-scoped config overrides another role", () => {
    expect(
      resolveTaskModelRole({
        cfg: config({
          agents: {
            list: [
              {
                id: "research",
                activeModelProvider: "openrouter",
                taskModels: {
                  cheapCheck: "openrouter/flat-cheap",
                },
                modelProviders: {
                  openrouter: {
                    primary: "openrouter/default",
                    taskModels: {
                      escalation: "openrouter/provider-escalation",
                    },
                  },
                },
              },
            ],
          },
        }),
        agentId: "research",
        role: "cheapCheck",
      }),
    ).toMatchObject({
      model: "openrouter/flat-cheap",
      source: "agent",
    });
  });

  it("falls back to global task model roles", () => {
    expect(
      resolveTaskModelRole({
        cfg: config(),
        agentId: "assistant",
        role: "cheapCheck",
      }),
    ).toMatchObject({
      model: "openrouter/global-cheap",
      source: "global",
      label: "Global cheap/check role",
    });
  });

  it("treats task model overrides as explicit model refs", () => {
    expect(
      taskExplicitModelRef(
        job({
          executionPolicy: {
            modelPolicy: {
              mode: "task-override",
              model: "openrouter/task-cheap",
            },
          },
        }),
      ),
    ).toBe("openrouter/task-cheap");
  });

  it("maps planner strategies to task model roles", () => {
    expect(plannerStrategyModelRole("cheap-model")).toBe("cheapCheck");
    expect(plannerStrategyModelRole("strong-model")).toBe("strong");
    expect(plannerStrategyModelRole("skill-only")).toBeUndefined();
  });
});
