import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";
import { WizardStartResultSchema } from "./wizard.js";

export const ModelChoiceSchema = Type.Object(
  {
    id: NonEmptyString,
    name: NonEmptyString,
    provider: NonEmptyString,
    contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
    maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    reasoning: Type.Optional(Type.Boolean()),
    input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
    baseUrl: Type.Optional(NonEmptyString),
    api: Type.Optional(NonEmptyString),
    catalogSource: Type.Optional(
      Type.Union([
        Type.Literal("configured"),
        Type.Literal("runtime"),
        Type.Literal("provider-api"),
        Type.Literal("current-preview"),
        Type.Literal("provider-index"),
        Type.Literal("manifest"),
      ]),
    ),
    available: Type.Optional(Type.Boolean()),
    runnable: Type.Optional(Type.Boolean()),
    recommended: Type.Optional(Type.Boolean()),
    assignedRoles: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Literal("primary"),
          Type.Literal("fallback"),
          Type.Literal("cheapCheck"),
          Type.Literal("strong"),
          Type.Literal("escalation"),
          Type.Literal("coding"),
          Type.Literal("summarizer"),
        ]),
      ),
    ),
    metadata: Type.Optional(
      Type.Object(
        {
          ref: NonEmptyString,
          provider: NonEmptyString,
          publicProviderId: NonEmptyString,
          publicProviderLabel: NonEmptyString,
          model: NonEmptyString,
          label: NonEmptyString,
          contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
          maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
          apiRoute: Type.Optional(NonEmptyString),
          features: Type.Array(
            Type.Union([
              Type.Literal("text"),
              Type.Literal("vision"),
              Type.Literal("reasoning"),
              Type.Literal("tools"),
              Type.Literal("json"),
              Type.Literal("audio"),
              Type.Literal("video"),
              Type.Literal("speech"),
            ]),
          ),
          thinkingLevels: Type.Optional(
            Type.Array(
              Type.Union([
                Type.Literal("off"),
                Type.Literal("minimal"),
                Type.Literal("low"),
                Type.Literal("medium"),
                Type.Literal("high"),
                Type.Literal("xhigh"),
                Type.Literal("max"),
                Type.Literal("ultra"),
              ]),
            ),
          ),
          defaultThinkingLevel: Type.Optional(
            Type.Union([
              Type.Literal("off"),
              Type.Literal("minimal"),
              Type.Literal("low"),
              Type.Literal("medium"),
              Type.Literal("high"),
              Type.Literal("xhigh"),
              Type.Literal("max"),
              Type.Literal("ultra"),
            ]),
          ),
          thinkingMode: Type.Optional(
            Type.Union([
              Type.Literal("openai-reasoning-effort"),
              Type.Literal("anthropic-thinking-budget"),
              Type.Literal("anthropic-adaptive"),
              Type.Literal("google-thinking-budget"),
              Type.Literal("xai-reasoning-effort"),
              Type.Literal("xai-multi-agent-effort"),
              Type.Literal("mistral-reasoning-effort"),
              Type.Literal("volcengine-reasoning-effort"),
              Type.Literal("byteplus-thinking-type"),
              Type.Literal("zai-binary"),
              Type.Literal("qwen-thinking"),
              Type.Literal("moonshot-thinking"),
              Type.Literal("generic-reasoning"),
            ]),
          ),
          reasoningBudgetSupported: Type.Optional(Type.Boolean()),
          streaming: Type.Boolean(),
          capabilityConfidence: Type.Union([
            Type.Literal("verified"),
            Type.Literal("declared"),
            Type.Literal("inferred"),
            Type.Literal("unknown"),
          ]),
          capabilitySource: Type.Union([
            Type.Literal("provider-api"),
            Type.Literal("official-docs"),
            Type.Literal("runtime"),
            Type.Literal("configured"),
            Type.Literal("inferred"),
            Type.Literal("unknown"),
          ]),
          capabilityRetrievedAt: Type.Optional(NonEmptyString),
          retrievedAt: NonEmptyString,
          availabilitySource: Type.Union([
            Type.Literal("provider-api"),
            Type.Literal("runtime-catalog"),
            Type.Literal("configured"),
            Type.Literal("provider-plugin"),
            Type.Literal("reviewed-catalog"),
            Type.Literal("curated-recommendation"),
          ]),
          authRoute: NonEmptyString,
          authMode: Type.Union([
            Type.Literal("api-key"),
            Type.Literal("oauth"),
            Type.Literal("token"),
            Type.Literal("aws-sdk"),
          ]),
          credentialRoute: Type.Object(
            {
              id: NonEmptyString,
              label: NonEmptyString,
              authMode: Type.Union([
                Type.Literal("api-key"),
                Type.Literal("oauth"),
                Type.Literal("token"),
                Type.Literal("aws-sdk"),
              ]),
            },
            { additionalProperties: false },
          ),
          credentialRoutes: Type.Array(
            Type.Object(
              {
                id: NonEmptyString,
                label: NonEmptyString,
                authMode: Type.Union([
                  Type.Literal("api-key"),
                  Type.Literal("oauth"),
                  Type.Literal("token"),
                  Type.Literal("aws-sdk"),
                ]),
              },
              { additionalProperties: false },
            ),
            { minItems: 1 },
          ),
          price: Type.Optional(
            Type.Object(
              {
                input: Type.Number({ minimum: 0 }),
                output: Type.Number({ minimum: 0 }),
                cacheRead: Type.Number({ minimum: 0 }),
                cacheWrite: Type.Number({ minimum: 0 }),
                unit: Type.Literal("usd-per-million-tokens"),
              },
              { additionalProperties: false },
            ),
          ),
          privateNetwork: Type.Boolean(),
          privateNetworkAllowed: Type.Boolean(),
          recommended: Type.Optional(Type.Boolean()),
          recommendationRank: Type.Optional(Type.Integer({ minimum: 1 })),
          default: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const AgentSummarySchema = Type.Object(
  {
    id: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    identity: Type.Optional(
      Type.Object(
        {
          name: Type.Optional(NonEmptyString),
          theme: Type.Optional(NonEmptyString),
          emoji: Type.Optional(NonEmptyString),
          avatar: Type.Optional(NonEmptyString),
          avatarUrl: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const AgentTaskModelSlotsSchema = Type.Object(
  {
    cheapCheck: Type.Optional(Type.String()),
    strong: Type.Optional(Type.String()),
    escalation: Type.Optional(Type.String()),
    coding: Type.Optional(Type.String()),
    summarizer: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentModelProviderSettingsSchema = Type.Object(
  {
    profileId: Type.Optional(Type.String()),
    primary: Type.Optional(Type.String()),
    fallbacks: Type.Optional(Type.Array(Type.String())),
    taskModels: Type.Optional(AgentTaskModelSlotsSchema),
  },
  { additionalProperties: false },
);

export const AgentsListParamsSchema = Type.Object({}, { additionalProperties: false });

export const AgentsListResultSchema = Type.Object(
  {
    defaultId: NonEmptyString,
    mainKey: NonEmptyString,
    scope: Type.Union([Type.Literal("per-sender"), Type.Literal("global")]),
    agents: Type.Array(AgentSummarySchema),
  },
  { additionalProperties: false },
);

export const AgentsCreateParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    workspace: NonEmptyString,
    model: Type.Optional(NonEmptyString),
    emoji: Type.Optional(Type.String()),
    avatar: Type.Optional(Type.String()),
    personaTemplateId: Type.Optional(
      Type.Union([
        Type.Literal("private-operator"),
        Type.Literal("mining-operator"),
        Type.Literal("market-researcher"),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const AgentsCreateResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    name: NonEmptyString,
    workspace: NonEmptyString,
    model: Type.Optional(NonEmptyString),
    personaTemplateId: Type.Union([
      Type.Literal("private-operator"),
      Type.Literal("mining-operator"),
      Type.Literal("market-researcher"),
    ]),
  },
  { additionalProperties: false },
);

export const AgentsUpdateParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    workspace: Type.Optional(NonEmptyString),
    activeModelProvider: Type.Optional(Type.String()),
    modelProviders: Type.Optional(Type.Record(Type.String(), AgentModelProviderSettingsSchema)),
    model: Type.Optional(NonEmptyString),
    taskModels: Type.Optional(AgentTaskModelSlotsSchema),
    avatar: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentsUpdateResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsDeleteParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    deleteFiles: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentsDeleteResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    removedBindings: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const AgentsFileEntrySchema = Type.Object(
  {
    name: NonEmptyString,
    path: NonEmptyString,
    missing: Type.Boolean(),
    size: Type.Optional(Type.Integer({ minimum: 0 })),
    updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    content: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentsFilesListParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsFilesListResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    files: Type.Array(AgentsFileEntrySchema),
  },
  { additionalProperties: false },
);

export const AgentsFilesGetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsFilesGetResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    file: AgentsFileEntrySchema,
  },
  { additionalProperties: false },
);

export const AgentsFilesSetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: NonEmptyString,
    content: Type.String(),
  },
  { additionalProperties: false },
);

export const AgentsFilesSetResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    file: AgentsFileEntrySchema,
  },
  { additionalProperties: false },
);

export const ModelsListParamsSchema = Type.Object(
  {
    all: Type.Optional(Type.Boolean()),
    available: Type.Optional(Type.Boolean()),
    provider: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    includeMetadata: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ModelsListResultSchema = Type.Object(
  {
    models: Type.Array(ModelChoiceSchema),
    generatedAt: Type.Optional(NonEmptyString),
    agentId: Type.Optional(NonEmptyString),
    providers: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: NonEmptyString,
            label: NonEmptyString,
            routes: Type.Array(NonEmptyString),
            credentialRoutes: Type.Array(
              Type.Object(
                {
                  id: NonEmptyString,
                  label: NonEmptyString,
                  authMode: NonEmptyString,
                },
                { additionalProperties: false },
              ),
            ),
            available: Type.Integer({ minimum: 0 }),
            recommended: Type.Integer({ minimum: 0 }),
            assigned: Type.Integer({ minimum: 0 }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    assignments: Type.Optional(
      Type.Array(
        Type.Object(
          {
            role: Type.Union([
              Type.Literal("primary"),
              Type.Literal("fallback"),
              Type.Literal("cheapCheck"),
              Type.Literal("strong"),
              Type.Literal("escalation"),
              Type.Literal("coding"),
              Type.Literal("summarizer"),
            ]),
            ref: NonEmptyString,
            available: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

export const ModelsCatalogStatusParamsSchema = Type.Object({}, { additionalProperties: false });

export const ModelsCatalogStatusProviderSchema = Type.Object(
  {
    provider: NonEmptyString,
    totalModels: Type.Integer({ minimum: 0 }),
    configured: Type.Boolean(),
    reasoningModels: Type.Integer({ minimum: 0 }),
    visionModels: Type.Integer({ minimum: 0 }),
    sources: Type.Array(NonEmptyString),
    sourceConfidence: NonEmptyString,
    capabilityCounts: Type.Object(
      {
        textModels: Type.Integer({ minimum: 0 }),
        visionModels: Type.Integer({ minimum: 0 }),
        reasoningModels: Type.Integer({ minimum: 0 }),
        toolsModels: Type.Integer({ minimum: 0 }),
        jsonModels: Type.Integer({ minimum: 0 }),
        audioModels: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    authModes: Type.Array(NonEmptyString),
    privateNetwork: Type.Object(
      {
        models: Type.Integer({ minimum: 0 }),
        allowed: Type.Integer({ minimum: 0 }),
        blocked: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    probeStatus: Type.Union([
      Type.Literal("not-run"),
      Type.Literal("ok"),
      Type.Literal("warn"),
      Type.Literal("fail"),
      Type.Literal("unknown"),
    ]),
    health: Type.Optional(
      Type.Object(
        {
          reachable: Type.Union([
            Type.Literal("ok"),
            Type.Literal("fail"),
            Type.Literal("unknown"),
          ]),
          auth: Type.Union([Type.Literal("ok"), Type.Literal("fail"), Type.Literal("unknown")]),
          modelsDiscovered: Type.Integer({ minimum: 0 }),
          privateNetworkApproved: Type.Boolean(),
          checkedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
          detail: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    maxContextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
    maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const ModelsCatalogStatusCacheSchema = Type.Object(
  {
    modelCatalog: NonEmptyString,
    providerExtensionCatalog: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ModelsCatalogStatusProviderExtensionEntrySchema = Type.Object(
  {
    id: NonEmptyString,
    source: NonEmptyString,
    trusted: Type.Boolean(),
    providerIds: Type.Array(NonEmptyString),
    loadedProviderIds: Type.Array(NonEmptyString),
    modelCount: Type.Integer({ minimum: 0 }),
    status: Type.Union([
      Type.Literal("loaded"),
      Type.Literal("skipped-untrusted"),
      Type.Literal("empty"),
      Type.Literal("error"),
    ]),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ModelsCatalogStatusProviderExtensionCatalogSchema = Type.Object(
  {
    totalEntries: Type.Integer({ minimum: 0 }),
    loadedEntries: Type.Integer({ minimum: 0 }),
    skippedUntrustedEntries: Type.Integer({ minimum: 0 }),
    emptyEntries: Type.Integer({ minimum: 0 }),
    errorEntries: Type.Integer({ minimum: 0 }),
    modelCount: Type.Integer({ minimum: 0 }),
    loadedProviderIds: Type.Array(NonEmptyString),
    warnings: Type.Array(ModelsCatalogStatusProviderExtensionEntrySchema),
    entries: Type.Array(ModelsCatalogStatusProviderExtensionEntrySchema),
  },
  { additionalProperties: false },
);

export const ModelsCatalogStatusProviderExtensionManifestSchema = Type.Object(
  {
    upstreamProviderCount: Type.Integer({ minimum: 0 }),
    mappedProviderCount: Type.Integer({ minimum: 0 }),
    deferredProviderCount: Type.Integer({ minimum: 0 }),
    mappedProviderIds: Type.Array(NonEmptyString),
    deferredProviderIds: Type.Array(NonEmptyString),
    missingMappedProviderIds: Type.Array(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ModelsCatalogStatusResultSchema = Type.Object(
  {
    checkedAtMs: Type.Integer({ minimum: 0 }),
    cache: ModelsCatalogStatusCacheSchema,
    totalProviders: Type.Integer({ minimum: 0 }),
    totalModels: Type.Integer({ minimum: 0 }),
    configuredProviders: Type.Integer({ minimum: 0 }),
    availableProviders: Type.Integer({ minimum: 0 }),
    reasoningModels: Type.Integer({ minimum: 0 }),
    visionModels: Type.Integer({ minimum: 0 }),
    capabilityCounts: Type.Object(
      {
        textModels: Type.Integer({ minimum: 0 }),
        visionModels: Type.Integer({ minimum: 0 }),
        reasoningModels: Type.Integer({ minimum: 0 }),
        toolsModels: Type.Integer({ minimum: 0 }),
        jsonModels: Type.Integer({ minimum: 0 }),
        audioModels: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    sourceCounts: Type.Record(NonEmptyString, Type.Integer({ minimum: 0 })),
    providers: Type.Array(ModelsCatalogStatusProviderSchema),
    providerExtensionCatalog: ModelsCatalogStatusProviderExtensionCatalogSchema,
    providerExtensionManifest: ModelsCatalogStatusProviderExtensionManifestSchema,
  },
  { additionalProperties: false },
);

export const ModelsAuthStatusParamsSchema = Type.Object({}, { additionalProperties: false });

export const ModelsAuthStatusKindSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("expiring"),
  Type.Literal("refresh-required"),
  Type.Literal("expired"),
  Type.Literal("missing"),
  Type.Literal("static"),
]);

export const ModelsAuthStatusEffectiveSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("profiles"),
      Type.Literal("env"),
      Type.Literal("models.json"),
      Type.Literal("local"),
      Type.Literal("missing"),
    ]),
    detail: Type.String(),
  },
  { additionalProperties: false },
);

export const ModelsAuthStatusProfileSchema = Type.Object(
  {
    profileId: NonEmptyString,
    provider: NonEmptyString,
    type: Type.Union([Type.Literal("oauth"), Type.Literal("token"), Type.Literal("api_key")]),
    status: ModelsAuthStatusKindSchema,
    label: Type.String(),
    expiresAt: Type.Optional(Type.Integer()),
    remainingMs: Type.Optional(Type.Integer()),
    source: Type.Literal("store"),
    unusableKind: Type.Optional(Type.Union([Type.Literal("cooldown"), Type.Literal("disabled")])),
    unusableUntil: Type.Optional(Type.Integer({ minimum: 1 })),
    unusableReason: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ModelsAuthStatusProviderSchema = Type.Object(
  {
    provider: NonEmptyString,
    status: ModelsAuthStatusKindSchema,
    expiresAt: Type.Optional(Type.Integer()),
    remainingMs: Type.Optional(Type.Integer()),
    effective: ModelsAuthStatusEffectiveSchema,
    profiles: Type.Array(ModelsAuthStatusProfileSchema),
  },
  { additionalProperties: false },
);

export const ModelsAuthStatusResultSchema = Type.Object(
  {
    storePath: NonEmptyString,
    warnAfterMs: Type.Integer({ minimum: 1 }),
    providers: Type.Array(ModelsAuthStatusProviderSchema),
  },
  { additionalProperties: false },
);

export const ModelsAuthStoreModeSchema = Type.Union([
  Type.Literal("api_key"),
  Type.Literal("token"),
]);

export const ModelsAuthStoreParamsSchema = Type.Object(
  {
    profileId: NonEmptyString,
    provider: NonEmptyString,
    mode: ModelsAuthStoreModeSchema,
    secret: NonEmptyString,
    email: Type.Optional(Type.String()),
    expiresAtMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const ModelsAuthStoreResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    profileId: NonEmptyString,
    provider: NonEmptyString,
    mode: ModelsAuthStoreModeSchema,
  },
  { additionalProperties: false },
);

export const ModelsAuthConfigureParamsSchema = Type.Object(
  {
    provider: NonEmptyString,
    secret: Type.Optional(NonEmptyString),
    profileId: Type.Optional(NonEmptyString),
    setDefaultModel: Type.Optional(Type.Boolean()),
    baseUrl: Type.Optional(NonEmptyString),
    modelId: Type.Optional(NonEmptyString),
    compatibility: Type.Optional(
      Type.Union([Type.Literal("openai"), Type.Literal("anthropic"), Type.Literal("unknown")]),
    ),
    customProviderId: Type.Optional(NonEmptyString),
    alias: Type.Optional(NonEmptyString),
    allowPrivateNetwork: Type.Optional(Type.Boolean()),
    accountId: Type.Optional(NonEmptyString),
    gatewayId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ModelsAuthConfigureResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    provider: NonEmptyString,
    authChoice: NonEmptyString,
    configured: Type.Boolean(),
    profileId: Type.Optional(NonEmptyString),
    defaultModel: Type.Optional(NonEmptyString),
    detail: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ModelsAuthClearParamsSchema = Type.Object(
  {
    profileId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ModelsAuthClearResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    profileId: NonEmptyString,
    cleared: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ModelsAuthInteractiveStartParamsSchema = Type.Object(
  {
    provider: NonEmptyString,
    methodId: Type.Optional(Type.String()),
    replaceRunning: Type.Optional(Type.Boolean()),
    browserLocal: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ModelsAuthInteractiveStartResultSchema = WizardStartResultSchema;

export const SkillsStatusParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsBinsParamsSchema = Type.Object({}, { additionalProperties: false });

export const SkillsBinsResultSchema = Type.Object(
  {
    bins: Type.Array(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ClawHubSkillSearchResultSchema = Type.Object(
  {
    score: Type.Number(),
    slug: NonEmptyString,
    displayName: NonEmptyString,
    summary: Type.Optional(Type.String()),
    version: Type.Optional(Type.String()),
    updatedAt: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

export const SkillsSearchParamsSchema = Type.Object(
  {
    query: Type.String(),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

export const SkillsSearchResultSchema = Type.Object(
  {
    results: Type.Array(ClawHubSkillSearchResultSchema),
  },
  { additionalProperties: false },
);

export const SkillsDetailParamsSchema = Type.Object(
  {
    slug: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SkillsDetailResultSchema = Type.Any();

export const SkillsMarketplaceTargetSchema = Type.Object(
  {
    scope: Type.Union([
      Type.Literal("shared"),
      Type.Literal("agent"),
      Type.Literal("default-agent"),
    ]),
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsMarketplaceInstallParamsSchema = Type.Object(
  {
    slug: NonEmptyString,
    version: Type.Optional(NonEmptyString),
    target: Type.Optional(SkillsMarketplaceTargetSchema),
    allowPermissionChanges: Type.Optional(Type.Boolean()),
    force: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const SkillsMarketplaceInstallResultSchema = Type.Any();

export const SkillsMarketplaceInstallPreviewParamsSchema = Type.Object(
  {
    slug: NonEmptyString,
    version: Type.Optional(NonEmptyString),
    target: Type.Optional(SkillsMarketplaceTargetSchema),
  },
  { additionalProperties: false },
);

export const SkillsMarketplaceInstallPreviewResultSchema = Type.Any();

export const SkillsMarketplaceUpdatePreviewParamsSchema = Type.Object(
  {
    slug: Type.Optional(NonEmptyString),
    target: Type.Optional(SkillsMarketplaceTargetSchema),
  },
  { additionalProperties: false },
);

export const SkillsMarketplaceUpdatePreviewResultSchema = Type.Any();

export const SkillsMarketplaceUpdateParamsSchema = Type.Object(
  {
    slug: Type.Optional(NonEmptyString),
    target: Type.Optional(SkillsMarketplaceTargetSchema),
    allowPermissionChanges: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const SkillsMarketplaceUpdateResultSchema = Type.Any();

export const SkillsWalletGrantsParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsWalletGrantsResultSchema = Type.Any();

export const SkillsWalletGrantSetParamsSchema = Type.Object(
  {
    skillId: NonEmptyString,
    actions: Type.Array(NonEmptyString),
    registry: Type.Optional(Type.Array(NonEmptyString)),
    walletId: Type.Optional(Type.Array(NonEmptyString)),
    chain: Type.Optional(Type.Array(NonEmptyString)),
    inputMint: Type.Optional(Type.Array(NonEmptyString)),
    outputMint: Type.Optional(Type.Array(NonEmptyString)),
    maxAmount: Type.Optional(Type.String()),
    maxSlippageBps: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    autonomous: Type.Optional(Type.Boolean()),
    cron: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const SkillsWalletGrantSetResultSchema = Type.Any();

export const SkillsWalletGrantClearParamsSchema = Type.Object(
  {
    skillId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SkillsWalletGrantClearResultSchema = Type.Any();

export const SkillsInstallParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    installId: NonEmptyString,
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
  },
  { additionalProperties: false },
);

export const SkillsFileGetParamsSchema = Type.Object(
  {
    skillKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsFileGetResultSchema = Type.Object(
  {
    skillKey: NonEmptyString,
    name: NonEmptyString,
    source: NonEmptyString,
    filePath: NonEmptyString,
    content: Type.String(),
    size: Type.Number(),
    updatedAtMs: Type.Number(),
  },
  { additionalProperties: false },
);

export const SkillsFileSetParamsSchema = Type.Object(
  {
    skillKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    content: Type.String(),
  },
  { additionalProperties: false },
);

export const SkillsFileSetResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    skillKey: NonEmptyString,
    name: NonEmptyString,
    source: NonEmptyString,
    filePath: NonEmptyString,
    size: Type.Number(),
    updatedAtMs: Type.Number(),
  },
  { additionalProperties: false },
);

export const SkillsCopyParamsSchema = Type.Object(
  {
    skillKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    overwrite: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const SkillsCopyResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    skillKey: NonEmptyString,
    name: NonEmptyString,
    source: NonEmptyString,
    filePath: NonEmptyString,
    targetDir: NonEmptyString,
    copiedFiles: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const SkillsCreateParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    description: Type.Optional(Type.String()),
    agentId: Type.Optional(NonEmptyString),
    template: Type.Optional(
      Type.Union([
        Type.Literal("general"),
        Type.Literal("research"),
        Type.Literal("tool"),
        Type.Literal("wallet-safe"),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const SkillsCreateResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    skillKey: NonEmptyString,
    name: NonEmptyString,
    filePath: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SkillsUpdateParamsSchema = Type.Object(
  {
    skillKey: NonEmptyString,
    enabled: Type.Optional(Type.Boolean()),
    apiKey: Type.Optional(Type.String()),
    env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
    config: Type.Optional(Type.Record(NonEmptyString, Type.Unknown())),
  },
  { additionalProperties: false },
);

export const ToolsCatalogParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    includePlugins: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ToolCatalogProfileSchema = Type.Object(
  {
    id: Type.Union([
      Type.Literal("minimal"),
      Type.Literal("coding"),
      Type.Literal("messaging"),
      Type.Literal("full"),
    ]),
    label: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ToolCatalogEntrySchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    description: Type.String(),
    source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
    pluginId: Type.Optional(NonEmptyString),
    optional: Type.Optional(Type.Boolean()),
    defaultProfiles: Type.Array(
      Type.Union([
        Type.Literal("minimal"),
        Type.Literal("coding"),
        Type.Literal("messaging"),
        Type.Literal("full"),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const ToolCatalogGroupSchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
    pluginId: Type.Optional(NonEmptyString),
    tools: Type.Array(ToolCatalogEntrySchema),
  },
  { additionalProperties: false },
);

export const ToolsCatalogResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    profiles: Type.Array(ToolCatalogProfileSchema),
    groups: Type.Array(ToolCatalogGroupSchema),
  },
  { additionalProperties: false },
);

export const ToolsEffectiveParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ToolEffectiveSourceSchema = Type.Union([
  Type.Literal("core"),
  Type.Literal("plugin"),
  Type.Literal("channel"),
]);

export const ToolEffectiveEntrySchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    description: Type.String(),
    source: ToolEffectiveSourceSchema,
    pluginId: Type.Optional(NonEmptyString),
    channelId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ToolEffectiveGroupSchema = Type.Object(
  {
    id: ToolEffectiveSourceSchema,
    label: NonEmptyString,
    source: ToolEffectiveSourceSchema,
    tools: Type.Array(ToolEffectiveEntrySchema),
  },
  { additionalProperties: false },
);

export const ToolsEffectiveResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    profile: NonEmptyString,
    groups: Type.Array(ToolEffectiveGroupSchema),
  },
  { additionalProperties: false },
);

export const PluginMarketplaceActionSchema = Type.Union([
  Type.Literal("status"),
  Type.Literal("install"),
  Type.Literal("update"),
  Type.Literal("uninstall"),
]);

export const PluginMarketplaceMutationActionSchema = Type.Union([
  Type.Literal("install"),
  Type.Literal("update"),
  Type.Literal("uninstall"),
  Type.Literal("restart"),
  Type.Literal("runtime-helper"),
  Type.Literal("admin-rpc-grant"),
]);

export const PluginMarketplaceInstallChoiceSchema = Type.Union([
  Type.Literal("npm"),
  Type.Literal("local"),
]);

export const PluginMarketplaceInstallRecordSchema = Type.Object(
  {
    source: Type.Union([
      Type.Literal("npm"),
      Type.Literal("archive"),
      Type.Literal("path"),
      Type.Literal("clawhub"),
    ]),
    spec: Type.Optional(NonEmptyString),
    sourcePath: Type.Optional(NonEmptyString),
    installPath: Type.Optional(NonEmptyString),
    version: Type.Optional(NonEmptyString),
    resolvedName: Type.Optional(NonEmptyString),
    resolvedVersion: Type.Optional(NonEmptyString),
    resolvedSpec: Type.Optional(NonEmptyString),
    integrity: Type.Optional(NonEmptyString),
    shasum: Type.Optional(NonEmptyString),
    resolvedAt: Type.Optional(NonEmptyString),
    installedAt: Type.Optional(NonEmptyString),
    clawhubUrl: Type.Optional(NonEmptyString),
    clawhubArtifactUrl: Type.Optional(NonEmptyString),
    clawhubPackage: Type.Optional(NonEmptyString),
    clawhubFamily: Type.Optional(
      Type.Union([Type.Literal("code-plugin"), Type.Literal("bundle-plugin")]),
    ),
    clawhubChannel: Type.Optional(
      Type.Union([Type.Literal("official"), Type.Literal("community"), Type.Literal("private")]),
    ),
    artifactKind: Type.Optional(
      Type.Union([Type.Literal("legacy-zip"), Type.Literal("npm-pack"), Type.Literal("clawpack")]),
    ),
    artifactFormat: Type.Optional(Type.Union([Type.Literal("zip"), Type.Literal("tgz")])),
    npmIntegrity: Type.Optional(NonEmptyString),
    npmShasum: Type.Optional(NonEmptyString),
    npmTarballName: Type.Optional(NonEmptyString),
    clawpackSha256: Type.Optional(NonEmptyString),
    clawpackSpecVersion: Type.Optional(Type.Integer({ minimum: 0 })),
    clawpackManifestSha256: Type.Optional(NonEmptyString),
    clawpackSize: Type.Optional(Type.Integer({ minimum: 0 })),
    securityState: Type.Optional(NonEmptyString),
    scanState: Type.Optional(NonEmptyString),
    moderationState: Type.Optional(NonEmptyString),
    readinessPhase: Type.Optional(NonEmptyString),
    verificationTier: Type.Optional(NonEmptyString),
    verificationSourceRepo: Type.Optional(NonEmptyString),
    verificationSourceCommit: Type.Optional(NonEmptyString),
    verificationHasProvenance: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const PluginMarketplaceInstallOptionsSchema = Type.Object(
  {
    npmSpec: Type.Optional(NonEmptyString),
    localPath: Type.Optional(NonEmptyString),
    resolvedLocalPath: Type.Optional(NonEmptyString),
    bundledLocalPath: Type.Optional(NonEmptyString),
    defaultChoice: Type.Optional(Type.Union([Type.Literal("npm"), Type.Literal("local")])),
    expectedIntegrity: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const PluginMarketplaceChannelCatalogMetaSchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    selectionLabel: NonEmptyString,
    detailLabel: Type.Optional(NonEmptyString),
    docsPath: NonEmptyString,
    docsLabel: Type.Optional(NonEmptyString),
    blurb: Type.String(),
    systemImage: Type.Optional(NonEmptyString),
    order: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

export const PluginMarketplaceAdminRpcActionMethodSchema = Type.Union([
  Type.Literal("chat.inject"),
  Type.Literal("push.test"),
  Type.Literal("web.login.start"),
  Type.Literal("web.login.wait"),
]);

export const PluginMarketplaceAdminRpcActionGrantStatusSchema = Type.Object(
  {
    method: PluginMarketplaceAdminRpcActionMethodSchema,
    granted: Type.Boolean(),
    effective: Type.Boolean(),
    sources: Type.Array(NonEmptyString),
    requireOperatorApproval: Type.Boolean(),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const PluginMarketplaceAdminRpcActionsSchema = Type.Object(
  {
    sourceKeys: Type.Array(NonEmptyString),
    methods: Type.Array(PluginMarketplaceAdminRpcActionGrantStatusSchema),
  },
  { additionalProperties: false },
);

export const PluginMarketplaceRuntimeHelpersSchema = Type.Object(
  {
    sessions: Type.Object(
      {
        read: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    adminRpcActions: Type.Optional(PluginMarketplaceAdminRpcActionsSchema),
  },
  { additionalProperties: false },
);

export const PluginMarketplaceSourceTrustSchema = Type.Object(
  {
    source: Type.Union([
      Type.Literal("npm"),
      Type.Literal("archive"),
      Type.Literal("path"),
      Type.Literal("clawhub"),
    ]),
    spec: Type.Optional(NonEmptyString),
    trusted: Type.Boolean(),
    reason: Type.String(),
    integrityPinned: Type.Boolean(),
    resolvedSpec: Type.Optional(NonEmptyString),
    resolvedIntegrity: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const PluginMarketplacePermissionDiffSchema = Type.Object(
  {
    added: Type.Object(
      {
        channels: Type.Array(NonEmptyString),
        providers: Type.Array(NonEmptyString),
        tools: Type.Array(NonEmptyString),
        skills: Type.Array(NonEmptyString),
      },
      { additionalProperties: false },
    ),
    removed: Type.Object(
      {
        channels: Type.Array(NonEmptyString),
        providers: Type.Array(NonEmptyString),
        tools: Type.Array(NonEmptyString),
        skills: Type.Array(NonEmptyString),
      },
      { additionalProperties: false },
    ),
    changed: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const PluginMarketplaceUpdateReviewSchema = Type.Object(
  {
    currentVersion: Type.Optional(NonEmptyString),
    nextVersion: Type.Optional(NonEmptyString),
    sourceTrust: PluginMarketplaceSourceTrustSchema,
    dependencyWarnings: Type.Array(Type.String()),
    scriptWarnings: Type.Array(Type.String()),
    scanWarnings: Type.Array(Type.String()),
    permissionDiff: PluginMarketplacePermissionDiffSchema,
    approvalRequired: Type.Boolean(),
    reasons: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const PluginMarketplaceDiagnosticSchema = Type.Object(
  {
    level: Type.Union([Type.Literal("warn"), Type.Literal("error")]),
    message: Type.String(),
    pluginId: Type.Optional(NonEmptyString),
    source: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const PluginMarketplaceEntrySchema = Type.Object(
  {
    id: NonEmptyString,
    name: NonEmptyString,
    description: Type.Optional(Type.String()),
    version: Type.Optional(NonEmptyString),
    kind: Type.Optional(NonEmptyString),
    origin: Type.Optional(
      Type.Union([
        Type.Literal("bundled"),
        Type.Literal("global"),
        Type.Literal("workspace"),
        Type.Literal("config"),
      ]),
    ),
    source: Type.Optional(NonEmptyString),
    status: Type.Union([
      Type.Literal("loaded"),
      Type.Literal("disabled"),
      Type.Literal("error"),
      Type.Literal("available"),
    ]),
    discovered: Type.Boolean(),
    managed: Type.Boolean(),
    loaded: Type.Boolean(),
    enabled: Type.Boolean(),
    hasInstallRecord: Type.Boolean(),
    install: Type.Optional(PluginMarketplaceInstallRecordSchema),
    error: Type.Optional(Type.String()),
    channels: Type.Array(NonEmptyString),
    providers: Type.Array(NonEmptyString),
    toolNames: Type.Array(NonEmptyString),
    hookNames: Type.Array(NonEmptyString),
    gatewayMethods: Type.Array(NonEmptyString),
    cliCommands: Type.Array(NonEmptyString),
    services: Type.Array(NonEmptyString),
    commands: Type.Array(NonEmptyString),
    httpHandlers: Type.Integer({ minimum: 0 }),
    hookCount: Type.Integer({ minimum: 0 }),
    channelCatalog: Type.Optional(PluginMarketplaceChannelCatalogMetaSchema),
    installOptions: PluginMarketplaceInstallOptionsSchema,
    runtimeHelpers: Type.Optional(PluginMarketplaceRuntimeHelpersSchema),
    actions: Type.Array(PluginMarketplaceActionSchema),
  },
  { additionalProperties: false },
);

export const PluginsMarketplaceListParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const PluginsMarketplaceInfoParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const PluginsMarketplaceInstallParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    sourceChoice: Type.Optional(PluginMarketplaceInstallChoiceSchema),
  },
  { additionalProperties: false },
);

export const PluginsMarketplaceUpdateParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    approveRiskyChanges: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const PluginsMarketplaceUpdatePreviewParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const PluginsMarketplaceUninstallParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    deleteFiles: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const PluginsMarketplaceRestartParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const PluginsMarketplaceRuntimeHelperSetParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    helper: Type.Literal("sessions.read"),
    enabled: Type.Boolean(),
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const PluginsMarketplaceAdminRpcGrantSetParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    method: PluginMarketplaceAdminRpcActionMethodSchema,
    enabled: Type.Boolean(),
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const PluginsMarketplaceListResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspaceDir: Type.Optional(NonEmptyString),
    plugins: Type.Array(PluginMarketplaceEntrySchema),
    diagnostics: Type.Array(PluginMarketplaceDiagnosticSchema),
  },
  { additionalProperties: false },
);

export const PluginsMarketplaceInfoResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspaceDir: Type.Optional(NonEmptyString),
    plugin: PluginMarketplaceEntrySchema,
    diagnostics: Type.Array(PluginMarketplaceDiagnosticSchema),
  },
  { additionalProperties: false },
);

export const PluginMarketplaceMutationResultSchema = Type.Object(
  {
    action: PluginMarketplaceMutationActionSchema,
    pluginId: NonEmptyString,
    changed: Type.Boolean(),
    requiresRestart: Type.Boolean(),
    message: Type.String(),
    warnings: Type.Array(Type.String()),
    updateReview: Type.Optional(PluginMarketplaceUpdateReviewSchema),
  },
  { additionalProperties: false },
);

export const PluginMarketplaceUpdatePreviewResultSchema = Type.Object(
  {
    pluginId: NonEmptyString,
    action: Type.Literal("update-preview"),
    message: Type.String(),
    updateReview: PluginMarketplaceUpdateReviewSchema,
    warnings: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
