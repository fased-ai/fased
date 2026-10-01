import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const index = process.argv.indexOf("--dist");
assert(index >= 0 && process.argv[index + 1], "--dist requires a built output directory");
const dist = path.resolve(process.argv[index + 1]);
const importCorePlugins = process.argv.includes("--import-core-plugins");
assert(
  !importCorePlugins || process.argv.includes("--import-runtime"),
  "--import-core-plugins requires --import-runtime",
);
const required = [
  "wallet/wen-market-review-contract.js",
  "wallet/wen-bond-purchase-review-contract.js",
  "wallet/wen-bond-claim-review-contract.js",
  "wallet/wen-campaign-review-contract.js",
  "wallet/wen-mining-preparation.js",
  "wallet/wen-btc-claim-preparation.js",
  "wallet/wen-btc-claim-preparation-contract.js",
  "wallet/wen-native-claim-preparation.js",
  "wallet/wen-native-claim-preparation-contract.js",
  "wallet/wen-withdrawal-preparation.js",
  "wallet/wen-mining-recovery-profile.js",
  "wallet/wen-claim-journey-contract.js",
  "wallet/wen-btc-preparation.js",
  "wallet/wen-btc-inspection.js",
  "wallet/wen-btc-route-preview.js",
  "wallet/external-submission-ledger.js",
  "tasks/task-ledger-store.js",
  "memory/manager.js",
];
const files = {};
for (const relative of required) {
  const file = path.join(dist, relative);
  assert(fs.existsSync(file), `Required financial client module missing: ${relative}`);
  assert(fs.lstatSync(file).isFile(), `Expected regular module: ${relative}`);
  const bytes = fs.readFileSync(file);
  assert(bytes.length > 0, `Empty financial client module: ${relative}`);
  files[relative] = createHash("sha256").update(bytes).digest("hex");
}
let imports;
if (process.argv.includes("--import-runtime")) {
  const bondReview = JSON.parse(
    fs.readFileSync(
      fileURLToPath(
        new URL("../src/wallet/fixtures/wen-bond-purchase-review-v2.json", import.meta.url),
      ),
      "utf8",
    ),
  );
  // Import only guarded modules: do not invoke CLI commands, start a gateway,
  // select a wallet, or create another instance for this package check.
  const modules = [...required, "cli/run-main.js", "gateway/server.js"];
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {pathToFileURL} from 'node:url';
       const started = performance.now();
       for (const file of JSON.parse(process.argv[1])) await import(pathToFileURL(file).href);
       const fixture = JSON.parse(process.argv[2]);
       const {bindWenBondPurchaseReview} = await import(pathToFileURL(process.argv[3]).href);
       await bindWenBondPurchaseReview(fixture.review, fixture.expected,
         Date.parse(fixture.review.issuedAt) + 1);
       console.log(JSON.stringify({modules: JSON.parse(process.argv[1]).length,
         bondReviewCompatibility: 'PASS',
         elapsedMs: performance.now()-started, resourceUsage: process.resourceUsage()}));`,
      JSON.stringify([
        ...modules.map((relative) => path.join(dist, relative)),
        ...(importCorePlugins
          ? ["memory-core", "wen"].map((id) => path.join(dist, "..", "extensions", id, "index.js"))
          : []),
      ]),
      JSON.stringify(bondReview),
      path.join(dist, "wallet/wen-bond-purchase-review-contract.js"),
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
    },
  );
  imports = JSON.parse(output.trim().split("\n").at(-1));
}
console.log(
  JSON.stringify(
    {
      status: "PASS",
      scope: imports ? "PACKAGED_MODULE_IMPORTS_ONLY" : "PACKAGED_FILE_PRESENCE_ONLY",
      files,
      ...(imports ? { imports } : {}),
    },
    null,
    2,
  ),
);
