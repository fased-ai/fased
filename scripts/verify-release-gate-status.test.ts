import { describe, expect, it } from "vitest";
import { RELEASE_GATE_CONTEXT, verifyReleaseGateStatus } from "./verify-release-gate-status.mjs";

const commit = "a".repeat(40);
const receiptDigest = `sha256:${"b".repeat(64)}`;
const artifactSetDigest = `sha256:${"c".repeat(64)}`;
const now = new Date("2026-08-02T12:00:00.000Z");

function status(overrides = {}) {
  return {
    id: 10,
    url: `https://api.github.com/repos/fased-ai/fased/statuses/${commit}`,
    state: "success",
    context: RELEASE_GATE_CONTEXT,
    description: `r=${receiptDigest.slice(7)};e=2026-08-02T12:30:00.000Z;a=tag`,
    creator: { login: "release-founder" },
    created_at: "2026-08-02T11:55:00.000Z",
    target_url: `https://github.com/fased-ai/fased/commit/${commit}?fased-artifact-set=${artifactSetDigest.slice(7)}`,
    ...overrides,
  };
}

describe("release gate status verification", () => {
  it("accepts only the newest exact-commit trusted single-action status", () => {
    const result = verifyReleaseGateStatus([status({ id: 9, state: "failure" }), status()], {
      commit,
      action: "tag",
      trustedActor: "release-founder",
      repository: "fased-ai/fased",
      receiptDigest,
      now,
    });
    expect(result).toMatchObject({ commit, action: "tag", receiptDigest, statusId: 10 });
  });

  it.each([
    ["wrong actor", status({ creator: { login: "other" } }), /actor is not trusted/],
    [
      "wrong action",
      status({ description: status().description.replace("a=tag", "a=github-release") }),
      /exactly/,
    ],
    [
      "combined actions",
      status({ description: status().description.replace("a=tag", "a=tag,github-release") }),
      /malformed/,
    ],
    ["expired", status({ description: status().description.replace("12:30", "11:30") }), /expired/],
    [
      "wrong commit",
      status({ url: `https://api.github.com/repos/fased-ai/fased/statuses/${"c".repeat(40)}` }),
      /no successful/,
    ],
    [
      "unbound artifact set",
      status({ target_url: `https://github.com/fased-ai/fased/commit/${commit}` }),
      /does not bind/,
    ],
  ])("rejects %s", (_label, candidate, error) => {
    expect(() =>
      verifyReleaseGateStatus([candidate], {
        commit,
        action: "tag",
        trustedActor: "release-founder",
        repository: "fased-ai/fased",
        receiptDigest,
        now,
      }),
    ).toThrow(error);
  });

  it("binds GitHub Release authorization to the exact promoted artifact set", () => {
    const candidate = status({
      description: status().description.replace("a=tag", "a=github-release"),
    });
    expect(
      verifyReleaseGateStatus([candidate], {
        commit,
        action: "github-release",
        trustedActor: "release-founder",
        repository: "fased-ai/fased",
        receiptDigest,
        artifactSetDigest,
        now,
      }),
    ).toMatchObject({ artifactSetDigest });
    expect(() =>
      verifyReleaseGateStatus([candidate], {
        commit,
        action: "github-release",
        trustedActor: "release-founder",
        repository: "fased-ai/fased",
        receiptDigest,
        artifactSetDigest: `sha256:${"d".repeat(64)}`,
        now,
      }),
    ).toThrow("artifact-set digest mismatch");
  });
});
