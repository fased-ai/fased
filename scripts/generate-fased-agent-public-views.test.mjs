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
  assert.equal(createHash("sha256").update(contractBytes).digest("hex"), source.contractSha256);
  assert.match(source.upstreamGeneratedTypeScriptSha256, /^[0-9a-f]{64}$/u);
  assert.equal(
    createHash("sha256").update(generatedBytes).digest("hex"),
    source.generatedTypeScriptSha256,
  );
});
