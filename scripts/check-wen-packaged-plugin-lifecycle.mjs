import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
// Package fixture only: no configured wallet, public RPC or gateway process.
const index = process.argv.indexOf("--root");
assert(index >= 0 && process.argv[index + 1], "--root requires the staged package directory");
const root = path.resolve(process.argv[index + 1]);
const pluginLoader = createJiti(import.meta.url, {
  interopDefault: false,
  extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"],
  alias: {
    "fased/plugin-sdk": root + "/dist/plugin-sdk/index.js",
    "fased/plugin-sdk/sat-runtime": root + "/dist/plugin-sdk/sat-runtime.js",
  },
});
const { default: mining, shouldActivateMining } = await pluginLoader.import(
  root + "/extensions/sat-mining/index.ts",
);
const { default: memory } = await pluginLoader.import(root + "/extensions/memory-core/index.ts");
const { SAT_MINING_GATEWAY_METHODS } = await import(
  pathToFileURL(root + "/dist/plugin-sdk/sat-runtime.js")
);
// Keep the acceptance list independent of the implementation's WEN constants:
// dropping a route or changing its scope must fail this packaged check.
const wenMethods = [
  "wen.mining.review.refresh",
  "wen.mining.claim.refresh",
  "wen.economy.read",
  "wen.acquisition.handoff",
  "wen.mining.approval.prepare",
  "wen.mining.approval.begin",
  "wen.mining.approval.finish",
  "wen.mining.approval.cancel",
  "wen.mining.approval.execute",
  "wen.mining.approval.recover",
  "wen.campaign.approval.prepare",
  "wen.campaign.approval.begin",
  "wen.campaign.approval.finish",
  "wen.campaign.approval.cancel",
  "wen.campaign.approval.execute",
  "wen.campaign.approval.recover",
  "wen.campaign.approval.selection",
];
const readWenMethods = new Set(["wen.economy.read", "wen.acquisition.handoff"]);
const stateDir = await fs.mkdtemp("/tmp/wen-plugin-registration-");
try {
  const methods = new Map(),
    services = [],
    logs = [];
  let commands = 0;
  const toolNames = [];
  const api = {
    pluginConfig: undefined,
    registerGatewayMethod(name, handler, options) {
      assert(!methods.has(name));
      if (wenMethods.includes(name)) {
        assert.equal(
          options?.scope,
          readWenMethods.has(name) ? "operator.read" : "operator.admin",
          `${name} has the wrong scope`,
        );
      }
      methods.set(name, handler);
    },
    registerService(s) {
      services.push(s);
    },
    registerCommand() {
      commands++;
    },
    registerTool(tool) {
      toolNames.push(tool.name);
    },
    logger: {
      info(s) {
        logs.push(s);
      },
    },
  };
  mining.register(api);
  assert.deepEqual([...methods.keys()], [...SAT_MINING_GATEWAY_METHODS, ...wenMethods]);
  assert.equal(services.length, 1);
  assert.equal(services[0].id, "sat-mining");
  assert.deepEqual(toolNames, ["wen_economy_facts", "wen_acquisition_request"]);
  const context = { stateDir };
  assert.equal(await shouldActivateMining(api, context), false);
  for (let i = 0; i < 2; i++) {
    await services[0].start(context);
    await services[0].checkpointForLifecycle(context);
    await services[0].stop(context);
  }
  assert.equal(commands, 0);
  assert.deepEqual(toolNames, ["wen_economy_facts", "wen_acquisition_request"]);
  assert.equal(logs.length, 2);
  assert.equal(await shouldActivateMining({ pluginConfig: { enabled: true } }, context), true);
  await fs.mkdir(path.join(stateDir, "wallet"));
  await fs.writeFile(path.join(stateDir, "wallet/provider-registry.v1.json"), "{}");
  assert.equal(await shouldActivateMining(api, context), false);
  await fs.rm(path.join(stateDir, "wallet"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "sat-mining/wallets/test"), { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "sat-mining/wallets/test/mining.sqlite"),
    "detection fixture only",
  );
  assert.equal(await shouldActivateMining(api, context), true);
  let toolFactory, cliFactory;
  memory.register({
    registerTool(fn) {
      toolFactory = fn;
    },
    registerCli(fn) {
      cliFactory = fn;
    },
    runtime: {
      tools: {
        createMemorySearchTool() {
          return null;
        },
        createMemoryGetTool() {
          return null;
        },
        registerMemoryCli() {},
      },
    },
  });
  assert.equal(typeof toolFactory, "function");
  assert.equal(typeof cliFactory, "function");
  assert.equal(toolFactory({}), null);
  console.log(
    JSON.stringify({
      status: "PASS",
      gatewayMethods: methods.size,
      adminWenMethods: wenMethods.length - readWenMethods.size,
      readWenMethods: readWenMethods.size,
      acquisitionTools: toolNames.length,
      dormantStartCheckpointStopCycles: 2,
      recoveryTriggers: ["configuration", "mining database presence"],
      memoryRegistration: true,
      scope:
        "packaged registration and dormant lifecycle fixture; no operational mining, database replay, gateway startup or installed acceptance",
    }),
  );
} finally {
  await fs.rm(stateDir, { recursive: true, force: true });
}
