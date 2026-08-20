import { spawnSync } from "node:child_process";

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
runGraph("light-cli");
