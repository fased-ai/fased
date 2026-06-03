import path from "node:path";
import type { FasedAgentConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";

const STALE_ROOT_STATE_DIRS = [path.resolve("/home/root/.fased"), path.resolve("/root/.fased")];

function rewriteStateScopedPath(
  value: string | undefined,
  targetStateDir: string,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return value;
  }
  const resolved = path.resolve(trimmed);
  for (const staleStateDir of STALE_ROOT_STATE_DIRS) {
    if (resolved === staleStateDir || resolved.startsWith(`${staleStateDir}${path.sep}`)) {
      const relative = path.relative(staleStateDir, resolved);
      return relative ? path.join(targetStateDir, relative) : targetStateDir;
    }
  }
  return value;
}

export function normalizeHostedWalletPaths(
  cfg: FasedAgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): FasedAgentConfig {
  const targetStateDir = path.resolve(resolveStateDir(env));
  const vars = { ...cfg.env?.vars };
  let changed = false;

  for (const [key, rawValue] of Object.entries(vars)) {
    if (
      key !== "FASED_WALLET_KEYSTORE_PATH" &&
      key !== "FASED_WALLET_PASSPHRASE_FILE" &&
      key !== "FASED_WALLET_LOCAL_SIGNER_SOCKET" &&
      key !== "FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET" &&
      key !== "FASED_WALLET_SIGNER_STATE_DIR" &&
      !key.startsWith("FASED_WALLET_SOLANA_KEYSTORE_PATH")
    ) {
      continue;
    }
    const nextValue = rewriteStateScopedPath(rawValue, targetStateDir);
    if (nextValue !== rawValue) {
      vars[key] = nextValue ?? rawValue;
      changed = true;
    }
  }

  const walletKeystorePath = rewriteStateScopedPath(cfg.wallet?.keystore?.path, targetStateDir);
  if (walletKeystorePath !== cfg.wallet?.keystore?.path) {
    changed = true;
  }

  if (!changed) {
    return cfg;
  }

  return {
    ...cfg,
    env: {
      ...cfg.env,
      vars,
    },
    wallet: cfg.wallet
      ? {
          ...cfg.wallet,
          keystore: cfg.wallet.keystore
            ? {
                ...cfg.wallet.keystore,
                path: walletKeystorePath,
              }
            : cfg.wallet.keystore,
        }
      : cfg.wallet,
  };
}
