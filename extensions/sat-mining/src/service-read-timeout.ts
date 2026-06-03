const SAT_SERVICE_READ_TIMEOUT_MS = 4_000;

export function createSatServiceReadTimeoutError(service: string, label: string): Error {
  const error = new Error(`${service} timed out waiting for ${label}`);
  error.name = "SatServiceReadTimeoutError";
  return error;
}

export function isSatServiceReadTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "SatServiceReadTimeoutError";
}

export function swallowSatReadErrorUnlessTimeout(error: unknown): null {
  if (isSatServiceReadTimeoutError(error)) {
    throw error;
  }
  return null;
}

export async function withSatServiceReadTimeout<T>(
  service: string,
  label: string,
  task: () => Promise<T>,
  timeoutMs = SAT_SERVICE_READ_TIMEOUT_MS,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      task(),
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(
          () => reject(createSatServiceReadTimeoutError(service, label)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
