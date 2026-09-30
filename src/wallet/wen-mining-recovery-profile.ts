import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import { bindWenClaimJourneyResult } from "./wen-claim-journey-contract.js";
import { validateWenMiningClaimProposalRequest } from "./wen-mining-claim-proposal-contract.js";
import { proposeWenMiningClaimWithSigner } from "./wen-mining-claim-proposal.js";
import {
  type WenMiningRecoveryRequest,
  type WenMiningRecoveryResult,
  validateWenMiningRecoveryRequest,
} from "./wen-mining-recovery-contract.js";
import { createWenMiningRecoveryLifecycle } from "./wen-mining-recovery-lifecycle.js";
import { recoverWenMiningWithSigner } from "./wen-mining-recovery.js";
import { validateWenMiningReviewPrepareRequest } from "./wen-mining-review-preparation-contract.js";
import { prepareWenMiningReviewWithSigner } from "./wen-mining-review-preparation.js";
import { createWenProfileApproval } from "./wen-profile-approval.js";

// Local candidate wiring only. The output is an ephemeral review mailbox, not
// signer admission. No profile is discovered or created automatically.
export function createLocalWenRecoveryProfile(
  profilePath: string,
  onError: (error: unknown) => void,
) {
  const lifecycle = createWenMiningRecoveryLifecycle();
  async function read() {
    if (!path.isAbsolute(profilePath) || path.normalize(profilePath) !== profilePath) {
      throw Error("Invalid local WEN profile path");
    }
    const info = await lstat(profilePath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.() ||
      info.size > 65536
    ) {
      throw Error("Unprotected local WEN profile");
    }
    const handle = await open(profilePath, "r");
    let raw: string;
    try {
      const actual = await handle.stat();
      if (actual.ino !== info.ino || actual.dev !== info.dev) {
        throw Error("WEN profile replaced during read");
      }
      const bytes = Buffer.alloc(65537);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 65536) {
        throw Error("WEN profile too large");
      }
      raw = bytes.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    const value = JSON.parse(raw) as Record<string, unknown>;
    const fields = ["version", "mode", "walletId", "socketPath", "request", "ticks", "intervalMs"];
    if (
      Object.keys(value).length !== fields.length ||
      fields.some((key) => !(key in value)) ||
      value.version !== 1 ||
      value.mode !== "local-candidate-only" ||
      typeof value.walletId !== "string" ||
      typeof value.socketPath !== "string" ||
      !path.isAbsolute(value.socketPath) ||
      !Number.isInteger(value.ticks) ||
      !Number.isInteger(value.intervalMs)
    ) {
      throw Error("Invalid local WEN recovery profile");
    }
    return {
      walletId: value.walletId,
      socketPath: value.socketPath,
      request: validateWenMiningRecoveryRequest(value.request),
      ticks: value.ticks as number,
      intervalMs: value.intervalMs as number,
    };
  }
  const approval = createWenProfileApproval(read);
  let approved:
    | {
        profile: string;
        requestId: string;
        proof: { proofId: string };
        expiresAt: string;
        attempted: boolean;
      }
    | undefined;
  let approvalGeneration = 0;
  const cancelApproval = () => {
    approvalGeneration++;
    approval.cancel();
    approved = undefined;
  };
  let output = Promise.resolve();
  return {
    async prepareClaimApproval(input: unknown) {
      const selected = await read();
      const request = validateWenMiningReviewPrepareRequest(input);
      const v = request.intent,
        pins = selected.request.pins;
      if (
        v.operation !== selected.request.operation ||
        v.programId !== pins.ProgramID ||
        v.genesis !== pins.Genesis ||
        v.descriptorSha256 !== pins.DescriptorSHA256 ||
        v.capabilitySha256 !== pins.CapabilitySHA256 ||
        BigInt(v.maxFeeLamports) > BigInt(selected.request.maxFeeLamports) ||
        v.minFinalizedSlot !== selected.request.minFinalizedSlot ||
        v.expiresSlot !== selected.request.expiresSlot
      ) {
        throw Error("Preparation does not match profile");
      }
      const result = await prepareWenMiningReviewWithSigner(
        selected.socketPath,
        selected.walletId,
        request,
      );
      if (JSON.stringify(await read()) !== JSON.stringify(selected)) {
        throw Error("Profile changed during preparation");
      }
      return result;
    },
    beginClaimApproval: (input: unknown) => {
      approved = undefined;
      return approval.begin(input);
    },
    async finishClaimApproval(challengeId: string, credential: unknown) {
      const generation = approvalGeneration;
      const selected = JSON.stringify(await read());
      const result = await approval.finish(challengeId, credential);
      if (JSON.stringify(await read()) !== selected || generation !== approvalGeneration) {
        throw Error("Profile changed during approval");
      }
      approved = {
        profile: selected,
        requestId: result.binding.requestId,
        proof: structuredClone(result.authorization.proof),
        expiresAt: result.expiresAt,
        attempted: false,
      };
      return result;
    },
    cancelClaimApproval: cancelApproval,
    async runClaimJourney(requestId: string, action: "execute" | "recover") {
      if (!/^[a-zA-Z0-9_:.-]{8,128}$/.test(requestId)) {
        throw Error("Invalid claim request");
      }
      const selected = await read();
      const retained = approved;
      if (action === "execute") {
        if (
          !retained ||
          retained.attempted ||
          retained.requestId !== requestId ||
          retained.profile !== JSON.stringify(selected) ||
          Date.parse(retained.expiresAt) <= Date.now()
        ) {
          throw Error("No matching current claim approval");
        }
        retained.attempted = true;
      }
      try {
        const result = await callLocalSocketSigner<unknown>(selected.socketPath, {
          op: "v2.wenMining.claim.journey",
          walletId: selected.walletId,
          request:
            action === "execute"
              ? { requestId, action, proof: retained!.proof }
              : { requestId, action },
        });
        return bindWenClaimJourneyResult(result, requestId, selected.walletId);
      } finally {
        if (action === "execute" && approved === retained) {
          approved = undefined;
        }
      }
    },
    // Explicit consumer refresh. Never promote mailbox history into a review:
    // the signer re-reads settlement/custody and binds the unsigned result.
    async refreshReviewPage(cursor = "") {
      const selected = await read();
      const request = validateWenMiningRecoveryRequest({ ...selected.request, cursor });
      const result = await recoverWenMiningWithSigner(
        selected.socketPath,
        selected.walletId,
        request,
      );
      if (JSON.stringify(await read()) !== JSON.stringify(selected)) {
        throw Error("WEN profile changed during review refresh; result discarded");
      }
      return result;
    },
    // Caller supplies an admission identity only. Wallet, RPC, slot bounds and
    // current fee ceiling remain owned by the protected profile.
    async refreshAdmittedClaim(input: unknown) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).length !== 2 ||
        !("base" in input) ||
        !("reviewSha256" in input)
      ) {
        throw Error("Expected claim base and admission hash");
      }
      const selected = await read();
      const request = validateWenMiningClaimProposalRequest({
        ...input,
        minFinalizedSlot: selected.request.minFinalizedSlot,
        expiresSlot: selected.request.expiresSlot,
      });
      const base = request.base,
        pins = selected.request.pins;
      if (
        base.operation !== selected.request.operation ||
        base.programId !== pins.ProgramID ||
        base.genesis !== pins.Genesis ||
        base.descriptorSha256 !== pins.DescriptorSHA256 ||
        base.capabilitySha256 !== pins.CapabilitySHA256 ||
        BigInt(base.maxFeeLamports) > BigInt(selected.request.maxFeeLamports)
      ) {
        throw Error("Claim does not match the current profile");
      }
      const result = await proposeWenMiningClaimWithSigner(
        selected.socketPath,
        selected.walletId,
        request,
      );
      if (JSON.stringify(await read()) !== JSON.stringify(selected)) {
        throw Error("WEN profile changed during claim refresh; result discarded");
      }
      return result;
    },
    async start() {
      cancelApproval();
      await lifecycle.stop();
      await output;
      const selected = await read();
      let requestedProfile = JSON.stringify(selected);
      let observedCursor = "";
      const history: { request: WenMiningRecoveryRequest; result: WenMiningRecoveryResult }[] = [];
      await lifecycle.start({
        ...selected,
        request: async (signal) => {
          signal.throwIfAborted();
          const current = await read();
          signal.throwIfAborted();
          if (
            current.walletId !== selected.walletId ||
            current.socketPath !== selected.socketPath ||
            JSON.stringify(current.request.pins) !== JSON.stringify(selected.request.pins) ||
            current.request.operation !== selected.request.operation ||
            current.request.descriptor !== selected.request.descriptor
          ) {
            throw Error("WEN profile identity changed; restart required");
          }
          requestedProfile = JSON.stringify(current);
          return current.request;
        },
        onError,
        onResult: (result) => {
          const resultProfile = requestedProfile;
          const snapshot = structuredClone(result);
          const bounds = {
            ...(JSON.parse(resultProfile) as typeof selected).request,
            cursor: observedCursor,
          };
          observedCursor = snapshot.nextCursor;
          async function requireCurrentProfile() {
            if (JSON.stringify(await read()) !== resultProfile) {
              throw Error("WEN profile changed during recovery; review discarded");
            }
          }
          output = output
            .then(async () => {
              await requireCurrentProfile();
              const parent = await lstat(path.dirname(profilePath));
              if (
                !parent.isDirectory() ||
                parent.isSymbolicLink() ||
                (parent.mode & 0o022) !== 0 ||
                parent.uid !== process.getuid?.()
              ) {
                throw Error("Unprotected WEN review directory");
              }
              const nextHistory = [...history, { request: bounds, result: snapshot }];
              const encoded = JSON.stringify({
                version: 1,
                mode: "local-candidate-only",
                walletId: selected.walletId,
                signingEnabled: false,
                result: snapshot,
                history: nextHistory,
                historyMeaning: "observations-only-revalidate-before-review",
              });
              if (nextHistory.length > 100 || Buffer.byteLength(encoded) > 8 * 1024 * 1024) {
                throw Error("WEN review history capacity reached; previous mailbox preserved");
              }
              const target = profilePath + ".review.json",
                temp = target + "." + process.pid + ".tmp";
              const handle = await open(temp, "wx", 0o600);
              try {
                await handle.writeFile(encoded);
                await handle.sync();
              } finally {
                await handle.close();
              }
              try {
                await requireCurrentProfile();
                await rename(temp, target);
                history.push({ request: bounds, result: snapshot });
              } finally {
                await unlink(temp).catch(() => {});
              }
            })
            .catch(onError);
        },
      });
    },
    async stop() {
      cancelApproval();
      await lifecycle.stop();
      await output;
    },
  };
}
