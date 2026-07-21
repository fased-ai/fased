import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
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
  },
  tsconfig: "tsconfig.plugin-sdk.dts.json",
  outDir: "dist/plugin-sdk",
  clean: false,
  platform: "node",
  format: "esm",
  fixedExtension: false,
  skipNodeModulesBundle: true,
  report: false,
  dts: {
    emitDtsOnly: true,
    resolver: "tsc",
    incremental: true,
  },
});
