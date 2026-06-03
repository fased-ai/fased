import type { FasedAgentConfig } from "../../../config/config.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter } from "../onboarding-types.js";
import { resolveAccountIdForConfigure } from "./helpers.js";

const channel = "mattermost" as const;

type MattermostChannelConfig = {
  enabled?: boolean;
  botToken?: string;
  baseUrl?: string;
  accounts?: Record<string, { enabled?: boolean; botToken?: string; baseUrl?: string } | undefined>;
};

function resolveMattermostConfig(cfg: FasedAgentConfig): MattermostChannelConfig {
  return ((cfg.channels as Record<string, unknown> | undefined)?.mattermost ??
    {}) as MattermostChannelConfig;
}

function hasMattermostCredentials(cfg: FasedAgentConfig): boolean {
  return listMattermostAccountIds(cfg).some((accountId) => {
    const account = resolveMattermostAccount(cfg, accountId);
    return Boolean(account.botToken && account.baseUrl);
  });
}

function listMattermostAccountIds(cfg: FasedAgentConfig): string[] {
  const accountIds = Object.keys(resolveMattermostConfig(cfg).accounts ?? {}).filter(Boolean);
  if (accountIds.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return accountIds.toSorted((a, b) => a.localeCompare(b));
}

function resolveDefaultMattermostAccountId(cfg: FasedAgentConfig): string {
  const accountIds = listMattermostAccountIds(cfg);
  if (accountIds.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return accountIds[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveMattermostAccount(cfg: FasedAgentConfig, rawAccountId?: string | null) {
  const accountId = normalizeAccountId(rawAccountId);
  const mattermost = resolveMattermostConfig(cfg);
  const { accounts: _ignored, ...base } = mattermost;
  const account = accountId === DEFAULT_ACCOUNT_ID ? {} : (mattermost.accounts?.[accountId] ?? {});
  const merged = { ...base, ...account };
  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv ? process.env.MATTERMOST_BOT_TOKEN?.trim() : undefined;
  const envUrl = allowEnv ? process.env.MATTERMOST_URL?.trim() : undefined;
  const botToken = merged.botToken?.trim() || envToken || "";
  const baseUrl = merged.baseUrl?.trim() || envUrl || "";
  return {
    accountId,
    botToken,
    baseUrl,
    config: merged,
  };
}

function patchMattermostConfig(
  cfg: FasedAgentConfig,
  patch: Record<string, unknown>,
): FasedAgentConfig {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const current = (channels.mattermost ?? {}) as Record<string, unknown>;
  return {
    ...cfg,
    channels: {
      ...channels,
      mattermost: {
        ...current,
        enabled: true,
        ...patch,
      },
    },
  };
}

function patchMattermostAccountConfig(params: {
  cfg: FasedAgentConfig;
  accountId: string;
  patch: Record<string, unknown>;
}): FasedAgentConfig {
  const { cfg, accountId, patch } = params;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return patchMattermostConfig(cfg, patch);
  }
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const current = (channels.mattermost ?? {}) as MattermostChannelConfig;
  const accounts = current.accounts ?? {};
  const existing = accounts[accountId] ?? {};
  return {
    ...cfg,
    channels: {
      ...channels,
      mattermost: {
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

async function promptMattermostCredentials(prompter: WizardPrompter) {
  const botToken = String(
    await prompter.text({
      message: "Enter Mattermost bot token",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
  const baseUrl = String(
    await prompter.text({
      message: "Enter Mattermost base URL",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
  return { botToken, baseUrl };
}

export const mattermostOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  uiSetup: {
    title: "Mattermost",
    detail: "Bot token and server URL.",
    notes: [
      "1) Mattermost System Console -> Integrations -> Bot Accounts",
      "2) Create a bot and copy its token",
      "3) Use your server base URL, for example https://chat.example.com",
      "Tip: the bot must be a member of any channel you want it to monitor.",
    ],
    fields: [
      {
        label: "Bot token",
        path: ["channels", "mattermost", "botToken"],
        placeholder: "Mattermost bot token",
        kind: "password",
      },
      {
        label: "Base URL",
        path: ["channels", "mattermost", "baseUrl"],
        placeholder: "https://chat.example.com",
      },
    ],
  },
  getStatus: async ({ cfg }) => {
    const configured = hasMattermostCredentials(cfg);
    return {
      channel,
      configured,
      statusLines: [`Mattermost: ${configured ? "configured" : "needs token + url"}`],
      selectionHint: configured ? "configured" : "needs setup",
      quickstartScore: configured ? 2 : 1,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const accountId = await resolveAccountIdForConfigure({
      cfg,
      prompter,
      label: "Mattermost",
      accountOverride: accountOverrides.mattermost,
      shouldPromptAccountIds,
      listAccountIds: listMattermostAccountIds,
      defaultAccountId: resolveDefaultMattermostAccountId(cfg),
    });

    let next = cfg;
    const resolvedAccount = resolveMattermostAccount(next, accountId);
    const accountConfigured = Boolean(resolvedAccount.botToken && resolvedAccount.baseUrl);
    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv =
      allowEnv &&
      Boolean(process.env.MATTERMOST_BOT_TOKEN?.trim()) &&
      Boolean(process.env.MATTERMOST_URL?.trim());
    const hasConfigValues = Boolean(
      resolvedAccount.config.botToken || resolvedAccount.config.baseUrl,
    );

    let botToken: string | null = null;
    let baseUrl: string | null = null;

    if (!accountConfigured) {
      await prompter.note(
        [
          "1) Mattermost System Console -> Integrations -> Bot Accounts",
          "2) Create a bot and copy its token",
          "3) Use your server base URL, for example https://chat.example.com",
          "Tip: the bot must be a member of any channel you want it to monitor.",
        ].join("\n"),
        "Mattermost bot token",
      );
    }

    if (canUseEnv && !hasConfigValues) {
      const keepEnv = await prompter.confirm({
        message: "MATTERMOST_BOT_TOKEN + MATTERMOST_URL detected. Use env vars?",
        initialValue: true,
      });
      if (keepEnv) {
        next = patchMattermostAccountConfig({ cfg: next, accountId, patch: {} });
      } else {
        ({ botToken, baseUrl } = await promptMattermostCredentials(prompter));
      }
    } else if (accountConfigured) {
      const keep = await prompter.confirm({
        message: "Mattermost credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        ({ botToken, baseUrl } = await promptMattermostCredentials(prompter));
      }
    } else {
      ({ botToken, baseUrl } = await promptMattermostCredentials(prompter));
    }

    if (botToken || baseUrl) {
      next = patchMattermostAccountConfig({
        cfg: next,
        accountId,
        patch: {
          ...(botToken ? { botToken } : {}),
          ...(baseUrl ? { baseUrl } : {}),
        },
      });
    }

    return {
      cfg: next,
      accountId,
    };
  },
  disable: (cfg) => {
    const channels = (cfg.channels ?? {}) as Record<string, unknown>;
    const current = (channels.mattermost ?? {}) as Record<string, unknown>;
    return {
      ...cfg,
      channels: {
        ...channels,
        mattermost: {
          ...current,
          enabled: false,
        },
      },
    };
  },
};
