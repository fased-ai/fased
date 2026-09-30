import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type {
  FasedAgentPluginApi,
  FasedAgentPluginService,
  FasedAgentPluginServiceContext,
} from "fased/plugin-sdk";
import {
  buildWenAcquisitionHandoff,
  readWenEconomyLocal,
  SAT_MINING_GATEWAY_METHODS,
  type WenEconomyReadPin,
} from "fased/plugin-sdk/sat-runtime";
import { createSatMiningPluginConfigSchema } from "./src/config.js";
import { registerWenApprovalGateway, type WenApprovalProfile } from "./src/wen-approval-gateway.js";

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
  return await hasMiningRecoveryState(context.stateDir);
}

const satMiningPlugin = {
  id: "sat-mining",
  name: "SAT Mining",
  description: "Lazy SAT mining facade for explicitly configured or historical recovery runtimes.",
  configSchema: createSatMiningPluginConfigSchema(),
  register(api: FasedAgentPluginApi) {
    let wenRecovery:
      | {
          start(): Promise<void>;
          stop(): Promise<void>;
          refreshReviewPage(cursor?: string): Promise<unknown>;
          refreshAdmittedClaim(input: unknown): Promise<unknown>;
          prepareClaimApproval(input: unknown): Promise<unknown>;
          beginClaimApproval(input: unknown): Promise<unknown>;
          finishClaimApproval(challengeId: string, credential: unknown): Promise<unknown>;
          cancelClaimApproval(): void;
          runClaimJourney(requestId: string, action: "execute" | "recover"): Promise<unknown>;
        }
      | undefined;
    let wenCampaign: (WenApprovalProfile & { stop(): void }) | undefined;
    let wenEconomyRead: { url: string; pin: WenEconomyReadPin } | undefined;
    let refreshingWenReview = false;
    let wenReviewReady = false;
    let serviceContext: FasedAgentPluginServiceContext | null = null;
    let operationalService: FasedAgentPluginService | null = null;
    let registrationPromise: Promise<void> | null = null;
    let activationPromise: Promise<void> | null = null;
    const gatewayHandlers = new Map<string, GatewayHandler>();
    const readCurrentWenEconomy = async () => {
      const profile = wenEconomyRead;
      if (!wenReviewReady || !profile) throw Error("WEN economy read is not configured");
      const snapshot = await readWenEconomyLocal(profile);
      if (!wenReviewReady || wenEconomyRead !== profile) throw Error("WEN economy read changed");
      return snapshot;
    };

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
        if (!serviceContext || !(await shouldActivateMining(api, serviceContext))) {
          context.respond(false, undefined, {
            code: "UNAVAILABLE",
            message:
              "Legacy SAT mining requires an existing recovery state or explicit configuration",
          });
          return;
        }
        await activate();
        const handler = gatewayHandlers.get(method);
        if (!handler) {
          throw new Error(`SAT Mining implementation did not register ${method}`);
        }
        await handler(context);
      });
    }

    for (const method of ["wen.mining.review.refresh", "wen.mining.claim.refresh"] as const) {
      api.registerGatewayMethod(
        method,
        async ({ params, respond }) => {
          if (
            method === "wen.mining.review.refresh"
              ? Object.keys(params).some((key) => key !== "cursor") ||
                (params.cursor !== undefined && typeof params.cursor !== "string")
              : Object.keys(params).length !== 2 ||
                !("base" in params) ||
                typeof params.reviewSha256 !== "string"
          ) {
            respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "Invalid WEN refresh parameters",
            });
            return;
          }
          const selected = wenRecovery;
          if (!selected || !wenReviewReady || refreshingWenReview) {
            respond(false, undefined, {
              code: "UNAVAILABLE",
              message: "Local WEN review refresh unavailable",
            });
            return;
          }
          refreshingWenReview = true;
          try {
            const result =
              method === "wen.mining.claim.refresh"
                ? await selected.refreshAdmittedClaim(params)
                : await selected.refreshReviewPage(params.cursor as string | undefined);
            if (wenRecovery !== selected || !wenReviewReady) {
              throw Error("WEN lifecycle changed");
            }
            respond(true, {
              ok: true,
              mode: "local-candidate-only",
              signingEnabled: false,
              payload: result,
            });
          } catch {
            respond(false, undefined, {
              code: "UNAVAILABLE",
              message: "WEN review refresh rejected; retry with the current profile",
            });
          } finally {
            refreshingWenReview = false;
          }
        },
        { scope: "operator.admin" },
      );
    }

    api.registerTool({
      name: "wen_economy_facts",
      label: "WEN Economy Facts",
      description:
        "Read the pinned local WEN economy factsheet. Report unavailable values as unavailable. This is not a trade quote, complete NAV, or permission to sign.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        let details: unknown;
        if (!wenReviewReady || !wenEconomyRead) {
          details = { status: "unavailable", reason: "No pinned local WEN economy read" };
        } else {
          try {
            details = {
              status: "verified-local-read-only",
              ...(await readCurrentWenEconomy()),
            };
          } catch {
            details = {
              status: "unavailable",
              reason: "Pinned WEN economy read could not be verified",
            };
          }
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details) }],
          details,
        };
      },
    });

    api.registerGatewayMethod(
      "wen.economy.read",
      async ({ params, respond }) => {
        if (Object.keys(params).length !== 0) {
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: "WEN economy read takes no parameters",
          });
          return;
        }
        if (!wenReviewReady || !wenEconomyRead) {
          respond(false, undefined, {
            code: "UNAVAILABLE",
            message: "WEN economy read is not configured",
          });
          return;
        }
        try {
          respond(true, await readCurrentWenEconomy());
        } catch {
          respond(false, undefined, {
            code: "UNAVAILABLE",
            message: "WEN economy read could not be verified",
          });
        }
      },
      { scope: "operator.read" },
    );

    const acquisitionHandoff = async (input: unknown) => {
      const profile = wenEconomyRead;
      if (!profile) throw Error("WEN read not configured");
      const snapshot = await readCurrentWenEconomy();
      if (wenEconomyRead !== profile) throw Error("WEN profile changed");
      return buildWenAcquisitionHandoff(input, snapshot, new URL("/", profile.url).href);
    };
    api.registerTool({
      name: "wen_acquisition_request",
      label: "WEN Acquisition Request",
      description:
        "Prepare a manual Buy or Bonds request for the owner's local WEN terminal. Quantity is in smallest asset units. This cannot quote, sign, submit or reserve funds. The owner reviews fresh terms in WEN.",
      parameters: Type.Object(
        {
          owner: Type.String(),
          action: Type.Union([Type.Literal("buy"), Type.Literal("bond")]),
          netAtoms: Type.String(),
          nonce: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      async execute(_id, input) {
        const details = await acquisitionHandoff(input);
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
      },
    });
    api.registerGatewayMethod(
      "wen.acquisition.handoff",
      async ({ params, respond }) => {
        try {
          respond(true, await acquisitionHandoff(params));
        } catch {
          respond(false, undefined, {
            code: "UNAVAILABLE",
            message: "Fresh local WEN acquisition handoff unavailable",
          });
        }
      },
      { scope: "operator.read" },
    );

    const cancelWenApproval = registerWenApprovalGateway(api, () =>
      wenReviewReady ? wenRecovery : undefined,
    );
    const cancelCampaignApproval = registerWenApprovalGateway(
      api,
      () => (wenReviewReady ? wenCampaign : undefined),
      "wen.campaign.approval",
    );
    api.registerService({
      id: "sat-mining",
      async start(context) {
        cancelWenApproval();
        cancelCampaignApproval();
        wenCampaign?.stop();
        wenCampaign = undefined;
        wenEconomyRead = undefined;
        wenReviewReady = false;
        serviceContext = context;
        const previous = wenRecovery;
        wenRecovery = undefined;
        await previous?.stop();
        const economyReadPath = process.env.FASED_WEN_LOCAL_READ_PROFILE;
        if (economyReadPath) {
          const bytes = await fs.readFile(economyReadPath);
          if (bytes.byteLength > 4096) throw Error("WEN economy read profile too large");
          const profile = JSON.parse(bytes.toString("utf8")) as { url?: unknown; pin?: unknown };
          if (typeof profile.url !== "string" || !profile.pin || typeof profile.pin !== "object")
            throw Error("Invalid WEN economy read profile");
          wenEconomyRead = { url: profile.url, pin: profile.pin as WenEconomyReadPin };
        }
        const profilePath = process.env.FASED_WEN_LOCAL_RECOVERY_PROFILE;
        if (profilePath) {
          const { createLocalWenRecoveryProfile } = await import("fased/plugin-sdk/sat-runtime");
          wenRecovery = await createLocalWenRecoveryProfile(profilePath, (error) =>
            api.logger.warn(`[sat-mining] local WEN recovery: ${String(error)}`),
          );
          await wenRecovery.start();
        }
        const campaignPath = process.env.FASED_WEN_LOCAL_CAMPAIGN_PROFILE;
        if (campaignPath) {
          try {
            const { createLocalWenCampaignProfile } = await import("fased/plugin-sdk/sat-runtime");
            wenCampaign = await createLocalWenCampaignProfile(campaignPath);
          } catch (error) {
            await wenRecovery?.stop();
            throw error;
          }
        }
        if (await shouldActivateMining(api, context)) {
          try {
            await activate();
            wenReviewReady = true;
          } catch (error) {
            wenCampaign?.stop();
            wenCampaign = undefined;
            await wenRecovery?.stop();
            throw error;
          }
          return;
        }
        wenReviewReady = true;
        api.logger.info("[sat-mining] operational implementation remains lazy");
      },
      async stop(context) {
        cancelWenApproval();
        cancelCampaignApproval();
        wenCampaign?.stop();
        wenCampaign = undefined;
        wenEconomyRead = undefined;
        wenReviewReady = false;
        const previous = wenRecovery;
        wenRecovery = undefined;
        await previous?.stop();
        if (activationPromise) {
          await activationPromise;
          await operationalService?.stop?.(context);
          activationPromise = null;
        }
        serviceContext = null;
      },
      async checkpointForLifecycle(context) {
        cancelWenApproval();
        cancelCampaignApproval();
        wenCampaign?.stop();
        wenCampaign = undefined;
        wenEconomyRead = undefined;
        wenReviewReady = false;
        const previous = wenRecovery;
        wenRecovery = undefined;
        await previous?.stop();
        if (activationPromise) {
          await activationPromise;
          await operationalService?.checkpointForLifecycle?.(context);
        }
      },
    });
  },
};

export default satMiningPlugin;
