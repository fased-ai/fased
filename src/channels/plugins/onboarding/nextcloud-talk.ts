import type { FasedAgentConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import {
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  resolveAccountIdForConfigure,
} from "./helpers.js";

const channel = "nextcloud-talk" as const;

type NextcloudTalkConfig = {
  enabled?: boolean;
  baseUrl?: string;
  botSecret?: string;
  botSecretFile?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  accounts?: Record<
    string,
    | {
        enabled?: boolean;
        baseUrl?: string;
        botSecret?: string;
        botSecretFile?: string;
        dmPolicy?: DmPolicy;
        allowFrom?: Array<string | number>;
      }
    | undefined
  >;
};

function resolveNextcloudTalkConfig(cfg: FasedAgentConfig): NextcloudTalkConfig {
  return ((cfg.channels as Record<string, unknown> | undefined)?.["nextcloud-talk"] ??
    {}) as NextcloudTalkConfig;
}

function patchNextcloudTalkConfig(
  cfg: FasedAgentConfig,
  patch: Record<string, unknown>,
): FasedAgentConfig {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const current = (channels["nextcloud-talk"] ?? {}) as Record<string, unknown>;
  return {
    ...cfg,
    channels: {
      ...channels,
      "nextcloud-talk": {
        ...current,
        enabled: true,
        ...patch,
      },
    },
  };
}

function listNextcloudTalkAccountIds(cfg: FasedAgentConfig): string[] {
  const accountIds = Object.keys(resolveNextcloudTalkConfig(cfg).accounts ?? {}).filter(Boolean);
  if (accountIds.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return accountIds.toSorted((a, b) => a.localeCompare(b));
}

function resolveDefaultNextcloudTalkAccountId(cfg: FasedAgentConfig): string {
  const accountIds = listNextcloudTalkAccountIds(cfg);
  if (accountIds.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return accountIds[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveNextcloudTalkAccount(cfg: FasedAgentConfig, rawAccountId?: string | null) {
  const accountId = normalizeAccountId(rawAccountId);
  const nextcloudTalk = resolveNextcloudTalkConfig(cfg);
  const { accounts: _ignored, ...base } = nextcloudTalk;
  const account =
    accountId === DEFAULT_ACCOUNT_ID ? {} : (nextcloudTalk.accounts?.[accountId] ?? {});
  const merged = { ...base, ...account };
  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envSecret = allowEnv ? process.env.NEXTCLOUD_TALK_BOT_SECRET?.trim() : undefined;
  const secret = merged.botSecret?.trim() || envSecret || "";
  const baseUrl = merged.baseUrl?.trim() || "";
  return {
    accountId,
    baseUrl,
    secret,
    config: merged,
  };
}

function patchNextcloudTalkAccountConfig(params: {
  cfg: FasedAgentConfig;
  accountId: string;
  patch: Record<string, unknown>;
}): FasedAgentConfig {
  const { cfg, accountId, patch } = params;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return patchNextcloudTalkConfig(cfg, patch);
  }
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const current = (channels["nextcloud-talk"] ?? {}) as NextcloudTalkConfig;
  const accounts = current.accounts ?? {};
  const existing = accounts[accountId] ?? {};
  return {
    ...cfg,
    channels: {
      ...channels,
      "nextcloud-talk": {
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

function hasNextcloudTalkCredentials(cfg: FasedAgentConfig): boolean {
  return listNextcloudTalkAccountIds(cfg).some((accountId) => {
    const account = resolveNextcloudTalkAccount(cfg, accountId);
    return Boolean(account.baseUrl && account.secret);
  });
}

function splitEntries(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function setNextcloudTalkDmPolicy(cfg: FasedAgentConfig, policy: DmPolicy): FasedAgentConfig {
  const current = resolveNextcloudTalkConfig(cfg);
  const allowFrom = policy === "open" ? addWildcardAllowFrom(current.allowFrom) : undefined;
  return patchNextcloudTalkConfig(cfg, {
    dmPolicy: policy,
    ...(allowFrom ? { allowFrom } : {}),
  });
}

async function noteNextcloudTalkSecretHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) SSH into your Nextcloud server",
      '2) Run: ./occ talk:bot:install "FasedAgent" "<shared-secret>" "<webhook-url>" --feature reaction',
      "3) Copy the shared secret you used in the command",
      "4) Enable the bot in your Nextcloud Talk room settings",
      "Tip: you can also set NEXTCLOUD_TALK_BOT_SECRET in your env.",
    ].join("\n"),
    "Nextcloud Talk bot setup",
  );
}

async function promptNextcloudTalkSecret(prompter: WizardPrompter): Promise<string> {
  return String(
    await prompter.text({
      message: "Enter Nextcloud Talk bot secret",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Nextcloud Talk",
  channel,
  policyKey: "channels.nextcloud-talk.dmPolicy",
  allowFromKey: "channels.nextcloud-talk.allowFrom",
  getCurrent: (cfg) => resolveNextcloudTalkConfig(cfg).dmPolicy ?? "pairing",
  setPolicy: setNextcloudTalkDmPolicy,
  promptAllowFrom: async ({ cfg, prompter, accountId }) => {
    const resolvedAccount = resolveNextcloudTalkAccount(
      cfg,
      accountId ?? resolveDefaultNextcloudTalkAccountId(cfg),
    );
    const current = resolvedAccount.config;
    const raw = await prompter.text({
      message: "Nextcloud Talk allowFrom (user id)",
      placeholder: "username",
      initialValue: current.allowFrom?.map((entry) => String(entry)).join(", "),
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    return patchNextcloudTalkAccountConfig({
      cfg,
      accountId: resolvedAccount.accountId,
      patch: {
        dmPolicy: "allowlist",
        allowFrom: mergeAllowFromEntries(current.allowFrom, splitEntries(String(raw))),
      },
    });
  },
};

export const nextcloudTalkOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  uiSetup: {
    title: "Nextcloud Talk",
    detail: "Bot webhook URL and shared secret.",
    notes: [
      "1) SSH into your Nextcloud server",
      '2) Run: ./occ talk:bot:install "FasedAgent" "<shared-secret>" "<webhook-url>" --feature reaction',
      "3) Copy the shared secret you used in the command",
      "4) Enable the bot in your Nextcloud Talk room settings",
      "Tip: you can also set NEXTCLOUD_TALK_BOT_SECRET in your env.",
    ],
    fields: [
      {
        label: "Instance URL",
        path: ["channels", "nextcloud-talk", "baseUrl"],
        placeholder: "https://cloud.example.com",
      },
      {
        label: "Bot secret",
        path: ["channels", "nextcloud-talk", "botSecret"],
        placeholder: "Shared secret",
        kind: "password",
      },
    ],
  },
  getStatus: async ({ cfg }) => {
    const configured = hasNextcloudTalkCredentials(cfg);
    return {
      channel,
      configured,
      statusLines: [`Nextcloud Talk: ${configured ? "configured" : "needs setup"}`],
      selectionHint: configured ? "configured" : "self-hosted chat",
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
      label: "Nextcloud Talk",
      accountOverride: accountOverrides["nextcloud-talk"],
      shouldPromptAccountIds,
      listAccountIds: listNextcloudTalkAccountIds,
      defaultAccountId: resolveDefaultNextcloudTalkAccountId(cfg),
    });

    let next = cfg;
    const resolvedAccount = resolveNextcloudTalkAccount(next, accountId);
    const accountConfigured = Boolean(resolvedAccount.secret && resolvedAccount.baseUrl);
    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv = allowEnv && Boolean(process.env.NEXTCLOUD_TALK_BOT_SECRET?.trim());
    const hasConfigSecret = Boolean(
      resolvedAccount.config.botSecret || resolvedAccount.config.botSecretFile,
    );

    let baseUrl = resolvedAccount.baseUrl;
    if (!baseUrl) {
      baseUrl = String(
        await prompter.text({
          message: "Enter Nextcloud instance URL (e.g., https://cloud.example.com)",
          validate: (value) => {
            const v = String(value ?? "").trim();
            if (!v) {
              return "Required";
            }
            if (!v.startsWith("http://") && !v.startsWith("https://")) {
              return "URL must start with http:// or https://";
            }
            return undefined;
          },
        }),
      ).trim();
    }

    let botSecret: string | null = null;
    if (!accountConfigured) {
      await noteNextcloudTalkSecretHelp(prompter);
    }

    if (canUseEnv && !hasConfigSecret) {
      const keepEnv = await prompter.confirm({
        message: "NEXTCLOUD_TALK_BOT_SECRET detected. Use env var?",
        initialValue: true,
      });
      if (keepEnv) {
        next = patchNextcloudTalkAccountConfig({
          cfg: next,
          accountId,
          patch: { baseUrl },
        });
      } else {
        botSecret = await promptNextcloudTalkSecret(prompter);
      }
    } else if (hasConfigSecret) {
      const keep = await prompter.confirm({
        message: "Nextcloud Talk secret already configured. Keep it?",
        initialValue: true,
      });
      if (!keep) {
        botSecret = await promptNextcloudTalkSecret(prompter);
      }
    } else {
      botSecret = await promptNextcloudTalkSecret(prompter);
    }

    if (botSecret || baseUrl !== resolvedAccount.baseUrl) {
      next = patchNextcloudTalkAccountConfig({
        cfg: next,
        accountId,
        patch: {
          baseUrl,
          ...(botSecret ? { botSecret } : {}),
        },
      });
    }

    if (forceAllowFrom) {
      const updated = await dmPolicy.promptAllowFrom?.({ cfg: next, prompter, accountId });
      if (updated) {
        next = updated;
      }
    }

    return {
      cfg: next,
      accountId,
    };
  },
  dmPolicy,
  disable: (cfg) => {
    const channels = (cfg.channels ?? {}) as Record<string, unknown>;
    const current = (channels["nextcloud-talk"] ?? {}) as Record<string, unknown>;
    return {
      ...cfg,
      channels: {
        ...channels,
        "nextcloud-talk": {
          ...current,
          enabled: false,
        },
      },
    };
  },
};
