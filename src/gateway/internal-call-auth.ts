import type { FasedAgentConfig } from "../config/config.js";
import type { CallGatewayOptions } from "./call.js";
import { resolveGatewayCredentialsFromConfig } from "./credentials.js";

export function resolveInternalGatewayCallAuth(
  cfg: FasedAgentConfig,
): Pick<CallGatewayOptions, "config" | "token" | "password"> {
  const credentials = resolveGatewayCredentialsFromConfig({
    cfg,
    localTokenPrecedence: "config-first",
    localPasswordPrecedence: "config-first",
    remoteTokenPrecedence: "remote-first",
    remotePasswordPrecedence: "remote-first",
  });
  return {
    config: cfg,
    ...(credentials.token ? { token: credentials.token } : {}),
    ...(credentials.password ? { password: credentials.password } : {}),
  };
}
