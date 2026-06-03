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

const channel = "bluebubbles" as const;
const DEFAULT_WEBHOOK_PATH = "/bluebubbles-webhook";

type BlueBubblesAccountConfig = {
  enabled?: boolean;
  serverUrl?: string;
  password?: string;
  webhookPath?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
};

type BlueBubblesConfig = BlueBubblesAccountConfig & {
  accounts?: Record<string, BlueBubblesAccountConfig | undefined>;
};

function normalizeBlueBubblesServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("BlueBubbles server URL is required");
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

function resolveBlueBubblesConfig(cfg: FasedAgentConfig): BlueBubblesConfig {
  return ((cfg.channels as Record<string, unknown> | undefined)?.bluebubbles ??
    {}) as BlueBubblesConfig;
}

function listBlueBubblesAccountIds(cfg: FasedAgentConfig): string[] {
  const accountIds = Object.keys(resolveBlueBubblesConfig(cfg).accounts ?? {}).filter(Boolean);
  if (accountIds.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return accountIds.toSorted((a, b) => a.localeCompare(b));
}

function resolveDefaultBlueBubblesAccountId(cfg: FasedAgentConfig): string {
  const accountIds = listBlueBubblesAccountIds(cfg);
  if (accountIds.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return accountIds[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveBlueBubblesAccount(cfg: FasedAgentConfig, rawAccountId?: string | null) {
  const accountId = normalizeAccountId(rawAccountId);
  const bluebubbles = resolveBlueBubblesConfig(cfg);
  const { accounts: _ignored, ...base } = bluebubbles;
  const account = accountId === DEFAULT_ACCOUNT_ID ? {} : (bluebubbles.accounts?.[accountId] ?? {});
  const merged = { ...base, ...account };
  return {
    accountId,
    serverUrl: merged.serverUrl?.trim() ?? "",
    password: merged.password?.trim() ?? "",
    webhookPath: merged.webhookPath?.trim() || DEFAULT_WEBHOOK_PATH,
    config: merged,
  };
}

function hasBlueBubblesCredentials(cfg: FasedAgentConfig): boolean {
  return listBlueBubblesAccountIds(cfg).some((accountId) => {
    const account = resolveBlueBubblesAccount(cfg, accountId);
    return Boolean(account.serverUrl && account.password);
  });
}

function patchBlueBubblesConfig(
  cfg: FasedAgentConfig,
  patch: Record<string, unknown>,
): FasedAgentConfig {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const current = (channels.bluebubbles ?? {}) as Record<string, unknown>;
  return {
    ...cfg,
    channels: {
      ...channels,
      bluebubbles: {
        ...current,
        enabled: true,
        ...patch,
      },
    },
  };
}

function patchBlueBubblesAccountConfig(params: {
  cfg: FasedAgentConfig;
  accountId: string;
  patch: Record<string, unknown>;
}): FasedAgentConfig {
  const { cfg, accountId, patch } = params;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return patchBlueBubblesConfig(cfg, patch);
  }
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const current = (channels.bluebubbles ?? {}) as BlueBubblesConfig;
  const accounts = current.accounts ?? {};
  const existing = accounts[accountId] ?? {};
  return {
    ...cfg,
    channels: {
      ...channels,
      bluebubbles: {
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

function parseBlueBubblesAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isValidBlueBubblesAllowTarget(value: string): boolean {
  if (value === "*") {
    return true;
  }
  if (/^chat_(id|guid|identifier):.+/i.test(value)) {
    return true;
  }
  return value.length > 0;
}

function setBlueBubblesDmPolicy(cfg: FasedAgentConfig, policy: DmPolicy): FasedAgentConfig {
  const current = resolveBlueBubblesConfig(cfg);
  const allowFrom = policy === "open" ? addWildcardAllowFrom(current.allowFrom) : undefined;
  return patchBlueBubblesConfig(cfg, {
    dmPolicy: policy,
    ...(allowFrom ? { allowFrom } : {}),
  });
}

async function promptBlueBubblesAllowFrom(params: {
  cfg: FasedAgentConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<FasedAgentConfig> {
  const accountId = params.accountId
    ? normalizeAccountId(params.accountId)
    : resolveDefaultBlueBubblesAccountId(params.cfg);
  const resolved = resolveBlueBubblesAccount(params.cfg, accountId);
  const existing = resolved.config.allowFrom ?? [];
  await params.prompter.note(
    [
      "Allowlist BlueBubbles DMs by handle or chat target.",
      "Examples:",
      "- +15555550123",
      "- user@example.com",
      "- chat_id:123",
      "- chat_guid:iMessage;-;+15555550123",
      "Multiple entries: comma- or newline-separated.",
      `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
    ].join("\n"),
    "BlueBubbles allowlist",
  );
  const entry = await params.prompter.text({
    message: "BlueBubbles allowFrom (handle or chat_id)",
    placeholder: "+15555550123, user@example.com, chat_id:123",
    initialValue: existing[0] ? String(existing[0]) : undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) {
        return "Required";
      }
      const parts = parseBlueBubblesAllowFromInput(raw);
      for (const part of parts) {
        if (!isValidBlueBubblesAllowTarget(part)) {
          return `Invalid entry: ${part}`;
        }
      }
      return undefined;
    },
  });
  const unique = mergeAllowFromEntries(undefined, parseBlueBubblesAllowFromInput(String(entry)));
  return patchBlueBubblesAccountConfig({
    cfg: params.cfg,
    accountId,
    patch: { allowFrom: unique },
  });
}

async function promptBlueBubblesServerUrl(
  prompter: WizardPrompter,
  initialValue?: string,
): Promise<string> {
  const entered = await prompter.text({
    message: "BlueBubbles server URL",
    placeholder: "http://192.168.1.100:1234",
    initialValue,
    validate: (value) => {
      const trimmed = String(value ?? "").trim();
      if (!trimmed) {
        return "Required";
      }
      try {
        new URL(normalizeBlueBubblesServerUrl(trimmed));
        return undefined;
      } catch {
        return "Invalid URL format";
      }
    },
  });
  return normalizeBlueBubblesServerUrl(String(entered));
}

async function promptBlueBubblesPassword(
  prompter: WizardPrompter,
  initialValue?: string,
): Promise<string> {
  return String(
    await prompter.text({
      message: "BlueBubbles password",
      initialValue,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    }),
  ).trim();
}

async function promptBlueBubblesWebhookPath(
  prompter: WizardPrompter,
  initialValue?: string,
): Promise<string> {
  const wantsWebhook = await prompter.confirm({
    message: "Configure a custom webhook path? (default: /bluebubbles-webhook)",
    initialValue: Boolean(initialValue && initialValue !== DEFAULT_WEBHOOK_PATH),
  });
  if (!wantsWebhook) {
    return DEFAULT_WEBHOOK_PATH;
  }
  return String(
    await prompter.text({
      message: "Webhook path",
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
  label: "BlueBubbles",
  channel,
  policyKey: "channels.bluebubbles.dmPolicy",
  allowFromKey: "channels.bluebubbles.allowFrom",
  getCurrent: (cfg) => resolveBlueBubblesConfig(cfg).dmPolicy ?? "pairing",
  setPolicy: setBlueBubblesDmPolicy,
  promptAllowFrom: promptBlueBubblesAllowFrom,
};

export const blueBubblesOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  uiSetup: {
    title: "BlueBubbles",
    detail: "Server URL, password, and webhook path.",
    notes: [
      "Find the server URL in BlueBubbles Server -> Connection.",
      "Find the password in BlueBubbles Server -> Settings.",
      "Configure the webhook in BlueBubbles Server -> Settings -> Webhooks.",
    ],
    fields: [
      {
        label: "Server URL",
        path: ["channels", "bluebubbles", "serverUrl"],
        placeholder: "http://192.168.1.100:1234",
      },
      {
        label: "Password",
        path: ["channels", "bluebubbles", "password"],
        placeholder: "BlueBubbles server password",
        kind: "password",
      },
      {
        label: "Webhook path",
        path: ["channels", "bluebubbles", "webhookPath"],
        placeholder: DEFAULT_WEBHOOK_PATH,
      },
    ],
  },
  getStatus: async ({ cfg }) => {
    const configured = hasBlueBubblesCredentials(cfg);
    return {
      channel,
      configured,
      statusLines: [`BlueBubbles: ${configured ? "configured" : "needs setup"}`],
      selectionHint: configured ? "configured" : "iMessage via BlueBubbles app",
      quickstartScore: configured ? 1 : 0,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const accountId = await resolveAccountIdForConfigure({
      cfg,
      prompter,
      label: "BlueBubbles",
      accountOverride: accountOverrides.bluebubbles,
      shouldPromptAccountIds,
      listAccountIds: listBlueBubblesAccountIds,
      defaultAccountId: resolveDefaultBlueBubblesAccountId(cfg),
    });

    let next = cfg;
    const resolvedAccount = resolveBlueBubblesAccount(next, accountId);
    let serverUrl = resolvedAccount.serverUrl;
    let password = resolvedAccount.password;

    if (!serverUrl) {
      await prompter.note(
        [
          "Enter the BlueBubbles server URL, for example http://192.168.1.100:1234.",
          "Find this in the BlueBubbles Server app under Connection.",
          `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
        ].join("\n"),
        "BlueBubbles server URL",
      );
      serverUrl = await promptBlueBubblesServerUrl(prompter);
    } else {
      const keepUrl = await prompter.confirm({
        message: `BlueBubbles server URL already set (${serverUrl}). Keep it?`,
        initialValue: true,
      });
      if (!keepUrl) {
        serverUrl = await promptBlueBubblesServerUrl(prompter, serverUrl);
      }
    }

    if (!password) {
      await prompter.note(
        [
          "Enter the BlueBubbles server password.",
          "Find this in the BlueBubbles Server app under Settings.",
        ].join("\n"),
        "BlueBubbles password",
      );
      password = await promptBlueBubblesPassword(prompter);
    } else {
      const keepPassword = await prompter.confirm({
        message: "BlueBubbles password already set. Keep it?",
        initialValue: true,
      });
      if (!keepPassword) {
        password = await promptBlueBubblesPassword(prompter);
      }
    }

    const webhookPath = await promptBlueBubblesWebhookPath(
      prompter,
      resolvedAccount.config.webhookPath,
    );

    next = patchBlueBubblesAccountConfig({
      cfg: next,
      accountId,
      patch: { serverUrl, password, webhookPath },
    });

    await prompter.note(
      [
        "Configure the webhook URL in BlueBubbles Server:",
        "1. Open BlueBubbles Server -> Settings -> Webhooks",
        "2. Add your FasedAgent gateway URL + webhook path",
        "   Example: https://your-gateway-host:3000/bluebubbles-webhook",
        "3. Enable the webhook and save",
        "",
        `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
      ].join("\n"),
      "BlueBubbles next steps",
    );

    return { cfg: next, accountId };
  },
  dmPolicy,
  disable: (cfg) => {
    const channels = (cfg.channels ?? {}) as Record<string, unknown>;
    const current = (channels.bluebubbles ?? {}) as Record<string, unknown>;
    return {
      ...cfg,
      channels: {
        ...channels,
        bluebubbles: {
          ...current,
          enabled: false,
        },
      },
    };
  },
};
