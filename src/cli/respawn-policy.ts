import { hasHelpOrVersion } from "./argv.js";

const ROOT_BOOLEAN_FLAGS = new Set(["--dev", "--no-color"]);
const ROOT_VALUE_FLAGS = new Set(["--profile", "--log-level"]);

const GATEWAY_RUN_BOOLEAN_FLAGS = new Set([
  "--allow-unconfigured",
  "--claude-cli-logs",
  "--compact",
  "--dev",
  "--force",
  "--raw-stream",
  "--reset",
  "--tailscale-reset-on-exit",
  "--verbose",
]);

const GATEWAY_RUN_VALUE_FLAGS = new Set([
  "--auth",
  "--bind",
  "--password",
  "--password-file",
  "--port",
  "--raw-stream-path",
  "--tailscale",
  "--token",
  "--ws-log",
]);

function isValueToken(value: string | undefined): boolean {
  return Boolean(value && value !== "--" && !value.startsWith("-"));
}

function isFlagWithInlineValue(arg: string, flags: ReadonlySet<string>): boolean {
  const equalIndex = arg.indexOf("=");
  return equalIndex > 0 && flags.has(arg.slice(0, equalIndex));
}

function collectGatewayPositionals(argv: string[]): string[] | null {
  const positionals: string[] = [];
  let seenGateway = false;
  const args = argv.slice(2);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      return null;
    }

    const booleanFlags = seenGateway ? GATEWAY_RUN_BOOLEAN_FLAGS : ROOT_BOOLEAN_FLAGS;
    const valueFlags = seenGateway ? GATEWAY_RUN_VALUE_FLAGS : ROOT_VALUE_FLAGS;

    if (booleanFlags.has(arg) || isFlagWithInlineValue(arg, valueFlags)) {
      continue;
    }
    if (valueFlags.has(arg)) {
      if (isValueToken(args[index + 1])) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }

    if (!seenGateway) {
      if (arg !== "gateway") {
        return null;
      }
      seenGateway = true;
      continue;
    }

    positionals.push(arg);
  }

  return seenGateway ? positionals : null;
}

function isForegroundGatewayRunArgv(argv: string[]): boolean {
  const positionals = collectGatewayPositionals(argv);
  if (!positionals) {
    return false;
  }
  return positionals.length === 0 || (positionals.length === 1 && positionals[0] === "run");
}

export function shouldSkipRespawnForArgv(argv: string[]): boolean {
  return hasHelpOrVersion(argv) || isForegroundGatewayRunArgv(argv);
}
