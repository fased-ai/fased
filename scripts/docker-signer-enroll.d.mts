import type net from "node:net";

export function createDockerSignerEnrollmentProxy(options?: {
  backendHost?: string;
  backendPort?: number;
}): net.Server;

export function runDockerSignerEnrollment(args?: string[]): Promise<{
  code: number;
  signal?: NodeJS.Signals | null;
}>;
