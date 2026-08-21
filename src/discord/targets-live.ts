import type { DirectoryConfigParams } from "../channels/plugins/directory-config.js";
import { buildMessagingTarget, type MessagingTarget } from "../channels/targets.js";
import { listDiscordDirectoryPeersLive } from "./directory-live.js";
import { parseDiscordTarget } from "./targets.js";

type DiscordTargetParseOptions = Parameters<typeof parseDiscordTarget>[1];

/** Discord-pack-owned username resolution. Core retains only target parsing. */
export async function resolveDiscordTarget(
  raw: string,
  options: DirectoryConfigParams,
  parseOptions: DiscordTargetParseOptions = {},
): Promise<MessagingTarget | undefined> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const likelyUsername = isLikelyUsername(trimmed);
  const shouldLookup = isExplicitUserLookup(trimmed, parseOptions) || likelyUsername;
  const directParse = safeParseDiscordTarget(trimmed, parseOptions);
  if (directParse && directParse.kind !== "channel" && !likelyUsername) {
    return directParse;
  }
  if (!shouldLookup) {
    return directParse ?? parseDiscordTarget(trimmed, parseOptions);
  }
  try {
    const match = (
      await listDiscordDirectoryPeersLive({ ...options, query: trimmed, limit: 1 })
    )[0];
    if (match?.kind === "user") {
      return buildMessagingTarget("user", match.id.replace(/^user:/, ""), trimmed);
    }
  } catch {
    // Preserve the historical channel-name fallback when directory lookup fails.
  }
  return parseDiscordTarget(trimmed, parseOptions);
}

function safeParseDiscordTarget(
  input: string,
  options: DiscordTargetParseOptions,
): MessagingTarget | undefined {
  try {
    return parseDiscordTarget(input, options);
  } catch {
    return undefined;
  }
}

function isExplicitUserLookup(input: string, options: DiscordTargetParseOptions): boolean {
  return (
    /^<@!?(\d+)>$/.test(input) ||
    /^(user:|discord:)/.test(input) ||
    input.startsWith("@") ||
    (/^\d+$/.test(input) && options.defaultKind === "user")
  );
}

function isLikelyUsername(input: string): boolean {
  return !/^(user:|channel:|discord:|@|<@!?)|[\d]+$/.test(input);
}
