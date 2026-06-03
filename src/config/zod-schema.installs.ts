import { z } from "zod";

export const InstallSourceSchema = z.union([
  z.literal("npm"),
  z.literal("archive"),
  z.literal("path"),
  z.literal("clawhub"),
]);

export const InstallRecordShape = {
  source: InstallSourceSchema,
  spec: z.string().optional(),
  sourcePath: z.string().optional(),
  installPath: z.string().optional(),
  version: z.string().optional(),
  resolvedName: z.string().optional(),
  resolvedVersion: z.string().optional(),
  resolvedSpec: z.string().optional(),
  integrity: z.string().optional(),
  shasum: z.string().optional(),
  resolvedAt: z.string().optional(),
  installedAt: z.string().optional(),
  clawhubUrl: z.string().optional(),
  clawhubArtifactUrl: z.string().optional(),
  clawhubPackage: z.string().optional(),
  clawhubFamily: z.union([z.literal("code-plugin"), z.literal("bundle-plugin")]).optional(),
  clawhubChannel: z
    .union([z.literal("official"), z.literal("community"), z.literal("private")])
    .optional(),
  artifactKind: z
    .union([z.literal("legacy-zip"), z.literal("npm-pack"), z.literal("clawpack")])
    .optional(),
  artifactFormat: z.union([z.literal("zip"), z.literal("tgz")]).optional(),
  npmIntegrity: z.string().optional(),
  npmShasum: z.string().optional(),
  npmTarballName: z.string().optional(),
  clawpackSha256: z.string().optional(),
  clawpackSpecVersion: z.number().int().nonnegative().optional(),
  clawpackManifestSha256: z.string().optional(),
  clawpackSize: z.number().int().nonnegative().optional(),
  securityState: z.string().optional(),
  scanState: z.string().optional(),
  moderationState: z.string().optional(),
  readinessPhase: z.string().optional(),
  verificationTier: z.string().optional(),
  verificationSourceRepo: z.string().optional(),
  verificationSourceCommit: z.string().optional(),
  verificationHasProvenance: z.boolean().optional(),
} as const;
