import { describe, expect, it } from "vitest";
import { verifyNextReleaseSequence } from "./verify-next-release-sequence.mjs";

const current = {
  schemaVersion: 1,
  type: "fased-release-index",
  channel: "beta",
  releaseSequence: 25,
  securityEpoch: 1,
};

describe("next release sequence", () => {
  it("derives the exact next identity from the public channel", () => {
    expect(
      verifyNextReleaseSequence(current, {
        channel: "beta",
        releaseSequence: 26,
        securityEpoch: 1,
      }),
    ).toEqual({ channel: "beta", releaseSequence: 26, securityEpoch: 1 });
  });

  it("rejects the rc.122 sequence regression before allocation", () => {
    expect(() =>
      verifyNextReleaseSequence(current, {
        channel: "beta",
        releaseSequence: 3,
        securityEpoch: 1,
      }),
    ).toThrow("release sequence 26");
  });
});
