import fs from "node:fs/promises";

export function stubFetchTextResponse(text: string) {
  const buffer = Buffer.from(text);
  const response = {
    ok: true,
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    text: async () => text,
  } as Response;
  globalThis.fetch = async () => response;
}

export async function readFileUtf8AndCleanup(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } finally {
    await fs.rm(filePath, { force: true });
  }
}
