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

  it("requires granular Node, Hosting, Local fresh, and Local update only when selected", () => {
    const selected = {
      "format and lint": "success",
      "strict types baseline": "success",
      "focused Node tests": "success",
      "full Node tests": "success",
      "dist build": "success",
      "release contracts": "success",
      "packed Local install": "success",
      "Hosting lifecycle": "success",
      "Protected Local fixture artifact": "success",
      "Protected Local lifecycle": "success",
      "Protected Local update lifecycle": "success",
    };
    expect(() =>
      assertApplicableGates({
        runNodeFocused: true,
        runNodeBuild: true,
        runNodePackaging: true,
        runNodeFull: true,
        runHosting: true,
        runLocalFresh: true,
        runLocalUpdate: true,
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
        runLocalFresh: true,
        runLocalUpdate: true,
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
        runLocalUpdate: true,
        results: {
          ...alwaysGreen,
          ...selected,
          "Protected Local update lifecycle": "failure",
        },
      }),
    ).toThrow(/required Protected Local update lifecycle result was failure/);

    expect(() =>
      assertApplicableGates({
        runHosting: true,
        results: { ...alwaysGreen, "Hosting lifecycle": "success" },
      }),
    ).not.toThrow();
    expect(() =>
      assertApplicableGates({
        runLocalFresh: true,
        results: {
          ...alwaysGreen,
          "Protected Local fixture artifact": "success",
          "Protected Local lifecycle": "success",
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
        runLocalUpdate: true,
        runT2Contracts: true,
        results: {
          ...alwaysGreen,
          "format and lint": "success",
          "strict types baseline": "success",
          "focused Node tests": "success",
          "dist build": "success",
          "signer integration": "success",
          "Protected Local fixture artifact": "success",
          "Protected Local update lifecycle": "success",
          "T2 harness contracts": "success",
        },
      }),
    ).not.toThrow();
  });

  it("requires selected platform-bootstrap, Docker, and split signer lanes", () => {
    expect(() =>
      assertApplicableGates({
        runNativeSigner: true,
        runSignerIntegration: true,
        runSignerDarwinIntegration: true,
        runPlatformBootstrap: true,
        runDocker: true,
        runCodeqlJavascript: true,
        runCodeqlGo: true,
        runCodeqlPython: true,
        results: {
          ...alwaysGreen,
          "native signer": "success",
          "signer integration": "success",
          "Darwin signer integration": "success",
          "platform bootstrap": "success",
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

  it("requires only supported full-matrix compatibility lanes", () => {
    expect(() =>
      assertApplicableGates({
        fullMatrix: true,
        results: {
          ...alwaysGreen,
          "Protected Local Rocky lifecycle": "success",
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertApplicableGates({
        fullMatrix: true,
        results: {
          ...alwaysGreen,
          "Protected Local Rocky lifecycle": "failure",
        },
      }),
    ).toThrow(/required Protected Local Rocky lifecycle result was failure/u);
  });
});
