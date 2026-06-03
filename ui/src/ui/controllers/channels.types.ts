import type { GatewayBrowserClient } from "../gateway.ts";
import type { ChannelsStatusSnapshot } from "../types.ts";

export type ChannelQrLoginState = {
  message: string | null;
  qrDataUrl: string | null;
  connected: boolean | null;
};

export type ChannelsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  channelsLoading: boolean;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  channelsError: string | null;
  channelsNotice: string | null;
  channelsLastSuccess: number | null;
  channelRuntimeBusy: Record<string, boolean>;
  channelQrLogin: Record<string, ChannelQrLoginState>;
  whatsappLoginMessage: string | null;
  whatsappLoginQrDataUrl: string | null;
  whatsappLoginConnected: boolean | null;
  whatsappBusy: boolean;
};
