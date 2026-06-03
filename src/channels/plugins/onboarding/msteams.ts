import type { FasedAgentConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import type { MSTeamsTeamConfig } from "../../../config/types.msteams.js";
import { formatDocsLink } from "../../../terminal/links.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import { promptChannelAccessConfig, type ChannelAccessPolicy } from "./channel-access.js";
import { addWildcardAllowFrom } from "./helpers.js";

const channel = "msteams" as const;

function resolveMSTeamsConfigured(cfg: FasedAgentConfig): boolean {
  const msteams = cfg.channels?.msteams;
  return Boolean(
    (msteams?.appId?.trim() && msteams?.appPassword?.trim() && msteams?.tenantId?.trim()) ||
    (process.env.MSTEAMS_APP_ID?.trim() &&
      process.env.MSTEAMS_APP_PASSWORD?.trim() &&
      process.env.MSTEAMS_TENANT_ID?.trim()),
  );
}

function setMSTeamsDmPolicy(cfg: FasedAgentConfig, dmPolicy: DmPolicy): FasedAgentConfig {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.msteams?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: {
        ...cfg.channels?.msteams,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

async function noteMSTeamsCredentialHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Azure Bot registration -> get App ID and Tenant ID",
      "2) Add a client secret (App Password)",
      "3) Set webhook URL and messaging endpoint",
      "Tip: you can also set MSTEAMS_APP_ID / MSTEAMS_APP_PASSWORD / MSTEAMS_TENANT_ID.",
      `Docs: ${formatDocsLink("/channels/msteams", "msteams")}`,
    ].join("\n"),
    "MS Teams credentials",
  );
}

function setMSTeamsGroupPolicy(
  cfg: FasedAgentConfig,
  groupPolicy: ChannelAccessPolicy,
): FasedAgentConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: {
        ...cfg.channels?.msteams,
        enabled: true,
        groupPolicy,
      },
    },
  };
}

function parseMSTeamsTeamEntry(raw: string): { teamKey: string; channelKey?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const [teamRaw, ...channelParts] = trimmed.split("/");
  const teamKey = teamRaw.trim();
  if (!teamKey) {
    return null;
  }
  const channelKey = channelParts.join("/").trim();
  return channelKey ? { teamKey, channelKey } : { teamKey };
}

function formatMSTeamsTeamEntries(cfg: FasedAgentConfig): string[] {
  return Object.entries(cfg.channels?.msteams?.teams ?? {}).flatMap(([teamKey, value]) => {
    const channels = value?.channels ?? {};
    const channelKeys = Object.keys(channels);
    if (channelKeys.length === 0) {
      return [teamKey];
    }
    return channelKeys.map((channelKey) => `${teamKey}/${channelKey}`);
  });
}

function setMSTeamsTeamsAllowlist(
  cfg: FasedAgentConfig,
  entries: Array<{ teamKey: string; channelKey?: string }>,
): FasedAgentConfig {
  const teams: Record<string, MSTeamsTeamConfig> = {};
  for (const entry of entries) {
    if (!entry.teamKey) {
      continue;
    }
    if (!entry.channelKey) {
      teams[entry.teamKey] = teams[entry.teamKey] ?? {};
      continue;
    }
    const existing = teams[entry.teamKey] ?? {};
    teams[entry.teamKey] = {
      ...existing,
      channels: {
        ...existing.channels,
        [entry.channelKey]: {},
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: {
        ...cfg.channels?.msteams,
        enabled: true,
        teams,
      },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "MS Teams",
  channel,
  policyKey: "channels.msteams.dmPolicy",
  allowFromKey: "channels.msteams.allowFrom",
  getCurrent: (cfg) => cfg.channels?.msteams?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setMSTeamsDmPolicy(cfg, policy),
};

export const msteamsOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  uiSetup: {
    title: "Microsoft Teams",
    detail: "Bot Framework app credentials.",
    notes: [
      "1) Azure Bot registration -> get App ID and Tenant ID",
      "2) Add a client secret (App Password)",
      "3) Set webhook URL and messaging endpoint",
      "Tip: you can also set MSTEAMS_APP_ID / MSTEAMS_APP_PASSWORD / MSTEAMS_TENANT_ID.",
    ],
    fields: [
      {
        label: "App ID",
        path: ["channels", "msteams", "appId"],
        placeholder: "Azure Bot App ID",
      },
      {
        label: "App Password",
        path: ["channels", "msteams", "appPassword"],
        placeholder: "Client secret",
        kind: "password",
      },
      {
        label: "Tenant ID",
        path: ["channels", "msteams", "tenantId"],
        placeholder: "Azure AD tenant ID",
      },
    ],
    access: {
      kind: "msteams-channels",
      label: "MS Teams channels",
      note: "Allowlist Teams channels, open all channels, or block channel messages.",
      placeholder: "Team Name/Channel Name, teamId/conversationId",
    },
  },
  dmPolicy,
  getStatus: async ({ cfg }) => {
    const configured = resolveMSTeamsConfigured(cfg);
    return {
      channel,
      configured,
      statusLines: [`MS Teams: ${configured ? "configured" : "needs app credentials"}`],
      selectionHint: configured ? "configured" : "needs app creds",
      quickstartScore: configured ? 2 : 0,
    };
  },
  configure: async ({ cfg, prompter }) => {
    let next = cfg;
    if (!resolveMSTeamsConfigured(next)) {
      await noteMSTeamsCredentialHelp(prompter);
      const appId = String(
        await prompter.text({
          message: "Enter MS Teams App ID",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
      const appPassword = String(
        await prompter.text({
          message: "Enter MS Teams App Password",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
      const tenantId = String(
        await prompter.text({
          message: "Enter MS Teams Tenant ID",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
      next = {
        ...next,
        channels: {
          ...next.channels,
          msteams: {
            ...next.channels?.msteams,
            enabled: true,
            appId,
            appPassword,
            tenantId,
          },
        },
      };
    }
    const accessConfig = await promptChannelAccessConfig({
      prompter,
      label: "MS Teams channels",
      currentPolicy: next.channels?.msteams?.groupPolicy ?? "allowlist",
      currentEntries: formatMSTeamsTeamEntries(next),
      placeholder: "Team Name/Channel Name, teamId/conversationId",
      updatePrompt: Boolean(next.channels?.msteams?.teams),
    });
    if (accessConfig) {
      next = setMSTeamsGroupPolicy(next, accessConfig.policy);
      if (accessConfig.policy === "allowlist") {
        next = setMSTeamsTeamsAllowlist(
          next,
          accessConfig.entries
            .map((entry) => parseMSTeamsTeamEntry(entry))
            .filter((entry): entry is { teamKey: string; channelKey?: string } => Boolean(entry)),
        );
      }
    }
    return { cfg: next };
  },
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: { ...cfg.channels?.msteams, enabled: false },
    },
  }),
};
