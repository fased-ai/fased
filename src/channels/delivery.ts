export const CHANNEL_DELIVERIES = [
  "official-addon",
  "bundled",
  "source-only",
  "external-prerequisite",
] as const;

export type ChannelDelivery = (typeof CHANNEL_DELIVERIES)[number];

export type ChannelDeliveryEntry = {
  id: string;
  docsPath: string;
  delivery: ChannelDelivery;
};

const CHANNEL_DELIVERY_ENTRIES: ChannelDeliveryEntry[] = [
  ...["telegram", "whatsapp", "discord", "slack", "feishu", "googlechat"].map((id) => ({
    id,
    docsPath: `/channels/${id}`,
    delivery: "official-addon" as const,
  })),
  ...[
    "irc",
    "line",
    "mattermost",
    "msteams",
    "nextcloud-talk",
    "synology-chat",
    "zalo",
    "zalouser",
  ].map((id) => ({ id, docsPath: `/channels/${id}`, delivery: "bundled" as const })),
  ...["matrix", "nostr", "tlon", "twitch"].map((id) => ({
    id,
    docsPath: `/channels/${id}`,
    delivery: "source-only" as const,
  })),
  ...["signal", "imessage", "bluebubbles"].map((id) => ({
    id,
    docsPath: `/channels/${id}`,
    delivery: "external-prerequisite" as const,
  })),
];

const DELIVERY_BY_ID = new Map(CHANNEL_DELIVERY_ENTRIES.map((entry) => [entry.id, entry]));

export function listChannelDeliveryEntries(): ChannelDeliveryEntry[] {
  return CHANNEL_DELIVERY_ENTRIES.map((entry) => ({ ...entry }));
}

export function getChannelDeliveryEntry(id: string): ChannelDeliveryEntry | undefined {
  return DELIVERY_BY_ID.get(id.trim().toLowerCase());
}

export function getChannelDelivery(id: string): ChannelDelivery {
  return getChannelDeliveryEntry(id)?.delivery ?? "source-only";
}

export function formatChannelDelivery(delivery: ChannelDelivery): string {
  switch (delivery) {
    case "official-addon":
      return "Official add-on";
    case "bundled":
      return "Bundled";
    case "source-only":
      return "Source-only";
    case "external-prerequisite":
      return "External prerequisite";
  }
}

export function channelDeliveryAllowsInstall(delivery: ChannelDelivery): boolean {
  return delivery === "official-addon" || delivery === "bundled";
}
