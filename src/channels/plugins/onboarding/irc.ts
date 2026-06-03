import type { FasedAgentConfig } from "../../../config/config.js";
import type { IrcAccountConfig } from "../../../config/types.irc.js";
import { DEFAULT_ACCOUNT_ID } from "../../../routing/session-key.js";
import { formatDocsLink } from "../../../terminal/links.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter } from "../onboarding-types.js";
import {
  patchChannelConfigForAccount,
  resolveAccountIdForConfigure,
  setOnboardingChannelEnabled,
  splitOnboardingEntries,
} from "./helpers.js";

const channel = "irc" as const;

function listIrcAccountIds(cfg: FasedAgentConfig): string[] {
  const ids = new Set<string>([DEFAULT_ACCOUNT_ID]);
  for (const accountId of Object.keys(cfg.channels?.irc?.accounts ?? {})) {
    if (accountId.trim()) {
      ids.add(accountId.trim());
    }
  }
  return [...ids];
}

function resolveIrcAccount(cfg: FasedAgentConfig, accountId: string): IrcAccountConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return cfg.channels?.irc ?? {};
  }
  return cfg.channels?.irc?.accounts?.[accountId] ?? {};
}

function isIrcConfigured(account: IrcAccountConfig): boolean {
  return Boolean(account.host?.trim() && account.nick?.trim());
}

async function noteIrcHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Enter the IRC server host and the bot nick to use on that network.",
      "Channels are comma-separated, for example #fased, #ops.",
      "Use port 6697 for TLS networks unless your IRC network documents another port.",
      `Docs: ${formatDocsLink("/channels/irc", "irc")}`,
    ].join("\n"),
    "IRC setup",
  );
}

export const ircOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  uiSetup: {
    title: "IRC",
    detail: "Server and nick.",
    notes: [
      "Enter the IRC server host and the bot nick to use on that network.",
      "Channels are comma-separated, for example #fased, #ops.",
      "Use port 6697 for TLS networks unless your IRC network documents another port.",
    ],
    fields: [
      {
        label: "Server host",
        path: ["channels", "irc", "host"],
        placeholder: "irc.libera.chat",
      },
      {
        label: "Nick",
        path: ["channels", "irc", "nick"],
        placeholder: "fased-bot",
      },
      {
        label: "Channels",
        path: ["channels", "irc", "channels"],
        placeholder: "#fased, #ops",
        kind: "list",
      },
      {
        label: "Port",
        path: ["channels", "irc", "port"],
        placeholder: "6697",
        kind: "number",
      },
    ],
    access: {
      kind: "irc-channels",
      label: "IRC channels",
      note: "Allowlist IRC channels, open all channels, or block channel messages.",
      placeholder: "#fased, #ops",
    },
  },
  getStatus: async ({ cfg }) => {
    const configured = listIrcAccountIds(cfg).some((accountId) =>
      isIrcConfigured(resolveIrcAccount(cfg, accountId)),
    );
    return {
      channel,
      configured,
      statusLines: [`IRC: ${configured ? "configured" : "needs server and nick"}`],
      selectionHint: configured ? "configured" : "needs server and nick",
      quickstartScore: configured ? 2 : 1,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const accountId = await resolveAccountIdForConfigure({
      cfg,
      prompter,
      label: "IRC",
      accountOverride: accountOverrides.irc,
      shouldPromptAccountIds,
      listAccountIds: listIrcAccountIds,
      defaultAccountId: DEFAULT_ACCOUNT_ID,
    });
    const existing = resolveIrcAccount(cfg, accountId);
    if (!isIrcConfigured(existing)) {
      await noteIrcHelp(prompter);
    }

    const host = String(
      await prompter.text({
        message: "IRC server host",
        placeholder: "irc.libera.chat",
        initialValue: existing.host,
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
    ).trim();
    const nick = String(
      await prompter.text({
        message: "IRC bot nick",
        placeholder: "fased-bot",
        initialValue: existing.nick,
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
    ).trim();
    const channelsRaw = String(
      await prompter.text({
        message: "IRC channels (comma-separated)",
        placeholder: "#fased, #ops",
        initialValue: existing.channels?.join(", "),
      }),
    ).trim();
    const portRaw = String(
      await prompter.text({
        message: "IRC port",
        placeholder: "6697",
        initialValue: existing.port ? String(existing.port) : undefined,
      }),
    ).trim();
    const port = portRaw ? Number(portRaw) : undefined;

    return {
      cfg: patchChannelConfigForAccount({
        cfg,
        channel,
        accountId,
        patch: {
          host,
          nick,
          ...(channelsRaw ? { channels: splitOnboardingEntries(channelsRaw) } : {}),
          ...(Number.isFinite(port) ? { port } : {}),
        },
      }),
      accountId,
    };
  },
  disable: (cfg) => setOnboardingChannelEnabled(cfg, channel, false),
};
