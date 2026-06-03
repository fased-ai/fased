import fs from "node:fs";
import path from "node:path";
import { replaceCliName, resolveCliName } from "./cli-name.js";
import { normalizeProfileName } from "./profile-utils.js";

const CLI_PREFIX_RE = /^(?:pnpm|npm|bunx|npx)\s+fased\b|^fased\b|^node\s+scripts\/run-node\.mjs\b/;
const PROFILE_FLAG_RE = /(?:^|\s)--profile(?:\s|=|$)/;
const DEV_FLAG_RE = /(?:^|\s)--dev(?:\s|$)/;

function resolveHintCliInvocation(argv: string[] = process.argv): string {
  const fallback = resolveCliName(argv);
  const argv1 = argv[1];
  if (!argv1) {
    return fallback;
  }
  if (path.basename(argv1).trim() !== "run-node.mjs") {
    return fallback;
  }
  const localRunner = path.resolve(process.cwd(), "scripts", "run-node.mjs");
  if (!fs.existsSync(localRunner)) {
    return fallback;
  }
  return "node scripts/run-node.mjs";
}

export function formatCliCommand(
  command: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  const cliName = resolveCliName();
  const hintCliInvocation = resolveHintCliInvocation();
  let normalizedCommand = replaceCliName(command, cliName);
  if (hintCliInvocation !== cliName && CLI_PREFIX_RE.test(normalizedCommand)) {
    normalizedCommand = normalizedCommand.replace(CLI_PREFIX_RE, hintCliInvocation);
  }
  const profile = normalizeProfileName(env.FASED_PROFILE);
  if (!profile) {
    return normalizedCommand;
  }
  if (!CLI_PREFIX_RE.test(normalizedCommand)) {
    return normalizedCommand;
  }
  if (PROFILE_FLAG_RE.test(normalizedCommand) || DEV_FLAG_RE.test(normalizedCommand)) {
    return normalizedCommand;
  }
  return normalizedCommand.replace(CLI_PREFIX_RE, (match) => `${match} --profile ${profile}`);
}
