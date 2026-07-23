import { describe, expect, it } from "vitest";
import { assertApplicableGates } from "./ci-required-gates.mjs";

const alwaysGreen = {
  "change scope": "success",
  secrets: "success",
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
        results: { ...alwaysGreen, "version identity": "success" },
      }),
    ).not.toThrow();
  });

  it("requires the Node and Hosting groups only when selected", () => {
    const nodeAndHosting = {
      "format and lint": "success",
      "strict types baseline": "success",
      "Node tests": "success",
      "dist build": "success",
      "release contracts": "success",
      "packed Local install": "success",
      "Hosting lifecycle": "success",
    };
    expect(() =>
      assertApplicableGates({
        runNode: true,
        runHosting: true,
        results: { ...alwaysGreen, ...nodeAndHosting },
      }),
    ).not.toThrow();
    expect(() =>
      assertApplicableGates({
        runNode: true,
        runHosting: true,
        results: {
          ...alwaysGreen,
          ...nodeAndHosting,
          "Hosting lifecycle": "skipped",
        },
      }),
    ).toThrow(/required Hosting lifecycle result was skipped/);
  });

  it("requires all selected full-matrix lanes", () => {
    expect(() =>
      assertApplicableGates({
        fullMatrix: true,
        results: { ...alwaysGreen, "full UI": "success", Windows: "success" },
      }),
    ).not.toThrow();
    expect(() =>
      assertApplicableGates({
        fullMatrix: true,
        results: { ...alwaysGreen, "full UI": "success", Windows: "failure" },
      }),
    ).toThrow(/required Windows result was failure/);
  });
});
