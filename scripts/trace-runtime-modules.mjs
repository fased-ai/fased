import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

const output = process.env.FASED_RUNTIME_MODULE_TRACE?.trim();
const seen = new Set();

if (output) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (resolved.url.startsWith("file:") && !seen.has(resolved.url)) {
        seen.add(resolved.url);
        appendFileSync(output, `${resolved.url}\n`, { encoding: "utf8", mode: 0o600 });
      }
      return resolved;
    },
  });
}
