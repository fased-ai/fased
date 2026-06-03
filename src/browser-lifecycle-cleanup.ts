export async function cleanupBrowserSessionsForLifecycleEnd(_params: {
  sessionKeys: string[];
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<void> {
  // No browser lifecycle cleanup is required in the default runtime path.
}
