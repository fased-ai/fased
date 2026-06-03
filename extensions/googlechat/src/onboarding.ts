import type { FasedAgentConfig, DmPolicy } from "fased/plugin-sdk";
import {
  addWildcardAllowFrom,
  formatDocsLink,
  mergeAllowFromEntries,
  promptAccountId,
  type ChannelOnboardingAdapter,
  type ChannelOnboardingDmPolicy,
  type WizardPrompter,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  migrateBaseNameToDefaultAccount,
} from "fased/plugin-sdk";
import {
  listGoogleChatAccountIds,
  resolveDefaultGoogleChatAccountId,
  resolveGoogleChatAccount,
} from "./accounts.js";

const channel = "googlechat" as const;

const ENV_SERVICE_ACCOUNT = "GOOGLE_CHAT_SERVICE_ACCOUNT";
const ENV_SERVICE_ACCOUNT_FILE = "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE";

function setGoogleChatDmPolicy(cfg: FasedAgentConfig, policy: DmPolicy) {
  const allowFrom =
    policy === "open"
      ? addWildcardAllowFrom(cfg.channels?.["googlechat"]?.dm?.allowFrom)
      : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      googlechat: {
        ...cfg.channels?.["googlechat"],
        dm: {
          ...cfg.channels?.["googlechat"]?.dm,
          policy,
          ...(allowFrom ? { allowFrom } : {}),
        },
      },
    },
  };
}

function parseAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function promptAllowFrom(params: {
  cfg: FasedAgentConfig;
  prompter: WizardPrompter;
}): Promise<FasedAgentConfig> {
  const current = params.cfg.channels?.["googlechat"]?.dm?.allowFrom ?? [];
  const entry = await params.prompter.text({
    message: "Google Chat allowFrom (users/<id> or raw email; avoid users/<email>)",
    placeholder: "users/123456789, name@example.com",
    initialValue: current[0] ? String(current[0]) : undefined,
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });
  const parts = parseAllowFromInput(String(entry));
  const unique = mergeAllowFromEntries(undefined, parts);
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      googlechat: {
        ...params.cfg.channels?.["googlechat"],
        enabled: true,
        dm: {
          ...params.cfg.channels?.["googlechat"]?.dm,
          policy: "allowlist",
          allowFrom: unique,
        },
      },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Google Chat",
  channel,
  policyKey: "channels.googlechat.dm.policy",
  allowFromKey: "channels.googlechat.dm.allowFrom",
  getCurrent: (cfg) => cfg.channels?.["googlechat"]?.dm?.policy ?? "pairing",
  setPolicy: (cfg, policy) => setGoogleChatDmPolicy(cfg, policy),
  promptAllowFrom,
};

const googleChatUiSetup: ChannelOnboardingAdapter["uiSetup"] = {
  title: "Google Chat",
  detail: "Chat API webhook.",
  notes: [
    "Create a Google Chat app in Google Cloud, enable the Chat API, and create a service account JSON key.",
    "Use the gateway webhook URL or webhook path for inbound Chat events.",
    "Set the audience to the app URL or Google Cloud project number used by the Chat app.",
  ],
  fields: [
    {
      label: "Service account file",
      path: ["channels", "googlechat", "serviceAccountFile"],
      placeholder: "/run/secrets/google-chat-service-account.json",
    },
    {
      label: "Webhook path",
      path: ["channels", "googlechat", "webhookPath"],
      placeholder: "/googlechat",
    },
    {
      label: "Webhook URL",
      path: ["channels", "googlechat", "webhookUrl"],
      placeholder: "https://agent.example.com/googlechat",
    },
    {
      label: "Audience type",
      path: ["channels", "googlechat", "audienceType"],
      kind: "select",
      options: [
        { label: "App URL", value: "app-url" },
        { label: "Project number", value: "project-number" },
      ],
    },
    {
      label: "Audience",
      path: ["channels", "googlechat", "audience"],
      placeholder: "https://agent.example.com/googlechat or 123456789012",
    },
    {
      label: "Bot user",
      path: ["channels", "googlechat", "botUser"],
      placeholder: "users/123456789012345678901",
    },
  ],
};

function hasGoogleChatWebhookConfig(cfg: FasedAgentConfig, accountId: string): boolean {
  const account = resolveGoogleChatAccount({ cfg, accountId });
  return Boolean(account.config.webhookPath?.trim() || account.config.webhookUrl?.trim());
}

function hasGoogleChatAudienceConfig(cfg: FasedAgentConfig, accountId: string): boolean {
  const account = resolveGoogleChatAccount({ cfg, accountId });
  return Boolean(
    (account.config.audienceType === "app-url" ||
      account.config.audienceType === "project-number") &&
    account.config.audience?.trim(),
  );
}

function isGoogleChatConfigured(cfg: FasedAgentConfig, accountId: string): boolean {
  const account = resolveGoogleChatAccount({ cfg, accountId });
  return (
    account.credentialSource !== "none" &&
    hasGoogleChatWebhookConfig(cfg, accountId) &&
    hasGoogleChatAudienceConfig(cfg, accountId)
  );
}

function applyAccountConfig(params: {
  cfg: FasedAgentConfig;
  accountId: string;
  patch: Record<string, unknown>;
}): FasedAgentConfig {
  const { cfg, accountId, patch } = params;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        googlechat: {
          ...cfg.channels?.["googlechat"],
          enabled: true,
          ...patch,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      googlechat: {
        ...cfg.channels?.["googlechat"],
        enabled: true,
        accounts: {
          ...cfg.channels?.["googlechat"]?.accounts,
          [accountId]: {
            ...cfg.channels?.["googlechat"]?.accounts?.[accountId],
            enabled: true,
            ...patch,
          },
        },
      },
    },
  };
}

async function promptCredentials(params: {
  cfg: FasedAgentConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<FasedAgentConfig> {
  const { cfg, prompter, accountId } = params;
  const envReady =
    accountId === DEFAULT_ACCOUNT_ID &&
    (Boolean(process.env[ENV_SERVICE_ACCOUNT]) || Boolean(process.env[ENV_SERVICE_ACCOUNT_FILE]));
  if (envReady) {
    const useEnv = await prompter.confirm({
      message: "Use GOOGLE_CHAT_SERVICE_ACCOUNT env vars?",
      initialValue: true,
    });
    if (useEnv) {
      return applyAccountConfig({ cfg, accountId, patch: {} });
    }
  }

  const method = await prompter.select({
    message: "Google Chat auth method",
    options: [
      { value: "file", label: "Service account JSON file" },
      { value: "inline", label: "Paste service account JSON" },
    ],
    initialValue: "file",
  });

  if (method === "file") {
    const path = await prompter.text({
      message: "Service account JSON path",
      placeholder: "/path/to/service-account.json",
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    return applyAccountConfig({
      cfg,
      accountId,
      patch: { serviceAccountFile: String(path).trim() },
    });
  }

  const json = await prompter.text({
    message: "Service account JSON (single line)",
    placeholder: '{"type":"service_account", ... }',
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });
  return applyAccountConfig({
    cfg,
    accountId,
    patch: { serviceAccount: String(json).trim() },
  });
}

async function promptAudience(params: {
  cfg: FasedAgentConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<FasedAgentConfig> {
  const account = resolveGoogleChatAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const currentType = account.config.audienceType ?? "app-url";
  const currentAudience = account.config.audience ?? "";
  const audienceType = await params.prompter.select({
    message: "Webhook audience type",
    options: [
      { value: "app-url", label: "App URL (recommended)" },
      { value: "project-number", label: "Project number" },
    ],
    initialValue: currentType === "project-number" ? "project-number" : "app-url",
  });
  const audience = await params.prompter.text({
    message: audienceType === "project-number" ? "Project number" : "App URL",
    placeholder: audienceType === "project-number" ? "1234567890" : "https://your.host/googlechat",
    initialValue: currentAudience || undefined,
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });
  return applyAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
    patch: { audienceType, audience: String(audience).trim() },
  });
}

async function noteGoogleChatSetup(prompter: WizardPrompter) {
  await prompter.note(
    [
      "Google Chat apps use service-account auth and an HTTPS webhook.",
      "Set the Chat API scopes in your service account and configure the Chat app URL.",
      "Webhook verification requires audience type + audience value.",
      `Docs: ${formatDocsLink("/channels/googlechat", "channels/googlechat")}`,
    ].join("\n"),
    "Google Chat setup",
  );
}

export const googlechatOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  uiSetup: googleChatUiSetup,
  dmPolicy,
  getStatus: async ({ cfg }) => {
    const configured = listGoogleChatAccountIds(cfg).some((accountId) =>
      isGoogleChatConfigured(cfg, accountId),
    );
    return {
      channel,
      configured,
      statusLines: [
        `Google Chat: ${
          configured ? "configured" : "needs service account, webhook, and audience"
        }`,
      ],
      selectionHint: configured ? "configured" : "needs service account, webhook, and audience",
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const override = accountOverrides["googlechat"]?.trim();
    const defaultAccountId = resolveDefaultGoogleChatAccountId(cfg);
    let accountId = override ? normalizeAccountId(override) : defaultAccountId;
    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: "Google Chat",
        currentId: accountId,
        listAccountIds: listGoogleChatAccountIds,
        defaultAccountId,
      });
    }

    let next = cfg;
    await noteGoogleChatSetup(prompter);
    next = await promptCredentials({ cfg: next, prompter, accountId });
    next = await promptAudience({ cfg: next, prompter, accountId });

    const namedConfig = migrateBaseNameToDefaultAccount({
      cfg: next,
      channelKey: "googlechat",
    });

    return { cfg: namedConfig, accountId };
  },
};
