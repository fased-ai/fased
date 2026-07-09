#!/usr/bin/env node

import { lstatSync, rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");

let stat;
try {
  stat = lstatSync(dist);
} catch (error) {
  if (error?.code === "ENOENT") {
    process.exit(0);
  }
  throw error;
}

if (!stat.isDirectory() || stat.isSymbolicLink()) {
  throw new Error(`Refusing to clean unexpected dist path: ${dist}`);
}

rmSync(dist, { recursive: true, force: true });
