import { throwLegacyEmbeddedKeystoreMigrationRequired } from "../legacy-embedded-keystore.js";

export type EmbeddedKeystoreAdapterOptions = Readonly<Record<string, never>>;

/**
 * Import-only compatibility symbol. It deliberately throws in the constructor before inspecting
 * options or touching the filesystem. Production resolution no longer imports this module.
 */
export class EmbeddedKeystoreAdapter {
  constructor(_options?: unknown) {
    throwLegacyEmbeddedKeystoreMigrationRequired("embedded-keystore adapter is unavailable");
  }
}
