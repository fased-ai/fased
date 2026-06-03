import type { FasedAgentConfig } from "../../../config/config.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import { formatDocsLink } from "../../../terminal/links.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter } from "../onboarding-types.js";
import { mergeAllowFromEntries, resolveAccountIdForConfigure } from "./helpers.js";

const channel = "synology-chat" as const;
const DEFAULT_WEBHOOK_PATH = "/webhook/synology";

type SynologyDmPolicy = "open" | "allowlist" | "disabled";

type SynologyChatAccountConfig = {
  enabled?: boolean;
  token?: string;
  incomingUrl?: string;
  nasHost?: string;
  webhookPath?: string;
  dmPolicy?: SynologyDmPolicy;
  allowedUserIds?: string | string[];
  rateLimitPerMinute?: number;
  botName?: string;
  allowInsecureSsl?: boolean;
};

type SynologyChatConfig = SynologyChatAccountConfig & {
  accounts?: Record<string, SynologyChatAccountConfig | undefined>;
};

function resolveSynologyChatConfig(cfg: FasedAgentConfig): SynologyChatConfig {
  return ((cfg.channels as Record<string, unknown> | undefined)?.["synology-chat"] ??
    {}) as SynologyChatConfig;
}

function splitSynologyEntries(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseAllowedUserIds(raw: string | string[] | undefined): string[] {
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.map((entry) => String(entry).trim()).filter(Boolean);
  }
  return splitSynologyEntries(raw);
}

function listSynologyChatAccountIds(cfg: FasedAgentConfig): string[] {
  const synologyChat = resolveSynologyChatConfig(cfg);
  const ids = new Set<string>();
  if (synologyChat.token?.trim() || process.env.SYNOLOGY_CHAT_TOKEN?.trim()) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }
  for (const id of Object.keys(synologyChat.accounts ?? {})) {
    ids.add(normalizeAccountId(id));
  }
  if (ids.size === 0) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }
  return Array.from(ids).toSorted((a, b) => a.localeCompare(b));
}

function resolveDefaultSynologyChatAccountId(cfg: FasedAgentConfig): string {
  const accountIds = listSynologyChatAccountIds(cfg);
  if (accountIds.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return accountIds[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveSynologyChatAccount(cfg: FasedAgentConfig, rawAccountId?: string | null) {
  const accountId = normalizeAccountId(rawAccountId);
  const synologyChat = resolveSynologyChatConfig(cfg);
  const { accounts: _ignored, ...base } = synologyChat;
  const account =
    accountId === DEFAULT_ACCOUNT_ID ? {} : (synologyChat.accounts?.[accountId] ?? {});
  const merged = { ...base, ...account };
  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv ? process.env.SYNOLOGY_CHAT_TOKEN?.trim() : undefined;
  const envIncomingUrl = allowEnv ? process.env.SYNOLOGY_CHAT_INCOMING_URL?.trim() : undefined;
  return {
    accountId,
    token: merged.token?.trim() || envToken || "",
    incomingUrl: merged.incomingUrl?.trim() || envIncomingUrl || "",
    webhookPath: merged.webhookPath?.trim() || DEFAULT_WEBHOOK_PATH,
    dmPolicy: merged.dmPolicy ?? "allowlist",
    allowedUserIds: parseAllowedUserIds(merged.allowedUserIds),
    config: merged,
  };
}

function hasSynologyChatCredentials(cfg: FasedAgentConfig): boolean {
  return listSynologyChatAccountIds(cfg).some((accountId) => {
    const account = resolveSynologyChatAccount(cfg, accountId);
    return Boolean(account.token && account.incomingUrl);
  });
}

function patchSynologyChatConfig(
  cfg: FasedAgentConfig,
  patch: Record<string, unknown>,
): FasedAgentConfig {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const current = (channels["synology-chat"] ?? {}) as Record<string, unknown>;
  return {
    ...cfg,
    channels: {
      ...channels,
      "synology-chat": {
        ...current,
        enabled: true,
        ...patch,
      },
    },
  };
}

function patchSynologyChatAccountConfig(params: {
  cfg: FasedAgentConfig;
  accountId: string;
  patch: Record<string, unknown>;
}): FasedAgentConfig {
  const { cfg, accountId, patch } = params;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return patchSynologyChatConfig(cfg, patch);
  }
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const current = (channels["synology-chat"] ?? {}) as SynologyChatConfig;
  const accounts = current.accounts ?? {};
  const existing = accounts[accountId] ?? {};
  return {
    ...cfg,
    channels: {
      ...channels,
      "synology-chat": {
        ...current,
        enabled: true,
        accounts: {
          ...accounts,
          [accountId]: {
            ...existing,
            enabled: existing.enabled ?? true,
            ...patch,
          },
        },
      },
    },
  };
}

async function promptSynologyToken(
  prompter: WizardPrompter,
  initialValue?: string,
): Promise<string> {
  return String(
    await prompter.text({
      message: "Synology outgoing webhook token",
      initialValue,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    }),
  ).trim();
}

async function promptSynologyIncomingUrl(
  prompter: WizardPrompter,
  initialValue?: string,
): Promise<string> {
  return String(
    await prompter.text({
      message: "Synology incoming webhook URL",
      initialValue,
      validate: (value) => {
        const trimmed = String(value ?? "").trim();
        if (!trimmed) {
          return "Required";
        }
        if (!/^https?:\/\//i.test(trimmed)) {
          return "Use a full URL (https://...)";
        }
        return undefined;
      },
    }),
  ).trim();
}

async function promptSynologyWebhookPath(
  prompter: WizardPrompter,
  initialValue?: string,
): Promise<string> {
  const wantsCustomPath = await prompter.confirm({
    message: "Configure a custom webhook path? (default: /webhook/synology)",
    initialValue: Boolean(initialValue && initialValue !== DEFAULT_WEBHOOK_PATH),
  });
  if (!wantsCustomPath) {
    return DEFAULT_WEBHOOK_PATH;
  }
  return String(
    await prompter.text({
      message: "Synology outgoing webhook path",
      placeholder: DEFAULT_WEBHOOK_PATH,
      initialValue: initialValue || DEFAULT_WEBHOOK_PATH,
      validate: (value) => {
        const trimmed = String(value ?? "").trim();
        if (!trimmed) {
          return "Required";
        }
        if (!trimmed.startsWith("/")) {
          return "Path must start with /";
        }
        return undefined;
      },
    }),
  ).trim();
}

async function promptSynologyAllowedUserIds(params: {
  cfg: FasedAgentConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<FasedAgentConfig> {
  const current = resolveSynologyChatAccount(params.cfg, params.accountId);
  const raw = await params.prompter.text({
    message: "Synology allowed user IDs",
    placeholder: "123456, 987654",
    initialValue: current.allowedUserIds.join(", "),
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });
  return patchSynologyChatAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
    patch: {
      dmPolicy: "allowlist",
      allowedUserIds: mergeAllowFromEntries(
        current.allowedUserIds,
        splitSynologyEntries(String(raw)),
      ),
    },
  });
}

export const synologyChatOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  uiSetup: {
    title: "Synology Chat",
    detail: "Incoming webhook URL, outgoing token, and allowlisted users.",
    notes: [
      "Create an incoming webhook in Synology Chat and copy its URL.",
      "Create an outgoing webhook with a secret token.",
      "Point the outgoing webhook URL to your gateway plus /webhook/synology.",
    ],
    fields: [
      {
        label: "Outgoing token",
        path: ["channels", "synology-chat", "token"],
        placeholder: "Synology outgoing webhook token",
        kind: "password",
      },
      {
        label: "Incoming webhook URL",
        path: ["channels", "synology-chat", "incomingUrl"],
        placeholder: "https://nas.example.com/webapi/entry.cgi?...",
        kind: "password",
      },
      {
        label: "Webhook path",
        path: ["channels", "synology-chat", "webhookPath"],
        placeholder: DEFAULT_WEBHOOK_PATH,
      },
      {
        label: "DM policy",
        path: ["channels", "synology-chat", "dmPolicy"],
        kind: "select",
        options: [
          { value: "allowlist", label: "Allowlist" },
          { value: "open", label: "Open" },
          { value: "disabled", label: "Disabled" },
        ],
      },
      {
        label: "Allowed user IDs",
        path: ["channels", "synology-chat", "allowedUserIds"],
        placeholder: "123456, 987654",
        kind: "list",
      },
      {
        label: "Rate limit/min",
        path: ["channels", "synology-chat", "rateLimitPerMinute"],
        placeholder: "30",
        kind: "number",
      },
    ],
  },
  getStatus: async ({ cfg }) => {
    const configured = hasSynologyChatCredentials(cfg);
    return {
      channel,
      configured,
      statusLines: [`Synology Chat: ${configured ? "configured" : "needs token + incoming URL"}`],
      selectionHint: configured ? "configured" : "webhook bridge",
      quickstartScore: configured ? 1 : 5,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    const accountId = await resolveAccountIdForConfigure({
      cfg,
      prompter,
      label: "Synology Chat",
      accountOverride: accountOverrides["synology-chat"],
      shouldPromptAccountIds,
      listAccountIds: listSynologyChatAccountIds,
      defaultAccountId: resolveDefaultSynologyChatAccountId(cfg),
    });

    let next = cfg;
    const resolved = resolveSynologyChatAccount(next, accountId);
    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv =
      allowEnv &&
      Boolean(process.env.SYNOLOGY_CHAT_TOKEN?.trim()) &&
      Boolean(process.env.SYNOLOGY_CHAT_INCOMING_URL?.trim());
    const hasConfigValues = Boolean(resolved.config.token || resolved.config.incomingUrl);

    let token: string | null = null;
    let incomingUrl: string | null = null;

    if (!resolved.token || !resolved.incomingUrl) {
      await prompter.note(
        [
          "1) In Synology Chat, create an incoming webhook and copy its URL",
          "2) Create an outgoing webhook with a secret token",
          "3) Point the outgoing webhook URL to your gateway endpoint",
          "   Example: https://gateway-host/webhook/synology",
          `Docs: ${formatDocsLink("/channels/synology-chat", "synology-chat")}`,
        ].join("\n"),
        "Synology Chat webhook setup",
      );
    }

    if (canUseEnv && !hasConfigValues) {
      const keepEnv = await prompter.confirm({
        message: "SYNOLOGY_CHAT_TOKEN + SYNOLOGY_CHAT_INCOMING_URL detected. Use env vars?",
        initialValue: true,
      });
      if (keepEnv) {
        next = patchSynologyChatAccountConfig({ cfg: next, accountId, patch: {} });
      } else {
        token = await promptSynologyToken(prompter);
        incomingUrl = await promptSynologyIncomingUrl(prompter);
      }
    } else if (resolved.token && resolved.incomingUrl && hasConfigValues) {
      const keep = await prompter.confirm({
        message: "Synology Chat credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        token = await promptSynologyToken(prompter, resolved.config.token);
        incomingUrl = await promptSynologyIncomingUrl(prompter, resolved.config.incomingUrl);
      }
    } else {
      token = await promptSynologyToken(prompter, resolved.config.token);
      incomingUrl = await promptSynologyIncomingUrl(prompter, resolved.config.incomingUrl);
    }

    const webhookPath = await promptSynologyWebhookPath(prompter, resolved.config.webhookPath);
    next = patchSynologyChatAccountConfig({
      cfg: next,
      accountId,
      patch: {
        ...(token ? { token } : {}),
        ...(incomingUrl ? { incomingUrl } : {}),
        webhookPath,
        dmPolicy: resolved.config.dmPolicy ?? "allowlist",
        rateLimitPerMinute: resolved.config.rateLimitPerMinute ?? 30,
      },
    });

    const nextResolved = resolveSynologyChatAccount(next, accountId);
    if (forceAllowFrom || nextResolved.dmPolicy === "allowlist") {
      next = await promptSynologyAllowedUserIds({ cfg: next, prompter, accountId });
    }

    return { cfg: next, accountId };
  },
  disable: (cfg) => {
    const channels = (cfg.channels ?? {}) as Record<string, unknown>;
    const current = (channels["synology-chat"] ?? {}) as Record<string, unknown>;
    return {
      ...cfg,
      channels: {
        ...channels,
        "synology-chat": {
          ...current,
          enabled: false,
        },
      },
    };
  },
};
