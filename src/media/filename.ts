import path from "node:path";

/** Recover an embedded original name without loading the media store implementation. */
export function extractOriginalFilename(filePath: string): string {
  const basename = path.basename(filePath);
  if (!basename) {
    return "file.bin";
  }
  const ext = path.extname(basename);
  const nameWithoutExt = path.basename(basename, ext);
  const match = nameWithoutExt.match(
    /^(.+)---[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu,
  );
  return match?.[1] ? `${match[1]}${ext}` : basename;
}
