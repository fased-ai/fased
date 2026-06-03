import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  DmPolicy,
  FasedAgentConfig,
  WizardPrompter,
} from "fased/plugin-sdk";
import { addWildcardAllowFrom, formatDocsLink, mergeAllowFromEntries } from "fased/plugin-sdk";
import { DEFAULT_RELAYS, normalizePubkey } from "./nostr-bus.js";
import { resolveNostrAccount } from "./types.js";

const channel = "nostr" as const;

type NostrChannelConfig = {
  enabled?: boolean;
  privateKey?: string;
  relays?: string[];
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
};

function resolveNostrConfig(cfg: FasedAgentConfig): NostrChannelConfig {
  return ((cfg.channels as Record<string, unknown> | undefined)?.nostr ?? {}) as NostrChannelConfig;
}

function patchNostrConfig(cfg: FasedAgentConfig, patch: Record<string, unknown>): FasedAgentConfig {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const current = (channels.nostr ?? {}) as Record<string, unknown>;
  return {
    ...cfg,
    channels: {
      ...channels,
      nostr: {
        ...current,
        enabled: true,
        ...patch,
      },
    },
  };
}

function splitEntries(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeAllowEntry(raw: string): string {
  const stripped = raw.replace(/^nostr:/i, "").trim();
  if (stripped === "*") {
    return stripped;
  }
  try {
    return normalizePubkey(stripped);
  } catch {
    return stripped;
  }
}

function setNostrDmPolicy(cfg: FasedAgentConfig, policy: DmPolicy): FasedAgentConfig {
  const current = resolveNostrConfig(cfg);
  const allowFrom = policy === "open" ? addWildcardAllowFrom(current.allowFrom) : undefined;
  return patchNostrConfig(cfg, {
    dmPolicy: policy,
    ...(allowFrom ? { allowFrom } : {}),
  });
}

async function noteNostrHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Use an existing Nostr private key or generate one with `nak key generate`.",
      "Private key formats: nsec... or 64-character hex.",
      "Use 2-3 WebSocket relays for redundancy.",
      `Docs: ${formatDocsLink("/channels/nostr", "nostr")}`,
    ].join("\n"),
    "Nostr setup",
  );
}

async function promptNostrAllowFrom(params: {
  cfg: FasedAgentConfig;
  prompter: WizardPrompter;
}): Promise<FasedAgentConfig> {
  const current = resolveNostrConfig(params.cfg);
  await params.prompter.note(
    [
      "Allowlist Nostr DMs by npub or 64-character hex pubkey.",
      "Multiple entries: comma-separated.",
      `Docs: ${formatDocsLink("/channels/nostr", "nostr")}`,
    ].join("\n"),
    "Nostr allowlist",
  );
  const raw = await params.prompter.text({
    message: "Nostr allowFrom (npub or hex pubkeys)",
    placeholder: "npub1..., 0123abcd...",
    initialValue: current.allowFrom?.map((entry) => String(entry)).join(", "),
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });
  const entries = splitEntries(String(raw)).map(normalizeAllowEntry);
  return patchNostrConfig(params.cfg, {
    dmPolicy: "allowlist",
    allowFrom: mergeAllowFromEntries(current.allowFrom, entries),
  });
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Nostr",
  channel,
  policyKey: "channels.nostr.dmPolicy",
  allowFromKey: "channels.nostr.allowFrom",
  getCurrent: (cfg) => resolveNostrConfig(cfg).dmPolicy ?? "pairing",
  setPolicy: setNostrDmPolicy,
  promptAllowFrom: promptNostrAllowFrom,
};

export const nostrOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  uiSetup: {
    title: "Nostr",
    detail: "Nostr private key and relays.",
    notes: [
      "Use an existing Nostr private key or generate one with nak key generate.",
      "Private key formats: nsec... or 64-character hex.",
      "Use 2-3 WebSocket relays for redundancy.",
    ],
    fields: [
      {
        label: "Private key",
        path: ["channels", "nostr", "privateKey"],
        placeholder: "nsec1... or 64-character hex",
        kind: "password",
      },
      {
        label: "Relays",
        path: ["channels", "nostr", "relays"],
        placeholder: DEFAULT_RELAYS.join(", "),
        kind: "list",
      },
    ],
  },
  getStatus: async ({ cfg }) => {
    const account = resolveNostrAccount({ cfg });
    return {
      channel,
      configured: account.configured,
      statusLines: [`Nostr: ${account.configured ? "configured" : "needs private key"}`],
      selectionHint: account.configured ? "configured" : "needs private key",
      quickstartScore: account.configured ? 2 : 1,
    };
  },
  configure: async ({ cfg, prompter }) => {
    const account = resolveNostrAccount({ cfg });
    if (!account.configured) {
      await noteNostrHelp(prompter);
    }
    const privateKey = String(
      await prompter.text({
        message: "Nostr private key",
        placeholder: "nsec1... or 64-character hex",
        initialValue: account.config.privateKey,
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
    ).trim();
    const relaysRaw = String(
      await prompter.text({
        message: "Nostr relays (comma-separated)",
        placeholder: DEFAULT_RELAYS.join(", "),
        initialValue: account.config.relays?.join(", ") ?? DEFAULT_RELAYS.join(", "),
      }),
    ).trim();
    const relays = splitEntries(relaysRaw);
    return {
      cfg: patchNostrConfig(cfg, {
        privateKey,
        ...(relays.length > 0 ? { relays } : {}),
      }),
      accountId: "default",
    };
  },
  dmPolicy,
  disable: (cfg) => {
    const channels = (cfg.channels ?? {}) as Record<string, unknown>;
    const current = (channels.nostr ?? {}) as Record<string, unknown>;
    return {
      ...cfg,
      channels: {
        ...channels,
        nostr: {
          ...current,
          enabled: false,
        },
      },
    };
  },
};
