import fs from "node:fs";
import path from "node:path";

/** Schema-side credential presence check; it does not load the WhatsApp runtime. */
export function hasWebCredsSync(authDir: string): boolean {
  try {
    const stats = fs.statSync(path.join(authDir, "creds.json"));
    return stats.isFile() && stats.size > 1;
  } catch {
    return false;
  }
}
