export interface LifecycleReleaseAuthority {
  type: string;
  repository: string;
  workflow: string;
  sourceRefPrefix: string;
  denySelfHostedRunners: boolean;
}

export interface InitialLifecycleTrust {
  envelope: Readonly<Record<string, unknown>>;
  pinnedSha256: string;
  root: {
    version: number;
    root: {
      keyIds: readonly string[];
      threshold: number;
    };
    releaseAuthority: LifecycleReleaseAuthority;
    revocations: {
      releaseVersions: readonly string[];
      targetDigests: readonly string[];
    };
  };
  state: {
    schemaVersion: number;
    rootVersion: number;
    rootSha256: string;
  };
}

export const INITIAL_LIFECYCLE_ROOT_SHA256: string;
export const INITIAL_LIFECYCLE_ROOT_ENVELOPE: Readonly<Record<string, unknown>>;
export const INITIAL_LIFECYCLE_TRUST: InitialLifecycleTrust;

export function loadInitialLifecycleTrust(
  envelope?: unknown,
  pinnedSha256?: string,
  now?: number,
): InitialLifecycleTrust;

export function officialReleaseAttestationVerifyArgs(params: {
  assetPath: string;
  version: string;
  bundlePath?: string | null;
  targetDigests?: readonly string[];
}): string[];
