import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { writeBundledPluginLock } from "./assemble-lifecycle-generation.mjs";
// Local package fixture, not installation or successor deployment acceptance.
assert(process.getuid?.() !== 0, "do not execute project code as root");
const argIndex = process.argv.indexOf("--root");
assert(argIndex >= 0 && process.argv[argIndex + 1], "--root requires a staged package directory");
const root = path.resolve(process.argv[argIndex + 1]);
const serviceVersion = JSON.parse(await fs.readFile(root + "/package.json", "utf8")).version;
assert(
  typeof serviceVersion === "string" && serviceVersion.trim() && serviceVersion !== "dev",
  "staged package requires a release version",
);
assert.equal(
  await fs.access(root + "/plugin.lock.json").then(
    () => true,
    () => false,
  ),
  false,
  "staged root already contains plugin.lock.json; preserve it",
);
const evidenceDirectory = await fs.mkdtemp("/tmp/wen-gateway-evidence-");
const state = await fs.mkdtemp("/tmp/wen-gateway-package-fixture-");
await writeBundledPluginLock(root);
await fs.copyFile(root + "/plugin.lock.json", state + "/plugin.lock.json");
await fs.rm(root + "/plugin.lock.json");
await fs.mkdir(state + "/plugin-code");
await fs.mkdir(state + "/plugin-data");
await fs.writeFile(
  state + "/fased.json",
  JSON.stringify({
    logging: { file: state + "/gateway.log" },
    gateway: {
      mode: "local",
      auth: { mode: "token", token: "local-package-fixture-token" },
      controlUi: { enabled: false },
      tailscale: { mode: "off" },
    },
    cron: { enabled: false },
    plugins: {
      allow: ["device-pair", "memory-core", "wen"],
      entries: { wen: { enabled: true } },
    },
  }),
);
await fs.writeFile(state + "/preservation-marker", "fixture-state-must-survive");
const hash = createHash("sha256");
async function hashTree(dir, rel = "") {
  for (const e of (await fs.readdir(dir, { withFileTypes: true })).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const r = rel + "/" + e.name;
    if (e.isDirectory()) {
      await hashTree(dir + "/" + e.name, r);
    } else if (e.isFile()) {
      hash.update(r + "\0");
      hash.update(
        createHash("sha256")
          .update(await fs.readFile(dir + "/" + e.name))
          .digest(),
      );
    } else if (e.isSymbolicLink()) {
      hash.update(r + "\0" + (await fs.readlink(dir + "/" + e.name)));
    }
  }
}
await hashTree(root);
const fixtureContentHash = "sha256:" + hash.digest("hex");
const runs = [];
try {
  for (let i = 0; i < 2; i++) {
    const reserve = net.createServer();
    await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
    const port = reserve.address().port;
    await new Promise((r) => reserve.close(r));
    const log = [];
    const start = performance.now();
    const child = spawn(
      process.execPath,
      [
        root + "/dist/entry.js",
        "gateway",
        "--allow-unconfigured",
        "--bind",
        "loopback",
        "--port",
        String(port),
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          LANG: "C.UTF-8",
          FASED_STATE_DIR: state,
          FASED_CONFIG_PATH: state + "/fased.json",
          FASED_MANAGED_INTERNAL: "1",
          FASED_SERVICE_VERSION: serviceVersion,
          FASED_GENERATION_ID: fixtureContentHash,
          FASED_PLUGIN_READINESS_PATH: state + "/plugin-readiness.json",
          FASED_PLUGIN_CODE_ROOT: state + "/plugin-code",
          FASED_PLUGIN_DATA_ROOT: state + "/plugin-data",
          FASED_PLUGIN_LOCK_PATH: state + "/plugin.lock.json",
          FASED_NO_RESPAWN: "1",
          FASED_TEST_RUNTIME_LOG: "1",
          FASED_SKIP_CHANNELS: "1",
          FASED_SKIP_GMAIL_WATCHER: "1",
          FASED_DISABLE_CONTROL_UI_AUTOBUILD: "1",
          NODE_DISABLE_COMPILE_CACHE: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (x) => log.push(String(x)));
    child.stderr.on("data", (x) => log.push(String(x)));
    let ready = false;
    try {
      while (performance.now() - start < 30000) {
        if (child.exitCode !== null) {
          throw Error("gateway exit " + child.exitCode + " " + log.join("").slice(-5000));
        }
        const connected = await new Promise((r) => {
          const s = net.createConnection({ host: "127.0.0.1", port });
          s.once("connect", () => {
            s.destroy();
            r(true);
          });
          s.once("error", () => r(false));
          s.setTimeout(150, () => {
            s.destroy();
            r(false);
          });
        });
        if (connected && /plugins\.load(?:\.deferred)?=\d+ms/.test(log.join(""))) {
          ready = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      assert(ready, "gateway readiness timeout: " + log.join("").slice(-5000));
      assert(!log.join("").includes("native preload failed"));
      assert(!log.join("").includes("could not write status cache"));
      const receipt = JSON.parse(await fs.readFile(state + "/plugin-readiness.json", "utf8"));
      assert.equal(receipt.generationId, fixtureContentHash);
      assert.equal(receipt.type, "fased-plugin-readiness");
      for (const id of ["memory-core", "wen"]) {
        assert.equal(
          receipt.entries.find((entry) => entry.id === id)?.status,
          "loaded",
          `required plugin ${id} did not load`,
        );
      }
      assert(receipt.entries.filter((e) => e.required).every((e) => e.status === "loaded"));
      const status = await fs.readFile("/proc/" + child.pid + "/status", "utf8");
      runs.push({
        readyMs: performance.now() - start,
        pluginLoadMs: Number(log.join("").match(/plugins\.load(?:\.deferred)?=(\d+)ms/)[1]),
        rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)[1]),
      });
    } finally {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      let timer;
      let forced = false;
      try {
        await Promise.race([
          exited,
          new Promise((resolve) => {
            timer = setTimeout(() => {
              forced = true;
              child.kill("SIGKILL");
              resolve();
            }, 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      await fs.writeFile(evidenceDirectory + "/gateway-run-" + i + ".log", log.join(""));
      assert(!forced, "gateway required forced shutdown");
    }
    assert(log.join("").includes("all accepted tasks drained"), "drain acknowledgement missing");
    assert.equal(
      await fs.readFile(state + "/preservation-marker", "utf8"),
      "fixture-state-must-survive",
    );
  }
  console.log(
    JSON.stringify({
      status: "PASS",
      fixtureContentHash,
      evidenceDirectory,
      runs,
      scope:
        "local empty-state packaged gateway startup/restart fixture; channels disabled, no operational signer, mining or installed acceptance",
    }),
  );
} finally {
  await fs.rm(state, { recursive: true, force: true });
}
