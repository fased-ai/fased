import { describe, expect, it } from "vitest";
import { issueHostingStagingReceipt } from "./hosting-staging-vps-receipt.mjs";

const descriptor = Buffer.from(
  JSON.stringify({ version: "0.1.76-rc.200", commit: "a".repeat(40), tree: "b".repeat(40) }),
);
const contract = Buffer.from("exact acceptance contract\n");

function evidence(overrides = {}) {
  return {
    descriptor,
    acceptanceContract: contract,
    installOutput: Buffer.from("Updated successfully: 0.1.76-rc.200\n"),
    retryOutput: Buffer.from("Already current: 0.1.76-rc.200\n"),
    memoryEvents: Buffer.from("low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n"),
    memoryPeakBytes: 512 * 1024 * 1024,
    memoryLimitBytes: 2 * 1024 * 1024 * 1024,
    swapLimitBytes: 2 * 1024 * 1024 * 1024,
    initialSystemSwapBytes: 0,
    finalSystemSwapBytes: 2 * 1024 * 1024 * 1024,
    managedSwapActive: true,
    managedSwapPersistent: true,
    ...overrides,
  };
}

describe("Hosting staging VPS receipt", () => {
  it("binds the literal unpublished install and exact Already current retry", () => {
    expect(issueHostingStagingReceipt(evidence())).toMatchObject({
      status: "PASS",
      evidenceClass: "PASS",
      environmentClass: "hosting-staging-vps",
      source: { commit: "a".repeat(40), tree: "b".repeat(40) },
      identicalRetry: { status: "PASS", outcome: "ALREADY_CURRENT" },
      resources: {
        memoryLimitBytes: 2147483648,
        swapLimitBytes: 2147483648,
        initialSystemSwapBytes: 0,
        finalSystemSwapBytes: 2147483648,
        managedSwapActive: true,
        managedSwapPersistent: true,
        oomKill: 0,
      },
    });
  });

  it("fails closed on OOM, swap, or a non-identical retry", () => {
    expect(() =>
      issueHostingStagingReceipt(evidence({ memoryEvents: Buffer.from("oom 1\noom_kill 1\n") })),
    ).toThrow("resource evidence");
    expect(() => issueHostingStagingReceipt(evidence({ swapLimitBytes: 4294967296 }))).toThrow(
      "resource evidence",
    );
    expect(() => issueHostingStagingReceipt(evidence({ finalSystemSwapBytes: 0 }))).toThrow(
      "resource evidence",
    );
    expect(() => issueHostingStagingReceipt(evidence({ managedSwapPersistent: false }))).toThrow(
      "resource evidence",
    );
    expect(() =>
      issueHostingStagingReceipt(evidence({ retryOutput: Buffer.from("UPDATED\n") })),
    ).toThrow("Already current");
  });
});
