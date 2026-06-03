import type { FasedAgentConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import { formatDocsLink } from "../../../terminal/links.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import {
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  resolveAccountIdForConfigure,
} from "./helpers.js";

const channel = "line" as const;
const DEFAULT_WEBHOOK_PATH = "/line/webhook";

type LineAccountConfig = {
  enabled?: boolean;
  channelAccessToken?: string;
  channelSecret?: string;
  tokenFile?: string;
  secretFile?: string;
  name?: string;
  webhookPath?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
};

type LineConfig = LineAccountConfig & {
  accounts?: Record<string, LineAccountConfig | undefined>;
};

function resolveLineConfig(cfg: FasedAgentConfig): LineConfig {
  return ((cfg.channels as Record<string, unknown> | undefined)?.line ?? {}) as LineConfig;
}

function listLineAccountIds(cfg: FasedAgentConfig): string[] {
  const line = resolveLineConfig(cfg);
  const ids = new Set<string>();
  if (
    line.channelAccessToken?.trim() ||
    line.tokenFile?.trim() ||
    process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim()
  ) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }
  for (const id of Object.keys(line.accounts ?? {})) {
    ids.add(normalizeAccountId(id));
  }
  if (ids.size === 0) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }
  return Array.from(ids).toSorted((a, b) => a.localeCompare(b));
}

function resolveDefaultLineAccountId(cfg: FasedAgentConfig): string {
  const accountIds = listLineAccountIds(cfg);
  if (accountIds.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return accountIds[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveLineAccount(cfg: FasedAgentConfig, rawAccountId?: string | null) {
  const accountId = normalizeAccountId(rawAccountId);
  const line = resolveLineConfig(cfg);
  const { accounts: _ignored, ...base } = line;
  const account = accountId === DEFAULT_ACCOUNT_ID ? {} : (line.accounts?.[accountId] ?? {});
  const merged = { ...base, ...account };
  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv ? process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim() : undefined;
  const envSecret = allowEnv ? process.env.LINE_CHANNEL_SECRET?.trim() : undefined;
  return {
    accountId,
    channelAccessToken: merged.channelAccessToken?.trim() || envToken || "",
    channelSecret: merged.channelSecret?.trim() || envSecret || "",
    webhookPath: merged.webhookPath?.trim() || DEFAULT_WEBHOOK_PATH,
    config: merged,
  };
}

function hasLineCredentials(cfg: FasedAgentConfig): boolean {
  return listLineAccountIds(cfg).some((accountId) => {
    const account = resolveLineAccount(cfg, accountId);
    return Boolean(account.channelAccessToken && account.channelSecret);
  });
}

function patchLineConfig(cfg: FasedAgentConfig, patch: Record<string, unknown>): FasedAgentConfig {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const current = (channels.line ?? {}) as Record<string, unknown>;
  return {
    ...cfg,
    channels: {
      ...channels,
      line: {
        ...current,
        enabled: true,
        ...patch,
      },
    },
  };
}

function patchLineAccountConfig(params: {
  cfg: FasedAgentConfig;
  accountId: string;
  patch: Record<string, unknown>;
}): FasedAgentConfig {
  const { cfg, accountId, patch } = params;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return patchLineConfig(cfg, patch);
  }
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const current = (channels.line ?? {}) as LineConfig;
  const accounts = current.accounts ?? {};
  const existing = accounts[accountId] ?? {};
  return {
    ...cfg,
    channels: {
      ...channels,
      line: {
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

function splitLineEntries(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeLineAllowEntry(raw: string): string {
  return raw.trim().replace(/^line:(?:user:)?/i, "");
}

function setLineDmPolicy(cfg: FasedAgentConfig, policy: DmPolicy): FasedAgentConfig {
  const current = resolveLineConfig(cfg);
  const allowFrom = policy === "open" ? addWildcardAllowFrom(current.allowFrom) : undefined;
  return patchLineConfig(cfg, {
    dmPolicy: policy,
    ...(allowFrom ? { allowFrom } : {}),
  });
}

async function promptLineAllowFrom(params: {
  cfg: FasedAgentConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<FasedAgentConfig> {
  const accountId = params.accountId
    ? normalizeAccountId(params.accountId)
    : resolveDefaultLineAccountId(params.cfg);
  const resolved = resolveLineAccount(params.cfg, accountId);
  const current = resolved.config.allowFrom ?? [];
  await params.prompter.note(
    [
      "Allowlist LINE DMs by user ID.",
      "LINE user IDs are case-sensitive and usually look like U plus 32 hex characters.",
      "Multiple entries: comma-, semicolon-, or newline-separated.",
      `Docs: ${formatDocsLink("/channels/line", "line")}`,
    ].join("\n"),
    "LINE allowlist",
  );
  const raw = await params.prompter.text({
    message: "LINE allowFrom (user IDs)",
    placeholder: "U0123456789abcdef0123456789abcdef",
    initialValue: current.map((entry) => String(entry)).join(", "),
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });
  return patchLineAccountConfig({
    cfg: params.cfg,
    accountId,
    patch: {
      dmPolicy: "allowlist",
      allowFrom: mergeAllowFromEntries(
        current,
        splitLineEntries(String(raw)).map(normalizeLineAllowEntry),
      ),
    },
  });
}

async function promptLineToken(prompter: WizardPrompter, initialValue?: string): Promise<string> {
  return String(
    await prompter.text({
      message: "LINE channel access token",
      initialValue,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    }),
  ).trim();
}

async function promptLineSecret(prompter: WizardPrompter, initialValue?: string): Promise<string> {
  return String(
    await prompter.text({
      message: "LINE channel secret",
      initialValue,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    }),
  ).trim();
}

async function promptLineWebhookPath(
  prompter: WizardPrompter,
  initialValue?: string,
): Promise<string> {
  const wantsCustomPath = await prompter.confirm({
    message: "Configure a custom webhook path? (default: /line/webhook)",
    initialValue: Boolean(initialValue && initialValue !== DEFAULT_WEBHOOK_PATH),
  });
  if (!wantsCustomPath) {
    return DEFAULT_WEBHOOK_PATH;
  }
  return String(
    await prompter.text({
      message: "LINE webhook path",
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

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "LINE",
  channel,
  policyKey: "channels.line.dmPolicy",
  allowFromKey: "channels.line.allowFrom",
  getCurrent: (cfg) => resolveLineConfig(cfg).dmPolicy ?? "pairing",
  setPolicy: setLineDmPolicy,
  promptAllowFrom: promptLineAllowFrom,
};

export const lineOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  uiSetup: {
    title: "LINE",
    detail: "Messaging API token, secret, and webhook path.",
    notes: [
      "LINE Developers Console -> Provider -> Messaging API channel.",
      "Copy the channel access token and channel secret.",
      "Enable Use webhook and set the webhook URL to your gateway plus /line/webhook.",
    ],
    fields: [
      {
        label: "Channel access token",
        path: ["channels", "line", "channelAccessToken"],
        placeholder: "LINE channel access token",
        kind: "password",
      },
      {
        label: "Channel secret",
        path: ["channels", "line", "channelSecret"],
        placeholder: "LINE channel secret",
        kind: "password",
      },
      {
        label: "Webhook path",
        path: ["channels", "line", "webhookPath"],
        placeholder: DEFAULT_WEBHOOK_PATH,
      },
    ],
  },
  getStatus: async ({ cfg }) => {
    const configured = hasLineCredentials(cfg);
    return {
      channel,
      configured,
      statusLines: [`LINE: ${configured ? "configured" : "needs token + secret"}`],
      selectionHint: configured ? "configured" : "Messaging API bot",
      quickstartScore: configured ? 1 : 4,
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
      label: "LINE",
      accountOverride: accountOverrides.line,
      shouldPromptAccountIds,
      listAccountIds: listLineAccountIds,
      defaultAccountId: resolveDefaultLineAccountId(cfg),
    });

    let next = cfg;
    const resolved = resolveLineAccount(next, accountId);
    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv =
      allowEnv &&
      Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim()) &&
      Boolean(process.env.LINE_CHANNEL_SECRET?.trim());
    const hasConfigValues = Boolean(
      resolved.config.channelAccessToken ||
      resolved.config.channelSecret ||
      resolved.config.tokenFile ||
      resolved.config.secretFile,
    );

    let channelAccessToken: string | null = null;
    let channelSecret: string | null = null;

    if (!resolved.channelAccessToken || !resolved.channelSecret) {
      await prompter.note(
        [
          "1) LINE Developers Console -> create or pick a Messaging API channel",
          "2) Copy the Channel access token and Channel secret",
          "3) Enable Use webhook",
          "4) Set webhook URL to your gateway endpoint, for example https://gateway-host/line/webhook",
          `Docs: ${formatDocsLink("/channels/line", "line")}`,
        ].join("\n"),
        "LINE Messaging API",
      );
    }

    if (canUseEnv && !hasConfigValues) {
      const keepEnv = await prompter.confirm({
        message: "LINE_CHANNEL_ACCESS_TOKEN + LINE_CHANNEL_SECRET detected. Use env vars?",
        initialValue: true,
      });
      if (keepEnv) {
        next = patchLineAccountConfig({ cfg: next, accountId, patch: {} });
      } else {
        channelAccessToken = await promptLineToken(prompter);
        channelSecret = await promptLineSecret(prompter);
      }
    } else if (resolved.channelAccessToken && resolved.channelSecret && hasConfigValues) {
      const keep = await prompter.confirm({
        message: "LINE credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        channelAccessToken = await promptLineToken(prompter, resolved.config.channelAccessToken);
        channelSecret = await promptLineSecret(prompter, resolved.config.channelSecret);
      }
    } else {
      channelAccessToken = await promptLineToken(prompter, resolved.config.channelAccessToken);
      channelSecret = await promptLineSecret(prompter, resolved.config.channelSecret);
    }

    const webhookPath = await promptLineWebhookPath(prompter, resolved.config.webhookPath);
    next = patchLineAccountConfig({
      cfg: next,
      accountId,
      patch: {
        ...(channelAccessToken ? { channelAccessToken } : {}),
        ...(channelSecret ? { channelSecret } : {}),
        webhookPath,
      },
    });

    if (forceAllowFrom) {
      next = await promptLineAllowFrom({ cfg: next, prompter, accountId });
    }

    return { cfg: next, accountId };
  },
  dmPolicy,
  disable: (cfg) => {
    const channels = (cfg.channels ?? {}) as Record<string, unknown>;
    const current = (channels.line ?? {}) as Record<string, unknown>;
    return {
      ...cfg,
      channels: {
        ...channels,
        line: {
          ...current,
          enabled: false,
        },
      },
    };
  },
};
