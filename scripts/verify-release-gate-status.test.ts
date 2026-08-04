import { describe, expect, it } from "vitest";
import { RELEASE_GATE_CONTEXT, verifyReleaseGateStatus } from "./verify-release-gate-status.mjs";

const commit = "a".repeat(40);
const receiptDigest = `sha256:${"b".repeat(64)}`;
const artifactSetDigest = `sha256:${"c".repeat(64)}`;
const releaseTag = "v0.1.76-rc.35";
const trustedActorId = "1234567";
const now = new Date("2026-08-02T12:00:00.000Z");

function status(overrides = {}) {
  return {
    id: 10,
    url: `https://api.github.com/repos/fased-ai/fased/statuses/${commit}`,
    state: "success",
    context: RELEASE_GATE_CONTEXT,
    description: `r=${receiptDigest.slice(7)};e=2026-08-02T12:30:00.000Z;a=tag`,
    creator: { id: Number(trustedActorId), login: "release-founder" },
    created_at: "2026-08-02T11:55:00.000Z",
    target_url: `https://github.com/fased-ai/fased/commit/${commit}?fased-artifact-set=${artifactSetDigest.slice(7)}&fased-tag=${releaseTag}`,
    ...overrides,
  };
}

function options(overrides = {}) {
  return {
    commit,
    action: "tag",
    trustedActor: "release-founder",
    trustedActorId,
    repository: "fased-ai/fased",
    releaseTag,
    receiptDigest,
    now,
    ...overrides,
  };
}

describe("release gate status verification", () => {
  it("accepts only the newest exact-commit trusted single-action status", () => {
    const result = verifyReleaseGateStatus(
      [status({ id: 9, created_at: "2026-08-02T11:54:00.000Z", state: "failure" }), status()],
      options(),
    );
    expect(result).toMatchObject({
      commit,
      action: "tag",
      actorId: trustedActorId,
      releaseTag,
      receiptDigest,
      statusId: 10,
    });
  });

  it("rejects a newer non-success status even when an older success exists", () => {
    expect(() =>
      verifyReleaseGateStatus(
        [status(), status({ id: 11, created_at: "2026-08-02T11:56:00.000Z", state: "error" })],
        options(),
      ),
    ).toThrow("newest exact-commit lifecycle release gate status is not successful");
  });

  it.each([
    [
      "wrong actor",
      status({ creator: { id: Number(trustedActorId), login: "other" } }),
      /actor is not trusted/,
    ],
    [
      "wrong actor ID",
      status({ creator: { id: 7654321, login: "release-founder" } }),
      /actor ID is not trusted/,
    ],
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
      "overlong authorization window",
      status({ description: status().description.replace("12:30", "13:00") }),
      /one-hour trust window/,
    ],
    [
      "wrong commit",
      status({ url: `https://api.github.com/repos/fased-ai/fased/statuses/${"c".repeat(40)}` }),
      /no lifecycle/,
    ],
    [
      "unbound artifact set",
      status({ target_url: `https://github.com/fased-ai/fased/commit/${commit}` }),
      /does not bind/,
    ],
    [
      "wrong release tag",
      status({ target_url: status().target_url.replace(releaseTag, "v0.1.76-rc.34") }),
      /does not bind/,
    ],
  ])("rejects %s", (_label, candidate, error) => {
    expect(() => verifyReleaseGateStatus([candidate], options())).toThrow(error);
  });

  it("binds GitHub Release authorization to the exact promoted artifact set", () => {
    const candidate = status({
      description: status().description.replace("a=tag", "a=github-release"),
    });
    expect(
      verifyReleaseGateStatus(
        [candidate],
        options({ action: "github-release", artifactSetDigest }),
      ),
    ).toMatchObject({ artifactSetDigest });
    expect(() =>
      verifyReleaseGateStatus(
        [candidate],
        options({
          action: "github-release",
          artifactSetDigest: `sha256:${"d".repeat(64)}`,
        }),
      ),
    ).toThrow("artifact-set digest mismatch");
  });
});
