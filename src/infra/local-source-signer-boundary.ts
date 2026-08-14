import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export async function isLocalSourceSignerConfigured(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const stateDir = path.resolve(resolveStateDir(env));
  for (const candidate of [
    path.join(stateDir, "bin", "fased-signerd"),
    path.join(stateDir, "wallet", "signerd-v2.db"),
  ]) {
    const found = await fs
      .lstat(candidate)
      .then((stat) => stat.isFile() && !stat.isSymbolicLink())
      .catch(() => false);
    if (found) {
      return true;
    }
  }
  const walletDir = path.join(stateDir, "wallet");
  const legacyMaterial = await fs
    .readdir(walletDir, { withFileTypes: true })
    .then((entries) =>
      entries.some(
        (entry) =>
          entry.isFile() &&
          (entry.name === "wallet-keys.json" ||
            /^keystore-(?:solana|evm)(?:-[A-Za-z0-9_-]+)?\.v1\.enc$/u.test(entry.name)),
      ),
    )
    .catch(() => false);
  if (legacyMaterial) {
    return true;
  }
  try {
    const registry = JSON.parse(
      await fs.readFile(path.join(walletDir, "provider-registry.v1.json"), "utf8"),
    ) as { wallets?: Array<{ providerId?: unknown }> };
    return (registry.wallets ?? []).some((wallet) => wallet?.providerId === "local-socket-signer");
  } catch {
    return false;
  }
}
