import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerWalletWenReview } from "./register.wallet-wen.js";

const artifact = {
  schema: "fased.wen-btc-subscription-acknowledgement-candidate.v1",
  state: "SOURCE_REVIEW_ONLY",
  publicEntryEnabled: false,
  signingEnabled: false,
  legacyCapabilityReuse: false,
  deployment: "NOT_BOUND",
  runtime: "NOT_BOUND",
  ownerPermission: "NOT_BOUND",
  operations: ["acceptance", "acquisition"],
  portableClient: "client/btc-subscription-client.mjs",
  capabilityDigest: "11".repeat(32),
  sourceDigest: "22".repeat(32),
  contractDigest: "33".repeat(32),
  accountOrderDigest: "44".repeat(32),
};
describe("wallet wen-btc-review command", () => {
  it.each(["ok", "hash", "symlink", "oversize", "missing-pin"])(
    "checks %s through Commander and the filesystem",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "wen-cli-"));
      try {
        const path = join(root, "review.json");
        const bytes = Buffer.from(JSON.stringify(artifact));
        await writeFile(path, mode === "oversize" ? Buffer.alloc(16385) : bytes);
        const link = join(root, "link.json");
        if (mode === "symlink") {
          await symlink(path, link);
        }
        const output: string[] = [];
        const wallet = new Command("wallet").exitOverride().configureOutput({ writeErr() {} });
        registerWalletWenReview(wallet, (text) => output.push(text));
        const args = [
          "wen-btc-review",
          "--artifact",
          mode === "symlink" ? link : path,
          "--artifact-digest",
          mode === "hash" ? "00".repeat(32) : createHash("sha256").update(bytes).digest("hex"),
          "--capability-digest",
          artifact.capabilityDigest,
          "--source-digest",
          artifact.sourceDigest,
          "--contract-digest",
          artifact.contractDigest,
          "--account-order-digest",
          artifact.accountOrderDigest,
        ];
        if (mode === "missing-pin") {
          args.splice(-2);
        }
        const run = () => wallet.parseAsync(args, { from: "user" });
        if (mode === "ok") {
          await run();
          const result = JSON.parse(output[0]);
          expect(result.status).toBe("SOURCE_REVIEW_ONLY");
          expect(result.signingEnabled).toBe(false);
          expect(result.missing).toEqual(["deployment", "installedRuntime", "ownerPermission"]);
        } else {
          await expect(run()).rejects.toThrow();
          expect(output).toEqual([]);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
