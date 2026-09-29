import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

// Lock compatibility only; this does not authenticate installed package bytes.
export function checkStagedDependencyLocks(source, staged) {
  const current = source.importers?.["."];
  const candidate = staged.importers?.["."];
  assert(current && candidate, "root lock importers required");
  let productionDependencies = 0;
  for (const field of ["dependencies", "optionalDependencies"]) {
    const versions = (input) =>
      Object.fromEntries(Object.entries(input ?? {}).map(([key, value]) => [key, value.version]));
    assert.deepEqual(
      versions(candidate[field]),
      versions(current[field]),
      `${field} resolution drift`,
    );
    for (const value of Object.values(current[field] ?? {})) {
      assert(typeof value.version === "string", "missing dependency resolution");
      assert(
        !/^(file:|link:|workspace:)/.test(value.version),
        "local root dependency needs separate binding",
      );
      productionDependencies++;
    }
  }
  const counts = {};
  const localWorkspaceRecords = [];
  for (const field of ["packages", "snapshots"]) {
    assert(source[field] && staged[field], `${field} required`);
    counts[field] = 0;
    for (const [key, value] of Object.entries(staged[field])) {
      if (key.includes("@file:") || key.includes("@link:")) {
        localWorkspaceRecords.push(`${field}:${key}`);
        continue;
      }
      assert.deepEqual(value, source[field][key], `${field} drift: ${key}`);
      counts[field]++;
    }
    assert(counts[field] > 0, `empty registry ${field}`);
  }
  return {
    status: "PASS",
    scope: "resolved production importer and staged registry lock compatibility only",
    productionDependencies,
    registryRecords: counts,
    localWorkspaceRecords,
    installedBytesVerified: false,
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, staged] = process.argv.slice(2);
  assert(source && staged, "usage: check-wen-staged-dependencies.mjs <source-lock> <staged-lock>");
  console.log(
    JSON.stringify(
      checkStagedDependencyLocks(
        YAML.parse(fs.readFileSync(source, "utf8")),
        YAML.parse(fs.readFileSync(staged, "utf8")),
      ),
      null,
      2,
    ),
  );
}
