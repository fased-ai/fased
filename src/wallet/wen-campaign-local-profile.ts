import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createWenCampaignGatewayProfile } from "./wen-campaign-gateway-profile.js";
import { campaignSelectionSchema } from "./wen-campaign-selection-contract.js";
const schema = campaignSelectionSchema
  .extend({
    version: z.literal(1),
    mode: z.literal("local-candidate-only"),
    socketPath: z.string().min(1).max(256),
  })
  .strict();
// Host-owned expectations are not signer admission. The signer independently
// verifies its protected admission and the deployed program before execution.
export async function createLocalWenCampaignProfile(profilePath: string) {
  if (!path.isAbsolute(profilePath) || path.normalize(profilePath) !== profilePath) {
    throw Error("Invalid campaign profile path");
  }
  let stopped = false;
  async function read() {
    if (stopped) {
      throw Error("Campaign profile stopped");
    }
    const handle = await open(
      profilePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let raw: string;
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.uid !== process.getuid?.() ||
        (before.mode & 0o077) !== 0 ||
        before.size > 16384
      ) {
        throw Error("Unprotected campaign profile");
      }
      const bytes = Buffer.alloc(16385);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const after = await handle.stat();
      if (
        bytesRead > 16384 ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      ) {
        throw Error("Campaign profile changed during read");
      }
      raw = bytes.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    const v = schema.parse(JSON.parse(raw));
    if (
      !path.isAbsolute(v.socketPath) ||
      path.normalize(v.socketPath) !== v.socketPath ||
      stopped
    ) {
      throw Error("Invalid campaign socket or stopped profile");
    }
    return {
      socket: {
        walletId: v.expected.walletId,
        socketPath: v.socketPath,
        revision: createHash("sha256").update(raw).digest("hex"),
      },
      expected: v.expected,
      draftSha256: v.draftSha256,
      artifactDigest: v.artifactDigest,
    };
  }
  await read();
  const profile = createWenCampaignGatewayProfile(read);
  return {
    ...profile,
    stop() {
      stopped = true;
      profile.cancelClaimApproval();
    },
  };
}
