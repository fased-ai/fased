import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateCurrentVersionInventory } from "./ci-version-identity.mjs";

function fixture(version = "1.2.3") {
  const root = mkdtempSync(join(tmpdir(), "fased-version-inventory-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "extensions", "example"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "@fased/fased", version })}\n`,
  );
  writeFileSync(join(root, "src", "brand.ts"), `FASED_PRODUCT_VERSION = "${version}";\n`);
  writeFileSync(
    join(root, "extensions", "example", "package.json"),
    `${JSON.stringify({
      name: "@fased/example",
      peerDependencies: { "@fased/fased": `^${version}` },
      version,
    })}\n`,
  );
  return root;
}

describe("release version inventory", () => {
  it("accepts one synchronized core and extension identity", () => {
    expect(validateCurrentVersionInventory(fixture())).toBe("1.2.3");
  });

  it("accepts the synchronized rc.148 beta-candidate identity", () => {
    expect(validateCurrentVersionInventory(fixture("0.1.76-rc.149"))).toBe("0.1.76-rc.149");
  });

  it("rejects mismatched extension identity", () => {
    const root = fixture();
    writeFileSync(
      join(root, "extensions", "example", "package.json"),
      `${JSON.stringify({ name: "@fased/example", version: "1.2.4" })}\n`,
    );
    expect(() => validateCurrentVersionInventory(root)).toThrow(/does not match core/u);
  });

  it("rejects a stale core peer range even when the extension version is current", () => {
    const root = fixture();
    writeFileSync(
      join(root, "extensions", "example", "package.json"),
      `${JSON.stringify({
        name: "@fased/example",
        peerDependencies: { "@fased/fased": "^1.2.2" },
        version: "1.2.3",
      })}\n`,
    );
    expect(() => validateCurrentVersionInventory(root)).toThrow(/core peer/u);
  });

  it("rejects mismatched brand identity", () => {
    const root = fixture();
    writeFileSync(join(root, "src", "brand.ts"), 'FASED_PRODUCT_VERSION = "1.2.4";\n');
    expect(() => validateCurrentVersionInventory(root)).toThrow(/brand version/u);
  });
});
