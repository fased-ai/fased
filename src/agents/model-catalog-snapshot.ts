import type { FasedAgentConfig } from "../config/config.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import { resolveTaskModelRole, type CronTaskModelRole } from "../cron/task-model-roles.js";
import {
  resolveAgentEffectiveModelPrimary,
  resolveAgentModelFallbacksOverride,
} from "./agent-scope.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { resolveAuthenticatedModelCatalog } from "./authenticated-model-catalog.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import { deriveModelMetadata, type ModelMetadata } from "./model-metadata.js";

export type ModelAssignmentRole =
  | "primary"
  | "fallback"
  | "cheapCheck"
  | "strong"
  | "escalation"
  | "coding"
  | "summarizer";

export type CanonicalModelCatalogEntry = ModelCatalogEntry & {
  metadata: ModelMetadata;
  available: true;
  runnable: boolean;
  recommended: boolean;
  assignedRoles: ModelAssignmentRole[];
};

export type CanonicalModelAssignment = {
  role: ModelAssignmentRole;
  ref: string;
  available: boolean;
};

export type CanonicalProviderCatalogSummary = {
  id: string;
  label: string;
  routes: string[];
  credentialRoutes: Array<{
    id: string;
    label: string;
    authMode: string;
  }>;
  available: number;
  recommended: number;
  assigned: number;
};

export type CanonicalModelCatalogSnapshot = {
  generatedAt: string;
  agentId: string;
  models: CanonicalModelCatalogEntry[];
  providers: CanonicalProviderCatalogSummary[];
  assignments: CanonicalModelAssignment[];
};

const TASK_ROLES: CronTaskModelRole[] = [
  "cheapCheck",
  "strong",
  "escalation",
  "coding",
  "summarizer",
];

function normalizeRef(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function collectAssignments(params: {
  cfg: FasedAgentConfig;
  agentId: string;
}): Array<{ role: ModelAssignmentRole; ref: string }> {
  const assignments: Array<{ role: ModelAssignmentRole; ref: string }> = [];
  const add = (role: ModelAssignmentRole, ref: string | undefined) => {
    const normalized = normalizeRef(ref);
    if (
      normalized &&
      !assignments.some((entry) => entry.role === role && entry.ref === normalized)
    ) {
      assignments.push({ role, ref: normalized });
    }
  };

  add("primary", resolveAgentEffectiveModelPrimary(params.cfg, params.agentId));
  const fallbacks =
    resolveAgentModelFallbacksOverride(params.cfg, params.agentId) ??
    resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
  for (const fallback of fallbacks) {
    add("fallback", fallback);
  }
  for (const role of TASK_ROLES) {
    add(role, resolveTaskModelRole({ cfg: params.cfg, agentId: params.agentId, role })?.model);
  }
  return assignments;
}

function modelRef(model: Pick<ModelCatalogEntry, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

function buildProviderSummaries(
  models: CanonicalModelCatalogEntry[],
): CanonicalProviderCatalogSummary[] {
  const summaries = new Map<string, CanonicalProviderCatalogSummary>();
  for (const model of models) {
    const providerId = model.metadata.publicProviderId;
    const existing = summaries.get(providerId) ?? {
      id: providerId,
      label: model.metadata.publicProviderLabel,
      routes: [],
      credentialRoutes: [],
      available: 0,
      recommended: 0,
      assigned: 0,
    };
    if (!existing.routes.includes(model.provider)) {
      existing.routes.push(model.provider);
    }
    for (const route of model.metadata.credentialRoutes) {
      if (!existing.credentialRoutes.some((entry) => entry.id === route.id)) {
        existing.credentialRoutes.push(route);
      }
    }
    existing.available += 1;
    existing.recommended += model.recommended ? 1 : 0;
    existing.assigned += model.assignedRoles.length > 0 ? 1 : 0;
    summaries.set(providerId, existing);
  }
  return [...summaries.values()]
    .map((summary) => ({
      ...summary,
      routes: summary.routes.toSorted(),
      credentialRoutes: summary.credentialRoutes.toSorted((left, right) =>
        left.label.localeCompare(right.label),
      ),
    }))
    .toSorted((left, right) => left.label.localeCompare(right.label));
}

export async function resolveCanonicalModelCatalogSnapshot(params: {
  cfg: FasedAgentConfig;
  store: AuthProfileStore;
  catalog: ModelCatalogEntry[];
  defaultProvider: string;
  agentId: string;
  agentDir?: string;
}): Promise<CanonicalModelCatalogSnapshot> {
  const authenticated = await resolveAuthenticatedModelCatalog({
    cfg: params.cfg,
    store: params.store,
    catalog: params.catalog,
    defaultProvider: params.defaultProvider,
    agentDir: params.agentDir,
  });
  const configuredAssignments = collectAssignments({ cfg: params.cfg, agentId: params.agentId });
  const assignmentsByRef = new Map<string, ModelAssignmentRole[]>();
  for (const assignment of configuredAssignments) {
    assignmentsByRef.set(assignment.ref, [
      ...(assignmentsByRef.get(assignment.ref) ?? []),
      assignment.role,
    ]);
  }
  const availableRefs = new Set(authenticated.usableCatalog.map(modelRef));
  const runnableRefs = new Set(authenticated.allowedCatalog.map(modelRef));
  const models = authenticated.usableCatalog
    .map((model): CanonicalModelCatalogEntry => {
      const metadata = model.metadata ?? deriveModelMetadata({ model, cfg: params.cfg });
      return {
        ...model,
        metadata,
        available: true,
        runnable: authenticated.allowAny || runnableRefs.has(modelRef(model)),
        recommended: metadata.recommended === true,
        assignedRoles: assignmentsByRef.get(modelRef(model)) ?? [],
      };
    })
    .toSorted(
      (left, right) =>
        left.metadata.publicProviderLabel.localeCompare(right.metadata.publicProviderLabel) ||
        Number(right.recommended) - Number(left.recommended) ||
        (left.metadata.recommendationRank ?? Number.MAX_SAFE_INTEGER) -
          (right.metadata.recommendationRank ?? Number.MAX_SAFE_INTEGER) ||
        left.name.localeCompare(right.name),
    );

  return {
    generatedAt: new Date().toISOString(),
    agentId: params.agentId,
    models,
    providers: buildProviderSummaries(models),
    assignments: configuredAssignments.map((assignment) => ({
      ...assignment,
      available: availableRefs.has(assignment.ref),
    })),
  };
}
