import fs from "node:fs/promises";
import path from "node:path";
import type {
  FasedAgentPluginApi,
  FasedAgentPluginService,
  FasedAgentPluginServiceContext,
} from "fased/plugin-sdk";
import { SAT_MINING_GATEWAY_METHODS } from "fased/plugin-sdk/sat-runtime";
import { createSatMiningPluginConfigSchema } from "./src/config.js";

type GatewayHandler = Parameters<FasedAgentPluginApi["registerGatewayMethod"]>[1];

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function hasMiningRecoveryState(stateDir: string): Promise<boolean> {
  const walletsRoot = path.join(stateDir, "sat-mining", "wallets");
  let entries;
  try {
    entries = await fs.readdir(walletsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      (await pathExists(path.join(walletsRoot, entry.name, "mining.sqlite")))
    ) {
      return true;
    }
  }
  return false;
}

export async function shouldActivateMining(
  api: FasedAgentPluginApi,
  context: FasedAgentPluginServiceContext,
): Promise<boolean> {
  if (api.pluginConfig && Object.keys(api.pluginConfig).length > 0) {
    return true;
  }
  if (await pathExists(path.join(context.stateDir, "wallet", "provider-registry.v1.json"))) {
    return true;
  }
  return await hasMiningRecoveryState(context.stateDir);
}

const satMiningPlugin = {
  id: "sat-mining",
  name: "SAT Mining",
  description: "Lazy SAT mining facade for configured, Wallet-attached, or recovery runtimes.",
  configSchema: createSatMiningPluginConfigSchema(),
  register(api: FasedAgentPluginApi) {
    let serviceContext: FasedAgentPluginServiceContext | null = null;
    let operationalService: FasedAgentPluginService | null = null;
    let registrationPromise: Promise<void> | null = null;
    let activationPromise: Promise<void> | null = null;
    const gatewayHandlers = new Map<string, GatewayHandler>();

    const registerImplementation = async (): Promise<void> => {
      registrationPromise ??= (async () => {
        const implementation = await import("./implementation.js");
        await implementation.default.register({
          ...api,
          registerGatewayMethod(method, handler) {
            if (gatewayHandlers.has(method)) {
              throw new Error(`duplicate lazy SAT Mining Gateway method: ${method}`);
            }
            gatewayHandlers.set(method, handler);
          },
          registerService(service) {
            if (service.id !== "sat-mining" || operationalService) {
              throw new Error(`unexpected lazy SAT Mining service registration: ${service.id}`);
            }
            operationalService = service;
          },
        });
        if (!operationalService) {
          throw new Error("SAT Mining implementation did not register its operational service");
        }
      })();
      await registrationPromise;
    };

    const activate = async (): Promise<void> => {
      if (!serviceContext) {
        throw new Error("SAT Mining service context is not ready");
      }
      activationPromise ??= (async () => {
        await registerImplementation();
        await operationalService?.start(serviceContext);
      })();
      try {
        await activationPromise;
      } catch (error) {
        activationPromise = null;
        throw error;
      }
    };

    for (const method of SAT_MINING_GATEWAY_METHODS) {
      api.registerGatewayMethod(method, async (context) => {
        await activate();
        const handler = gatewayHandlers.get(method);
        if (!handler) {
          throw new Error(`SAT Mining implementation did not register ${method}`);
        }
        await handler(context);
      });
    }

    api.registerService({
      id: "sat-mining",
      async start(context) {
        serviceContext = context;
        if (await shouldActivateMining(api, context)) {
          await activate();
          return;
        }
        api.logger.info("[sat-mining] operational implementation remains lazy");
      },
      async stop(context) {
        if (activationPromise) {
          await activationPromise;
          await operationalService?.stop?.(context);
          activationPromise = null;
        }
        serviceContext = null;
      },
      async checkpointForLifecycle(context) {
        if (activationPromise) {
          await activationPromise;
          await operationalService?.checkpointForLifecycle?.(context);
        }
      },
    });
  },
};

export default satMiningPlugin;
