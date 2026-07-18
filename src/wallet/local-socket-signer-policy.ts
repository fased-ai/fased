import {
  LOCAL_SIGNER_NATIVE_FEE_RESERVATION_LAMPORTS_V2,
  type LocalSocketSignerPolicyV2,
} from "./local-socket-signer-protocol.js";

type GatewayPolicyState = {
  capsEnabled: boolean;
  directSigning: boolean;
  skillsEnabled: boolean;
  solana: {
    allowPrograms: string[];
    maxPerTx: string;
    maxDaily: string;
    tokenCaps: Record<string, { maxPerTx: string; maxDaily: string }>;
  };
};

export type LocalSignerGatewayPolicyPatch = {
  policyTemplate?: string;
  capsEnabled?: boolean;
  directSigning?: boolean;
  skillsEnabled?: boolean;
  solanaAllowPrograms?: string[];
  solanaMaxPerTx?: string;
  solanaMaxDaily?: string;
  solanaTokenCaps?: Record<string, { maxPerTx?: string; maxDaily?: string }>;
};

export class LocalSignerPolicyAdminRequiredError extends Error {
  readonly code = "signer_policy_admin_required";

  constructor(message: string) {
    super(message);
    this.name = "LocalSignerPolicyAdminRequiredError";
  }
}

function adminGuidance(hosting: boolean): string {
  return hosting
    ? "Use an authenticated host-administrator session and the signer-only control socket (`fased-signerd admin policy get/put` as the dedicated signer user). The Gateway cannot widen policy."
    : "Use the same-user native signer control socket with `fased-signerd admin policy get/put`. The Gateway cannot widen policy.";
}

function requireAdmin(reason: string, hosting: boolean): never {
  throw new LocalSignerPolicyAdminRequiredError(`${reason} ${adminGuidance(hosting)}`);
}

function normalizeStringSet(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].toSorted();
}

function requireCanonicalAmount(raw: string, field: string): bigint {
  const value = raw.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${field} must be a canonical non-negative integer in base units`);
  }
  return BigInt(value);
}

function clonePolicy(policy: LocalSocketSignerPolicyV2): LocalSocketSignerPolicyV2 {
  return {
    ...policy,
    operations: [...policy.operations],
    programs: [...policy.programs],
    assets: policy.assets.map((asset) => ({
      ...asset,
      destinations: [...asset.destinations],
    })),
  };
}

function setAssetCaps(params: {
  candidate: LocalSocketSignerPolicyV2;
  assetId: string;
  maxPerTx?: string;
  maxDaily?: string;
  hosting: boolean;
}): void {
  if (params.maxPerTx === undefined && params.maxDaily === undefined) {
    return;
  }
  const index = params.candidate.assets.findIndex((asset) => asset.asset === params.assetId);
  const current = index >= 0 ? params.candidate.assets[index] : undefined;
  const nextPerTx =
    params.maxPerTx === undefined
      ? current
        ? requireCanonicalAmount(current.maxPerTx, `${params.assetId} signer maxPerTx`)
        : 0n
      : requireCanonicalAmount(params.maxPerTx, `${params.assetId} maxPerTx`);
  const nextDaily =
    params.maxDaily === undefined
      ? current
        ? requireCanonicalAmount(current.maxDaily, `${params.assetId} signer maxDaily`)
        : 0n
      : requireCanonicalAmount(params.maxDaily, `${params.assetId} maxDaily`);

  if (!current) {
    if (nextPerTx > 0n || nextDaily > 0n) {
      requireAdmin(
        `Adding signer asset permission ${params.assetId} is a policy expansion.`,
        params.hosting,
      );
    }
    return;
  }
  if (nextPerTx === 0n || nextDaily === 0n) {
    params.candidate.assets.splice(index, 1);
    return;
  }
  const currentPerTx = requireCanonicalAmount(
    current.maxPerTx,
    `${params.assetId} signer maxPerTx`,
  );
  const currentDaily = requireCanonicalAmount(
    current.maxDaily,
    `${params.assetId} signer maxDaily`,
  );
  if (nextPerTx > currentPerTx || nextDaily > currentDaily) {
    requireAdmin(
      `Raising signer caps for ${params.assetId} is a policy expansion.`,
      params.hosting,
    );
  }
  params.candidate.assets[index] = {
    ...current,
    maxPerTx: nextPerTx.toString(),
    maxDaily: nextDaily.toString(),
  };
}

function requireGatewayAmountNotRaised(params: {
  next?: string;
  current: string;
  field: string;
  hosting: boolean;
}): void {
  if (params.next === undefined) {
    return;
  }
  const next = requireCanonicalAmount(params.next, params.field);
  const current = requireCanonicalAmount(params.current, `current ${params.field}`);
  if (next > current) {
    requireAdmin(`${params.field} cannot be raised through the Gateway.`, params.hosting);
  }
}

export function buildLocalSignerPolicyTightening(params: {
  current: LocalSocketSignerPolicyV2;
  expectedRole: "agent" | "mining" | "vault";
  gatewayPolicy: GatewayPolicyState;
  patch: LocalSignerGatewayPolicyPatch;
  hosting: boolean;
}): LocalSocketSignerPolicyV2 {
  if (params.current.role !== params.expectedRole) {
    requireAdmin(
      `Wallet role metadata (${params.expectedRole}) does not match the signer-owned role (${params.current.role}); roles are immutable.`,
      params.hosting,
    );
  }
  if (params.patch.policyTemplate !== undefined) {
    requireAdmin(
      "Policy presets are not signer-exact and may add operations, programs, assets, or limits.",
      params.hosting,
    );
  }
  const signerLocked = localSignerPolicyState(params.current) === "locked";
  if (
    signerLocked &&
    (params.patch.directSigning === true || params.patch.skillsEnabled === true)
  ) {
    requireAdmin(
      "This signer-owned wallet is locked by an explicit deny-all policy; app settings cannot unlock it.",
      params.hosting,
    );
  }
  if (params.patch.capsEnabled === false && params.gatewayPolicy.capsEnabled) {
    requireAdmin(
      "Signer-backed spend caps cannot be disabled through the Gateway.",
      params.hosting,
    );
  }
  if (params.patch.directSigning === true && !params.gatewayPolicy.directSigning) {
    requireAdmin("Automated direct signing cannot be enabled through the Gateway.", params.hosting);
  }
  if (params.patch.skillsEnabled === true && !params.gatewayPolicy.skillsEnabled) {
    requireAdmin("Skill wallet access cannot be enabled through the Gateway.", params.hosting);
  }

  const candidate = clonePolicy(params.current);
  if (params.patch.solanaAllowPrograms !== undefined) {
    const requestedPrograms = normalizeStringSet(params.patch.solanaAllowPrograms);
    const currentGatewayPrograms = normalizeStringSet(params.gatewayPolicy.solana.allowPrograms);
    if (requestedPrograms.join("\n") === currentGatewayPrograms.join("\n")) {
      // The Gateway copy may predate signer-v2. An unchanged app value is not allowed to
      // overwrite the signer-owned source of truth.
    } else {
      if (signerLocked && requestedPrograms.length > 0) {
        requireAdmin(
          "This signer-owned wallet is locked; adding programs requires an owner-reviewed policy installation.",
          params.hosting,
        );
      }
      const allowed = new Set(params.current.programs);
      const currentGatewayAllowed = new Set(currentGatewayPrograms);
      const addedToGateway = requestedPrograms.filter(
        (program) => !currentGatewayAllowed.has(program),
      );
      if (addedToGateway.length > 0) {
        requireAdmin(
          `Adding Gateway program permission${addedToGateway.length === 1 ? "" : "s"} (${addedToGateway.join(", ")}) is a policy expansion.`,
          params.hosting,
        );
      }
      const added = requestedPrograms.filter((program) => !allowed.has(program));
      if (added.length > 0) {
        requireAdmin(
          `Adding signer program permission${added.length === 1 ? "" : "s"} (${added.join(", ")}) is a policy expansion.`,
          params.hosting,
        );
      }
      candidate.programs = requestedPrograms;
    }
  }

  if (params.gatewayPolicy.capsEnabled && params.patch.capsEnabled !== false) {
    requireGatewayAmountNotRaised({
      next: params.patch.solanaMaxPerTx,
      current: params.gatewayPolicy.solana.maxPerTx,
      field: "Solana per-transaction cap",
      hosting: params.hosting,
    });
    requireGatewayAmountNotRaised({
      next: params.patch.solanaMaxDaily,
      current: params.gatewayPolicy.solana.maxDaily,
      field: "Solana daily cap",
      hosting: params.hosting,
    });
  }

  setAssetCaps({
    candidate,
    assetId: "solana:native",
    maxPerTx:
      params.patch.solanaMaxPerTx === params.gatewayPolicy.solana.maxPerTx
        ? undefined
        : params.patch.solanaMaxPerTx,
    maxDaily:
      params.patch.solanaMaxDaily === params.gatewayPolicy.solana.maxDaily
        ? undefined
        : params.patch.solanaMaxDaily,
    hosting: params.hosting,
  });
  if (params.patch.solanaTokenCaps !== undefined) {
    for (const [mintRaw, caps] of Object.entries(params.patch.solanaTokenCaps)) {
      const mint = mintRaw.trim();
      if (!mint) {
        throw new Error("SPL token cap mint cannot be empty");
      }
      const currentGatewayCap = params.gatewayPolicy.solana.tokenCaps[mint];
      setAssetCaps({
        candidate,
        assetId: `solana:spl:${mint}`,
        maxPerTx: caps.maxPerTx === currentGatewayCap?.maxPerTx ? undefined : caps.maxPerTx,
        maxDaily: caps.maxDaily === currentGatewayCap?.maxDaily ? undefined : caps.maxDaily,
        hosting: params.hosting,
      });
    }
  }
  return candidate;
}

export function localSignerPolicyState(
  policy: LocalSocketSignerPolicyV2,
): "locked" | "acknowledged" {
  const hasUsableAsset = policy.assets.some(
    (asset) =>
      asset.destinations.length > 0 &&
      /^[1-9][0-9]*$/.test(asset.maxPerTx) &&
      /^[1-9][0-9]*$/.test(asset.maxDaily),
  );
  const hasOnChainOperation = policy.operations.some(
    (operation) => operation !== "federation.bondChallenge",
  );
  const nativeFeeReserve = BigInt(LOCAL_SIGNER_NATIVE_FEE_RESERVATION_LAMPORTS_V2);
  const hasNativeFeeBudget = policy.assets.some(
    (asset) =>
      asset.asset === "solana:native" &&
      asset.destinations.length > 0 &&
      /^[1-9][0-9]*$/.test(asset.maxPerTx) &&
      /^[1-9][0-9]*$/.test(asset.maxDaily) &&
      BigInt(asset.maxPerTx) >= nativeFeeReserve &&
      BigInt(asset.maxDaily) >= nativeFeeReserve,
  );
  return policy.operations.length === 0 ||
    policy.programs.length === 0 ||
    !hasUsableAsset ||
    (hasOnChainOperation && !hasNativeFeeBudget)
    ? "locked"
    : "acknowledged";
}
