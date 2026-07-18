import type { FasedAgentConfig } from "../config/config.js";

export const LEGACY_EMBEDDED_KEYSTORE_PROVIDER_ID = "embedded-keystore" as const;

export const LEGACY_EMBEDDED_KEYSTORE_MIGRATION_MESSAGE =
  "embedded-keystore was retired so normal production Fased code no longer reads wallet private keys in Node or the Gateway. " +
  "On Local, the signer and Gateway share an OS account, so this code-path separation is not a hard compromise boundary; Hosting uses a separate signer account for OS isolation. " +
  "Migrate one way with the verified native fased-signerd through its signer-only control socket. " +
  "For a legacy encrypted keystore, run `fased-signerd admin wallet import-legacy --control-socket <absolute-control.sock> --wallet-id <wallet-id> --locked-role <agent|mining|vault> --keystore-path <absolute-0600-keystore> --passphrase-path <absolute-0600-passphrase-file>`. " +
  "For a Solana CLI keypair, run `fased-signerd admin wallet import --control-socket <absolute-control.sock> --wallet-id <wallet-id> --locked-role <agent|mining|vault> < /absolute/path/to/solana-keypair.json`. " +
  "After the native import succeeds, run `fased wallet finalize-legacy-migration --wallet-id <wallet-id>`; it verifies the protocol-v2 signer public key before replacing legacy config/registry references without reading the old key files. " +
  "Run the native command as the signer/control-socket owner; do not pass a private key or passphrase to Fased CLI, Gateway, UI, argv, or environment variables.";

export class LegacyEmbeddedKeystoreMigrationRequiredError extends Error {
  readonly code = "wallet_legacy_embedded_keystore_migration_required";

  constructor(context?: string) {
    super(
      context?.trim()
        ? `${context.trim()}: ${LEGACY_EMBEDDED_KEYSTORE_MIGRATION_MESSAGE}`
        : LEGACY_EMBEDDED_KEYSTORE_MIGRATION_MESSAGE,
    );
    this.name = "LegacyEmbeddedKeystoreMigrationRequiredError";
  }
}

export function throwLegacyEmbeddedKeystoreMigrationRequired(context?: string): never {
  throw new LegacyEmbeddedKeystoreMigrationRequiredError(context);
}

export function hasLegacyEmbeddedKeystoreConfig(
  cfg: FasedAgentConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  if (cfg.wallet?.provider?.id === LEGACY_EMBEDDED_KEYSTORE_PROVIDER_ID) {
    return true;
  }
  const legacyKeystore = cfg.wallet?.keystore;
  if (
    legacyKeystore &&
    (legacyKeystore.enabled !== undefined ||
      Boolean(legacyKeystore.path?.trim()) ||
      Boolean(legacyKeystore.chainSupport?.length) ||
      legacyKeystore.autoLockSeconds !== undefined ||
      legacyKeystore.requirePasskeyForUnlock !== undefined)
  ) {
    return true;
  }
  if (String(env.FASED_WALLET_PROVIDER ?? "").trim() === LEGACY_EMBEDDED_KEYSTORE_PROVIDER_ID) {
    return true;
  }
  return false;
}

export function hasLegacyEmbeddedKeystoreMaterialHint(env: NodeJS.ProcessEnv): boolean {
  for (const [key, rawValue] of Object.entries(env)) {
    if (typeof rawValue !== "string" || !rawValue.trim()) {
      continue;
    }
    if (
      key === "FASED_WALLET_KEYSTORE_PATH" ||
      key === "FASED_WALLET_PASSPHRASE" ||
      key === "FASED_WALLET_PASSPHRASE_FILE" ||
      key === "FASED_WALLET_PRIVATE_KEY" ||
      key === "FASED_WALLET_SOLANA_KEYSTORE_PATH" ||
      key.startsWith("FASED_WALLET_SOLANA_KEYSTORE_PATH__")
    ) {
      return true;
    }
  }
  return false;
}
