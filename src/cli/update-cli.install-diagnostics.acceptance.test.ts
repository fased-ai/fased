import { describe, expect, it } from "vitest";
import type { UpdateRunResult } from "../infra/update-runner.js";
import {
  buildPluginMarketplaceUpdateReview,
  formatPluginMarketplaceUpdateReviewWarnings,
} from "../plugins/marketplace-update-review.js";
import type { PluginMarketplaceEntry } from "../plugins/marketplace.js";
import type { PluginUpdateOutcome } from "../plugins/update.js";
import { inferUpdateFailureHints } from "./update-cli/progress.js";

function makeFailedNpmUpdate(stderrTail: string): UpdateRunResult {
  return {
    status: "error",
    mode: "npm",
    reason: "global update",
    steps: [
      {
        name: "global update",
        command: "npm i -g fased@latest",
        cwd: "/tmp/fased",
        durationMs: 1,
        exitCode: 1,
        stderrTail,
      },
    ],
    durationMs: 1,
  };
}

function createMarketplaceEntry(): PluginMarketplaceEntry {
  return {
    id: "risky",
    name: "Risky",
    status: "loaded",
    discovered: true,
    managed: true,
    loaded: true,
    enabled: true,
    hasInstallRecord: true,
    install: {
      source: "path",
      sourcePath: "/tmp/risky",
    },
    channels: ["telegram"],
    providers: ["openai"],
    toolNames: ["risky.status"],
    hookNames: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpHandlers: 0,
    hookCount: 0,
    installOptions: {},
    actions: ["status", "update"],
  };
}

function createUpdateOutcome(): PluginUpdateOutcome {
  return {
    pluginId: "risky",
    status: "updated",
    message: "updated risky",
    currentVersion: "1.0.0",
    nextVersion: "1.1.0",
    resolvedSpec: "@fased/risky@1.1.0",
    integrity: "sha512-new",
    packageReview: {
      pluginId: "risky",
      packageName: "@fased/risky",
      version: "1.1.0",
      extensions: ["./dist/index.js"],
      kind: "integration",
      channels: ["telegram", "discord"],
      providers: ["openai"],
      skills: [],
      tools: ["risky.status"],
      dependencyCount: 2,
      dependencyKinds: ["dependencies", "optionalDependencies"],
      scriptNames: ["postinstall"],
      dependencyWarnings: ["package declares 2 runtime dependencies"],
      scriptWarnings: ["package declares npm scripts: postinstall"],
      runtimeWarnings: [
        "package exposes TypeScript extension entry (./src/index.ts); publish compiled JavaScript runtime output before enabling this plugin",
      ],
    },
    warnings: ["scanner warning: package requests network access"],
  };
}

describe("Lane 2 install/update diagnostics audit", () => {
  it("keeps package-manager failure hints specific and actionable", () => {
    const hints = inferUpdateFailureHints(
      makeFailedNpmUpdate(
        [
          "npm ERR! code EACCES",
          "npm ERR! Error: EACCES: permission denied",
          "node-gyp rebuild failed for @discordjs/opus",
        ].join("\n"),
      ),
    );

    expect(hints.join("\n")).toContain("EACCES");
    expect(hints.join("\n")).toContain("npm config set prefix ~/.local");
    expect(hints.join("\n")).toContain("--omit=optional");
  });

  it("keeps source-trust, dependency, script, scanner, and runtime warnings visible", () => {
    const review = buildPluginMarketplaceUpdateReview({
      entry: createMarketplaceEntry(),
      outcome: createUpdateOutcome(),
    });
    const warnings = formatPluginMarketplaceUpdateReviewWarnings(review);

    expect(review.approvalRequired).toBe(true);
    expect(warnings).toEqual(
      expect.arrayContaining([
        "Update review: package declares npm scripts",
        "Update review: package dependency manifest changed or requires review",
        "Update review: plugin package exposes source-only TypeScript entries",
        "Update review: plugin manifest surface expands or changes",
        "Update review: scan warnings were reported",
        "Update review: source integrity is not pinned",
        "Update review: updates from path sources require manual review",
        "package declares 2 runtime dependencies",
        "package declares npm scripts: postinstall",
        "package exposes TypeScript extension entry (./src/index.ts); publish compiled JavaScript runtime output before enabling this plugin",
        "scanner warning: package requests network access",
      ]),
    );
  });
});
