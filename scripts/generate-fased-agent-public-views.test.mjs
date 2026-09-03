import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

void test("Fased pins one exact generated public Agent view contract", () => {
  const source = JSON.parse(
    fs.readFileSync(
      path.join(root, "src/agents/protocol-generation/public-agent-views.v1.source.json"),
      "utf8",
    ),
  );
  assert.equal(source.repository, "fased-ai/agent-protocol");
  assert.deepEqual(source.publicViews, [
    "AgentEvidenceRef",
    "AgentIdentityView",
    "AgentMiningView",
    "AgentQualificationView",
  ]);
  const contractBytes = fs.readFileSync(
    path.join(root, "src/agents/protocol-generation/public-agent-views.v1.json"),
  );
  const generatedBytes = fs.readFileSync(
    path.join(root, "src/agents/fased-agent-public-views.generated.ts"),
  );
  const fixtureBundleBytes = fs.readFileSync(
    path.join(root, "src/agents/protocol-generation/public-agent-views.v1.fixtures.json"),
  );
  const fixtureBundle = JSON.parse(fixtureBundleBytes.toString("utf8"));
  assert.equal(createHash("sha256").update(contractBytes).digest("hex"), source.contractSha256);
  assert.match(source.upstreamGeneratedTypeScriptSha256, /^[0-9a-f]{64}$/u);
  assert.equal(
    createHash("sha256").update(generatedBytes).digest("hex"),
    source.generatedTypeScriptSha256,
  );
  assert.equal(
    createHash("sha256").update(fixtureBundleBytes).digest("hex"),
    source.fixtureBundleSha256,
  );
  assert.equal(fixtureBundle.sourceCommit, source.commit);
  assert.equal(fixtureBundle.valid.length, source.validFixtureCount);
  assert.equal(fixtureBundle.invalid.length, source.invalidFixtureCount);
  assert.ok(source.validFixtureCount >= 10);
  assert.ok(source.invalidFixtureCount >= 5);
});
