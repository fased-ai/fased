import fs from "node:fs/promises";

type RaceTiming = "before-realpath" | "after-realpath";

export async function createRebindableDirectoryAlias(params: {
  aliasPath: string;
  targetPath: string;
}) {
  await fs.symlink(params.targetPath, params.aliasPath, "dir");
}

export async function withRealpathSymlinkRebindRace<T>(params: {
  shouldFlip: (realpathInput: string) => boolean;
  symlinkPath: string;
  symlinkTarget: string;
  timing: RaceTiming;
  run: () => Promise<T>;
}): Promise<T> {
  const originalRealpath = fs.realpath;
  let flipped = false;
  const flip = async () => {
    if (flipped) {
      return;
    }
    flipped = true;
    await fs.rm(params.symlinkPath, { recursive: true, force: true });
    await fs.symlink(params.symlinkTarget, params.symlinkPath, "dir");
  };

  fs.realpath = (async (pathLike: Parameters<typeof fs.realpath>[0], options?: unknown) => {
    const input = String(pathLike);
    if (params.timing === "before-realpath" && params.shouldFlip(input)) {
      await flip();
    }
    const resolved = await originalRealpath(pathLike, options as Parameters<typeof fs.realpath>[1]);
    if (params.timing === "after-realpath" && params.shouldFlip(input)) {
      await flip();
    }
    return resolved;
  }) as typeof fs.realpath;

  try {
    return await params.run();
  } finally {
    fs.realpath = originalRealpath;
  }
}
