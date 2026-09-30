import type { FasedAgentPluginApi } from "fased/plugin-sdk";

export type WenApprovalProfile = {
  confirmOwnerApproval?(input: unknown): Promise<unknown>;
  readCampaignSelection?(): Promise<unknown>;
  prepareClaimApproval(input: unknown): Promise<unknown>;
  beginClaimApproval(input: unknown): Promise<unknown>;
  finishClaimApproval(challengeId: string, credential: unknown): Promise<unknown>;
  cancelClaimApproval(): void;
  runClaimJourney(requestId: string, action: "execute" | "recover"): Promise<unknown>;
};
export const WEN_APPROVAL_METHODS = [
  "wen.mining.approval.prepare",
  "wen.mining.approval.begin",
  "wen.mining.approval.finish",
  "wen.mining.approval.cancel",
  "wen.mining.approval.execute",
  "wen.mining.approval.recover",
] as const;

// Approval and execution are connection-owned; recovery only reconciles existing journals.
export function registerWenApprovalGateway(
  api: Pick<FasedAgentPluginApi, "registerGatewayMethod">,
  read: () => WenApprovalProfile | undefined,
  namespace:
    | "wen.mining.approval"
    | "wen.campaign.approval"
    | "wen.market.approval"
    | "wen.bond-claim.approval"
    | "wen.bond.approval" = "wen.mining.approval",
) {
  let pending:
    | {
        connection: string;
        profile: WenApprovalProfile;
        approved?: boolean;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let busy = false;
  let generation = 0;
  const cancel = () => {
    generation++;
    if (pending) {
      clearTimeout(pending.timer);
      pending.profile.cancelClaimApproval();
      pending = undefined;
    }
  };
  for (const legacyMethod of [
    ...WEN_APPROVAL_METHODS,
    ...(namespace === "wen.market.approval" ? ["wen.market.approval.owner-confirm"] : []),
    ...(namespace !== "wen.mining.approval" ? ["wen.campaign.approval.selection"] : []),
  ]) {
    const method = namespace + "." + legacyMethod.split(".").at(-1);
    api.registerGatewayMethod(
      method,
      async ({ params, client, respond }) => {
        const connection = client?.connId;
        const profile = read();
        const suffix = method.split(".").at(-1);
        const keys = Object.keys(params);
        const valid =
          suffix === "cancel" || suffix === "selection"
            ? keys.length === 0
            : suffix === "execute" || suffix === "recover"
              ? keys.length === 1 && typeof params.requestId === "string"
              : suffix === "finish"
                ? keys.length === 2 &&
                  typeof params.challengeId === "string" &&
                  "credential" in params
                : keys.length === 1 && "input" in params;
        if (!valid) {
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: "Invalid WEN approval parameters",
          });
          return;
        }
        if (
          !connection ||
          !profile ||
          (pending && (pending.connection !== connection || pending.profile !== profile))
        ) {
          respond(false, undefined, {
            code: "UNAVAILABLE",
            message: "WEN approval owner unavailable",
          });
          return;
        }
        if (suffix === "cancel") {
          cancel();
          respond(true, { ok: true, signingEnabled: false });
          return;
        }
        if (
          busy ||
          (pending && !["finish", "execute", "recover"].includes(suffix!)) ||
          (suffix === "finish" && (!pending || pending.approved)) ||
          (suffix === "execute" && !pending?.approved)
        ) {
          respond(false, undefined, {
            code: "UNAVAILABLE",
            message: "WEN approval session unavailable",
          });
          return;
        }
        busy = true;
        const version = generation;
        if (suffix === "begin" || suffix === "owner-confirm") {
          const timer = setTimeout(cancel, 120000);
          timer.unref();
          pending = { connection, profile, timer };
        }
        try {
          const payload =
            suffix === "owner-confirm"
              ? await (profile.confirmOwnerApproval
                  ? profile.confirmOwnerApproval(params.input)
                  : Promise.reject(Error("Owner confirmation unavailable")))
              : suffix === "selection"
                ? await (profile.readCampaignSelection
                    ? profile.readCampaignSelection()
                    : Promise.reject(Error("Campaign selection unavailable")))
                : suffix === "execute" || suffix === "recover"
                  ? await profile.runClaimJourney(params.requestId as string, suffix)
                  : suffix === "prepare"
                    ? await profile.prepareClaimApproval(params.input)
                    : suffix === "begin"
                      ? await profile.beginClaimApproval(params.input)
                      : await profile.finishClaimApproval(
                          params.challengeId as string,
                          params.credential,
                        );
          if (version !== generation || read() !== profile) {
            throw Error("WEN approval lifecycle changed");
          }
          if ((suffix === "finish" || suffix === "owner-confirm") && pending) {
            pending.approved = true;
          }
          respond(true, {
            ok: true,
            mode: "local-candidate-only",
            signingEnabled: suffix === "execute",
            payload,
          });
        } catch {
          if (version === generation) {
            cancel();
          }
          respond(false, undefined, {
            code: "UNAVAILABLE",
            message:
              "WEN request rejected or response uncertain; reconcile the claim journal before another attempt",
          });
        } finally {
          if ((suffix === "execute" || suffix === "recover") && version === generation) {
            cancel();
          }
          busy = false;
        }
      },
      { scope: "operator.admin" },
    );
  }
  return cancel;
}
