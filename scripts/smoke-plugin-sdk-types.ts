export type PluginSdkDistSmoke = {
  root: typeof import("@fased/fased/plugin-sdk");
  accountId: typeof import("@fased/fased/plugin-sdk/account-id");
  channelCommon: typeof import("@fased/fased/plugin-sdk/channel-plugin-common");
  commandStatus: typeof import("@fased/fased/plugin-sdk/command-status");
  devicePair: typeof import("@fased/fased/plugin-sdk/device-pair");
  discord: typeof import("@fased/fased/plugin-sdk/discord");
  providerWebSearch: typeof import("@fased/fased/plugin-sdk/provider-web-search-config-contract");
  wenRuntime: typeof import("@fased/fased/plugin-sdk/wen-runtime");
  slack: typeof import("@fased/fased/plugin-sdk/slack");
  telegram: typeof import("@fased/fased/plugin-sdk/telegram");
  whatsapp: typeof import("@fased/fased/plugin-sdk/whatsapp");
};
