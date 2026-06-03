export type SandboxBackendExecSpec = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdinMode: "pipe-open" | "pipe-closed";
};

export type SandboxBackendRuntime = {
  id: string;
  runtimeId: string;
  runtimeLabel: string;
  workdir: string;
  buildExecSpec?: (params: {
    command: string;
    workdir?: string;
    env: Record<string, string>;
    usePty: boolean;
  }) => Promise<SandboxBackendExecSpec>;
  runShellCommand?: (params: {
    command: string;
    workdir?: string;
    env?: Record<string, string>;
  }) => Promise<{
    stdout: Buffer;
    stderr: Buffer;
    code: number;
  }>;
};

export type SandboxBackendFactory = () => Promise<SandboxBackendRuntime>;

const sandboxBackends = new Map<string, SandboxBackendFactory>();

export function registerSandboxBackend(id: string, factory: SandboxBackendFactory): () => void {
  sandboxBackends.set(id, factory);
  return () => {
    if (sandboxBackends.get(id) === factory) {
      sandboxBackends.delete(id);
    }
  };
}

export async function resolveSandboxBackend(id: string): Promise<SandboxBackendRuntime | null> {
  const factory = sandboxBackends.get(id);
  return factory ? await factory() : null;
}
