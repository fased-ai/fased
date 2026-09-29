import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Command } from "commander";
import { inspectWenBtcReview } from "../../wallet/wen-btc-admission.js";

// Public source-review entrypoint; no config, signer, gateway or wallet imports.
export function registerWalletWenReview(wallet: Command, log: (text: string) => void) {
  wallet
    .command("wen-btc-review")
    .description("Verify a WEN BTC source-review artifact; does not enable signing")
    .requiredOption("--artifact <path>", "Canonical review JSON file")
    .requiredOption("--artifact-digest <sha256>", "Independently reviewed artifact hash")
    .requiredOption("--capability-digest <sha256>", "Reviewed BTC capability hash")
    .requiredOption("--source-digest <sha256>", "Reviewed source hash")
    .requiredOption("--contract-digest <sha256>", "Reviewed contract hash")
    .requiredOption("--account-order-digest <sha256>", "Reviewed account-order hash")
    .action(async (opts: Record<string, string>) => {
      const file = await open(
        opts.artifact,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size <= 0 || stat.size > 16384) {
          throw new Error("WEN BTC review must be a regular JSON file of at most 16384 bytes");
        }
        // Bounded even if the file grows after stat. Hash validation detects edits.
        const bytes = Buffer.alloc(16385);
        let length = 0;
        while (length < bytes.length) {
          const read = await file.read(bytes, length, bytes.length - length, length);
          if (read.bytesRead === 0) {
            break;
          }
          length += read.bytesRead;
        }
        const result = inspectWenBtcReview(bytes.subarray(0, length), {
          artifactDigest: opts.artifactDigest,
          capabilityDigest: opts.capabilityDigest,
          sourceDigest: opts.sourceDigest,
          contractDigest: opts.contractDigest,
          accountOrderDigest: opts.accountOrderDigest,
        });
        log(JSON.stringify(result, null, 2));
      } finally {
        await file.close();
      }
    });
}
