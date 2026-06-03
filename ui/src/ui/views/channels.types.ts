import type {
  ChannelAccountSnapshot,
  AgentsListResult,
  ChannelsStatusSnapshot,
  ConfigUiHints,
  DiscordStatus,
  GoogleChatStatus,
  IMessageStatus,
  NostrProfile,
  NostrStatus,
  SignalStatus,
  SlackStatus,
  TelegramStatus,
  WhatsAppStatus,
} from "../types.ts";
import type { NostrProfileFormState } from "./channels.nostr-profile-form.ts";

export type ChannelKey = string;
export type ChannelsView = "accounts" | "messages" | "commands" | "sessions" | "web";
export type ChannelQrLoginState = {
  message: string | null;
  qrDataUrl: string | null;
  connected: boolean | null;
};

export type ChannelsProps = {
  connected: boolean;
  loading: boolean;
  snapshot: ChannelsStatusSnapshot | null;
  agentsList: AgentsListResult | null;
  lastError: string | null;
  notice: string | null;
  lastSuccessAt: number | null;
  channelRuntimeBusy: Record<string, boolean>;
  channelQrLogin: Record<string, ChannelQrLoginState>;
  whatsappMessage: string | null;
  whatsappQrDataUrl: string | null;
  whatsappConnected: boolean | null;
  whatsappBusy: boolean;
  configSchema: unknown;
  configSchemaLoading: boolean;
  configForm: Record<string, unknown> | null;
  configUiHints: ConfigUiHints;
  configSaving: boolean;
  configFormDirty: boolean;
  activeView?: ChannelsView;
  nostrProfileFormState: NostrProfileFormState | null;
  nostrProfileAccountId: string | null;
  onViewChange?: (view: ChannelsView) => void;
  onRefresh: (probe: boolean) => void;
  onChannelEnable: (channelId: string) => void;
  onChannelStart: (channelId: string, accountId?: string) => void;
  onChannelStop: (channelId: string, accountId?: string) => void;
  onChannelInstall: (channelId: string) => void;
  onChannelLogout: (channelId: string, accountId?: string) => void;
  onChannelQrStart: (channelId: string, force?: boolean, accountId?: string) => void;
  onChannelQrWait: (channelId: string, accountId?: string) => void;
  onWhatsAppStart: (force: boolean) => void;
  onWhatsAppWait: () => void;
  onWhatsAppLogout: () => void;
  onConfigPatch: (path: Array<string | number>, value: unknown) => void;
  onConfigRemove: (path: Array<string | number>) => void;
  onConfigSave: () => void;
  onConfigReload: () => void;
  onNostrProfileEdit: (accountId: string, profile: NostrProfile | null) => void;
  onNostrProfileCancel: () => void;
  onNostrProfileFieldChange: (field: keyof NostrProfile, value: string) => void;
  onNostrProfileSave: () => void;
  onNostrProfileImport: () => void;
  onNostrProfileToggleAdvanced: () => void;
};

export type ChannelsChannelData = {
  whatsapp?: WhatsAppStatus;
  telegram?: TelegramStatus;
  discord?: DiscordStatus | null;
  googlechat?: GoogleChatStatus | null;
  slack?: SlackStatus | null;
  signal?: SignalStatus | null;
  imessage?: IMessageStatus | null;
  nostr?: NostrStatus | null;
  channelAccounts?: Record<string, ChannelAccountSnapshot[]> | null;
};
