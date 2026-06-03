import type { FasedAgentConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import { addWildcardAllowFrom, mergeAllowFromEntries } from "./helpers.js";

const channel = "nostr" as const;

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://relay.primal.net"];

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

function setNostrDmPolicy(cfg: FasedAgentConfig, policy: DmPolicy): FasedAgentConfig {
  const current = resolveNostrConfig(cfg);
  const allowFrom = policy === "open" ? addWildcardAllowFrom(current.allowFrom) : undefined;
  return patchNostrConfig(cfg, {
    dmPolicy: policy,
    ...(allowFrom ? { allowFrom } : {}),
  });
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Nostr",
  channel,
  policyKey: "channels.nostr.dmPolicy",
  allowFromKey: "channels.nostr.allowFrom",
  getCurrent: (cfg) => resolveNostrConfig(cfg).dmPolicy ?? "pairing",
  setPolicy: setNostrDmPolicy,
  promptAllowFrom: async ({ cfg, prompter }) => {
    const current = resolveNostrConfig(cfg);
    const raw = await prompter.text({
      message: "Nostr allowFrom (npub or hex pubkeys)",
      placeholder: "npub1..., 0123abcd...",
      initialValue: current.allowFrom?.map((entry) => String(entry)).join(", "),
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    return patchNostrConfig(cfg, {
      dmPolicy: "allowlist",
      allowFrom: mergeAllowFromEntries(current.allowFrom, splitEntries(String(raw))),
    });
  },
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
    const configured = Boolean(resolveNostrConfig(cfg).privateKey?.trim());
    return {
      channel,
      configured,
      statusLines: [`Nostr: ${configured ? "configured" : "needs private key"}`],
      selectionHint: configured ? "configured" : "needs private key",
      quickstartScore: configured ? 2 : 1,
    };
  },
  configure: async ({ cfg, prompter }) => {
    const current = resolveNostrConfig(cfg);
    const privateKey = String(
      await prompter.text({
        message: "Nostr private key",
        placeholder: "nsec1... or 64-character hex",
        initialValue: current.privateKey,
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
    ).trim();
    const relaysRaw = String(
      await prompter.text({
        message: "Nostr relays (comma-separated)",
        placeholder: DEFAULT_RELAYS.join(", "),
        initialValue: current.relays?.join(", ") ?? DEFAULT_RELAYS.join(", "),
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
