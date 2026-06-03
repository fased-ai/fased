import type { FasedAgentConfig } from "../../../config/config.js";
import type { GoogleChatAccountConfig } from "../../../config/types.googlechat.js";
import { DEFAULT_ACCOUNT_ID } from "../../../routing/session-key.js";
import { formatDocsLink } from "../../../terminal/links.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter } from "../onboarding-types.js";
import {
  patchChannelConfigForAccount,
  resolveAccountIdForConfigure,
  setOnboardingChannelEnabled,
} from "./helpers.js";

const channel = "googlechat" as const;

function listGoogleChatAccountIds(cfg: FasedAgentConfig): string[] {
  const ids = new Set<string>([cfg.channels?.googlechat?.defaultAccount ?? DEFAULT_ACCOUNT_ID]);
  for (const accountId of Object.keys(cfg.channels?.googlechat?.accounts ?? {})) {
    if (accountId.trim()) {
      ids.add(accountId.trim());
    }
  }
  return [...ids];
}

function resolveGoogleChatAccount(
  cfg: FasedAgentConfig,
  accountId: string,
): GoogleChatAccountConfig {
  if (accountId === DEFAULT_ACCOUNT_ID || accountId === cfg.channels?.googlechat?.defaultAccount) {
    return cfg.channels?.googlechat ?? {};
  }
  return cfg.channels?.googlechat?.accounts?.[accountId] ?? {};
}

function hasServiceAccount(account: GoogleChatAccountConfig): boolean {
  if (account.serviceAccountFile?.trim()) {
    return true;
  }
  if (account.serviceAccountRef) {
    return true;
  }
  if (typeof account.serviceAccount === "string") {
    return account.serviceAccount.trim().length > 0;
  }
  return Boolean(account.serviceAccount && typeof account.serviceAccount === "object");
}

function hasWebhook(account: GoogleChatAccountConfig): boolean {
  return Boolean(account.webhookPath?.trim() || account.webhookUrl?.trim());
}

function hasAudience(account: GoogleChatAccountConfig): boolean {
  return Boolean(
    (account.audienceType === "app-url" || account.audienceType === "project-number") &&
    account.audience?.trim(),
  );
}

function isGoogleChatConfigured(account: GoogleChatAccountConfig): boolean {
  return hasServiceAccount(account) && hasWebhook(account) && hasAudience(account);
}

async function noteGoogleChatHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Create a Google Chat app in Google Cloud, enable the Chat API, and create a service account JSON key.",
      "Use the gateway webhook URL or webhook path for inbound Chat events.",
      "Set the audience to the app URL or Google Cloud project number used by the Chat app.",
      `Docs: ${formatDocsLink("/channels/googlechat", "googlechat")}`,
    ].join("\n"),
    "Google Chat setup",
  );
}

export const googleChatOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  uiSetup: {
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
  },
  getStatus: async ({ cfg }) => {
    const configured = listGoogleChatAccountIds(cfg).some((accountId) =>
      isGoogleChatConfigured(resolveGoogleChatAccount(cfg, accountId)),
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
      quickstartScore: configured ? 2 : 1,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const accountId = await resolveAccountIdForConfigure({
      cfg,
      prompter,
      label: "Google Chat",
      accountOverride: accountOverrides.googlechat,
      shouldPromptAccountIds,
      listAccountIds: listGoogleChatAccountIds,
      defaultAccountId: cfg.channels?.googlechat?.defaultAccount ?? DEFAULT_ACCOUNT_ID,
    });
    const existing = resolveGoogleChatAccount(cfg, accountId);
    if (!isGoogleChatConfigured(existing)) {
      await noteGoogleChatHelp(prompter);
    }

    const serviceAccountFile = String(
      await prompter.text({
        message: "Google Chat service account file",
        placeholder: "/run/secrets/google-chat-service-account.json",
        initialValue: existing.serviceAccountFile,
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
    ).trim();
    const webhookPath = String(
      await prompter.text({
        message: "Google Chat webhook path",
        placeholder: "/googlechat",
        initialValue: existing.webhookPath ?? "/googlechat",
      }),
    ).trim();
    const webhookUrl = String(
      await prompter.text({
        message: "Google Chat webhook URL",
        placeholder: "https://agent.example.com/googlechat",
        initialValue: existing.webhookUrl,
      }),
    ).trim();
    const audienceType = await prompter.select({
      message: "Google Chat audience type",
      options: [
        { value: "app-url", label: "App URL" },
        { value: "project-number", label: "Project number" },
      ],
      initialValue: existing.audienceType ?? "app-url",
    });
    const audience = String(
      await prompter.text({
        message: "Google Chat audience",
        placeholder: "https://agent.example.com/googlechat or 123456789012",
        initialValue: existing.audience,
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
    ).trim();
    const botUser = String(
      await prompter.text({
        message: "Google Chat bot user",
        placeholder: "users/123456789012345678901",
        initialValue: existing.botUser,
      }),
    ).trim();

    return {
      cfg: patchChannelConfigForAccount({
        cfg,
        channel,
        accountId,
        patch: {
          serviceAccountFile,
          ...(webhookPath ? { webhookPath } : {}),
          ...(webhookUrl ? { webhookUrl } : {}),
          audienceType,
          audience,
          ...(botUser ? { botUser } : {}),
        },
      }),
      accountId,
    };
  },
  disable: (cfg) => setOnboardingChannelEnabled(cfg, channel, false),
};
