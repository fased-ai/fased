import fs from "node:fs";
import path from "node:path";

// `tsc` emits declarations under `dist/plugin-sdk/src/plugin-sdk/*` because the source
// lives at `src/plugin-sdk/*` and the declaration config keeps `rootDir` at repo root.
//
// Our package export map points subpath `types` at `dist/plugin-sdk/<entry>.d.ts`, so we
// generate stable entry d.ts files that re-export the real declarations.
const entrypoints = [
  "index",
  "account-id",
  "channel-plugin-common",
  "command-status",
  "provider-web-search-config-contract",
  "sat-runtime",
] as const;
for (const entry of entrypoints) {
  const out = path.join(process.cwd(), `dist/plugin-sdk/${entry}.d.ts`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // NodeNext: reference the runtime specifier with `.js`, TS will map it to `.d.ts`.
  fs.writeFileSync(out, `export * from "./src/plugin-sdk/${entry}.js";\n`, "utf8");
}
