import chalk from "chalk";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveExplicitConfiguredModelRef } from "../agents/model-selection.js";
import type { loadConfig } from "../config/config.js";
import { getResolvedLoggerSettings } from "../logging.js";
import { collectEnabledInsecureOrDangerousFlags } from "../security/dangerous-config-flags.js";

export function logGatewayStartup(params: {
  cfg: ReturnType<typeof loadConfig>;
  bindHost: string;
  bindHosts?: string[];
  port: number;
  tlsEnabled?: boolean;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string) => void };
  isNixMode: boolean;
}) {
  const configuredModel = resolveExplicitConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  if (configuredModel) {
    const modelRef = `${configuredModel.provider}/${configuredModel.model}`;
    params.log.info(`agent model: ${modelRef}`, {
      consoleMessage: `agent model: ${chalk.whiteBright(modelRef)}`,
    });
  } else {
    const message = "agent model: not configured (provider setup skipped)";
    params.log.info(message, {
      consoleMessage: `agent model: ${chalk.yellow("not configured")} ${chalk.gray("(provider setup skipped)")}`,
    });
  }
  const scheme = params.tlsEnabled ? "wss" : "ws";
  const formatHost = (host: string) => (host.includes(":") ? `[${host}]` : host);
  const hosts =
    params.bindHosts && params.bindHosts.length > 0 ? params.bindHosts : [params.bindHost];
  const listenEndpoints = hosts.map((host) => `${scheme}://${formatHost(host)}:${params.port}`);
  params.log.info(`listening on ${listenEndpoints.join(", ")} (PID ${process.pid})`);
  params.log.info(`log file: ${getResolvedLoggerSettings().file}`);
  if (params.isNixMode) {
    params.log.info("gateway: running in Nix mode (config managed externally)");
  }

  const enabledDangerousFlags = collectEnabledInsecureOrDangerousFlags(params.cfg);
  if (enabledDangerousFlags.length > 0) {
    const warning =
      `security warning: dangerous config flags enabled: ${enabledDangerousFlags.join(", ")}. ` +
      "Run `fased security audit`.";
    params.log.warn(warning);
  }
}
