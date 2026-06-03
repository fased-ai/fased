import os from "node:os";
import path from "node:path";
import type { PluginRuntime } from "fased/plugin-sdk";

export const msteamsRuntimeStub = {
  state: {
    resolveStateDir: (env: NodeJS.ProcessEnv = process.env, homedir?: () => string) => {
      const override = env.FASED_STATE_DIR?.trim() || env.FASED_STATE_DIR?.trim();
      if (override) {
        return override;
      }
      const resolvedHome = homedir ? homedir() : os.homedir();
      return path.join(resolvedHome, ".fased");
    },
  },
} as unknown as PluginRuntime;
