import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import {
  buildChannelUiCatalog,
  listChannelPluginCatalogEntries,
} from "../../channels/plugins/catalog.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import {
  type ChannelId,
  getChannelPlugin,
  listChannelPlugins,
  normalizeChannelId,
} from "../../channels/plugins/index.js";
import { buildChannelAccountSnapshot } from "../../channels/plugins/status.js";
import type {
  ChannelAccountSnapshot,
  ChannelMeta,
  ChannelPlugin,
} from "../../channels/plugins/types.js";
import {
  CHAT_CHANNEL_ORDER,
  listChatChannels,
  type ChatChannelId,
} from "../../channels/registry.js";
import { getChannelOnboardingAdapter } from "../../commands/onboarding/registry.js";
import type { FasedAgentConfig } from "../../config/config.js";
import { loadConfig, readConfigFileSnapshot } from "../../config/config.js";
import { getChannelActivity } from "../../infra/channel-activity.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveDefaultWhatsAppAccountId, resolveWhatsAppAuthDir } from "../../web/accounts.js";
import { logoutWeb } from "../../web/auth-store.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChannelsLogoutParams,
  validateChannelsRuntimeControlParams,
  validateChannelsStatusParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

type ChannelLogoutPayload = {
  channel: ChannelId;
  accountId: string;
  cleared: boolean;
  [key: string]: unknown;
};

function channelCatalogSortOrder(id: string, meta: ChannelMeta): number {
  const coreIndex = CHAT_CHANNEL_ORDER.indexOf(id as ChatChannelId);
  return meta.order ?? (coreIndex === -1 ? 999 : coreIndex);
}

function buildStatusChannelCatalog(params: {
  cfg: FasedAgentConfig;
  plugins: ChannelPlugin[];
}): Array<{ id: ChannelId; meta: ChannelMeta; catalogOnly?: boolean; install?: unknown }> {
  const pluginIds = new Set(params.plugins.map((plugin) => plugin.id));
  const resolved = new Map<
    string,
    { id: ChannelId; meta: ChannelMeta; catalogOnly?: boolean; install?: unknown }
  >();
  for (const meta of listChatChannels()) {
    resolved.set(meta.id, { id: meta.id, meta, catalogOnly: !pluginIds.has(meta.id) });
  }
  for (const plugin of params.plugins) {
    resolved.set(plugin.id, { id: plugin.id, meta: plugin.meta });
  }
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, resolveDefaultAgentId(params.cfg));
  for (const entry of listChannelPluginCatalogEntries({ workspaceDir })) {
    const existing = resolved.get(entry.id);
    if (existing) {
      resolved.set(entry.id, {
        ...existing,
        install: existing.install ?? entry.install,
      });
      continue;
    }
    resolved.set(entry.id, {
      id: entry.id as ChannelId,
      meta: entry.meta,
      catalogOnly: true,
      install: entry.install,
    });
  }
  return Array.from(resolved.values()).toSorted((a, b) => {
    const orderA = channelCatalogSortOrder(a.id, a.meta);
    const orderB = channelCatalogSortOrder(b.id, b.meta);
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.meta.label.localeCompare(b.meta.label);
  });
}

function normalizeNpmPackageName(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  let value = input.trim();
  if (!value) {
    return null;
  }
  if (value.startsWith("npm:")) {
    value = value.slice("npm:".length).trim();
  }
  if (value.startsWith("@")) {
    const match = /^(@[^/\s]+\/[^@\s]+)(?:@.+)?$/.exec(value);
    return match?.[1]?.toLowerCase() ?? value.toLowerCase();
  }
  return value.split("@", 1)[0]?.toLowerCase() || value.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function pendingInstallMatchesChannel(params: {
  cfg: FasedAgentConfig;
  channelId: string;
  install: unknown;
}): boolean {
  if (params.cfg.plugins?.entries?.[params.channelId]?.enabled === true) {
    return true;
  }
  const channelConfig = (params.cfg.channels as Record<string, unknown> | undefined)?.[
    params.channelId
  ];
  if (isRecord(channelConfig) && channelConfig.enabled === true) {
    return true;
  }
  const installs = params.cfg.plugins?.installs ?? {};
  if (installs[params.channelId]) {
    return true;
  }
  const installRecord =
    params.install && typeof params.install === "object" ? params.install : null;
  const expectedNames = new Set(
    [params.channelId, (installRecord as { npmSpec?: unknown } | null)?.npmSpec]
      .map(normalizeNpmPackageName)
      .filter((entry): entry is string => Boolean(entry)),
  );
  if (expectedNames.size === 0) {
    return false;
  }
  for (const [pluginId, record] of Object.entries(installs)) {
    const candidateNames = [
      pluginId,
      record.spec,
      record.resolvedName,
      record.resolvedSpec,
      record.clawhubPackage,
      record.npmTarballName,
    ]
      .map(normalizeNpmPackageName)
      .filter((entry): entry is string => Boolean(entry));
    if (candidateNames.some((entry) => expectedNames.has(entry))) {
      return true;
    }
  }
  return false;
}

function readChannelBindingAudience(binding: Record<string, unknown>): {
  audience: string;
  audienceType: string;
} | null {
  const match = binding.match;
  if (!isRecord(match) || !isRecord(match.peer)) {
    return null;
  }
  const audienceType = normalizeChatType(
    typeof match.peer.kind === "string" ? match.peer.kind : undefined,
  );
  const audience = typeof match.peer.id === "string" ? match.peer.id.trim() : "";
  if (!audienceType || !audience) {
    return null;
  }
  return { audience, audienceType };
}

function channelBindingMatchesAccount(params: {
  match: Record<string, unknown>;
  accountId: string;
  defaultAccountId: string;
}): boolean {
  const bindingAccountId =
    typeof params.match.accountId === "string" ? params.match.accountId.trim() : "";
  if (bindingAccountId) {
    return bindingAccountId === params.accountId;
  }
  return params.accountId === params.defaultAccountId || params.accountId === DEFAULT_ACCOUNT_ID;
}

function resolveChannelBindingAudience(params: {
  cfg: FasedAgentConfig;
  channelId: string;
  accountId: string;
  defaultAccountId: string;
}): { audience: string; audienceType: string } | null {
  const bindings = Array.isArray(params.cfg.bindings) ? params.cfg.bindings.filter(isRecord) : [];
  let fallback: { audience: string; audienceType: string } | null = null;
  for (const binding of bindings) {
    const match = binding.match;
    if (!isRecord(match) || match.channel !== params.channelId) {
      continue;
    }
    const audience = readChannelBindingAudience(binding);
    if (!audience) {
      continue;
    }
    if (!fallback) {
      fallback = audience;
    }
    if (
      channelBindingMatchesAccount({
        match,
        accountId: params.accountId,
        defaultAccountId: params.defaultAccountId,
      })
    ) {
      return audience;
    }
  }
  return fallback;
}

function resolveRuntimeControlParams(params: {
  method: "channels.start" | "channels.stop";
  rawParams: Record<string, unknown>;
  respond: (ok: boolean, payload?: unknown, error?: ReturnType<typeof errorShape>) => void;
}): { channelId: ChannelId; accountId?: string } | null {
  if (!validateChannelsRuntimeControlParams(params.rawParams)) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid ${params.method} params: ${formatValidationErrors(validateChannelsRuntimeControlParams.errors)}`,
      ),
    );
    return null;
  }
  const rawChannel = params.rawParams.channel;
  const channelId = typeof rawChannel === "string" ? normalizeChannelId(rawChannel) : null;
  if (!channelId) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${params.method} channel`),
    );
    return null;
  }
  if (!getChannelPlugin(channelId)) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.NOT_FOUND, `channel ${channelId} not found`),
    );
    return null;
  }
  const accountIdRaw = params.rawParams.accountId;
  const accountId = typeof accountIdRaw === "string" ? accountIdRaw.trim() : undefined;
  return {
    channelId,
    ...(accountId ? { accountId } : {}),
  };
}

export async function logoutChannelAccount(params: {
  channelId: ChannelId;
  accountId?: string | null;
  cfg: FasedAgentConfig;
  context: GatewayRequestContext;
  plugin: ChannelPlugin;
}): Promise<ChannelLogoutPayload> {
  const resolvedAccountId =
    params.accountId?.trim() ||
    params.plugin.config.defaultAccountId?.(params.cfg) ||
    params.plugin.config.listAccountIds(params.cfg)[0] ||
    DEFAULT_ACCOUNT_ID;
  const account = params.plugin.config.resolveAccount(params.cfg, resolvedAccountId);
  await params.context.stopChannel(params.channelId, resolvedAccountId);
  const result = await params.plugin.gateway?.logoutAccount?.({
    cfg: params.cfg,
    accountId: resolvedAccountId,
    account,
    runtime: defaultRuntime,
  });
  if (!result) {
    throw new Error(`Channel ${params.channelId} does not support logout`);
  }
  const cleared = Boolean(result.cleared);
  const loggedOut = typeof result.loggedOut === "boolean" ? result.loggedOut : cleared;
  if (loggedOut) {
    params.context.markChannelLoggedOut(params.channelId, true, resolvedAccountId);
  }
  return {
    channel: params.channelId,
    accountId: resolvedAccountId,
    ...result,
    cleared,
  };
}

export const channelsHandlers: GatewayRequestHandlers = {
  "channels.start": async ({ params, respond, context }) => {
    const resolved = resolveRuntimeControlParams({
      method: "channels.start",
      rawParams: params,
      respond,
    });
    if (!resolved) {
      return;
    }
    try {
      await context.startChannel(resolved.channelId, resolved.accountId);
      respond(
        true,
        {
          channel: resolved.channelId,
          accountId: resolved.accountId ?? null,
          action: "start",
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "channels.stop": async ({ params, respond, context }) => {
    const resolved = resolveRuntimeControlParams({
      method: "channels.stop",
      rawParams: params,
      respond,
    });
    if (!resolved) {
      return;
    }
    try {
      await context.stopChannel(resolved.channelId, resolved.accountId);
      respond(
        true,
        {
          channel: resolved.channelId,
          accountId: resolved.accountId ?? null,
          action: "stop",
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "channels.status": async ({ params, respond, context }) => {
    if (!validateChannelsStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.status params: ${formatValidationErrors(validateChannelsStatusParams.errors)}`,
        ),
      );
      return;
    }
    const probe = (params as { probe?: boolean }).probe === true;
    const timeoutMsRaw = (params as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs = typeof timeoutMsRaw === "number" ? Math.max(1000, timeoutMsRaw) : 10_000;
    const cfg = loadConfig();
    const runtime = context.getRuntimeSnapshot();
    const plugins = listChannelPlugins();
    const pluginMap = new Map<ChannelId, ChannelPlugin>(
      plugins.map((plugin) => [plugin.id, plugin]),
    );
    const statusCatalog = buildStatusChannelCatalog({ cfg, plugins });
    const catalogOnlyById = new Map(statusCatalog.map((entry) => [entry.id, entry]));

    const resolveRuntimeSnapshot = (
      channelId: ChannelId,
      accountId: string,
      defaultAccountId: string,
    ): ChannelAccountSnapshot | undefined => {
      const accounts = runtime.channelAccounts[channelId];
      const defaultRuntime = runtime.channels[channelId];
      const raw =
        accounts?.[accountId] ?? (accountId === defaultAccountId ? defaultRuntime : undefined);
      if (!raw) {
        return undefined;
      }
      return raw;
    };

    const isAccountEnabled = (plugin: ChannelPlugin, account: unknown) =>
      plugin.config.isEnabled
        ? plugin.config.isEnabled(account, cfg)
        : !account ||
          typeof account !== "object" ||
          (account as { enabled?: boolean }).enabled !== false;

    const buildChannelAccounts = async (channelId: ChannelId) => {
      const plugin = pluginMap.get(channelId);
      if (!plugin) {
        return {
          accounts: [] as ChannelAccountSnapshot[],
          defaultAccountId: DEFAULT_ACCOUNT_ID,
          defaultAccount: undefined as ChannelAccountSnapshot | undefined,
          resolvedAccounts: {} as Record<string, unknown>,
        };
      }
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin,
        cfg,
        accountIds,
      });
      const accounts: ChannelAccountSnapshot[] = [];
      const resolvedAccounts: Record<string, unknown> = {};
      for (const accountId of accountIds) {
        const account = plugin.config.resolveAccount(cfg, accountId);
        const enabled = isAccountEnabled(plugin, account);
        resolvedAccounts[accountId] = account;
        let probeResult: unknown;
        let lastProbeAt: number | null = null;
        if (probe && enabled && plugin.status?.probeAccount) {
          let configured = true;
          if (plugin.config.isConfigured) {
            configured = await plugin.config.isConfigured(account, cfg);
          }
          if (configured) {
            probeResult = await plugin.status.probeAccount({
              account,
              timeoutMs,
              cfg,
            });
            lastProbeAt = Date.now();
          }
        }
        let auditResult: unknown;
        if (probe && enabled && plugin.status?.auditAccount) {
          let configured = true;
          if (plugin.config.isConfigured) {
            configured = await plugin.config.isConfigured(account, cfg);
          }
          if (configured) {
            auditResult = await plugin.status.auditAccount({
              account,
              timeoutMs,
              cfg,
              probe: probeResult,
            });
          }
        }
        const runtimeSnapshot = resolveRuntimeSnapshot(channelId, accountId, defaultAccountId);
        const snapshot = await buildChannelAccountSnapshot({
          plugin,
          cfg,
          accountId,
          runtime: runtimeSnapshot,
          probe: probeResult,
          audit: auditResult,
        });
        if (!snapshot.audience) {
          const bindingAudience = resolveChannelBindingAudience({
            cfg,
            channelId,
            accountId,
            defaultAccountId,
          });
          if (bindingAudience) {
            snapshot.audience = bindingAudience.audience;
            if (!snapshot.audienceType) {
              snapshot.audienceType = bindingAudience.audienceType;
            }
          }
        }
        if (lastProbeAt) {
          snapshot.lastProbeAt = lastProbeAt;
        }
        const activity = getChannelActivity({
          channel: channelId as never,
          accountId,
        });
        if (snapshot.lastInboundAt == null) {
          snapshot.lastInboundAt = activity.inboundAt;
        }
        if (snapshot.lastOutboundAt == null) {
          snapshot.lastOutboundAt = activity.outboundAt;
        }
        accounts.push(snapshot);
      }
      const defaultAccount =
        accounts.find((entry) => entry.accountId === defaultAccountId) ?? accounts[0];
      return { accounts, defaultAccountId, defaultAccount, resolvedAccounts };
    };

    const uiCatalog = buildChannelUiCatalog(statusCatalog);
    const payload: Record<string, unknown> = {
      ts: Date.now(),
      channelOrder: uiCatalog.order,
      channelLabels: uiCatalog.labels,
      channelDetailLabels: uiCatalog.detailLabels,
      channelSystemImages: uiCatalog.systemImages,
      channelMeta: uiCatalog.entries,
      channelSetup: Object.fromEntries(
        uiCatalog.order.flatMap((id) => {
          const adapter = getChannelOnboardingAdapter(id as ChannelId);
          const uiSetup = adapter?.uiSetup;
          if (!uiSetup) {
            return [];
          }
          return [
            [
              id,
              {
                ...uiSetup,
                ...(adapter.dmPolicy
                  ? {
                      dmPolicy: {
                        label: adapter.dmPolicy.label,
                        policyKey: adapter.dmPolicy.policyKey,
                        allowFromKey: adapter.dmPolicy.allowFromKey,
                      },
                    }
                  : {}),
              },
            ] as const,
          ];
        }),
      ),
      channels: {} as Record<string, unknown>,
      channelAccounts: {} as Record<string, unknown>,
      channelDefaultAccountId: {} as Record<string, unknown>,
    };
    const channelsMap = payload.channels as Record<string, unknown>;
    const accountsMap = payload.channelAccounts as Record<string, unknown>;
    const defaultAccountIdMap = payload.channelDefaultAccountId as Record<string, unknown>;
    for (const entry of statusCatalog) {
      const plugin = pluginMap.get(entry.id);
      if (!plugin) {
        const catalogEntry = catalogOnlyById.get(entry.id);
        const pendingRestart = pendingInstallMatchesChannel({
          cfg,
          channelId: entry.id,
          install: catalogEntry?.install,
        });
        channelsMap[entry.id] = {
          configured: false,
          running: false,
          connected: false,
          catalogOnly: true,
          ...(pendingRestart ? { pendingRestart: true } : {}),
          install: catalogEntry?.install,
        };
        accountsMap[entry.id] = [];
        defaultAccountIdMap[entry.id] = DEFAULT_ACCOUNT_ID;
        continue;
      }
      const { accounts, defaultAccountId, defaultAccount, resolvedAccounts } =
        await buildChannelAccounts(plugin.id);
      const fallbackAccount =
        resolvedAccounts[defaultAccountId] ?? plugin.config.resolveAccount(cfg, defaultAccountId);
      const summary = plugin.status?.buildChannelSummary
        ? await plugin.status.buildChannelSummary({
            account: fallbackAccount,
            cfg,
            defaultAccountId,
            snapshot:
              defaultAccount ??
              ({
                accountId: defaultAccountId,
              } as ChannelAccountSnapshot),
          })
        : {
            configured: defaultAccount?.configured ?? false,
          };
      channelsMap[plugin.id] = summary;
      accountsMap[plugin.id] = accounts;
      defaultAccountIdMap[plugin.id] = defaultAccountId;
    }

    respond(true, payload, undefined);
  },
  "channels.logout": async ({ params, respond, context }) => {
    if (!validateChannelsLogoutParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid channels.logout params: ${formatValidationErrors(validateChannelsLogoutParams.errors)}`,
        ),
      );
      return;
    }
    const rawChannel = (params as { channel?: unknown }).channel;
    const channelId = typeof rawChannel === "string" ? normalizeChannelId(rawChannel) : null;
    if (!channelId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid channels.logout channel"),
      );
      return;
    }
    const accountIdRaw = (params as { accountId?: unknown }).accountId;
    const accountId = typeof accountIdRaw === "string" ? accountIdRaw.trim() : undefined;
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config invalid; fix it before logging out"),
      );
      return;
    }
    if (channelId === "whatsapp") {
      const cfg = snapshot.config ?? {};
      const resolvedAccountId = accountId || resolveDefaultWhatsAppAccountId(cfg);
      const { authDir, isLegacy } = resolveWhatsAppAuthDir({
        cfg,
        accountId: resolvedAccountId,
      });
      try {
        await context.stopChannel(channelId, resolvedAccountId);
        const cleared = await logoutWeb({
          authDir,
          isLegacyAuthDir: isLegacy,
          runtime: defaultRuntime,
        });
        if (cleared) {
          context.markChannelLoggedOut(channelId, true, resolvedAccountId);
        }
        respond(
          true,
          {
            channel: channelId,
            accountId: resolvedAccountId,
            cleared,
            loggedOut: cleared,
          },
          undefined,
        );
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
      }
      return;
    }
    const plugin = getChannelPlugin(channelId);
    if (!plugin?.gateway?.logoutAccount) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `channel ${channelId} does not support logout`),
      );
      return;
    }
    try {
      const payload = await logoutChannelAccount({
        channelId,
        accountId,
        cfg: snapshot.config ?? {},
        context,
        plugin,
      });
      respond(true, payload, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
