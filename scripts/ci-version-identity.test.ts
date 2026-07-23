import { describe, expect, it } from "vitest";
import {
  assertBrandVersionOnlyChange,
  assertPackageVersionOnlyChange,
  isLineSubsequence,
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
});
