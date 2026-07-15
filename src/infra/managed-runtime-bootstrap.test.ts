import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveManagedPrefixForPackageRoot } from "./managed-runtime-bootstrap.js";

describe("managed runtime bootstrap", () => {
  it("derives the installer-owned prefix without consulting cwd", () => {
    expect(
      resolveManagedPrefixForPackageRoot(
        "/home/app/.fased/install-cache/npm-global/lib/node_modules/@fased/fased",
      ),
    ).toBe("/home/app/.fased/install-cache/npm-global");
  });

  it("does not migrate source checkouts or unrelated global packages", () => {
    expect(resolveManagedPrefixForPackageRoot("/home/app/fased")).toBeNull();
    expect(
      resolveManagedPrefixForPackageRoot(path.resolve("node_modules/@fased/fased")),
    ).toBeNull();
  });
});
