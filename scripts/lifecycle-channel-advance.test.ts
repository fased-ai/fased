import { describe, expect, it } from "vitest";
import { planLifecycleChannelAdvance } from "./lifecycle-channel-advance.mjs";

const commit = "a".repeat(40);

function index(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      type: "fased-release-index",
      channel: "beta",
      version: "0.1.2-rc.2",
      releaseSequence: 2,
      securityEpoch: 1,
      commit,
      ...overrides,
    })}\n`,
  );
}

describe("lifecycle channel advance", () => {
  it("initializes an empty channel and accepts an identical retry", () => {
    const candidateBytes = index();
    expect(
      planLifecycleChannelAdvance({
        candidateBytes,
        currentBytes: null,
        expectedCommit: commit,
        expectedVersion: "0.1.2-rc.2",
      }).action,
    ).toBe("INITIALIZE");
    expect(
      planLifecycleChannelAdvance({
        candidateBytes,
        currentBytes: candidateBytes,
        expectedCommit: commit,
        expectedVersion: "0.1.2-rc.2",
      }).action,
    ).toBe("ALREADY_CURRENT");
  });

  it("allows only a strictly monotonic same-channel advance", () => {
    const result = planLifecycleChannelAdvance({
      candidateBytes: index(),
      currentBytes: index({ version: "0.1.1-rc.1", releaseSequence: 1 }),
      expectedCommit: commit,
      expectedVersion: "0.1.2-rc.2",
    });
    expect(result.action).toBe("ADVANCE");

    expect(() =>
      planLifecycleChannelAdvance({
        candidateBytes: index({ releaseSequence: 1 }),
        currentBytes: index({ version: "0.1.1-rc.1", releaseSequence: 1 }),
        expectedCommit: commit,
        expectedVersion: "0.1.2-rc.2",
      }),
    ).toThrow("does not advance");
    expect(() =>
      planLifecycleChannelAdvance({
        candidateBytes: index({ securityEpoch: 1 }),
        currentBytes: index({
          version: "0.1.1-rc.1",
          releaseSequence: 1,
          securityEpoch: 2,
        }),
        expectedCommit: commit,
        expectedVersion: "0.1.2-rc.2",
      }),
    ).toThrow("roll back");
  });

  it("rejects rebound identities and channel/version disagreement", () => {
    expect(() =>
      planLifecycleChannelAdvance({
        candidateBytes: index({ commit: "b".repeat(40) }),
        currentBytes: null,
        expectedCommit: commit,
        expectedVersion: "0.1.2-rc.2",
      }),
    ).toThrow("exact release identity");
    expect(() =>
      planLifecycleChannelAdvance({
        candidateBytes: index({ channel: "stable" }),
        currentBytes: null,
        expectedCommit: commit,
        expectedVersion: "0.1.2-rc.2",
      }),
    ).toThrow("channel and version disagree");
  });
});
