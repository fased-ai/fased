import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { AgentCapabilityPackIdSchema } from "./agent-profile-contracts.js";
import { stableStringify } from "./stable-stringify.js";

const MANIFEST_DOMAIN = "fased.first-party-capability-manifest.v1";
const Identifier = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u)
  .max(96);
const ShortList = z.array(z.string().trim().min(1).max(256)).max(128);
const CanonicalTimestamp = z.string().refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}, "must be a canonical ISO timestamp");

export const CapabilityPermissionSetSchema = z
  .object({
    workspaceRead: ShortList,
    workspaceWrite: ShortList,
    networkOrigins: ShortList,
    secretIds: ShortList,
    modelIds: ShortList,
    walletRoles: ShortList,
    programIds: ShortList,
    assetIds: ShortList,
    subprocessCommands: ShortList,
    publicationScopes: ShortList,
  })
  .strict()
  .superRefine((value, context) => {
    for (const [field, entries] of Object.entries(value)) {
      if (new Set(entries).size !== entries.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: "permission entries must be unique",
        });
      }
    }
  });

export const FirstPartyCapabilityManifestSchema = z
  .object({
    schema: z.literal("fased.first-party-capability-manifest.v1"),
    capabilityId: Identifier,
    version: z.number().int().positive().max(1_000_000),
    adapterId: Identifier,
    adapterOperations: z.array(Identifier).min(1).max(128),
    capabilityPacks: z.array(AgentCapabilityPackIdSchema).max(8),
    permissions: CapabilityPermissionSetSchema,
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    issuedAt: CanonicalTimestamp,
    expiresAt: CanonicalTimestamp.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const field of ["adapterOperations", "capabilityPacks"] as const) {
      if (new Set(value[field]).size !== value[field].length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} entries must be unique`,
        });
      }
    }
    if (value.expiresAt && Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be later than issuedAt",
      });
    }
  });

export const SignedFirstPartyCapabilityManifestSchema = z
  .object({
    schema: z.literal("fased.signed-first-party-capability-manifest.v1"),
    signerKeyId: Identifier,
    signature: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/u)
      .max(256),
    manifest: FirstPartyCapabilityManifestSchema,
  })
  .strict();

export type CapabilityPermissionSet = z.infer<typeof CapabilityPermissionSetSchema>;
export type FirstPartyCapabilityManifest = z.infer<typeof FirstPartyCapabilityManifestSchema>;
export type SignedFirstPartyCapabilityManifest = z.infer<
  typeof SignedFirstPartyCapabilityManifestSchema
>;

function signingPayload(manifest: FirstPartyCapabilityManifest): Buffer {
  return Buffer.from(`${MANIFEST_DOMAIN}\0${stableStringify(manifest)}`, "utf8");
}

export function firstPartySignerKeyId(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  const der = key.export({ format: "der", type: "spki" });
  return `ed25519.${createHash("sha256").update(der).digest("hex").slice(0, 32)}`;
}

export function verifySignedFirstPartyCapabilityManifest(params: {
  envelope: unknown;
  trustedSignerKeys: Readonly<Record<string, string>>;
  now?: Date;
}): SignedFirstPartyCapabilityManifest {
  const envelope = SignedFirstPartyCapabilityManifestSchema.parse(params.envelope);
  const publicKeyPem = params.trustedSignerKeys[envelope.signerKeyId];
  if (!publicKeyPem) {
    throw new Error("Capability manifest signer is not a trusted first-party key");
  }
  if (firstPartySignerKeyId(publicKeyPem) !== envelope.signerKeyId) {
    throw new Error("Capability manifest signer key id does not match its public key");
  }
  if (
    !verify(
      null,
      signingPayload(envelope.manifest),
      createPublicKey(publicKeyPem),
      Buffer.from(envelope.signature, "base64"),
    )
  ) {
    throw new Error("Capability manifest signature is invalid");
  }
  const now = params.now ?? new Date();
  if (envelope.manifest.expiresAt && Date.parse(envelope.manifest.expiresAt) <= now.getTime()) {
    throw new Error("Capability manifest is expired");
  }
  return envelope;
}

const PERMISSION_FIELDS = [
  "workspaceRead",
  "workspaceWrite",
  "networkOrigins",
  "secretIds",
  "modelIds",
  "walletRoles",
  "programIds",
  "assetIds",
  "subprocessCommands",
  "publicationScopes",
] as const satisfies ReadonlyArray<keyof CapabilityPermissionSet>;

export type CapabilityPermissionDiff = Record<
  keyof CapabilityPermissionSet,
  { added: string[]; removed: string[] }
>;

export function diffCapabilityPermissions(
  previous: CapabilityPermissionSet,
  next: CapabilityPermissionSet,
): CapabilityPermissionDiff {
  const before = CapabilityPermissionSetSchema.parse(previous);
  const after = CapabilityPermissionSetSchema.parse(next);
  return Object.fromEntries(
    PERMISSION_FIELDS.map((field) => {
      const previousValues = new Set(before[field]);
      const nextValues = new Set(after[field]);
      return [
        field,
        {
          added: after[field].filter((value) => !previousValues.has(value)).toSorted(),
          removed: before[field].filter((value) => !nextValues.has(value)).toSorted(),
        },
      ];
    }),
  ) as CapabilityPermissionDiff;
}

export function createZeroCapabilityPermissions(): CapabilityPermissionSet {
  return {
    workspaceRead: [],
    workspaceWrite: [],
    networkOrigins: [],
    secretIds: [],
    modelIds: [],
    walletRoles: [],
    programIds: [],
    assetIds: [],
    subprocessCommands: [],
    publicationScopes: [],
  };
}

export const capabilityManifestSigningPayloadForTest = signingPayload;
