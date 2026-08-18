import type { CliDeps } from "../../cli/deps.js";
import { loadConfig } from "../../config/config.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import type { CronJob } from "../../cron/types.js";

export type GatewayAgentExecutionFacade = {
  runHookAgent(params: {
    deps: CliDeps;
    job: CronJob;
    message: string;
    sessionKey: string;
  }): ReturnType<typeof runCronIsolatedAgentTurn>;
};

type GatewayAgentExecutionFacadeDependencies = {
  loadConfig: typeof loadConfig;
  runIsolatedAgentTurn: typeof runCronIsolatedAgentTurn;
};

export function createGatewayAgentExecutionFacade(
  overrides: Partial<GatewayAgentExecutionFacadeDependencies> = {},
): GatewayAgentExecutionFacade {
  const dependencies: GatewayAgentExecutionFacadeDependencies = {
    loadConfig,
    runIsolatedAgentTurn: runCronIsolatedAgentTurn,
    ...overrides,
  };

  return {
    runHookAgent: ({ deps, job, message, sessionKey }) =>
      dependencies.runIsolatedAgentTurn({
        cfg: dependencies.loadConfig(),
        deps,
        job,
        message,
        sessionKey,
        lane: "cron",
      }),
  };
}
