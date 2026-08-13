import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertBrandVersionOnlyChange,
  assertLatestPublishedBaseRestore,
  assertPackageVersionOnlyChange,
  isLineSubsequence,
  validateCurrentVersionInventory,
} from "./ci-version-identity.mjs";

describe("version-only release identity", () => {
  it("accepts only the root package version field", () => {
    expect(() =>
      assertPackageVersionOnlyChange(
        { name: "@fased/fased", version: "1.2.3", private: false },
        { name: "@fased/fased", version: "1.2.4", private: false },
        "package.json",
      ),
    ).not.toThrow();
    expect(() =>
      assertPackageVersionOnlyChange(
        { name: "@fased/fased", version: "1.2.3", private: false },
        { name: "@fased/fased", version: "1.2.4", private: true },
        "package.json",
      ),
    ).toThrow(/non-version/);
  });

  it("accepts synchronized extension version and core peer fields", () => {
    expect(() =>
      assertPackageVersionOnlyChange(
        {
          name: "@fased/telegram",
          version: "1.2.3",
          peerDependencies: { "@fased/fased": "^1.2.3" },
        },
        {
          name: "@fased/telegram",
          version: "1.2.4",
          peerDependencies: { "@fased/fased": "^1.2.4" },
        },
        "extensions/telegram/package.json",
      ),
    ).not.toThrow();
  });

  it("rejects a partially restored release identity until every surface matches core", () => {
    const root = mkdtempSync(join(tmpdir(), "fased-version-inventory-"));
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "extensions", "example"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "@fased/fased", version: "1.2.3" })}\n`,
    );
    writeFileSync(join(root, "src", "brand.ts"), 'FASED_PRODUCT_VERSION = "1.2.3";\n');
    writeFileSync(
      join(root, "extensions", "example", "package.json"),
      `${JSON.stringify({ name: "@fased/example", version: "1.2.4" })}\n`,
    );

    expect(() => validateCurrentVersionInventory(root)).toThrow(/does not match core/u);

    writeFileSync(
      join(root, "extensions", "example", "package.json"),
      `${JSON.stringify({ name: "@fased/example", version: "1.2.3" })}\n`,
    );
    expect(validateCurrentVersionInventory(root)).toBe("1.2.3");
  });

  it("rejects source edits hidden beside the brand version", () => {
    expect(() =>
      assertBrandVersionOnlyChange(
        'export const FASED_PRODUCT_VERSION = "1.2.3";\nexport const name = "Fased";\n',
        'export const FASED_PRODUCT_VERSION = "1.2.4";\nexport const name = "Other";\n',
        "1.2.4",
      ),
    ).toThrow(/non-version/);
  });

  it("allows additive changelog entries but rejects rewritten history", () => {
    expect(
      isLineSubsequence("# Changelog\n\n## 1.2.3\n", "# Changelog\n\n## 1.2.4\n\n## 1.2.3\n"),
    ).toBe(true);
    expect(isLineSubsequence("# Changelog\n\n## 1.2.3\n", "# Changelog\n\n## 1.2.4\n")).toBe(false);
  });

  it("restores only the latest published ancestor after an untagged candidate", () => {
    const root = mkdtempSync(join(tmpdir(), "fased-version-restore-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
    git("init", "--quiet");
    git("config", "user.name", "Fased CI");
    git("config", "user.email", "ci@fased.invalid");
    writeFileSync(join(root, "version.txt"), "1.2.3\n");
    git("add", "version.txt");
    git("commit", "--quiet", "-m", "published base");
    git("tag", "v1.2.3");
    writeFileSync(join(root, "version.txt"), "1.2.4-rc.1\n");
    git("commit", "--quiet", "-am", "failed candidate");
    const base = git("rev-parse", "HEAD");

    expect(() =>
      assertLatestPublishedBaseRestore({
        base,
        previousVersion: "1.2.4-rc.1",
        repoRoot: root,
        version: "1.2.3",
      }),
    ).not.toThrow();

    git("tag", "v1.2.4-rc.1");
    expect(() =>
      assertLatestPublishedBaseRestore({
        base,
        previousVersion: "1.2.4-rc.1",
        repoRoot: root,
        version: "1.2.3",
      }),
    ).toThrow(/already tagged/u);

    expect(() =>
      assertLatestPublishedBaseRestore({
        allowObsoleteTaggedCandidate: true,
        base,
        previousVersion: "1.2.4-rc.1",
        releaseExists: (tag: string) => tag === "v1.2.3",
        repoRoot: root,
        version: "1.2.3",
      }),
    ).not.toThrow();

    expect(() =>
      assertLatestPublishedBaseRestore({
        allowObsoleteTaggedCandidate: true,
        base,
        previousVersion: "1.2.4-rc.1",
        releaseExists: () => true,
        repoRoot: root,
        version: "1.2.3",
      }),
    ).toThrow(/obsolete candidate is published/u);
  });
});
