import fs from "node:fs/promises";

export function isSharedFederationState(env: NodeJS.ProcessEnv = process.env): boolean {
  const protectedLocal = String(env.FASED_PROTECTED_LOCAL ?? "").trim() === "1";
  const hosting =
    String(env.FASED_HOST_PROFILE ?? "")
      .trim()
      .toLowerCase() === "hosting";
  return protectedLocal || hosting;
}

export function federationStateDirectoryMode(env: NodeJS.ProcessEnv = process.env): number {
  return isSharedFederationState(env) ? 0o2770 : 0o700;
}

export function federationStateFileMode(env: NodeJS.ProcessEnv = process.env): number {
  return isSharedFederationState(env) ? 0o660 : 0o600;
}

export async function ensureFederationStateDirectory(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const mode = federationStateDirectoryMode(env);
  let created = false;
  try {
    const info = await fs.stat(directory);
    if (!info.isDirectory()) {
      throw new Error(`federation state path is not a directory: ${directory}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    created =
      (await fs.mkdir(directory, {
        recursive: true,
        mode: isSharedFederationState(env) ? 0o770 : mode,
      })) !== undefined;
  }
  if (!isSharedFederationState(env) || created) {
    await fs.chmod(directory, mode);
  }
}

export async function enforceFederationStateFileMode(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    await fs.chmod(filePath, federationStateFileMode(env));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") {
      throw error;
    }
    // A peer service may own the group-shared file. Its existing mode remains authoritative.
  }
}
