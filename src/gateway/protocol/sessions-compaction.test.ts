import { describe, expect, it } from "vitest";
import {
  validateSessionsCompactionBranchParams,
  validateSessionsCompactionGetParams,
  validateSessionsCompactionListParams,
  validateSessionsCompactionRestoreParams,
} from "./index.js";

describe("session compaction protocol validators", () => {
  it("accepts list/get/branch/restore params", () => {
    expect(validateSessionsCompactionListParams({ key: "global" })).toBe(true);
    expect(
      validateSessionsCompactionGetParams({
        key: "global",
        checkpointId: "checkpoint-1",
      }),
    ).toBe(true);
    expect(
      validateSessionsCompactionBranchParams({
        key: "global",
        checkpointId: "checkpoint-1",
      }),
    ).toBe(true);
    expect(
      validateSessionsCompactionRestoreParams({
        key: "global",
        checkpointId: "checkpoint-1",
      }),
    ).toBe(true);
  });

  it("rejects empty keys and unknown fields", () => {
    expect(validateSessionsCompactionListParams({ key: "" })).toBe(false);
    expect(validateSessionsCompactionListParams({ key: "global", extra: true })).toBe(false);
    expect(
      validateSessionsCompactionGetParams({
        key: "global",
        checkpointId: "",
      }),
    ).toBe(false);
    expect(
      validateSessionsCompactionBranchParams({
        key: "global",
        checkpointId: "checkpoint-1",
        extra: true,
      }),
    ).toBe(false);
    expect(
      validateSessionsCompactionRestoreParams({
        key: "global",
        checkpointId: "",
      }),
    ).toBe(false);
  });
});
