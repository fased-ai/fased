import { describe, expect, it } from "vitest";
import { resolveReleaseAttestationIdentity } from "./release-attestation-identity.mjs";

const repository = "fased-ai/fased";
const historicalDigest = "a".repeat(40);

function bundle(overrides: Record<string, unknown> = {}) {
  const statement = {
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://actions.github.io/buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            ref: "refs/heads/main",
            repository: "https://github.com/fased-ai/fased",
            path: ".github/workflows/hosted-runtime-release.yml",
          },
        },
        resolvedDependencies: [
          {
            uri: "git+https://github.com/fased-ai/fased@refs/heads/main",
            digest: { gitCommit: historicalDigest },
          },
        ],
      },
      runDetails: {
        builder: {
          id: "https://github.com/fased-ai/fased/.github/workflows/hosted-runtime-release.yml@refs/heads/main",
        },
        metadata: {
          invocationId: "https://github.com/fased-ai/fased/actions/runs/32645990333/attempts/1",
        },
      },
    },
    ...overrides,
  };
  return { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } };
}

describe("release attestation identity", () => {
  it("preserves the immutable protected-main identity when main has advanced", () => {
    expect(resolveReleaseAttestationIdentity(bundle(), repository)).toEqual({
      sourceRef: "refs/heads/main",
      sourceDigest: historicalDigest,
      workflowPath: ".github/workflows/hosted-runtime-release.yml",
      workflowRunId: "32645990333",
      workflowRunAttempt: 1,
    });
  });

  it("rejects evidence from another workflow identity", () => {
    expect(() =>
      resolveReleaseAttestationIdentity(
        bundle({
          predicateType: "https://slsa.dev/provenance/v1",
          predicate: {
            buildDefinition: {
              buildType: "https://actions.github.io/buildtypes/workflow/v1",
              externalParameters: {
                workflow: {
                  ref: "refs/heads/main",
                  repository: "https://github.com/fased-ai/fased",
                  path: ".github/workflows/other.yml",
                },
              },
            },
          },
        }),
        repository,
      ),
    ).toThrow("protected release workflow");
  });
});
