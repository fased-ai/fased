import { describe, expect, it } from "vitest";
import {
  assessMergedPullRequest,
  hasSuccessfulAggregateCheck,
  pullRequestNumberFromSubject,
} from "./ci-merged-main-reuse.mjs";

const successfulCheck = {
  name: "checks",
  workflowName: "CI",
  status: "COMPLETED",
  conclusion: "SUCCESS",
};

describe("merged-main PR check reuse", () => {
  it("extracts only a trailing squash-merge pull request number", () => {
    expect(pullRequestNumberFromSubject("Fix lifecycle (#219)")).toBe(219);
    expect(pullRequestNumberFromSubject("Direct push")).toBeNull();
    expect(pullRequestNumberFromSubject("Mention #219 without squash suffix")).toBeNull();
  });

  it("requires the successful CI aggregate check", () => {
    expect(hasSuccessfulAggregateCheck([successfulCheck])).toBe(true);
    expect(hasSuccessfulAggregateCheck([{ ...successfulCheck, conclusion: "FAILURE" }])).toBe(
      false,
    );
    expect(hasSuccessfulAggregateCheck([{ ...successfulCheck, workflowName: "Other" }])).toBe(
      false,
    );
  });

  it("accepts only an exact merged commit and tree match", () => {
    const input = {
      headSha: "a".repeat(40),
      mainTree: "b".repeat(40),
      prTree: "b".repeat(40),
      pr: {
        state: "MERGED",
        mergeCommit: { oid: "a".repeat(40) },
        statusCheckRollup: [successfulCheck],
      },
    };
    expect(assessMergedPullRequest(input)).toBeNull();
    expect(
      assessMergedPullRequest({
        ...input,
        prTree: "c".repeat(40),
      }),
    ).toMatch(/tree/);
    expect(
      assessMergedPullRequest({
        ...input,
        pr: { ...input.pr, mergeCommit: { oid: "d".repeat(40) } },
      }),
    ).toMatch(/merge commit/);
  });
});
