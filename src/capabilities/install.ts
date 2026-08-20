import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { FasedAgentConfig } from "../config/config.js";
import { finalizeInstalledPluginConfig } from "../plugins/lifecycle.js";
import { loadCapabilityCatalog, type CapabilityCatalogEntry } from "./catalog.js";

const execFileAsync = promisify(execFile);
const MANAGED_FASED_COMMAND = "/usr/local/bin/fased";
const sha256Pattern = /^sha256:[0-9a-f]{64}$/u;

export type ManagedComponentTransaction = {
  catalogPath: string;
  catalogDigest: string;
  archivePath: string;
};

export type ManagedComponentTransactionRunner = (params: {
  pluginId: string;
  transaction: ManagedComponentTransaction;
}) => Promise<void>;

export type CapabilityComponentInstallResult = {
  config: FasedAgentConfig;
  entry: CapabilityCatalogEntry;
  pluginId: string;
  slotWarnings: string[];
};

export async function installCapabilityComponent(params: {
  id: string;
  config: FasedAgentConfig;
  transaction?: ManagedComponentTransaction;
  runManagedTransaction?: ManagedComponentTransactionRunner;
}): Promise<CapabilityComponentInstallResult> {
  const entry = loadCapabilityCatalog().find((candidate) => candidate.id === params.id);
  if (!entry) {
    throw new Error(`Unknown component: ${params.id}. Run \`fased components\` to list choices.`);
  }
  if (!entry.pluginId || entry.delivery === "external-runtime") {
    throw new Error(
      `${entry.label} is delivered as ${entry.delivery} and cannot be installed by Fased. See ${entry.docsPath}.`,
    );
  }

  if (entry.delivery === "managed-component") {
    if (!params.transaction) {
      throw new Error(
        `${entry.label} requires a signed component catalog and archive. ` +
          `Run \`fased components install ${entry.id} --catalog <path> --catalog-digest sha256:<digest> --archive <path>\`.`,
      );
    }
    validateManagedComponentTransaction(params.transaction);
    await (params.runManagedTransaction ?? runManagedComponentTransaction)({
      pluginId: entry.pluginId,
      transaction: params.transaction,
    });
  }

  const finalized = finalizeInstalledPluginConfig({
    config: params.config,
    pluginId: entry.pluginId,
  });
  return {
    config: finalized.config,
    entry,
    pluginId: entry.pluginId,
    slotWarnings: finalized.slotWarnings,
  };
}

function exactAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`${label} must be an exact absolute path`);
  }
  return value;
}

export function validateManagedComponentTransaction(
  transaction: ManagedComponentTransaction,
): void {
  exactAbsolutePath(transaction.catalogPath, "Managed component catalog");
  exactAbsolutePath(transaction.archivePath, "Managed component archive");
  if (!sha256Pattern.test(transaction.catalogDigest)) {
    throw new Error("Managed component catalog digest must be canonical sha256");
  }
}

async function runManagedComponentTransaction(params: {
  pluginId: string;
  transaction: ManagedComponentTransaction;
}): Promise<void> {
  await execFileAsync(
    MANAGED_FASED_COMMAND,
    [
      "plugins",
      "install",
      "--catalog",
      params.transaction.catalogPath,
      "--catalog-digest",
      params.transaction.catalogDigest,
      "--archive",
      `${params.pluginId}=${params.transaction.archivePath}`,
    ],
    { timeout: 120_000, maxBuffer: 1024 * 1024 },
  );
}
