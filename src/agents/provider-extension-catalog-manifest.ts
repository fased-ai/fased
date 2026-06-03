import { normalizeModelCatalogProviderId } from "./model-catalog-normalized.js";

export type ProviderExtensionCatalogManifestStatus = "mapped" | "deferred";

export type ProviderExtensionCatalogAuthSurface =
  | "api-key"
  | "oauth"
  | "token"
  | "local"
  | "shared"
  | "env"
  | "config";

export type ProviderExtensionCatalogManifestEntry = {
  upstreamProviderId: string;
  upstreamCatalogPaths: readonly string[];
  status: ProviderExtensionCatalogManifestStatus;
  fasedProviderIds: readonly string[];
  fasedProviderAliases?: readonly string[];
  docsPath?: string;
  authSurface?: ProviderExtensionCatalogAuthSurface;
  authChoiceIds?: readonly string[];
  reason?: string;
};

export type ProviderExtensionCatalogManifestIssue = {
  upstreamProviderId: string;
  providerId?: string;
  code:
    | "deferred-with-provider"
    | "mapped-without-provider"
    | "mapped-without-docs"
    | "mapped-without-auth"
    | "provider-missing-catalog"
    | "auth-choice-missing";
  message: string;
};

export const FASED_PROVIDER_EXTENSION_CATALOG_MANIFEST: readonly ProviderExtensionCatalogManifestEntry[] =
  [
    {
      upstreamProviderId: "anthropic",
      upstreamCatalogPaths: ["extensions/anthropic/provider-discovery.ts"],
      status: "mapped",
      fasedProviderIds: ["anthropic"],
      docsPath: "docs/providers/anthropic.md",
      authSurface: "api-key",
      authChoiceIds: ["apiKey", "token"],
    },
    {
      upstreamProviderId: "byteplus",
      upstreamCatalogPaths: [
        "extensions/byteplus/provider-catalog.ts",
        "extensions/byteplus/provider-discovery.ts",
      ],
      status: "mapped",
      fasedProviderIds: ["byteplus", "byteplus-coding", "byteplus-plan"],
      docsPath: "docs/providers/volcengine.md",
      authSurface: "api-key",
      authChoiceIds: ["byteplus-api-key"],
    },
    {
      upstreamProviderId: "chutes",
      upstreamCatalogPaths: ["extensions/chutes/provider-catalog.ts"],
      status: "mapped",
      fasedProviderIds: ["chutes"],
      docsPath: "docs/providers/chutes.md",
      authSurface: "oauth",
      authChoiceIds: ["chutes"],
    },
    {
      upstreamProviderId: "codex",
      upstreamCatalogPaths: [
        "extensions/codex/provider-catalog.ts",
        "extensions/codex/provider-discovery.ts",
      ],
      status: "mapped",
      fasedProviderIds: ["openai-codex"],
      fasedProviderAliases: ["codex"],
      docsPath: "docs/providers/openai.md",
      authSurface: "oauth",
      authChoiceIds: ["openai-codex"],
    },
    {
      upstreamProviderId: "huggingface",
      upstreamCatalogPaths: ["extensions/huggingface/provider-catalog.ts"],
      status: "mapped",
      fasedProviderIds: ["huggingface"],
      docsPath: "docs/providers/huggingface.md",
      authSurface: "api-key",
      authChoiceIds: ["huggingface-api-key"],
    },
    {
      upstreamProviderId: "kimi-coding",
      upstreamCatalogPaths: ["extensions/kimi-coding/provider-catalog.ts"],
      status: "mapped",
      fasedProviderIds: ["kimi"],
      fasedProviderAliases: ["kimi-coding", "kimi-code"],
      docsPath: "docs/providers/moonshot.md",
      authSurface: "api-key",
      authChoiceIds: ["kimi-code-api-key"],
    },
    {
      upstreamProviderId: "litellm",
      upstreamCatalogPaths: ["extensions/litellm/provider-catalog.ts"],
      status: "mapped",
      fasedProviderIds: ["litellm"],
      docsPath: "docs/providers/litellm.md",
      authSurface: "api-key",
      authChoiceIds: ["litellm-api-key"],
    },
    {
      upstreamProviderId: "minimax",
      upstreamCatalogPaths: ["extensions/minimax/provider-catalog.ts"],
      status: "mapped",
      fasedProviderIds: ["minimax", "minimax-cn", "minimax-portal"],
      docsPath: "docs/providers/minimax.md",
      authSurface: "api-key",
      authChoiceIds: [
        "minimax-portal",
        "minimax-api",
        "minimax-api-key-cn",
        "minimax-api-lightning",
      ],
    },
    {
      upstreamProviderId: "mistral",
      upstreamCatalogPaths: ["extensions/mistral/provider-catalog.ts"],
      status: "mapped",
      fasedProviderIds: ["mistral"],
      docsPath: "docs/providers/mistral.md",
      authSurface: "api-key",
      authChoiceIds: ["mistral-api-key"],
    },
    {
      upstreamProviderId: "moonshot",
      upstreamCatalogPaths: [
        "extensions/moonshot/provider-catalog.ts",
        "extensions/moonshot/provider-discovery.ts",
      ],
      status: "mapped",
      fasedProviderIds: ["moonshot"],
      docsPath: "docs/providers/moonshot.md",
      authSurface: "api-key",
      authChoiceIds: ["moonshot-api-key", "moonshot-api-key-cn"],
    },
    {
      upstreamProviderId: "openrouter",
      upstreamCatalogPaths: ["extensions/openrouter/provider-catalog.ts"],
      status: "mapped",
      fasedProviderIds: ["openrouter"],
      docsPath: "docs/providers/openrouter.md",
      authSurface: "api-key",
      authChoiceIds: ["openrouter-api-key"],
    },
    {
      upstreamProviderId: "qianfan",
      upstreamCatalogPaths: ["extensions/qianfan/provider-catalog.ts"],
      status: "mapped",
      fasedProviderIds: ["qianfan"],
      docsPath: "docs/providers/qianfan.md",
      authSurface: "api-key",
      authChoiceIds: ["qianfan-api-key"],
    },
    {
      upstreamProviderId: "qwen",
      upstreamCatalogPaths: ["extensions/qwen/provider-catalog.ts"],
      status: "mapped",
      fasedProviderIds: ["qwen"],
      docsPath: "docs/providers/qwen.md",
      authSurface: "api-key",
      authChoiceIds: ["qwen-coding-plan-api-key", "qwen-api-key"],
    },
    {
      upstreamProviderId: "synthetic",
      upstreamCatalogPaths: ["extensions/synthetic/provider-catalog.ts"],
      status: "mapped",
      fasedProviderIds: ["synthetic"],
      docsPath: "docs/providers/synthetic.md",
      authSurface: "api-key",
      authChoiceIds: ["synthetic-api-key"],
    },
    {
      upstreamProviderId: "together",
      upstreamCatalogPaths: ["extensions/together/provider-catalog.ts"],
      status: "mapped",
      fasedProviderIds: ["together"],
      docsPath: "docs/providers/together.md",
      authSurface: "api-key",
      authChoiceIds: ["together-api-key"],
    },
    {
      upstreamProviderId: "venice",
      upstreamCatalogPaths: ["extensions/venice/provider-catalog.ts"],
      status: "mapped",
      fasedProviderIds: ["venice"],
      docsPath: "docs/providers/venice.md",
      authSurface: "api-key",
      authChoiceIds: ["venice-api-key"],
    },
    {
      upstreamProviderId: "vercel-ai-gateway",
      upstreamCatalogPaths: ["extensions/vercel-ai-gateway/provider-catalog.ts"],
      status: "mapped",
      fasedProviderIds: ["vercel-ai-gateway"],
      docsPath: "docs/providers/vercel-ai-gateway.md",
      authSurface: "api-key",
      authChoiceIds: ["ai-gateway-api-key"],
    },
    {
      upstreamProviderId: "volcengine",
      upstreamCatalogPaths: [
        "extensions/volcengine/provider-catalog.ts",
        "extensions/volcengine/provider-discovery.ts",
      ],
      status: "mapped",
      fasedProviderIds: ["volcengine", "volcengine-coding", "volcengine-plan"],
      docsPath: "docs/providers/volcengine.md",
      authSurface: "api-key",
      authChoiceIds: ["volcengine-api-key"],
    },
    {
      upstreamProviderId: "xai",
      upstreamCatalogPaths: [
        "extensions/xai/provider-catalog.ts",
        "extensions/xai/provider-discovery.ts",
      ],
      status: "mapped",
      fasedProviderIds: ["xai"],
      docsPath: "docs/providers/xai.md",
      authSurface: "api-key",
      authChoiceIds: ["xai-oauth", "xai-device-code", "xai-api-key"],
    },
    {
      upstreamProviderId: "xiaomi",
      upstreamCatalogPaths: ["extensions/xiaomi/provider-catalog.ts"],
      status: "mapped",
      fasedProviderIds: ["xiaomi"],
      docsPath: "docs/providers/xiaomi.md",
      authSurface: "api-key",
      authChoiceIds: ["xiaomi-api-key"],
    },
  ];

export function listProviderExtensionCatalogManifestEntries(): readonly ProviderExtensionCatalogManifestEntry[] {
  return FASED_PROVIDER_EXTENSION_CATALOG_MANIFEST;
}

export function resolveProviderExtensionCatalogManifestEntry(
  upstreamProviderId: string,
): ProviderExtensionCatalogManifestEntry | undefined {
  const normalized = normalizeModelCatalogProviderId(upstreamProviderId);
  return FASED_PROVIDER_EXTENSION_CATALOG_MANIFEST.find(
    (entry) => normalizeModelCatalogProviderId(entry.upstreamProviderId) === normalized,
  );
}

export function listMappedProviderExtensionCatalogProviderIds(): string[] {
  return [
    ...new Set(
      FASED_PROVIDER_EXTENSION_CATALOG_MANIFEST.flatMap((entry) =>
        entry.status === "mapped"
          ? entry.fasedProviderIds.map(normalizeModelCatalogProviderId)
          : [],
      ),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

export function listDeferredProviderExtensionCatalogProviderIds(): string[] {
  return FASED_PROVIDER_EXTENSION_CATALOG_MANIFEST.filter((entry) => entry.status === "deferred")
    .map((entry) => normalizeModelCatalogProviderId(entry.upstreamProviderId))
    .toSorted((left, right) => left.localeCompare(right));
}

export function validateProviderExtensionCatalogManifest(params: {
  catalogProviderIds: Iterable<string>;
  docsPaths: Iterable<string>;
  authChoiceIds?: Iterable<string>;
}): ProviderExtensionCatalogManifestIssue[] {
  const catalogProviderIds = new Set(
    [...params.catalogProviderIds].map(normalizeModelCatalogProviderId),
  );
  const docsPaths = new Set(params.docsPaths);
  const authChoiceIds = new Set(params.authChoiceIds ?? []);
  const issues: ProviderExtensionCatalogManifestIssue[] = [];

  for (const entry of FASED_PROVIDER_EXTENSION_CATALOG_MANIFEST) {
    if (entry.status === "deferred") {
      if (entry.fasedProviderIds.length > 0) {
        issues.push({
          upstreamProviderId: entry.upstreamProviderId,
          code: "deferred-with-provider",
          message: "Deferred provider entries must not declare Fased provider IDs.",
        });
      }
      continue;
    }

    if (entry.fasedProviderIds.length === 0) {
      issues.push({
        upstreamProviderId: entry.upstreamProviderId,
        code: "mapped-without-provider",
        message: "Mapped provider entries must declare at least one Fased provider ID.",
      });
    }
    if (!entry.docsPath || !docsPaths.has(entry.docsPath)) {
      issues.push({
        upstreamProviderId: entry.upstreamProviderId,
        code: "mapped-without-docs",
        message: "Mapped provider entries must point at an existing Fased provider doc.",
      });
    }
    if (!entry.authSurface) {
      issues.push({
        upstreamProviderId: entry.upstreamProviderId,
        code: "mapped-without-auth",
        message: "Mapped provider entries must document their Fased auth surface.",
      });
    }

    for (const providerIdRaw of entry.fasedProviderIds) {
      const providerId = normalizeModelCatalogProviderId(providerIdRaw);
      if (!catalogProviderIds.has(providerId)) {
        issues.push({
          upstreamProviderId: entry.upstreamProviderId,
          providerId,
          code: "provider-missing-catalog",
          message: `Mapped provider "${providerId}" is not present in the Fased model catalog.`,
        });
      }
    }

    for (const authChoiceId of entry.authChoiceIds ?? []) {
      if (!authChoiceIds.has(authChoiceId)) {
        issues.push({
          upstreamProviderId: entry.upstreamProviderId,
          code: "auth-choice-missing",
          message: `Auth choice "${authChoiceId}" is not registered in Fased onboarding.`,
        });
      }
    }
  }

  return issues;
}
