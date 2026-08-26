import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

void test("Fased binds inactive 16-channel codecs while active legacy mining stays 25-channel", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/generate-sat-vnext-interface.mjs", "--check"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const generated = fs.readFileSync(
    path.join(root, "extensions/sat-mining/src/vnext-interface-manifest.ts"),
    "utf8",
  );
  assert.match(generated, /state: "FROZEN_NOT_ACTIVE"/u);
  assert.match(generated, /active: false/u);
  assert.match(generated, /strategyChannels: 16/u);
  assert.match(generated, /legacyStrategyChannels: 25/u);
  assert.match(generated, /revealDataLength: 105/u);

  const active = fs.readFileSync(
    path.join(root, "extensions/sat-mining/src/protocol-contract.ts"),
    "utf8",
  );
  assert.match(active, /allocationBuckets: 25/u);
  const activeSigner = fs.readFileSync(
    path.join(root, "extensions/sat-mining/src/signer-codec-manifest.ts"),
    "utf8",
  );
  assert.match(activeSigner, /action: "revealCycle"[\s\S]*?dataLength: 145/u);
  assert.doesNotMatch(activeSigner, /action: "revealCycleV2"/u);
});
