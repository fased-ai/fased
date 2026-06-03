import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type ManagedReservationSummary = {
  path: string;
  slug: string;
  tokenPresent: boolean;
};

export function readManagedReservationSummaries(
  env: NodeJS.ProcessEnv = process.env,
): ManagedReservationSummary[] {
  const stateDir = resolveStateDir(env);
  const entries = fs.readdirSync(stateDir, { withFileTypes: true });
  const summaries: ManagedReservationSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".zrok-reservation")) {
      continue;
    }
    const filePath = path.join(stateDir, entry.name);
    try {
      const token = fs.readFileSync(filePath, "utf8").trim();
      summaries.push({
        path: filePath,
        slug: entry.name.slice(0, -".zrok-reservation".length),
        tokenPresent: token.length > 0,
      });
    } catch {
      summaries.push({
        path: filePath,
        slug: entry.name.slice(0, -".zrok-reservation".length),
        tokenPresent: false,
      });
    }
  }
  return summaries;
}
