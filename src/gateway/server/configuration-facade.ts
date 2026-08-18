import {
  readConfigFileSnapshotForWrite,
  setRuntimeConfigSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
  type FasedAgentConfig,
} from "../../config/config.js";

export type GatewayConfigurationUpdateResult =
  | { ok: true; config: FasedAgentConfig }
  | { ok: false; message: string };

export type GatewayConfigurationFacade = {
  refreshRuntime(): Promise<FasedAgentConfig>;
  update(params: {
    prepare?: (config: FasedAgentConfig) => void;
    mutate: (config: FasedAgentConfig) => void;
    invalidMessage?: string;
  }): Promise<GatewayConfigurationUpdateResult>;
};

type GatewayConfigurationFacadeDependencies = {
  readSnapshotForWrite: typeof readConfigFileSnapshotForWrite;
  validateConfig: typeof validateConfigObjectWithPlugins;
  writeConfig: typeof writeConfigFile;
  activateRuntime: typeof setRuntimeConfigSnapshot;
};

export function createGatewayConfigurationFacade(
  overrides: Partial<GatewayConfigurationFacadeDependencies> = {},
): GatewayConfigurationFacade {
  const dependencies: GatewayConfigurationFacadeDependencies = {
    readSnapshotForWrite: readConfigFileSnapshotForWrite,
    validateConfig: validateConfigObjectWithPlugins,
    writeConfig: writeConfigFile,
    activateRuntime: setRuntimeConfigSnapshot,
    ...overrides,
  };

  const refreshRuntime = async (): Promise<FasedAgentConfig> => {
    const latest = await dependencies.readSnapshotForWrite();
    if (!latest.snapshot.valid) {
      throw new Error("wallet config write produced an invalid runtime snapshot");
    }
    dependencies.activateRuntime(latest.snapshot.config, latest.snapshot.resolved);
    return latest.snapshot.config;
  };

  return {
    refreshRuntime,
    update: async ({ prepare, mutate, invalidMessage = "invalid configuration patch" }) => {
      const writeSnapshot = await dependencies.readSnapshotForWrite();
      const nextConfig = structuredClone(writeSnapshot.snapshot.resolved ?? {});
      prepare?.(nextConfig);
      try {
        mutate(nextConfig);
      } catch (err) {
        return { ok: false, message: String(err) };
      }

      const validated = dependencies.validateConfig(nextConfig);
      if (!validated.ok) {
        const detail = validated.issues
          .slice(0, 3)
          .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
          .join("; ");
        return { ok: false, message: detail || invalidMessage };
      }

      await dependencies.writeConfig(validated.config, writeSnapshot.writeOptions);
      return { ok: true, config: await refreshRuntime() };
    },
  };
}
