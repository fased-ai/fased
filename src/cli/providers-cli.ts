import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { listAgentIds, resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  ensureAuthProfileStore,
  loadAuthProfileStoreForRuntime,
  type AuthProfileStore,
} from "../agents/auth-profiles.js";
import { ensureFasedModelsJson } from "../agents/models-config.js";
import { buildAuthChoiceGroups } from "../commands/auth-choice-options.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import type {
  FasedAgentConfig,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "../config/types.js";
import {
  applyProviderRefreshToRegistrySource,
  buildProviderRefreshEnvFromCredentials,
  buildProviderCapabilityOverridesSource,
  buildProviderRefreshReport,
  buildProviderRegistryReviewPatch,
  fetchOfficialProviderRefreshSnapshot,
  loadProviderRefreshSnapshotFromFile,
  type ProviderRefreshReport,
} from "../providers/refresh.js";
import { getProviderBrandManifestForRoute } from "../providers/registry.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";

export type ProvidersRefreshOptions = {
  fromFile?: string;
  json?: boolean;
  writeReview?: string;
  noNetwork?: boolean;
  apply?: boolean;
  wizard?: boolean;
};

export type ProvidersModelsAddOptions = {
  provider?: string;
  model?: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  contextWindow?: string;
  maxTokens?: string;
  reasoning?: boolean;
  vision?: boolean;
  tools?: boolean;
  json?: boolean;
  audio?: boolean;
  video?: boolean;
  speech?: boolean;
};

export type ProvidersModelsRemoveOptions = {
  provider?: string;
  model?: string;
};

const DEFAULT_REVIEW_PATH = "provider-refresh.review.patch";
const REGISTRY_PATH = "src/providers/registry.ts";
const CAPABILITIES_PATH = "src/providers/refreshed-model-capabilities.ts";
const DEFAULT_MANUAL_CONTEXT_WINDOW = 128_000;
const DEFAULT_MANUAL_MAX_TOKENS = 4_096;

function readRequiredOption(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}

function parsePositiveIntegerOption(
  value: string | undefined,
  label: string,
  fallback: number,
): number {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function modelCapabilityOptions(
  options: ProvidersModelsAddOptions,
): ModelDefinitionConfig["capabilities"] {
  const capabilities: NonNullable<ModelDefinitionConfig["capabilities"]> = {};
  if (options.tools !== undefined) {
    capabilities.tools = Boolean(options.tools);
  }
  if (options.json !== undefined) {
    capabilities.json = Boolean(options.json);
  }
  if (options.audio !== undefined) {
    capabilities.audio = Boolean(options.audio);
  }
  if (options.video !== undefined) {
    capabilities.video = Boolean(options.video);
  }
  if (options.speech !== undefined) {
    capabilities.speech = Boolean(options.speech);
  }
  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

function buildManualModelDefinition(options: ProvidersModelsAddOptions): ModelDefinitionConfig {
  const modelId = readRequiredOption(options.model, "--model");
  const input: Array<"text" | "image"> = options.vision ? ["text", "image"] : ["text"];
  const capabilities = modelCapabilityOptions(options);
  return {
    id: modelId,
    name: options.name?.trim() || modelId,
    reasoning: Boolean(options.reasoning),
    input,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: parsePositiveIntegerOption(
      options.contextWindow,
      "--context-window",
      DEFAULT_MANUAL_CONTEXT_WINDOW,
    ),
    maxTokens: parsePositiveIntegerOption(
      options.maxTokens,
      "--max-tokens",
      DEFAULT_MANUAL_MAX_TOKENS,
    ),
    ...(capabilities ? { capabilities } : {}),
  };
}

function upsertProviderModelConfig(params: {
  cfg: FasedAgentConfig;
  providerId: string;
  providerConfig: ModelProviderConfig;
}): FasedAgentConfig {
  return {
    ...params.cfg,
    models: {
      ...params.cfg.models,
      providers: {
        ...params.cfg.models?.providers,
        [params.providerId]: params.providerConfig,
      },
    },
  };
}

export async function providersModelsAddCommand(options: ProvidersModelsAddOptions): Promise<void> {
  const providerId = readRequiredOption(options.provider, "--provider");
  const model = buildManualModelDefinition(options);
  const cfg = loadConfig();
  const providers = cfg.models?.providers ?? {};
  const existing = providers[providerId];
  const baseUrl = options.baseUrl?.trim();
  if (!existing && !baseUrl) {
    throw new Error(
      `Provider "${providerId}" is not configured. Pass --base-url or configure the provider first.`,
    );
  }
  const existingModels = existing?.models ?? [];
  const nextModels = [
    ...existingModels.filter((entry) => entry.id.toLowerCase() !== model.id.toLowerCase()),
    model,
  ];
  const nextProvider = {
    ...(existing ?? {
      baseUrl: baseUrl ?? "",
      models: [],
    }),
    ...(baseUrl ? { baseUrl } : {}),
    ...(options.api?.trim() ? { api: options.api.trim() as ModelProviderConfig["api"] } : {}),
    models: nextModels,
  };
  const nextConfig = upsertProviderModelConfig({
    cfg,
    providerId,
    providerConfig: nextProvider,
  });
  await writeConfigFile(nextConfig);
  await ensureFasedModelsJson(nextConfig);
  console.log(`${theme.success("Model saved:")} ${providerId}/${model.id}`);
}

export async function providersModelsRemoveCommand(
  options: ProvidersModelsRemoveOptions,
): Promise<void> {
  const providerId = readRequiredOption(options.provider, "--provider");
  const modelId = readRequiredOption(options.model, "--model");
  const cfg = loadConfig();
  const existing = cfg.models?.providers?.[providerId];
  if (!existing) {
    throw new Error(`Provider "${providerId}" is not configured.`);
  }
  const nextModels = (existing.models ?? []).filter(
    (entry) => entry.id.toLowerCase() !== modelId.toLowerCase(),
  );
  if (nextModels.length === (existing.models ?? []).length) {
    throw new Error(`Model "${providerId}/${modelId}" is not configured.`);
  }
  const nextConfig = upsertProviderModelConfig({
    cfg,
    providerId,
    providerConfig: {
      ...existing,
      models: nextModels,
    },
  });
  await writeConfigFile(nextConfig);
  await ensureFasedModelsJson(nextConfig);
  console.log(`${theme.success("Model removed:")} ${providerId}/${modelId}`);
}

export async function providersModelsListCommand(options: { provider?: string }): Promise<void> {
  const cfg = loadConfig();
  const providers = cfg.models?.providers ?? {};
  const providerIds = options.provider?.trim()
    ? [options.provider.trim()]
    : Object.keys(providers).toSorted((left, right) => left.localeCompare(right));
  for (const providerId of providerIds) {
    const provider = providers[providerId];
    if (!provider) {
      continue;
    }
    for (const model of provider.models ?? []) {
      console.log(`${providerId}/${model.id}`);
    }
  }
}

function formatRouteSummary(route: ProviderRefreshReport["routes"][number]): string {
  if (route.missingSource) {
    const reason = route.missingSourceReason ? ` (${route.missingSourceReason})` : "";
    const detail = route.missingSourceDetail ? ` · ${route.missingSourceDetail}` : "";
    return `${route.brandId}/${route.route}: source missing${reason}, kept ${route.currentModels.length}${detail}`;
  }
  const capability =
    route.capabilityMetadata.total > 0
      ? ` · capabilities ${route.capabilityMetadata.total}/${route.discoveredModels.length}`
      : "";
  return [
    `${route.brandId}/${route.route}: ${route.currentModels.length} current -> ${route.discoveredModels.length} discovered`,
    `${route.additions.length} additions`,
    `${route.removals.length} source gaps preserved${capability}`,
  ].join(" · ");
}

function formatRouteSetupHint(route: ProviderRefreshReport["routes"][number]): string | undefined {
  if (!route.missingSource) {
    return undefined;
  }
  if (!route.missingSourceReason) {
    return undefined;
  }
  if (route.missingSourceReason === "catalog-unsupported") {
    return "No live catalog probe exists for this route yet; curated models stay available.";
  }
  const manifest = getProviderBrandManifestForRoute(route.route);
  if (!manifest) {
    return undefined;
  }
  const routeMethods = manifest.methods.filter(
    (method) => method.route === route.route || method.statusRoute === route.route,
  );
  const apiKeyMethods = routeMethods.filter((method) => method.kind === "api-key");
  const setupMethods =
    route.missingSourceReason === "credential-missing" && apiKeyMethods.length > 0
      ? apiKeyMethods
      : routeMethods;
  const labels = setupMethods.map((method) => method.label).filter(Boolean);
  const uiHint = labels.length
    ? `Open Providers > ${manifest.label} > ${labels.join(" / ")}.`
    : `Open Providers > ${manifest.label}.`;
  if (route.missingSourceReason === "base-url-missing") {
    return `${uiHint} Configure the base URL for ${route.route}, then rerun refresh.`;
  }
  const interactiveMethods = setupMethods.filter(
    (method) => method.kind === "oauth" || method.kind === "device",
  );
  if (interactiveMethods.length === 1) {
    const method = interactiveMethods[0];
    return `${uiHint} CLI: fased models auth login --provider ${method.route} --method ${method.id}.`;
  }
  return `${uiHint} Or set the env/config credential named above, then rerun refresh.`;
}

function formatProviderRefreshReport(report: ProviderRefreshReport): string {
  const lines = [
    theme.heading("Provider refresh review"),
    `${theme.muted("Source:")} ${report.source}`,
    `${theme.muted("Generated:")} ${report.generatedAt}`,
    "",
  ];
  for (const route of report.routes) {
    lines.push(formatRouteSummary(route));
    const hint = formatRouteSetupHint(route);
    if (hint) {
      lines.push(`  ${theme.muted("next")} ${hint}`);
    }
    if (route.additions.length) {
      lines.push(`  ${theme.success("add")} ${route.additions.join(", ")}`);
    }
    if (route.removals.length) {
      lines.push(`  ${theme.muted("preserve curated")} ${route.removals.join(", ")}`);
    }
  }
  return lines.join("\n");
}

async function loadProviderRefreshReport(
  options: ProvidersRefreshOptions,
): Promise<ProviderRefreshReport> {
  if (options.fromFile) {
    const snapshot = await loadProviderRefreshSnapshotFromFile(options.fromFile);
    return buildProviderRefreshReport({
      source: options.fromFile,
      snapshot,
    });
  }
  if (options.noNetwork) {
    return buildProviderRefreshReport({
      source: "local registry",
      snapshot: {},
    });
  }
  const snapshot = await fetchOfficialProviderRefreshSnapshot({
    env: loadProviderRefreshCredentialEnv(),
  });
  return buildProviderRefreshReport({
    source: "official provider catalogs",
    snapshot,
  });
}

function loadProviderRefreshCredentialEnv(): Record<string, string | undefined> {
  try {
    const cfg = loadConfig();
    const stores: AuthProfileStore[] = [];
    const seenAgentDirs = new Set<string>();
    for (const agentId of listAgentIds(cfg)) {
      const agentDir = resolveAgentDir(cfg, agentId);
      if (seenAgentDirs.has(agentDir)) {
        continue;
      }
      seenAgentDirs.add(agentDir);
      stores.push(
        loadAuthProfileStoreForRuntime(agentDir, {
          readOnly: true,
          allowKeychainPrompt: false,
        }),
      );
    }
    return buildProviderRefreshEnvFromCredentials({
      env: process.env,
      authStores: stores,
      modelProviders: cfg.models?.providers,
    });
  } catch {
    return { ...process.env };
  }
}

async function writeReviewPatch(params: {
  report: ProviderRefreshReport;
  outputPath: string;
}): Promise<string> {
  const registrySource = await readFile(REGISTRY_PATH, "utf8");
  const patch = buildProviderRegistryReviewPatch({
    registryPath: REGISTRY_PATH,
    registrySource,
    report: params.report,
  });
  const resolved = path.resolve(params.outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(
    resolved,
    patch || "# Provider registry is already aligned with the selected refresh source.\n",
    "utf8",
  );
  return resolved;
}

async function applyRegistryRefresh(
  report: ProviderRefreshReport,
): Promise<{ registryChanged: boolean; capabilitiesChanged: boolean }> {
  const registrySource = await readFile(REGISTRY_PATH, "utf8");
  const next = applyProviderRefreshToRegistrySource(registrySource, report);
  const registryChanged = next !== registrySource;
  if (registryChanged) {
    await writeFile(REGISTRY_PATH, next, "utf8");
  }
  const capabilitiesSource = buildProviderCapabilityOverridesSource(report);
  let existingCapabilities = "";
  try {
    existingCapabilities = await readFile(CAPABILITIES_PATH, "utf8");
  } catch {
    existingCapabilities = "";
  }
  const normalizeCapabilityTimestamps = (source: string) =>
    source.replace(/refreshedAt: "[^"]+",/g, 'refreshedAt: "<reviewed-at>",');
  const capabilitiesChanged =
    normalizeCapabilityTimestamps(capabilitiesSource) !==
    normalizeCapabilityTimestamps(existingCapabilities);
  if (capabilitiesChanged) {
    await writeFile(CAPABILITIES_PATH, capabilitiesSource, "utf8");
  }
  return { registryChanged, capabilitiesChanged };
}

export async function providersRefreshCommand(options: ProvidersRefreshOptions): Promise<void> {
  const report = await loadProviderRefreshReport(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatProviderRefreshReport(report));
  }

  let writeReviewPath = options.writeReview;
  let applyChanges = options.apply === true;
  if (options.wizard && !options.json) {
    const prompter = createClackPrompter();
    const choice = await prompter.select({
      message: "Provider refresh action",
      options: [
        {
          value: "write-review",
          label: "Write review patch",
          hint: "Generate a patch you can inspect before committing",
        },
        {
          value: "apply",
          label: "Apply model-list updates",
          hint: "Update src/providers/registry.ts now; review git diff afterwards",
        },
        {
          value: "none",
          label: "Report only",
          hint: "Do not write files",
        },
      ],
      initialValue: "write-review",
    });
    if (choice === "write-review") {
      writeReviewPath = "true";
    } else if (choice === "apply") {
      applyChanges = true;
    }
  }

  if (writeReviewPath) {
    const written = await writeReviewPatch({
      report,
      outputPath: writeReviewPath === "true" ? DEFAULT_REVIEW_PATH : writeReviewPath,
    });
    if (!options.json) {
      console.log("");
      console.log(`${theme.success("Review patch written:")} ${written}`);
    }
  }

  if (applyChanges) {
    const changed = await applyRegistryRefresh(report);
    if (!options.json) {
      console.log("");
      console.log(
        changed.registryChanged
          ? theme.success("Provider registry updated.")
          : theme.muted("Provider registry already matched the selected source."),
      );
      console.log(
        changed.capabilitiesChanged
          ? theme.success("Provider capability overrides updated.")
          : theme.muted("Provider capability overrides already matched the selected source."),
      );
    }
  }
}

export function registerProvidersCli(program: Command) {
  const providers = program
    .command("providers")
    .description("Review provider manifests and model catalogs");

  providers
    .command("connect")
    .description("Connect a model provider using the same auth flow as onboarding and the UI")
    .argument("[provider]", "Public provider id, for example openai or anthropic")
    .option("--method <id>", "Credential method id")
    .option("--set-default", "Apply the provider's recommended default model", false)
    .action(
      async (provider: string | undefined, options: { method?: string; setDefault?: boolean }) => {
        await providersConnectCommand({
          provider,
          method: options.method,
          setDefault: options.setDefault === true,
        });
      },
    );

  providers
    .command("refresh")
    .description("Compare provider registry against official/source catalogs")
    .option("--from-file <path>", "Use a provider refresh snapshot JSON file")
    .option("--json", "Output JSON", false)
    .option("--write-review [path]", "Write a review patch instead of applying changes")
    .option("--apply", "Apply model-list updates to src/providers/registry.ts", false)
    .option("--wizard", "Choose report/review/apply from an interactive wizard", false)
    .option("--no-network", "Do not fetch official provider docs; report local registry only")
    .action(async (opts) => {
      await providersRefreshCommand({
        fromFile: opts.fromFile as string | undefined,
        json: Boolean(opts.json),
        writeReview: opts.writeReview === true ? "true" : (opts.writeReview as string | undefined),
        noNetwork: Boolean(opts.noNetwork || opts.network === false),
        apply: Boolean(opts.apply),
        wizard: Boolean(opts.wizard),
      });
    });

  const models = providers
    .command("models")
    .description("Manage manually curated provider model entries");

  models
    .command("list")
    .description("List configured provider model entries")
    .option("--provider <id>", "Only list one provider")
    .action(async (opts) => {
      await providersModelsListCommand({ provider: opts.provider as string | undefined });
    });

  models
    .command("add")
    .description("Add or update a configured provider model entry")
    .requiredOption("--provider <id>", "Provider id, e.g. openai or custom-local")
    .requiredOption("--model <id>", "Model id without provider prefix")
    .option("--name <label>", "Human label")
    .option("--base-url <url>", "Base URL when creating a provider entry")
    .option("--api <api>", "Provider API adapter, e.g. openai-responses or anthropic-messages")
    .option("--context-window <tokens>", "Context window tokens")
    .option("--max-tokens <tokens>", "Max output tokens")
    .option("--reasoning", "Mark the model as reasoning-capable", false)
    .option("--vision", "Mark image input support", false)
    .option("--tools", "Mark tool-call support", false)
    .option("--json", "Mark JSON output support", false)
    .option("--audio", "Mark audio support", false)
    .option("--video", "Mark video support", false)
    .option("--speech", "Mark speech/TTS support", false)
    .action(async (opts) => {
      await providersModelsAddCommand({
        provider: opts.provider as string | undefined,
        model: opts.model as string | undefined,
        name: opts.name as string | undefined,
        baseUrl: opts.baseUrl as string | undefined,
        api: opts.api as string | undefined,
        contextWindow: opts.contextWindow as string | undefined,
        maxTokens: opts.maxTokens as string | undefined,
        reasoning: Boolean(opts.reasoning),
        vision: Boolean(opts.vision),
        tools: opts.tools === true ? true : undefined,
        json: opts.json === true ? true : undefined,
        audio: opts.audio === true ? true : undefined,
        video: opts.video === true ? true : undefined,
        speech: opts.speech === true ? true : undefined,
      });
    });

  models
    .command("remove")
    .alias("delete")
    .description("Remove a configured provider model entry")
    .requiredOption("--provider <id>", "Provider id")
    .requiredOption("--model <id>", "Model id without provider prefix")
    .action(async (opts) => {
      await providersModelsRemoveCommand({
        provider: opts.provider as string | undefined,
        model: opts.model as string | undefined,
      });
    });
}

export async function providersConnectCommand(options: {
  provider?: string;
  method?: string;
  setDefault?: boolean;
}) {
  if (!process.stdin.isTTY) {
    throw new Error("providers connect requires an interactive TTY.");
  }
  const config = loadConfig();
  const [{ applyAuthChoice }, { openUrl }] = await Promise.all([
    import("../commands/auth-choice.js"),
    import("../commands/onboard-helpers.js"),
  ]);
  const agentId = resolveDefaultAgentId(config);
  const agentDir = resolveAgentDir(config, agentId);
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const { groups } = buildAuthChoiceGroups({ store, includeSkip: false });
  const requestedProvider = options.provider?.trim().toLowerCase();
  const prompter = createClackPrompter();
  let selectedGroup = requestedProvider
    ? groups.find(
        (candidate) =>
          String(candidate.value).toLowerCase() === requestedProvider ||
          candidate.label.toLowerCase() === requestedProvider,
      )
    : undefined;
  if (!requestedProvider) {
    const selectedProvider = await prompter.select({
      message: "Model provider",
      options: groups.map((candidate) => ({
        value: candidate.value,
        label: candidate.label,
        hint: candidate.hint,
      })),
    });
    selectedGroup = groups.find(
      (candidate) => String(candidate.value) === String(selectedProvider),
    );
  }
  if (!selectedGroup) {
    throw new Error(
      `Unknown provider: ${options.provider}. Run \`fased providers connect\` to choose.`,
    );
  }
  const requestedMethod = options.method?.trim();
  let method = requestedMethod
    ? selectedGroup.options.find((candidate) => String(candidate.value) === requestedMethod)
    : selectedGroup.options.length === 1
      ? selectedGroup.options[0]
      : undefined;
  if (!requestedMethod && selectedGroup.options.length > 1) {
    const selectedMethod = await prompter.select({
      message: `${selectedGroup.label} auth method`,
      options: selectedGroup.options,
    });
    method = selectedGroup.options.find(
      (candidate) => String(candidate.value) === String(selectedMethod),
    );
  }
  if (!method) {
    throw new Error(
      `Unknown auth method for ${selectedGroup.label}: ${options.method ?? "(none)"}`,
    );
  }
  const result = await applyAuthChoice({
    authChoice: method.value,
    config,
    prompter,
    runtime: defaultRuntime,
    openUrl: async (url) => {
      await openUrl(url);
    },
    agentDir,
    agentId,
    setDefaultModel: options.setDefault === true,
    opts: {},
  });
  await writeConfigFile(result.config);
  await ensureFasedModelsJson(result.config, agentDir);
  defaultRuntime.log(`${theme.success("Provider connected:")} ${selectedGroup.label}`);
}
