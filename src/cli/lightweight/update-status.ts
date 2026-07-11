import process from "node:process";
import { getFlagValue, hasFlag } from "../argv.js";
import { updateStatusCommand } from "../update-cli/status.js";

export async function run(argv: string[] = process.argv): Promise<boolean> {
  if (argv[2] !== "update" || argv[3] !== "status") {
    return false;
  }
  const timeout = getFlagValue(argv, "--timeout");
  if (timeout === null) {
    return false;
  }
  await updateStatusCommand({ json: hasFlag(argv, "--json"), timeout });
  return true;
}
