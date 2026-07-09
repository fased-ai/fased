import { defineConfig } from "tsdown";

const env = {
  NODE_ENV: "production",
};

const buildProfile = (process.env.FASED_BUILD_PROFILE ?? "").trim().toLowerCase();
const isVpsBuild = buildProfile === "vps" || buildProfile === "vps-lite";
const buildGraph = (process.env.FASED_BUILD_GRAPH ?? "").trim().toLowerCase();

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

const pluginSdkEntries = [
  {
    entry: "src/plugin-sdk/index.ts",
    outDir: "dist/plugin-sdk",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/plugin-sdk/account-id.ts",
    outDir: "dist/plugin-sdk",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/plugin-sdk/channel-plugin-common.ts",
    outDir: "dist/plugin-sdk",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/plugin-sdk/command-status.ts",
    outDir: "dist/plugin-sdk",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/plugin-sdk/provider-web-search-config-contract.ts",
    outDir: "dist/plugin-sdk",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/plugin-sdk/sat-runtime.ts",
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
    ...(isVpsBuild
      ? {}
      : {
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
  treeshake: false,
  unbundle: true,
};

const defaultEntries = isVpsBuild
  ? [...baseEntries]
  : [...baseEntries, ...pluginSdkEntries, ...fullRuntimeEntries];
const isolatedSdkEntries = pluginSdkEntries.map((entry) => ({ ...entry, clean: false }));

export default defineConfig(
  buildGraph === "core"
    ? [preservedCoreConfig]
    : buildGraph === "sdk"
      ? isolatedSdkEntries
      : defaultEntries,
);
