// Test-only frozen canonical interface; no deployment or release authority.
import { readFileSync } from "node:fs";
export async function generateGenesisInterface(profile = {}) {
  if (Object.keys(profile).length) {
    throw Error("unsupported snapshot profile");
  }
  return JSON.parse(readFileSync(new URL("./canonical-interface.json", import.meta.url), "utf8"));
}
