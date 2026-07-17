import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const DIGEST_PINNED_DOCKERFILES = [
  "Dockerfile",
  "deploy/containers/Dockerfile.sandbox",
  "deploy/containers/Dockerfile.sandbox-browser",
  "scripts/docker/cleanup-smoke/Dockerfile",
  "scripts/docker/install-sh-e2e/Dockerfile",
  "scripts/docker/install-sh-nonroot/Dockerfile",
  "scripts/docker/install-sh-smoke/Dockerfile",
  "scripts/e2e/Dockerfile",
  "scripts/e2e/Dockerfile.qr-import",
] as const;

type DependabotDockerGroup = {
  patterns?: string[];
};

type DependabotUpdate = {
  "package-ecosystem"?: string;
  directory?: string;
  schedule?: { interval?: string };
  groups?: Record<string, DependabotDockerGroup>;
};

type DependabotConfig = {
  updates?: DependabotUpdate[];
};

describe("docker base image pinning", () => {
  it("publishes a registry-qualified multi-arch manifest and verifies anonymous access", async () => {
    const workflow = await readFile(
      resolve(repoRoot, ".github/workflows/docker-release.yml"),
      "utf8",
    );

    expect(workflow).toContain('"${IMAGE}@${{ needs.build-amd64.outputs.image-digest }}"');
    expect(workflow).toContain('"${IMAGE}@${{ needs.build-arm64.outputs.image-digest }}"');
    expect(workflow).toContain("Verify public multi-architecture manifest and anonymous pull");
    expect(workflow).toContain(
      'DOCKER_CONFIG="$anonymous_config" docker buildx imagetools inspect',
    );
    expect(workflow).toContain(
      'DOCKER_CONFIG="$anonymous_config" docker pull --platform linux/amd64',
    );
    expect(workflow).toContain("grep -Fq 'linux/amd64'");
    expect(workflow).toContain("grep -Fq 'linux/arm64'");
    expect(workflow.match(/push-by-digest=true/g)).toHaveLength(2);
    expect(workflow).not.toContain("${IMAGE}:${version}-amd64");
    expect(workflow).not.toContain("${IMAGE}:${version}-arm64");
    expect(workflow).toContain("Attest public multi-architecture image");
    expect(workflow).toContain("push-to-registry: true");
    expect(workflow).toContain("fased-container-v${version}.json");
    expect(workflow).toContain("Attest container release metadata");
    expect(workflow).toContain("Publish container release metadata");
    expect(workflow).toContain('release_commit="$(git rev-parse HEAD)"');
    expect(workflow).toContain("--metadata-file /tmp/fased-image-create-metadata.json");
    expect(workflow).toContain('metadata?.["containerimage.descriptor"]?.digest');
    expect(workflow).toContain('imagetools inspect "${IMAGE}@${manifest_digest}"');
    expect(workflow).not.toContain("sha256sum /tmp/fased-image-manifest.json");
  });

  it("pins selected Dockerfile FROM lines to immutable sha256 digests", async () => {
    for (const dockerfilePath of DIGEST_PINNED_DOCKERFILES) {
      const dockerfile = await readFile(resolve(repoRoot, dockerfilePath), "utf8");
      const fromLines = dockerfile
        .split(/\r?\n/)
        .filter((line) => line.trimStart().startsWith("FROM "));
      expect(fromLines.length, `${dockerfilePath} should define a FROM line`).toBeGreaterThan(0);
      for (const fromLine of fromLines) {
        expect(fromLine, `${dockerfilePath} FROM must be digest-pinned`).toMatch(
          /^FROM\s+\S+@sha256:[a-f0-9]{64}(?:\s+AS\s+[A-Za-z0-9._-]+)?$/,
        );
      }
    }
  });

  it("keeps Dependabot Docker updates enabled for root and deploy Dockerfiles", async () => {
    const raw = await readFile(resolve(repoRoot, ".github/dependabot.yml"), "utf8");
    const config = parse(raw) as DependabotConfig;
    const dockerDirectories = new Set(
      config.updates
        ?.filter((update) => update["package-ecosystem"] === "docker")
        .map((update) => update.directory),
    );
    const dockerUpdate = config.updates?.find(
      (update) => update["package-ecosystem"] === "docker" && update.directory === "/",
    );
    const sandboxDockerUpdate = config.updates?.find(
      (update) =>
        update["package-ecosystem"] === "docker" && update.directory === "/deploy/containers",
    );

    expect(dockerDirectories).toContain("/");
    expect(dockerDirectories).toContain("/deploy/containers");
    expect(dockerUpdate).toBeDefined();
    expect(dockerUpdate?.schedule?.interval).toBe("weekly");
    expect(dockerUpdate?.groups?.["docker-images"]?.patterns).toContain("*");
    expect(sandboxDockerUpdate?.schedule?.interval).toBe("weekly");
    expect(sandboxDockerUpdate?.groups?.["docker-images"]?.patterns).toContain("*");
  });
});
