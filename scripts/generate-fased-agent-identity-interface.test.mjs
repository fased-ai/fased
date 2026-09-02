import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

void test("Fased consumes one generated Agent identity contract", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/generate-fased-agent-identity-interface.mjs", "--check"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const contract = JSON.parse(
    fs.readFileSync(
      path.join(root, "src/agents/protocol-generation/fased-agent-identity-interface.v1.json"),
      "utf8",
    ),
  );
  assert.equal(contract.$schema, "fased.agent-identity-interface.v1");
  assert.equal(contract.source.repository, "https://github.com/fased-ai/agent-protocol");
  assert.match(contract.source.commit, /^[0-9a-f]{40}$/u);
  assert.match(contract.source.tree, /^[0-9a-f]{40}$/u);
  assert.match(contract.source.idlSha256, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(contract.accounts.fasedAgentRecord.size, 219);
  assert.equal(contract.accounts.miningBinding.size, 234);
  assert.equal(contract.accounts.namespaceBinding.maxNameBytes, 20);
  assert.equal(contract.accounts.namespaceBinding.maxHandleBytes, 21);
  assert.equal(contract.accounts.namespaceBinding.maxTickerBytes, 6);
  assert.equal(contract.recoveryRotationDelaySeconds, 48 * 60 * 60);
  assert.deepEqual(contract.instructions, [
    "accept_controller_transfer",
    "accept_recovery_rotation",
    "bind_agent_mining",
    "bind_agent_namespace",
    "cancel_controller_transfer",
    "cancel_recovery_rotation",
    "create_fased_agent_record",
    "initialize_namespace_config",
    "propose_controller_transfer",
    "propose_recovery_rotation",
    "recover_controller",
    "set_namespace_authority",
  ]);

  const generated = fs.readFileSync(
    path.join(root, "src/agents/fased-agent-identity-contract.generated.ts"),
    "utf8",
  );
  assert.equal(generated.match(/pragma: allowlist secret/gu)?.length, 6);

  const preCommit = fs.readFileSync(path.join(root, ".pre-commit-config.yaml"), "utf8");
  assert.match(
    preCommit,
    /src\/agents\/protocol-generation\/fased-agent-identity-interface\\\.v1\\\.json/u,
  );

  const readback = fs.readFileSync(
    path.join(root, "src/agents/financial-agent-readback.ts"),
    "utf8",
  );
  assert.match(readback, /fased-agent-identity-contract\.generated\.js/u);
  assert.doesNotMatch(readback, /const FASED_AGENT_RECORD_SIZE/u);
  assert.doesNotMatch(readback, /const APPROVED_SATCOIN_PROGRAM_IDS/u);
});
