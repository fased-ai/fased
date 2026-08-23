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
        results: { ...alwaysGreen, "version identity": "success" },
      }),
    ).not.toThrow();
  });

  it("requires the dedicated dependency-integrity result when selected", () => {
    expect(() =>
      assertApplicableGates({
        runDependencyIntegrity: true,
        results: { ...alwaysGreen, "dependency integrity": "success" },
      }),
    ).not.toThrow();
    expect(() =>
      assertApplicableGates({
        runDependencyIntegrity: true,
        results: { ...alwaysGreen, "dependency integrity": "skipped" },
      }),
    ).toThrow(/required dependency integrity result was skipped/u);
  });

  it("accepts the exact dependency-remediation aggregate without generic Node gates", () => {
    expect(() =>
      assertApplicableGates({
        dependencyRemediation: true,
        runDependencyIntegrity: true,
        runNodeBuild: true,
        results: {
          ...alwaysGreen,
          "dependency integrity": "success",
          "dist build": "success",
          "format and lint": "skipped",
          "strict types baseline": "skipped",
        },
      }),
    ).not.toThrow();
  });

  it("requires granular Node and Hosting gates only when selected", () => {
    const selected = {
      "format and lint": "success",
      "strict types baseline": "success",
      "focused Node tests": "success",
      "full Node tests": "success",
      "dist build": "success",
      "release contracts": "success",
      "packed Local install": "success",
      "Hosting lifecycle": "success",
    };
    expect(() =>
      assertApplicableGates({
        runNodeFocused: true,
        runNodeBuild: true,
        runNodePackaging: true,
        runNodeFull: true,
        runHosting: true,
        results: { ...alwaysGreen, ...selected },
      }),
    ).not.toThrow();
    expect(() =>
      assertApplicableGates({
        runNodeFocused: true,
        runNodeBuild: true,
        runNodePackaging: true,
        runNodeFull: true,
        runHosting: true,
        results: {
          ...alwaysGreen,
          ...selected,
          "Hosting lifecycle": "skipped",
        },
      }),
    ).toThrow(/required Hosting lifecycle result was skipped/);
    expect(() =>
      assertApplicableGates({
        runNodeFocused: true,
        runNodeBuild: true,
        runHosting: true,
        results: {
          ...alwaysGreen,
          ...selected,
          "Hosting lifecycle": "failure",
        },
      }),
    ).toThrow(/required Hosting lifecycle result was failure/);

    expect(() =>
      assertApplicableGates({
        runHosting: true,
        results: { ...alwaysGreen, "Hosting lifecycle": "success" },
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
        results: { ...alwaysGreen, "T2 harness contracts": "success" },
      }),
    ).not.toThrow();
    expect(() =>
      assertApplicableGates({
        runT2Contracts: true,
        results: { ...alwaysGreen, "T2 harness contracts": "skipped" },
      }),
    ).toThrow(/required T2 harness contracts result was skipped/);
  });

  it("does not require full Node, packaging, or native signer for a focused Local update", () => {
    expect(() =>
      assertApplicableGates({
        runNodeFocused: true,
        runNodeBuild: true,
        runSignerIntegration: true,
        runT2Contracts: true,
        results: {
          ...alwaysGreen,
          "format and lint": "success",
          "strict types baseline": "success",
          "focused Node tests": "success",
          "dist build": "success",
          "signer integration": "success",
          "T2 harness contracts": "success",
        },
      }),
    ).not.toThrow();
  });

  it("accepts one focused Local-update source job instead of duplicate broad checks", () => {
    expect(() =>
      assertApplicableGates({
        docsChanged: true,
        focusedLocalUpdate: true,
        runNodeFocused: true,
        runCiContracts: true,
        runCodeqlJavascript: true,
        results: {
          ...alwaysGreen,
          "focused Node tests": "success",
          "CI contracts": "success",
          "CodeQL JavaScript": "success",
          documentation: "skipped",
          "format and lint": "skipped",
          "strict types baseline": "skipped",
          "T2 harness contracts": "skipped",
        },
      }),
    ).not.toThrow();
  });

  it("accepts any selected focused Node route instead of duplicate broad checks", () => {
    expect(() =>
      assertApplicableGates({
        docsChanged: true,
        runNodeFocused: true,
        runCiContracts: true,
        runCodeqlJavascript: true,
        results: {
          ...alwaysGreen,
          "focused Node tests": "success",
          "CI contracts": "success",
          "CodeQL JavaScript": "success",
          documentation: "skipped",
          "format and lint": "skipped",
          "strict types baseline": "skipped",
        },
      }),
    ).not.toThrow();
  });

  it("requires selected Docker and split signer lanes", () => {
    expect(() =>
      assertApplicableGates({
        runNativeSigner: true,
        runSignerIntegration: true,
        runSignerDarwinIntegration: true,
        runDocker: true,
        runCodeqlJavascript: true,
        runCodeqlGo: true,
        runCodeqlPython: true,
        results: {
          ...alwaysGreen,
          "native signer": "success",
          "signer integration": "success",
          "Darwin signer integration": "success",
          "Docker amd64": "success",
          "Docker arm64": "success",
          "CodeQL JavaScript": "success",
          "CodeQL Go": "success",
          "CodeQL Python": "success",
        },
      }),
    ).not.toThrow();
  });

  it("requires focused subsystem, UI, and supported macOS lanes", () => {
    expect(() =>
      assertApplicableGates({
        runNodeUnit: true,
        runNodeGateway: true,
        runNodeExtensions: true,
        runUi: true,
        runMacosRuntime: true,
        runMacosApp: true,
        results: {
          ...alwaysGreen,
          "format and lint": "success",
          "strict types baseline": "success",
          "Node unit tests": "success",
          "Node Gateway tests": "success",
          "Node extension tests": "success",
          "Control UI": "success",
          "macOS runtime": "success",
          "macOS app": "success",
        },
      }),
    ).not.toThrow();
  });

  it("rejects stale plans that request a human-only classifier escape hatch", () => {
    expect(() =>
      assertApplicableGates({
        manualReviewRequired: true,
        results: alwaysGreen,
      }),
    ).toThrow(/classification blocked: a stale gate plan requested manual review/u);
  });
});
