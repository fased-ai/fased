/**
 * Exact core facade modules available to digest-bound managed components.
 * Optional implementation modules are intentionally absent: they must remain
 * inside their component archive rather than re-entering the core artifact.
 */
export const MANAGED_RUNTIME_CORE_MODULES = [
  "agents/tools/common",
  "agents/model-auth",
  "agents/model-selection",
  "agents/pi-embedded-runner/model",
  "auto-reply/tokens",
  "auto-reply/types",
  "browser/config",
  "browser/constants",
  "browser/control-auth",
  "browser/form-fields",
  "browser/paths",
  "browser/proxy-files",
  "browser/runtime-dependency",
  "browser/trash",
  "channels/plugins/index",
  "channels/plugins/types",
  "cli/command-format",
  "config/config",
  "config/paths",
  "config/port-defaults",
  "config/types.tts",
  "gateway/auth",
  "gateway/net",
  "gateway/node-command-policy",
  "gateway/node-registry",
  "gateway/protocol/index",
  "gateway/server-methods/nodes.helpers",
  "gateway/server-methods/types",
  "gateway/server-utils",
  "gateway/ws-log",
  "globals",
  "infra/errors",
  "infra/fs-safe",
  "infra/net/ssrf",
  "infra/optional-runtime-dependency",
  "infra/path-guards",
  "infra/ports",
  "infra/secure-random",
  "infra/tmp-fased-dir",
  "infra/voicewake",
  "infra/ws",
  "line/markdown-to-line",
  "logging/subsystem",
  "media/audio",
  "media/image-ops",
  "media/store",
  "process/exec",
  "plugin-sdk/speech-runtime",
  "security/secret-equal",
  "utils",
  "utils/boolean",
] as const;

export const MANAGED_RUNTIME_SPECIFIER_PREFIX = "fased/managed-runtime/";

const managedRuntimeCoreModuleSet = new Set<string>(MANAGED_RUNTIME_CORE_MODULES);

export function managedRuntimeSpecifier(moduleId: string): string | null {
  const normalized = moduleId
    .replace(/\\/gu, "/")
    .replace(/^src\//u, "")
    .replace(/\.(?:tsx?|m?js)$/u, "");
  return managedRuntimeCoreModuleSet.has(normalized)
    ? `${MANAGED_RUNTIME_SPECIFIER_PREFIX}${normalized}`
    : null;
}
