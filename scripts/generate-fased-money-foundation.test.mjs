import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = (file) =>
  createHash("sha256")
    .update(fs.readFileSync(path.join(root, file)))
    .digest("hex");

void test("Fased pins exact Agent-protocol and Satcoin money-foundation sources", () => {
  const source = JSON.parse(
    fs.readFileSync(
      path.join(root, "src/agents/protocol-generation/money-foundation.v1.source.json"),
      "utf8",
    ),
  );
  assert.equal(source.schema, "fased.money-foundation-source.v1");
  assert.equal(source.agentProtocol.repository, "fased-ai/agent-protocol");
  assert.equal(source.satcoin.repository, "satcoin-org/sat");
  assert.equal(
    source.agentProtocol.contractSha256,
    digest("src/agents/protocol-generation/sat-sol-money-foundation.v1.json"),
  );
  assert.equal(
    source.agentProtocol.schemaSha256,
    digest("src/agents/protocol-generation/sat-sol-money-foundation.v1.schema.json"),
  );
  assert.equal(
    source.agentProtocol.generatedTypeScriptSha256,
    digest("src/agents/fased-sat-sol-money-foundation.generated.ts"),
  );
  assert.equal(
    source.agentProtocol.fixtureBundleSha256,
    digest("src/agents/protocol-generation/sat-sol-money-foundation.v1.fixtures.json"),
  );
  assert.equal(
    source.agentProtocol.capitalInterfaceSha256,
    digest("src/agents/protocol-generation/fased-agent-capital-interface.v1.json"),
  );
  for (const [file, expected] of Object.entries(source.satcoin.bondLayoutSha256)) {
    assert.equal(expected, digest(`token/sat/bond-api/${file}`));
  }
});
