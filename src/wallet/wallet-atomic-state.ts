import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const WALLET_STATE_FILE_MODE = 0o600;

/**
 * Replace a wallet state file durably without ever exposing a partially-written
 * destination. Callers remain responsible for validating the full document
 * before trusting it and for serializing read/modify/write operations.
 */
export function writeWalletStateFileAtomically(filePath: string, contents: string): void {
  const directoryPath = path.dirname(filePath);
  const temporaryPath = path.join(
    directoryPath,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  let renamed = false;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", WALLET_STATE_FILE_MODE);
    fs.writeFileSync(descriptor, contents, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    renamed = true;
    try {
      fs.chmodSync(filePath, WALLET_STATE_FILE_MODE);
    } catch {
      // Best effort for filesystems without POSIX mode semantics.
    }

    const directoryDescriptor = fs.openSync(directoryPath, "r");
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original write error.
      }
    }
    if (!renamed) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The temporary file may not exist or may already have been renamed.
      }
    }
    throw error;
  }
}

export function serializeWalletState(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
