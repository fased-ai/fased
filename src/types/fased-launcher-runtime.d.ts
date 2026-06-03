declare module "../../scripts/fased-launcher-runtime.mjs" {
  export function reexecWithSupportedNodeIfNeeded(params?: {
    argv?: string[];
    env?: Record<string, string | undefined>;
    execPath?: string;
    exit?: (code?: number) => never | void;
    fsImpl?: unknown;
    nodeVersion?: string;
    pathImpl?: unknown;
    requireFn?: (specifier: string) => unknown;
    selfPath?: string;
    spawnSyncImpl?: unknown;
  }): void;
}
