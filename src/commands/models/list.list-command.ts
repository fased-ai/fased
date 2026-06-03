import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { normalizeModelCatalogProviderId } from "../../agents/model-catalog-normalized.js";
import { resolveForwardCompatModel } from "../../agents/model-forward-compat.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createModelListAuthIndex } from "./list.auth-index.js";
import { resolveConfiguredEntries } from "./list.configured.js";
import { formatErrorWithStack } from "./list.errors.js";
import { loadMergedPreviewModelListSources } from "./list.preview-catalog.js";
import { loadModelRegistry, type ModelListSource, toModelRow } from "./list.registry.js";
import { printModelTable } from "./list.table.js";
import type { ModelRow } from "./list.types.js";
import { ensureFlagCompatibility, isLocalBaseUrl, modelKey } from "./shared.js";

export async function modelsListCommand(
  opts: {
    all?: boolean;
    local?: boolean;
    provider?: string;
    json?: boolean;
    plain?: boolean;
  },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const { loadConfig } = await import("../../config/config.js");
  const { ensureAuthProfileStore } = await import("../../agents/auth-profiles.js");
  const cfg = loadConfig();
  const authStore = ensureAuthProfileStore();
  const authIndex = createModelListAuthIndex({ cfg, authStore });
  const providerFilter = (() => {
    const raw = opts.provider?.trim();
    if (!raw) {
      return undefined;
    }
    return normalizeModelCatalogProviderId(raw);
  })();

  let models: ModelListSource[] = [];
  let modelRegistry: ModelRegistry | undefined;
  let availableKeys: Set<string> | undefined;
  let availabilityErrorMessage: string | undefined;
  try {
    const loaded = await loadModelRegistry(cfg);
    modelRegistry = loaded.registry;
    models = loaded.models;
    availableKeys = loaded.availableKeys;
    availabilityErrorMessage = loaded.availabilityErrorMessage;
  } catch (err) {
    if (opts.all && providerFilter) {
      models = await loadMergedPreviewModelListSources({ cfg, providerFilter });
    } else {
      runtime.error(`Model registry unavailable:\n${formatErrorWithStack(err)}`);
      process.exitCode = 1;
      return;
    }
  }
  if (availabilityErrorMessage !== undefined) {
    runtime.error(
      `Model availability lookup failed; falling back to auth heuristics for discovered models: ${availabilityErrorMessage}`,
    );
  }

  const modelByKey = new Map(models.map((model) => [modelKey(model.provider, model.id), model]));

  const { entries } = resolveConfiguredEntries(cfg);
  const configuredByKey = new Map(entries.map((entry) => [entry.key, entry]));

  const rows: ModelRow[] = [];

  if (opts.all) {
    const sorted = [...models].toSorted((a, b) => {
      const p = a.provider.localeCompare(b.provider);
      if (p !== 0) {
        return p;
      }
      return a.id.localeCompare(b.id);
    });

    for (const model of sorted) {
      if (providerFilter && normalizeModelCatalogProviderId(model.provider) !== providerFilter) {
        continue;
      }
      if (opts.local && (!model.baseUrl || !isLocalBaseUrl(model.baseUrl))) {
        continue;
      }
      const key = modelKey(model.provider, model.id);
      const configured = configuredByKey.get(key);
      if (
        !providerFilter &&
        !opts.local &&
        !configured &&
        model.baseUrl &&
        isLocalBaseUrl(model.baseUrl)
      ) {
        continue;
      }
      rows.push(
        toModelRow({
          model,
          key,
          tags: configured ? Array.from(configured.tags) : [],
          aliases: configured?.aliases ?? [],
          availableKeys,
          cfg,
          authStore,
          authIndex,
        }),
      );
    }
  } else {
    for (const entry of entries) {
      if (
        providerFilter &&
        normalizeModelCatalogProviderId(entry.ref.provider) !== providerFilter
      ) {
        continue;
      }
      let model = modelByKey.get(entry.key);
      if (!model && modelRegistry) {
        const forwardCompat = resolveForwardCompatModel(
          entry.ref.provider,
          entry.ref.model,
          modelRegistry,
        );
        if (forwardCompat) {
          model = forwardCompat;
          modelByKey.set(entry.key, forwardCompat);
        }
      }
      if (!model) {
        const { resolveModel } = await import("../../agents/pi-embedded-runner/model.js");
        model = resolveModel(entry.ref.provider, entry.ref.model, undefined, cfg).model;
      }
      if (opts.local && model && (!model.baseUrl || !isLocalBaseUrl(model.baseUrl))) {
        continue;
      }
      if (opts.local && !model) {
        continue;
      }
      rows.push(
        toModelRow({
          model,
          key: entry.key,
          tags: Array.from(entry.tags),
          aliases: entry.aliases,
          availableKeys,
          cfg,
          authStore,
          authIndex,
        }),
      );
    }
  }

  if (rows.length === 0) {
    runtime.log("No models found.");
    return;
  }

  printModelTable(rows, runtime, opts);
}
