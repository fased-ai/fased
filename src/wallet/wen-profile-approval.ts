import type { WenMiningRecoveryRequest } from "./wen-mining-recovery-contract.js";
import { beginWenMiningApproval } from "./wen-mining-review-authorization.js";
import { isWenMiningStoredReview } from "./wen-mining-review-preparation-contract.js";
type Profile = { walletId: string; socketPath: string; request: WenMiningRecoveryRequest };
type PendingApproval = {
  controller: AbortController;
  profile?: string;
  session?: Awaited<ReturnType<typeof beginWenMiningApproval>>;
  finishing?: boolean;
};
export function createWenProfileApproval(read: () => Promise<Profile>) {
  let active: PendingApproval | undefined;
  const cancel = () => {
    active?.controller.abort();
    active = undefined;
  };
  return {
    cancel,
    async begin(input: unknown) {
      if (active) {
        throw Error("Claim approval already pending");
      }
      const current: PendingApproval = { controller: new AbortController() };
      active = current;
      try {
        const selected = await read();
        current.controller.signal.throwIfAborted();
        if (!isWenMiningStoredReview(input)) {
          throw Error("Invalid stored review");
        }
        const review = structuredClone(input),
          v = review.semanticIntent.intent,
          pins = selected.request.pins;
        if (
          review.walletId !== selected.walletId ||
          v.operation !== selected.request.operation ||
          v.programId !== pins.ProgramID ||
          v.genesis !== pins.Genesis ||
          v.descriptorSha256 !== pins.DescriptorSHA256 ||
          v.capabilitySha256 !== pins.CapabilitySHA256 ||
          BigInt(v.maxFeeLamports) > BigInt(selected.request.maxFeeLamports) ||
          v.minFinalizedSlot !== selected.request.minFinalizedSlot ||
          v.expiresSlot !== selected.request.expiresSlot
        ) {
          throw Error("Approval review does not match profile");
        }
        current.profile = JSON.stringify(selected);
        current.session = await beginWenMiningApproval(
          selected.socketPath,
          selected.walletId,
          review,
          current.controller.signal,
        );
        if (JSON.stringify(await read()) !== current.profile) {
          throw Error("Profile changed during approval");
        }
        current.controller.signal.throwIfAborted();
        return structuredClone(current.session.challenge);
      } catch (error) {
        if (active === current) {
          cancel();
        }
        throw error;
      }
    },
    async finish(challengeId: string, credential: unknown) {
      const current = active;
      if (
        !current?.session ||
        current.finishing ||
        current.session.challenge.challengeId !== challengeId
      ) {
        throw Error("No matching pending claim approval");
      }
      current.finishing = true;
      try {
        if (JSON.stringify(await read()) !== current.profile) {
          throw Error("Profile changed before approval");
        }
        current.controller.signal.throwIfAborted();
        const result = await current.session.finish(credential);
        if (JSON.stringify(await read()) !== current.profile) {
          throw Error("Profile changed during approval");
        }
        current.controller.signal.throwIfAborted();
        return result;
      } finally {
        if (active === current) {
          cancel();
        }
      }
    },
  };
}
