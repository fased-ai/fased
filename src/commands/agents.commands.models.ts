import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { requireValidConfig } from "./agents.command-shared.js";
import { applyAgentConfig, listAgentEntries } from "./agents.config.js";

export type AgentsModelsSetOptions = {
  agent?: string;
  primary?: string;
  fallbacks?: string[];
  cheapCheck?: string;
  strong?: string;
  escalation?: string;
  coding?: string;
  summarizer?: string;
  json?: boolean;
};

function clean(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export async function agentsModelsSetCommand(
  opts: AgentsModelsSetOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }
  const agentId = normalizeAgentId(clean(opts.agent) ?? resolveDefaultAgentId(cfg));
  const current = listAgentEntries(cfg).find((entry) => normalizeAgentId(entry.id) === agentId);
  const primary = clean(opts.primary) ?? resolveAgentModelPrimaryValue(current?.model);
  const fallbacks =
    opts.fallbacks !== undefined
      ? [...new Set(opts.fallbacks.map((entry) => entry.trim()).filter(Boolean))]
      : resolveAgentModelFallbackValues(current?.model);
  const taskModels = {
    ...current?.taskModels,
    ...(opts.cheapCheck !== undefined ? { cheapCheck: clean(opts.cheapCheck) } : {}),
    ...(opts.strong !== undefined ? { strong: clean(opts.strong) } : {}),
    ...(opts.escalation !== undefined ? { escalation: clean(opts.escalation) } : {}),
    ...(opts.coding !== undefined ? { coding: clean(opts.coding) } : {}),
    ...(opts.summarizer !== undefined ? { summarizer: clean(opts.summarizer) } : {}),
  };
  const normalizedTaskModels = Object.fromEntries(
    Object.entries(taskModels).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  if (!primary && fallbacks.length === 0 && Object.keys(normalizedTaskModels).length === 0) {
    runtime.error("Set at least one model with --primary, --fallback, or a task-role option.");
    runtime.exit(1);
    return;
  }

  const model = primary ? (fallbacks.length > 0 ? { primary, fallbacks } : primary) : { fallbacks };
  const next = applyAgentConfig(cfg, {
    agentId,
    model,
    taskModels: normalizedTaskModels,
    activeModelProvider: null,
    modelProviders: null,
  });
  await writeConfigFile(next);
  if (!opts.json) {
    logConfigUpdated(runtime);
  }
  const payload = { agentId, model, taskModels: normalizedTaskModels };
  runtime.log(opts.json ? JSON.stringify(payload, null, 2) : `Agent models updated: ${agentId}`);
}
