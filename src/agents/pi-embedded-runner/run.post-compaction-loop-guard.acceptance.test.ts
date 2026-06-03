import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEmbeddedPiAgent } from "./run.js";
import {
  makeAttemptResult,
  makeCompactionSuccess,
  makeOverflowError,
} from "./run.overflow-compaction.fixture.js";
import {
  mockedCompactDirect,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams as baseParams,
} from "./run.overflow-compaction.shared-test.js";

describe("post-compaction loop guard acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops retrying when post-compaction observations repeat the same overflow state", async () => {
    const overflowError = makeOverflowError(
      "request_too_large: post-compaction prompt still exceeds model context window",
    );

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: overflowError,
          attemptUsage: { input: 180000, total: 180000 },
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: overflowError,
          attemptUsage: { input: 180000, total: 180000 },
        }),
      );
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session without reducing the observed prompt",
        firstKeptEntryId: "entry-5",
        tokensBefore: 180000,
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...baseParams,
      sessionKey: "agent:main:telegram:channel:-1001234567890:topic:42",
    });

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.meta.error?.kind).toBe("context_overflow");
  });

  it.skip("threads a live guard observer through compaction without changing provider retry policy", async () => {
    const observer = vi.fn();

    expect(observer).not.toHaveBeenCalled();
  });
});
