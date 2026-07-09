import { spawnSync } from "node:child_process";

const profile = (process.env.FASED_BUILD_PROFILE ?? "").trim().toLowerCase();
const isVpsBuild = profile === "vps" || profile === "vps-lite";

function runGraph(graph) {
  const startedAt = Date.now();
  const result = spawnSync("pnpm", ["exec", "tsdown"], {
    cwd: process.cwd(),
    env: { ...process.env, FASED_BUILD_GRAPH: graph },
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  console.log(`build-runtime: ${graph} graph completed in ${Date.now() - startedAt}ms`);
}

runGraph("core");
if (!isVpsBuild) {
  runGraph("sdk");
}
