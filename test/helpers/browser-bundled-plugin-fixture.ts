import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createBundledBrowserPluginFixture() {
  const rootDir = path.join(os.tmpdir(), `fased-browser-plugin-${randomUUID()}`);
  fs.mkdirSync(rootDir, { recursive: true });
  return {
    rootDir,
    cleanup() {
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}
