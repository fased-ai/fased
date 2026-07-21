export type DockerSignerReleaseExpectation = {
  requireProduction?: boolean;
  expectedVersion?: string;
  expectedCommit?: string;
  expectedBuildInputDigest?: string;
  expectedDevelopment?: boolean;
};

export function validateDockerSignerHealthEnvelope(
  envelope: unknown,
  options?: DockerSignerReleaseExpectation,
): boolean;

export function checkDockerSignerHealth(
  socketPath: string,
  options?: DockerSignerReleaseExpectation & { timeoutMs?: number },
): Promise<void>;
