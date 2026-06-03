import fs from "node:fs/promises";
import path from "node:path";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../../../src/infra/device-identity.js";
import type { SatAuditArtifact } from "./audit-store.js";
import { buildSatDisputeReview } from "./dispute-review.js";

export type SatValidatorArtifact = {
  schema: "sat-validator-artifact-v1";
  kind: "round-review" | "epoch-review";
  roundKey: string;
  payload: {
    metadata: {
      roundKey: string;
      epochId: number | null;
      microRoundId: number | null;
      validatorAuthority: string | null;
      targetAuthority: string | null;
    };
    audit: SatAuditArtifact;
    roots: {
      bucketHash?: string;
      bucketRoot?: string;
      scoreRoot?: string;
      coordinationRoot?: string;
    };
    disputeReview: {
      reasons: string[];
      evidenceBundle: {
        roundKey: string;
        targetAuthority: string | null;
        bucketHash: string | null;
        coordinationHash: string | null;
        coordinationGroupHash: string | null;
        coordinationMessageRoot: string | null;
        coordinationPeerCount: number | null;
        coordinationIntent: number | null;
      };
    };
    exportedAt: string;
  };
  signature: {
    type: "ed25519";
    publicKey: string;
    deviceId: string;
    value: string;
  };
};

export type SatValidatorArtifactMatch = {
  filePath: string;
  artifact: SatValidatorArtifact;
};

export function resolveSatValidatorArtifactsDir(stateDir: string): string {
  return path.join(stateDir, "sat-mining", "validator-artifacts");
}

function artifactFileName(roundKey: string, targetAuthority?: string | null): string {
  const target = targetAuthority?.trim();
  return target ? `${roundKey}--${target}.json` : `${roundKey}.json`;
}

export function resolveSatValidatorArtifactPath(
  stateDir: string,
  roundKey: string,
  targetAuthority?: string | null,
): string {
  return path.join(
    resolveSatValidatorArtifactsDir(stateDir),
    artifactFileName(roundKey, targetAuthority),
  );
}

export async function writeSatValidatorArtifact(
  stateDir: string,
  artifact: SatValidatorArtifact,
): Promise<string> {
  const filePath = resolveSatValidatorArtifactPath(
    stateDir,
    artifact.roundKey,
    artifact.payload.metadata.targetAuthority,
  );
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return filePath;
}

export async function findSatValidatorArtifact(
  stateDir: string,
  params: { roundKey: string; targetAuthority?: string | null },
): Promise<SatValidatorArtifactMatch | null> {
  const candidates = [
    resolveSatValidatorArtifactPath(stateDir, params.roundKey, params.targetAuthority),
    resolveSatValidatorArtifactPath(stateDir, params.roundKey),
  ];
  for (const filePath of candidates) {
    try {
      const artifact = JSON.parse(await fs.readFile(filePath, "utf8")) as SatValidatorArtifact;
      const target = params.targetAuthority?.trim();
      if (!target || artifact.payload.metadata.targetAuthority === target) {
        return { filePath, artifact };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function buildSatValidatorArtifact(params: {
  roundKey: string;
  audit: SatAuditArtifact;
  roots: {
    bucketHash?: string;
    bucketRoot?: string;
    scoreRoot?: string;
    coordinationRoot?: string;
  };
  targetAuthority?: string;
  validatorAuthority?: string;
  kind: "round-review" | "epoch-review";
}): SatValidatorArtifact {
  const identity = loadOrCreateDeviceIdentity();
  const payload = {
    metadata: {
      roundKey: params.roundKey,
      epochId: params.audit.context?.epochId ?? null,
      microRoundId: params.audit.context?.microRoundId ?? null,
      validatorAuthority: params.validatorAuthority?.trim() || null,
      targetAuthority: params.targetAuthority?.trim() || null,
    },
    audit: params.audit,
    roots: params.roots,
    disputeReview: buildSatDisputeReview(params.audit, {
      targetAuthority: params.targetAuthority,
      validatorAuthority: params.validatorAuthority,
    }),
    exportedAt: new Date().toISOString(),
  };
  const payloadText = JSON.stringify(payload);
  return {
    schema: "sat-validator-artifact-v1",
    kind: params.kind,
    roundKey: params.roundKey,
    payload,
    signature: {
      type: "ed25519",
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      deviceId: identity.deviceId,
      value: signDevicePayload(identity.privateKeyPem, payloadText),
    },
  };
}
