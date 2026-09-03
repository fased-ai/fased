#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "oxfmt";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = path.join(
  root,
  "src",
  "agents",
  "protocol-generation",
  "fased-agent-identity-interface.v1.json",
);
const generatedPath = path.join(
  root,
  "src",
  "agents",
  "fased-agent-identity-contract.generated.ts",
);
const goPath = path.join(root, "tools", "fased-signerd", "agent_identity_contract_generated.go");
const supportedAgentProgramId = "FasEdZ9BAsboUPF2TUQjLaapC8arcAkV5fRnMtV2G1Ev"; // pragma: allowlist secret
const importMode = process.argv.includes("--import");
const checkMode = process.argv.includes("--check");
const agentRootIndex = process.argv.indexOf("--agent-root");
const agentRoot = agentRootIndex >= 0 ? path.resolve(process.argv[agentRootIndex + 1] ?? "") : null;
const commitIndex = process.argv.indexOf("--source-commit");
const sourceCommit = commitIndex >= 0 ? (process.argv[commitIndex + 1] ?? "") : "";
const treeIndex = process.argv.indexOf("--source-tree");
const sourceTree = treeIndex >= 0 ? (process.argv[treeIndex + 1] ?? "") : "";

if (importMode === checkMode) {
  throw new Error("use exactly one mode: --import --agent-root <path> or --check");
}
if (importMode && (!agentRoot || !sourceCommit || !sourceTree)) {
  throw new Error(
    "--import requires --agent-root <canonical-agent-protocol-checkout> --source-commit <sha> --source-tree <sha>",
  );
}

function dataSize(args) {
  return (
    8 +
    args.reduce((size, arg) => {
      if (arg.type === "u64" || arg.type === "i64") {
        return size + 8;
      }
      if (arg.type === "u32") {
        return size + 4;
      }
      if (arg.type === "u16") {
        return size + 2;
      }
      if (arg.type === "u8") {
        return size + 1;
      }
      if (arg.type === "pubkey") {
        return size + 32;
      }
      if (typeof arg.type === "object" && Array.isArray(arg.type.array)) {
        const [item, count] = arg.type.array;
        if (item === "u8" && Number.isInteger(count)) {
          return size + count;
        }
      }
      return Number.NaN;
    }, 0)
  );
}

function fail(message) {
  throw new Error(`Fased Agent identity interface: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function exactNames(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} changed`);
  }
}

function constant(source, name, pattern) {
  const match = pattern.exec(source);
  if (!match) {
    fail(`cannot derive ${name}`);
  }
  return match[1];
}

function buildContract(sourceRoot) {
  const idlPath = path.join(sourceRoot, "idl", "fased_agent_identity.json");
  const constantsPath = path.join(
    sourceRoot,
    "programs",
    "fased-agent-identity",
    "src",
    "constants.rs",
  );
  const idlBytes = fs.readFileSync(idlPath);
  const idl = JSON.parse(idlBytes);
  const constants = fs.readFileSync(constantsPath, "utf8");
  const instructions = idl.instructions.map((entry) => entry.name);
  exactNames(
    instructions,
    [
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
    ],
    "instruction surface",
  );

  const accountByName = new Map(idl.accounts.map((entry) => [entry.name, entry]));
  const typeByName = new Map(idl.types.map((entry) => [entry.name, entry]));
  const discriminator = (name) => {
    const value = accountByName.get(name)?.discriminator;
    if (!Array.isArray(value) || value.length !== 8) {
      fail(`${name} discriminator is invalid`);
    }
    return value;
  };
  const fields = (name) => {
    const value = typeByName.get(name)?.type?.fields;
    if (!Array.isArray(value)) {
      fail(`${name} fields are unavailable`);
    }
    return value;
  };
  const fieldNames = (name) => fields(name).map((entry) => entry.name);
  const fieldSignatures = (name) =>
    fields(name).map(
      (entry) =>
        `${entry.name}:${typeof entry.type === "string" ? entry.type : JSON.stringify(entry.type)}`,
    );
  const generatedSize = (fileName, functionName) => {
    const generated = fs.readFileSync(
      path.join(sourceRoot, "clients", "js", "src", "generated", "accounts", fileName),
      "utf8",
    );
    return Number(
      constant(
        generated,
        `${functionName} generated size`,
        new RegExp(`function ${functionName}\\(\\): number \\{\\s*return (\\d+);`, "u"),
      ),
    );
  };

  exactNames(
    fieldNames("FasedAgentRecord"),
    [
      "version",
      "status",
      "bump",
      "authority_generation",
      "created_slot",
      "created_unix_timestamp",
      "founding_controller",
      "controller",
      "recovery_authority",
      "pending_controller",
      "pending_controller_generation",
      "pending_recovery_authority",
      "pending_recovery_generation",
      "pending_recovery_not_before_unix_timestamp",
    ],
    "FasedAgentRecord layout",
  );
  exactNames(
    fieldNames("AgentNamespaceBinding"),
    [
      "version",
      "bump",
      "fased_agent_record",
      "network_agent_id",
      "name",
      "handle",
      "ticker",
      "reservation_nonce",
      "reservation_issued_at",
      "reservation_expires_at",
      "bound_slot",
      "bound_unix_timestamp",
      "record_authority_generation",
      "namespace_config_generation",
    ],
    "AgentNamespaceBinding layout",
  );
  exactNames(
    fieldNames("AgentMiningBinding"),
    [
      "version",
      "bump",
      "fased_agent_record",
      "sat_agent_record",
      "satcoin_program_id",
      "permanent_mining_id",
      "fased_controller_at_binding",
      "mining_controller_at_binding",
      "fased_authority_generation",
      "mining_authority_generation",
      "bound_slot",
      "bound_unix_timestamp",
    ],
    "AgentMiningBinding layout",
  );
  exactNames(
    fieldSignatures("FasedAgentRecord"),
    [
      "version:u8",
      'status:{"defined":{"name":"AgentRecordStatus"}}',
      "bump:u8",
      "authority_generation:u64",
      "created_slot:u64",
      "created_unix_timestamp:i64",
      "founding_controller:pubkey",
      "controller:pubkey",
      "recovery_authority:pubkey",
      "pending_controller:pubkey",
      "pending_controller_generation:u64",
      "pending_recovery_authority:pubkey",
      "pending_recovery_generation:u64",
      "pending_recovery_not_before_unix_timestamp:i64",
    ],
    "FasedAgentRecord field types",
  );
  exactNames(
    fieldSignatures("AgentNamespaceBinding"),
    [
      "version:u8",
      "bump:u8",
      "fased_agent_record:pubkey",
      'network_agent_id:{"array":["u8",32]}',
      "name:string",
      "handle:string",
      "ticker:string",
      'reservation_nonce:{"array":["u8",32]}',
      "reservation_issued_at:i64",
      "reservation_expires_at:i64",
      "bound_slot:u64",
      "bound_unix_timestamp:i64",
      "record_authority_generation:u64",
      "namespace_config_generation:u64",
    ],
    "AgentNamespaceBinding field types",
  );
  exactNames(
    fieldSignatures("AgentMiningBinding"),
    [
      "version:u8",
      "bump:u8",
      "fased_agent_record:pubkey",
      "sat_agent_record:pubkey",
      "satcoin_program_id:pubkey",
      "permanent_mining_id:pubkey",
      "fased_controller_at_binding:pubkey",
      "mining_controller_at_binding:pubkey",
      "fased_authority_generation:u64",
      "mining_authority_generation:u64",
      "bound_slot:u64",
      "bound_unix_timestamp:i64",
    ],
    "AgentMiningBinding field types",
  );

  return {
    $schema: "fased.agent-identity-interface.v1",
    source: {
      repository: idl.metadata?.repository,
      commit: sourceCommit,
      tree: sourceTree,
      idlSha256: `sha256:${sha256(idlBytes)}`,
    },
    programId: idl.address,
    accounts: {
      fasedAgentRecord: {
        discriminator: discriminator("FasedAgentRecord"),
        version: Number(
          constant(constants, "record version", /FASED_AGENT_RECORD_VERSION: u8 = (\d+);/u),
        ),
        size: generatedSize("fasedAgentRecord.ts", "getFasedAgentRecordSize"),
        seed: constant(constants, "record seed", /FASED_AGENT_RECORD_SEED: &\[u8\] = b"([^"]+)";/u),
      },
      namespaceBinding: {
        discriminator: discriminator("AgentNamespaceBinding"),
        version: Number(
          constant(constants, "namespace version", /NAMESPACE_BINDING_VERSION: u8 = (\d+);/u),
        ),
        seed: constant(
          constants,
          "namespace seed",
          /NAMESPACE_BINDING_SEED: &\[u8\] = b"([^"]+)";/u,
        ),
        maxNameBytes: Number(
          constant(constants, "name bound", /NAMESPACE_NAME_MAX_BYTES: usize = (\d+);/u),
        ),
        maxHandleBytes: Number(
          constant(constants, "handle bound", /NAMESPACE_HANDLE_MAX_BYTES: usize = (\d+);/u),
        ),
        maxTickerBytes: Number(
          constant(constants, "ticker bound", /NAMESPACE_TICKER_MAX_BYTES: usize = (\d+);/u),
        ),
      },
      miningBinding: {
        discriminator: discriminator("AgentMiningBinding"),
        version: Number(
          constant(
            constants,
            "mining binding version",
            /AGENT_MINING_BINDING_VERSION: u8 = (\d+);/u,
          ),
        ),
        size: generatedSize("agentMiningBinding.ts", "getAgentMiningBindingSize"),
        seed: constant(
          constants,
          "mining binding seed",
          /AGENT_MINING_BINDING_SEED: &\[u8\] = b"([^"]+)";/u,
        ),
      },
    },
    approvedSatcoinPrograms: [
      constant(
        constants,
        "Devnet Satcoin program",
        /SATCOIN_DEVNET_MINING_PROGRAM: Pubkey =\s*pubkey!\("([^"]+)"\);/u,
      ),
      constant(
        constants,
        "Mainnet Satcoin program",
        /SATCOIN_MAINNET_MINING_PROGRAM: Pubkey =\s*pubkey!\("([^"]+)"\);/u,
      ),
    ],
    recoveryRotationDelaySeconds:
      Number(
        constant(
          constants,
          "recovery delay",
          /RECOVERY_ROTATION_DELAY_SECONDS: i64 = (\d+) \* 60 \* 60;/u,
        ),
      ) *
      60 *
      60,
    instructions: idl.instructions.map((entry) => ({
      action: entry.name,
      discriminator: entry.discriminator,
      dataSize: Number.isNaN(dataSize(entry.args)) ? null : dataSize(entry.args),
      args: entry.args,
      accounts: entry.accounts.map((account) => ({
        name: account.name,
        signer: account.signer === true,
        writable: account.writable === true,
        ...(account.address ? { address: account.address } : {}),
      })),
    })),
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function update(filePath, expected) {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  if (current === expected) {
    return;
  }
  if (checkMode) {
    fail(`${path.relative(root, filePath)} is stale`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, expected);
}

const imported = agentRoot ? buildContract(agentRoot) : null;
if (importMode) {
  const importedJson = await format("fased-agent-identity-interface.v1.json", stableJson(imported));
  update(contractPath, importedJson.code);
}
const contract = readJson(contractPath);
if (imported && stableJson(contract) !== stableJson(imported)) {
  fail("bundled contract differs from canonical Agent protocol source");
}
const bundledJson = await format("fased-agent-identity-interface.v1.json", stableJson(contract));
update(contractPath, bundledJson.code);
if (
  contract.$schema !== "fased.agent-identity-interface.v1" ||
  contract.programId !== supportedAgentProgramId ||
  contract.accounts.fasedAgentRecord.size !== 219 ||
  contract.accounts.miningBinding.size !== 234 ||
  contract.accounts.namespaceBinding.maxNameBytes !== 20 ||
  contract.accounts.namespaceBinding.maxHandleBytes !== 21 ||
  contract.accounts.namespaceBinding.maxTickerBytes !== 6 ||
  contract.recoveryRotationDelaySeconds !== 172800
) {
  fail("bundled contract is incomplete or unsupported");
}

const generatedContract = JSON.stringify(contract, null, 2)
  .replace(
    /^(\s+"(?:commit|tree|idlSha256|programId)": "[^"]+"[,]?)$/gmu,
    "$1 // pragma: allowlist secret",
  )
  .replace(
    /^(\s+"(?:H79sGVMLFSHX14rAj7gBxNS31V1984Br3d6PZKP4jNhF|DUWcfXrUu2nK6fBJ4VjcnGmkBa62BNBEm4LDo25ppNBT)"[,]?)$/gmu,
    "$1 // pragma: allowlist secret",
  )
  .replace(/^(\s+"address": "[^"]+"[,]?)$/gmu, "$1 // pragma: allowlist secret");
const generated =
  `// Code generated by scripts/generate-fased-agent-identity-interface.mjs; DO NOT EDIT.\n\n` +
  `export const FASED_AGENT_IDENTITY_CONTRACT = ${generatedContract} as const;\n\n` +
  `export const FASED_AGENT_IDENTITY_PROGRAM_ID = FASED_AGENT_IDENTITY_CONTRACT.programId;\n` +
  `export const FASED_AGENT_RECORD_LAYOUT = FASED_AGENT_IDENTITY_CONTRACT.accounts.fasedAgentRecord;\n` +
  `export const FASED_AGENT_NAMESPACE_LAYOUT = FASED_AGENT_IDENTITY_CONTRACT.accounts.namespaceBinding;\n` +
  `export const FASED_AGENT_MINING_LAYOUT = FASED_AGENT_IDENTITY_CONTRACT.accounts.miningBinding;\n` +
  `export const FASED_AGENT_APPROVED_SATCOIN_PROGRAM_IDS = new Set<string>(\n` +
  `  FASED_AGENT_IDENTITY_CONTRACT.approvedSatcoinPrograms,\n` +
  `);\n`;
const formatted = await format("fased-agent-identity-contract.generated.ts", generated);
update(generatedPath, formatted.code);

const rows = contract.instructions
  .map((instruction) => {
    const accounts = instruction.accounts
      .map(
        (account) =>
          `{Name: ${JSON.stringify(account.name)}, IsSigner: ${account.signer}, IsWritable: ${account.writable}, Address: ${JSON.stringify(account.address ?? "")}}`,
      )
      .join(", ");
    return `${JSON.stringify(instruction.action)}: {Discriminator: [8]byte{${instruction.discriminator.join(", ")}}, DataSize: ${instruction.dataSize ?? -1}, Accounts: []agentIdentityAccountContractV1{${accounts}}}, // pragma: allowlist secret`;
  })
  .join("\n\t");
const goSource = `// Code generated by scripts/generate-fased-agent-identity-interface.mjs; DO NOT EDIT.\npackage main\n\nconst agentIdentityProgramIDV1 = ${JSON.stringify(contract.programId)} // pragma: allowlist secret\n\ntype agentIdentityAccountContractV1 struct { Name string; IsSigner bool; IsWritable bool; Address string }\ntype agentIdentityInstructionContractV1 struct { Discriminator [8]byte; DataSize int; Accounts []agentIdentityAccountContractV1 }\n\nvar agentIdentityInstructionContractsV1 = map[string]agentIdentityInstructionContractV1{\n\t${rows}\n}\n`;
const formattedGo = execFileSync("gofmt", { input: goSource, encoding: "utf8" });
update(goPath, formattedGo);
