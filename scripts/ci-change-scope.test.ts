import { describe, expect, it } from "vitest";
import { classifyChangedPaths } from "./ci-change-scope.mjs";

describe("CI changed-surface classification", () => {
  it("keeps documentation-only changes lightweight", () => {
    expect(classifyChangedPaths(["docs/start/install.md", "README.md"])).toMatchObject({
      docsOnly: true,
      docsChanged: true,
      versionOnly: false,
      runNode: false,
      runSigner: false,
      runHosting: false,
      runUiMining: false,
    });
  });

  it("recognizes the exact release-version file set", () => {
    expect(
      classifyChangedPaths([
        "package.json",
        "src/brand.ts",
        "CHANGELOG.md",
        "extensions/telegram/package.json",
        "extensions/telegram/CHANGELOG.md",
      ]),
    ).toMatchObject({
      docsOnly: false,
      docsChanged: true,
      versionOnly: true,
      runNode: false,
      runSigner: false,
      runHosting: false,
      runUiMining: false,
    });
  });

  it("rejects a version-only classification when source code is mixed in", () => {
    expect(
      classifyChangedPaths(["package.json", "src/brand.ts", "src/gateway/server.ts"]),
    ).toMatchObject({
      versionOnly: false,
      runNode: true,
    });
  });

  it("runs Hosting checks only for Hosting lifecycle paths", () => {
    for (const path of [
      "scripts/fased-host-updater.mjs",
      "scripts/fased-managed-updater.mjs",
      "scripts/docker/streamed-hosting-bootstrap/run.sh",
      "scripts/docker/hosting-systemd/run.sh",
      "scripts/docker/protected-local-systemd/run.sh",
      "scripts/protected-local-bootstrap.mjs",
      "scripts/test-hosting-systemd-container.sh",
      "scripts/test-protected-local-systemd-container.sh",
      "src/wizard/onboarding.ts",
      "src/daemon/systemd-system.ts",
      "src/config/io.ts",
    ]) {
      expect(classifyChangedPaths([path]), path).toMatchObject({
        runNode: true,
        runHosting: true,
        runUiMining: false,
      });
    }
    expect(classifyChangedPaths(["src/agents/agent.ts"])).toMatchObject({
      runNode: true,
      runHosting: false,
    });
  });

  it("does not turn documentation contract files into a full Node run", () => {
    expect(classifyChangedPaths(["scripts/docs-product-contract.mjs"])).toMatchObject({
      docsOnly: true,
      docsChanged: true,
      runNode: false,
    });
  });

  it("runs Mining browser checks only for Mining-facing paths", () => {
    expect(classifyChangedPaths(["ui/src/ui/views/mining.ts"])).toMatchObject({
      runNode: true,
      runUiMining: true,
    });
    expect(classifyChangedPaths(["ui/src/ui/views/wallet.ts"])).toMatchObject({
      runNode: true,
      runUiMining: false,
    });
  });

  it("keeps generated signer protocol changes off the macOS app lane", () => {
    expect(
      classifyChangedPaths(["apps/macos/Sources/FasedAgentProtocol/Generated.swift"]),
    ).toMatchObject({
      runMacos: false,
    });
    expect(classifyChangedPaths(["apps/macos/Sources/App/Main.swift"])).toMatchObject({
      runMacos: true,
    });
  });

  it("enables every supported lane for a manual full matrix or failed diff", () => {
    for (const scope of [
      classifyChangedPaths([], { fullMatrix: true }),
      classifyChangedPaths([], { unknown: true }),
    ]) {
      expect(scope).toMatchObject({
        docsOnly: false,
        versionOnly: false,
        runNode: true,
        runMacos: true,
        runSigner: true,
        runHosting: true,
        runUiMining: true,
        runSkills: true,
        fullMatrix: true,
      });
    }
  });
});
