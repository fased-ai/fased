import { describe, expect, it } from "vitest";
import { assertApplicableGates } from "./ci-required-gates.mjs";

const alwaysGreen = {
  "change scope": "success",
  secrets: "success", // pragma: allowlist secret
};

describe("required CI gate aggregation", () => {
  it("accepts documentation-only changes without product jobs", () => {
    expect(() =>
      assertApplicableGates({
        docsChanged: true,
        results: { ...alwaysGreen, documentation: "success" },
      }),
    ).not.toThrow();
  });

  it("accepts exact version-only changes without docs or product jobs", () => {
    expect(() =>
      assertApplicableGates({
        docsChanged: true,
        versionOnly: true,
        results: {
          ...alwaysGreen,
          "version identity": "success",
        },
      }),
    ).not.toThrow();
  });

  it("fails a version-only change without version identity", () => {
    expect(() =>
      assertApplicableGates({
        versionOnly: true,
        results: alwaysGreen,
      }),
    ).toThrow(/required version identity result was missing/u);
  });

  it("requires Node, Hosting, Local fresh, and Local update only when selected", () => {
    const selected = {
      "format and lint": "success",
      "strict types baseline": "success",
      "Node tests": "success",
      "dist build": "success",
      "release contracts": "success",
      "packed package smoke": "success",
      "Hosting supporting fixtures": "success",
      "Protected Local fixture artifact": "success",
      "Local fresh supporting fixture": "success",
      "Local update supporting fixture": "success",
    };
    expect(() =>
      assertApplicableGates({
        runNode: true,
        runHosting: true,
        runLocalFresh: true,
        runLocalUpdate: true,
        results: { ...alwaysGreen, ...selected },
      }),
    ).not.toThrow();
    expect(() =>
      assertApplicableGates({
        runNode: true,
        runHosting: true,
        runLocalFresh: true,
        runLocalUpdate: true,
        results: {
          ...alwaysGreen,
          ...selected,
          "Hosting supporting fixtures": "skipped",
        },
      }),
    ).toThrow(/required Hosting supporting fixtures result was skipped/);
    expect(() =>
      assertApplicableGates({
        runNode: true,
        runLocalUpdate: true,
        results: {
          ...alwaysGreen,
          ...selected,
          "Local update supporting fixture": "failure",
        },
      }),
    ).toThrow(/required Local update supporting fixture result was failure/);

    expect(() =>
      assertApplicableGates({
        runHosting: true,
        results: { ...alwaysGreen, "Hosting supporting fixtures": "success" },
      }),
    ).not.toThrow();
    expect(() =>
      assertApplicableGates({
        runLocalFresh: true,
        results: {
          ...alwaysGreen,
          "Protected Local fixture artifact": "success",
          "Local fresh supporting fixture": "success",
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertApplicableGates({
        runCiContracts: true,
        results: { ...alwaysGreen, "CI contracts": "success" },
      }),
    ).not.toThrow();
    expect(() =>
      assertApplicableGates({
        runT2Contracts: true,
        results: {
          ...alwaysGreen,
          "T2 privilege source contracts (supporting)": "success",
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertApplicableGates({
        runT2Contracts: true,
        results: {
          ...alwaysGreen,
          "T2 privilege source contracts (supporting)": "skipped",
        },
      }),
    ).toThrow(/required T2 privilege source contracts \(supporting\) result was skipped/);
  });

  it("fails an ambiguous lifecycle scope before treating supporting jobs as acceptance", () => {
    expect(() =>
      assertApplicableGates({
        manualReviewRequired: true,
        results: alwaysGreen,
      }),
    ).toThrow(/change scope is ambiguous/u);
  });

  it("requires all selected full-matrix lanes", () => {
    expect(() =>
      assertApplicableGates({
        fullMatrix: true,
        results: {
          ...alwaysGreen,
          "Local Rocky supporting fixture": "success",
          "full UI": "success",
          Windows: "success",
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertApplicableGates({
        fullMatrix: true,
        results: {
          ...alwaysGreen,
          "Local Rocky supporting fixture": "success",
          "full UI": "success",
          Windows: "failure",
        },
      }),
    ).toThrow(/required Windows result was failure/);
  });
});
