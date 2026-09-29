import assert from "node:assert/strict";
import { test } from "node:test";
import { checkStagedDependencyLocks } from "./check-wen-staged-dependencies.mjs";
const fixture = () => ({
  importers: { ".": { dependencies: { x: { specifier: "^1.0.0", version: "1.0.0" } } } },
  packages: { "x@1.0.0": { resolution: { integrity: "sha512-fixture" } } },
  snapshots: { "x@1.0.0": {} },
});
void test("accepts deployment specifier normalization and reports scope", () => {
  const a = fixture(),
    b = fixture();
  b.importers["."].dependencies.x.specifier = "1.0.0";
  b.packages["@fased/plugin@file:/fixture"] = {};
  b.snapshots["@fased/plugin@file:/fixture"] = {};
  const result = checkStagedDependencyLocks(a, b);
  assert.equal(result.status, "PASS");
  assert.equal(result.installedBytesVerified, false);
  assert.equal(result.localWorkspaceRecords.length, 2);
});
for (const [name, change] of [
  [
    "version drift",
    (b) => {
      b.importers["."].dependencies.x.version = "2.0.0";
    },
  ],
  [
    "missing dependency",
    (b) => {
      delete b.importers["."].dependencies.x;
    },
  ],
  [
    "integrity drift",
    (b) => {
      b.packages["x@1.0.0"].resolution.integrity = "changed";
    },
  ],
  [
    "snapshot drift",
    (b) => {
      b.snapshots["x@1.0.0"].dependencies = { y: "2.0.0" };
    },
  ],
  [
    "unknown registry record",
    (b) => {
      b.snapshots["z@1.0.0"] = {};
    },
  ],
  [
    "empty registry",
    (b) => {
      b.packages = {};
    },
  ],
]) {
  void test(`rejects ${String(name)}`, () => {
    const a = fixture(),
      b = fixture();
    change(b);
    assert.throws(() => checkStagedDependencyLocks(a, b));
  });
}
