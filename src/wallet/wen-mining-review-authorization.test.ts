import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { validateLocalSocketSignerResult } from "./local-socket-signer-protocol.js";
import {
  bindWenMiningAuthorizationBegin,
  bindWenMiningAuthorizationFinish,
} from "./wen-mining-review-authorization-contract.js";
it.skipIf(!process.env.WEN_AUTH_VECTOR_DIR).each(["sol", "sat"])(
  "binds actual Go %s approval challenge and proof",
  async (op) => {
    const v = JSON.parse(
      await readFile(path.join(process.env.WEN_AUTH_VECTOR_DIR!, op + ".json"), "utf8"),
    );
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(v.review.issuedAt) + 1);
    try {
      expect(bindWenMiningAuthorizationBegin(v.begin, v.review)).toEqual(v.begin);
      expect(bindWenMiningAuthorizationFinish(v.finish, v.review)).toEqual(v.finish);
      expect(validateLocalSocketSignerResult("v2.review.authorization.begin", v.begin)).toBe(true);
      expect(validateLocalSocketSignerResult("v2.review.authorization.finish", v.finish)).toBe(
        true,
      );
      for (const field of [
        "walletId",
        "walletPublicKey",
        "nonce",
        "policyHash",
        "artifactDigest",
        "transactionDigest",
        "amount",
        "requestId",
        "role",
      ]) {
        for (const [value, bind] of [
          [v.begin, bindWenMiningAuthorizationBegin],
          [v.finish, bindWenMiningAuthorizationFinish],
        ] as const) {
          const changed = structuredClone(value);
          changed.binding[field] = "changed";
          expect(() => bind(changed, v.review)).toThrow();
        }
      }
      const changed = structuredClone(v.finish);
      changed.authorization.type = "control-ui";
      expect(() => bindWenMiningAuthorizationFinish(changed, v.review)).toThrow();
      clock.mockReturnValue(Date.parse(v.review.expiresAt) + 1);
      expect(() => bindWenMiningAuthorizationBegin(v.begin, v.review)).toThrow();
      expect(() => bindWenMiningAuthorizationFinish(v.finish, v.review)).toThrow();
    } finally {
      clock.mockRestore();
    }
  },
);
