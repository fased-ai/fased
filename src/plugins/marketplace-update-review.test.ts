import { describe, expect, it } from "vitest";
import {
  buildPluginMarketplaceUpdateReview,
  formatPluginMarketplaceUpdateReviewWarnings,
} from "./marketplace-update-review.js";
import type { PluginMarketplaceEntry } from "./marketplace.js";
import type { PluginUpdateOutcome } from "./update.js";

function createEntry(overrides: Partial<PluginMarketplaceEntry> = {}): PluginMarketplaceEntry {
  return {
    id: "demo",
    name: "Demo",
    status: "loaded",
    discovered: true,
    managed: true,
    loaded: true,
    enabled: true,
    hasInstallRecord: true,
    install: {
      source: "npm",
      spec: "@fased/demo@1.0.0",
      integrity: "sha512-old",
    },
    channels: ["telegram"],
    providers: ["openai"],
    toolNames: ["demo.status"],
    hookNames: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpHandlers: 0,
    hookCount: 0,
    installOptions: {},
    actions: ["status", "update"],
    ...overrides,
  };
}

function createOutcome(overrides: Partial<PluginUpdateOutcome> = {}): PluginUpdateOutcome {
  return {
    pluginId: "demo",
    status: "updated",
    message: "updated",
    currentVersion: "1.0.0",
    nextVersion: "1.0.1",
    resolvedSpec: "@fased/demo@1.0.1",
    integrity: "sha512-new",
    packageReview: {
      pluginId: "demo",
      packageName: "@fased/demo",
      version: "1.0.1",
      extensions: ["./dist/index.js"],
      channels: ["telegram"],
      providers: ["openai"],
      skills: [],
      tools: ["demo.status"],
      dependencyCount: 0,
      dependencyKinds: [],
      scriptNames: [],
      dependencyWarnings: [],
      scriptWarnings: [],
    },
    warnings: [],
    ...overrides,
  };
}

function createClawHubEntry(
  installOverrides: Partial<NonNullable<PluginMarketplaceEntry["install"]>> = {},
): PluginMarketplaceEntry {
  return createEntry({
    install: {
      source: "clawhub",
      clawhubUrl: "https://clawhub.com",
      clawhubArtifactUrl: "https://clawhub.com/artifacts/demo.zip",
      clawhubPackage: "@fased/demo",
      clawhubFamily: "code-plugin",
      clawhubChannel: "official",
      version: "1.0.0",
      integrity: "sha256-old",
      artifactKind: "clawpack",
      artifactFormat: "zip",
      clawpackSha256: "clawpack-sha256",
      clawpackSpecVersion: 1,
      clawpackManifestSha256: "manifest-sha256",
      clawpackSize: 1024,
      ...installOverrides,
    },
  });
}

describe("buildPluginMarketplaceUpdateReview", () => {
  it("does not require approval for trusted pinned updates without new surfaces", () => {
    const review = buildPluginMarketplaceUpdateReview({
      entry: createEntry(),
      outcome: createOutcome(),
    });

    expect(review.approvalRequired).toBe(false);
    expect(review.sourceTrust.trusted).toBe(true);
    expect(review.sourceTrust.integrityPinned).toBe(true);
    expect(review.permissionDiff.added.channels).toEqual([]);
    expect(review.permissionDiff.added.providers).toEqual([]);
    expect(review.permissionDiff.added.tools).toEqual([]);
    expect(review.reasons).toEqual([]);
  });

  it("requires approval for dependency/script warnings and expanded permissions", () => {
    const review = buildPluginMarketplaceUpdateReview({
      entry: createEntry(),
      outcome: createOutcome({
        packageReview: {
          pluginId: "demo",
          packageName: "@fased/demo",
          version: "1.1.0",
          extensions: ["./dist/index.js"],
          channels: ["telegram", "discord"],
          providers: ["openai", "anthropic"],
          skills: ["demo-trader"],
          tools: ["demo.status", "demo.send"],
          dependencyCount: 2,
          dependencyKinds: ["dependencies", "optionalDependencies"],
          scriptNames: ["postinstall"],
          dependencyWarnings: ["package declares runtime dependencies"],
          scriptWarnings: ["package declares npm scripts: postinstall"],
        },
        warnings: ["scan warning"],
      }),
    });

    expect(review.approvalRequired).toBe(true);
    expect(review.permissionDiff.added.channels).toEqual(["discord"]);
    expect(review.permissionDiff.added.providers).toEqual(["anthropic"]);
    expect(review.permissionDiff.added.skills).toEqual(["demo-trader"]);
    expect(review.permissionDiff.added.tools).toEqual(["demo.send"]);
    expect(review.permissionDiff.changed).toEqual([]);
    expect(review.reasons).toEqual([
      "package declares npm scripts",
      "package dependency manifest changed or requires review",
      "plugin manifest surface expands or changes",
      "scan warnings were reported",
    ]);
  });

  it("requires approval for untrusted or unpinned update sources", () => {
    const review = buildPluginMarketplaceUpdateReview({
      entry: createEntry({
        install: {
          source: "path",
          sourcePath: "/tmp/demo",
        },
      }),
      outcome: createOutcome(),
    });

    expect(review.approvalRequired).toBe(true);
    expect(review.sourceTrust.trusted).toBe(false);
    expect(review.sourceTrust.reason).toBe("updates from path sources require manual review");
    expect(review.reasons).toEqual([
      "source integrity is not pinned",
      "updates from path sources require manual review",
    ]);
  });

  it("trusts allowlisted ClawHub sources with pinned metadata and local review", () => {
    const review = buildPluginMarketplaceUpdateReview({
      entry: createClawHubEntry(),
      outcome: createOutcome(),
    });

    expect(review.approvalRequired).toBe(false);
    expect(review.sourceTrust.source).toBe("clawhub");
    expect(review.sourceTrust.spec).toBe("@fased/demo@1.0.0");
    expect(review.sourceTrust.trusted).toBe(true);
    expect(review.sourceTrust.integrityPinned).toBe(true);
    expect(review.reasons).toEqual([]);
  });

  it("requires approval for ClawHub sources without local package review", () => {
    const review = buildPluginMarketplaceUpdateReview({
      entry: createClawHubEntry(),
      outcome: createOutcome({ packageReview: undefined }),
    });

    expect(review.approvalRequired).toBe(true);
    expect(review.sourceTrust.trusted).toBe(false);
    expect(review.sourceTrust.reason).toBe("ClawHub source requires local package review");
    expect(review.reasons).toEqual(["ClawHub source requires local package review"]);
  });

  it("requires approval for ClawHub sources outside the allowlisted registry", () => {
    const review = buildPluginMarketplaceUpdateReview({
      entry: createClawHubEntry({ clawhubUrl: "https://example.invalid/packages/demo" }),
      outcome: createOutcome(),
    });

    expect(review.approvalRequired).toBe(true);
    expect(review.sourceTrust.trusted).toBe(false);
    expect(review.sourceTrust.reason).toBe(
      "ClawHub registry is not allowlisted: https://example.invalid",
    );
    expect(review.reasons).toEqual([
      "ClawHub registry is not allowlisted: https://example.invalid",
    ]);
  });

  it("requires approval for incomplete or unpinned ClawHub artifact metadata", () => {
    const review = buildPluginMarketplaceUpdateReview({
      entry: createClawHubEntry({
        integrity: undefined,
        clawpackManifestSha256: undefined,
      }),
      outcome: createOutcome(),
    });

    expect(review.approvalRequired).toBe(true);
    expect(review.sourceTrust.trusted).toBe(false);
    expect(review.sourceTrust.integrityPinned).toBe(false);
    expect(review.sourceTrust.reason).toBe(
      "ClawHub source metadata is incomplete: clawpackManifestSha256",
    );
    expect(review.reasons).toEqual([
      "ClawHub source metadata is incomplete: clawpackManifestSha256",
      "source integrity is not pinned",
    ]);
  });

  it("keeps ClawHub source-trust, dependency, script, and scanner warnings visible", () => {
    const review = buildPluginMarketplaceUpdateReview({
      entry: createClawHubEntry(),
      outcome: createOutcome({
        packageReview: {
          pluginId: "demo",
          packageName: "@fased/demo",
          version: "1.1.0",
          extensions: ["./dist/index.js"],
          channels: ["telegram"],
          providers: ["openai"],
          skills: [],
          tools: ["demo.status"],
          dependencyCount: 1,
          dependencyKinds: ["dependencies:1"],
          scriptNames: ["postinstall"],
          dependencyWarnings: ["package declares runtime dependencies"],
          scriptWarnings: ["package declares npm scripts: postinstall"],
        },
        warnings: ["scanner warning: package requests network access"],
      }),
    });

    expect(review.approvalRequired).toBe(true);
    expect(review.sourceTrust.source).toBe("clawhub");
    expect(review.sourceTrust.trusted).toBe(false);
    expect(review.sourceTrust.reason).toBe("ClawHub source has local scan warnings");
    expect(formatPluginMarketplaceUpdateReviewWarnings(review)).toEqual(
      expect.arrayContaining([
        "Update review: ClawHub source has local scan warnings",
        "Update review: package declares npm scripts",
        "Update review: package dependency manifest changed or requires review",
        "Update review: scan warnings were reported",
        "package declares runtime dependencies",
        "package declares npm scripts: postinstall",
        "scanner warning: package requests network access",
      ]),
    );
  });

  it("keeps source-only TypeScript runtime diagnostics visible", () => {
    const runtimeWarning =
      "package exposes TypeScript extension entry (./src/index.ts); publish compiled JavaScript runtime output before enabling this plugin";
    const review = buildPluginMarketplaceUpdateReview({
      entry: createEntry(),
      outcome: createOutcome({
        packageReview: {
          pluginId: "demo",
          packageName: "@fased/demo",
          version: "1.1.0",
          extensions: ["./src/index.ts"],
          channels: ["telegram"],
          providers: ["openai"],
          skills: [],
          tools: ["demo.status"],
          dependencyCount: 0,
          dependencyKinds: [],
          scriptNames: [],
          dependencyWarnings: [],
          scriptWarnings: [],
          runtimeWarnings: [runtimeWarning],
        },
      }),
    });

    expect(review.approvalRequired).toBe(true);
    expect(review.runtimeWarnings).toEqual([runtimeWarning]);
    expect(review.reasons).toEqual(["plugin package exposes source-only TypeScript entries"]);
    expect(formatPluginMarketplaceUpdateReviewWarnings(review)).toEqual([
      "Update review: plugin package exposes source-only TypeScript entries",
      runtimeWarning,
    ]);
  });

  it("formats review warnings with reasons before package warnings", () => {
    const review = buildPluginMarketplaceUpdateReview({
      entry: createEntry({ install: { source: "npm", spec: "@fased/demo@1.0.0" } }),
      outcome: createOutcome({
        packageReview: {
          pluginId: "demo",
          packageName: "@fased/demo",
          version: "1.0.1",
          extensions: ["./dist/index.js"],
          channels: ["telegram"],
          providers: ["openai"],
          skills: [],
          tools: ["demo.status"],
          dependencyCount: 1,
          dependencyKinds: ["dependencies"],
          scriptNames: [],
          dependencyWarnings: ["package declares runtime dependencies"],
          scriptWarnings: [],
        },
      }),
    });

    expect(formatPluginMarketplaceUpdateReviewWarnings(review)).toEqual([
      "Update review: package dependency manifest changed or requires review",
      "Update review: source integrity is not pinned",
      "package declares runtime dependencies",
    ]);
  });
});
