import { defineConfig } from "tsdown";

const env = {
  NODE_ENV: "production",
};

const buildProfile = (process.env.FASED_BUILD_PROFILE ?? "").trim().toLowerCase();
const isVpsBuild = buildProfile === "vps" || buildProfile === "vps-lite";
const buildGraph = (process.env.FASED_BUILD_GRAPH ?? "").trim().toLowerCase();
const channelRuntimeExternals = [
  /^@buape\/carbon(?:\/.*)?$/,
  /^@discordjs\/(?:opus|voice)(?:\/.*)?$/,
  /^@grammyjs\/(?:runner|transformer-throttler)(?:\/.*)?$/,
  /^@line\/bot-sdk(?:\/.*)?$/,
  /^@slack\/(?:bolt|web-api)(?:\/.*)?$/,
  /^@snazzah\/davey(?:\/.*)?$/,
  /^@whiskeysockets\/baileys(?:\/.*)?$/,
  /^discord-api-types(?:\/.*)?$/,
  /^grammy(?:\/.*)?$/,
  /^opusscript(?:\/.*)?$/,
];

const baseEntries = [
  {
    entry: "src/index.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/entry.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/cli/daemon-cli.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/infra/warning-filter.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
] as const;

const pluginSdkEntryMap = {
  index: "src/plugin-sdk/index.ts",
  "account-id": "src/plugin-sdk/account-id.ts",
  "channel-plugin-common": "src/plugin-sdk/channel-plugin-common.ts",
  "command-status": "src/plugin-sdk/command-status.ts",
  "device-pair": "src/plugin-sdk/device-pair.ts",
  discord: "src/plugin-sdk/discord.ts",
  "provider-web-search-config-contract": "src/plugin-sdk/provider-web-search-config-contract.ts",
  "sat-runtime": "src/plugin-sdk/sat-runtime.ts",
  slack: "src/plugin-sdk/slack.ts",
  telegram: "src/plugin-sdk/telegram.ts",
  whatsapp: "src/plugin-sdk/whatsapp.ts",
} as const;

const pluginSdkEntries = [
  {
    entry: pluginSdkEntryMap,
    outDir: "dist/plugin-sdk",
    env,
    fixedExtension: false,
    platform: "node",
  },
] as const;

const fullRuntimeEntries = [
  {
    entry: "src/extensionAPI.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: ["src/hooks/bundled/*/handler.ts", "src/hooks/llm-slug-generator.ts"],
    env,
    fixedExtension: false,
    platform: "node",
  },
] as const;

const preservedCoreConfig = {
  entry: {
    index: "src/index.ts",
    entry: "src/entry.ts",
    "daemon-cli": "src/cli/daemon-cli.ts",
    "warning-filter": "src/infra/warning-filter.ts",
    "text/strip-markdown": "src/text/strip-markdown.ts",
    ...(isVpsBuild
      ? {}
      : {
          ...Object.fromEntries(
            Object.entries(pluginSdkEntryMap).map(([name, entry]) => [`plugin-sdk/${name}`, entry]),
          ),
          extensionAPI: "src/extensionAPI.ts",
          "llm-slug-generator": "src/hooks/llm-slug-generator.ts",
          "bundled/boot-md/handler": "src/hooks/bundled/boot-md/handler.ts",
          "bundled/bootstrap-extra-files/handler":
            "src/hooks/bundled/bootstrap-extra-files/handler.ts",
          "bundled/command-logger/handler": "src/hooks/bundled/command-logger/handler.ts",
          "bundled/session-memory/handler": "src/hooks/bundled/session-memory/handler.ts",
        }),
  },
  env,
  fixedExtension: false,
  platform: "node" as const,
  external: channelRuntimeExternals,
  treeshake: false,
  unbundle: true,
};

const lightweightCliConfigs = [
  ["light-plugin-info", "src/cli/lightweight/plugin-info.ts"],
  ["light-plugin-doctor", "src/cli/lightweight/plugin-doctor.ts"],
].map(([name, entry]) => ({
  entry: { [name]: entry },
  clean: false,
  env,
  fixedExtension: false,
  minify: true,
  platform: "node" as const,
  external: channelRuntimeExternals,
  outputOptions: { codeSplitting: false },
  treeshake: true,
}));

const defaultEntries = (
  isVpsBuild ? [...baseEntries] : [...baseEntries, ...pluginSdkEntries, ...fullRuntimeEntries]
).map((entry) => ({ ...entry, external: channelRuntimeExternals }));

export default defineConfig(
  buildGraph === "core"
    ? [preservedCoreConfig]
    : buildGraph === "light-cli"
      ? lightweightCliConfigs
      : defaultEntries,
);
