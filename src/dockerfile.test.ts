import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const dockerfilePath = join(repoRoot, "Dockerfile");
const dockerignorePath = join(repoRoot, ".dockerignore");

describe("Dockerfile", () => {
  it("does not execute remote installer scripts during the image build", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");

    expect(dockerfile).not.toMatch(/curl\b[^\n|]*\|\s*(?:ba)?sh\b/u);
    expect(dockerfile).not.toContain("bun.sh/install");
  });

  it("installs optional browser dependencies after pnpm install", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
    const browserArgIndex = dockerfile.indexOf("ARG FASED_INSTALL_BROWSER");

    expect(installIndex).toBeGreaterThan(-1);
    expect(browserArgIndex).toBeGreaterThan(-1);
    expect(browserArgIndex).toBeGreaterThan(installIndex);
    expect(dockerfile).toContain(
      "node /app/node_modules/playwright-core/cli.js install --with-deps chromium",
    );
    expect(dockerfile).toContain("apt-get install -y --no-install-recommends xvfb");
  });

  it("runs the final image as the non-root node user", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const userInstructions = dockerfile
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("USER "));

    expect(userInstructions.at(-1)).toBe("USER node");
  });

  it("embeds the release-matched Compose definition used by the transactional updater", async () => {
    const [dockerfile, dockerignore] = await Promise.all([
      readFile(dockerfilePath, "utf8"),
      readFile(dockerignorePath, "utf8"),
    ]);

    expect(dockerfile).toContain("COPY --chown=node:node . .");
    expect(dockerignore).not.toMatch(/^docker-compose\.yml$/mu);
    expect(dockerignore).not.toMatch(/^docker-compose\.\*$/mu);
    expect(dockerfile).toContain("COPY package.json /src/package.json");
    expect(dockerfile).toContain('signer_version="$FASED_SIGNER_BUILD_VERSION"');
    expect(dockerfile).toContain("/src/package.json");
  });

  it("excludes local secrets and operator state from the build context", async () => {
    const [dockerignore, dockerfile] = await Promise.all([
      readFile(dockerignorePath, "utf8"),
      readFile(dockerfilePath, "utf8"),
    ]);
    const entries = new Set(
      dockerignore
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#")),
    );
    const requiredEntries = [
      ".env",
      ".env.*",
      "**/.env",
      "**/.env.*",
      ".fased",
      "**/.fased",
      "**/.agents",
      "**/.claude",
      "**/.codex",
      "**/.cursor",
      "**/.ssh",
      "**/.docker/config.json",
      ".npmrc",
      "**/.npmrc",
      "**/.pypirc",
      "**/.config/gh",
      "**/.config/gcloud",
      "**/.config/anthropic",
      "**/.config/openai",
      "**/.terraform.d/credentials.tfrc.json",
      "**/.git-credentials",
      "**/.netrc",
      "**/*.pem",
      "**/*.key",
      "**/*.jks",
      "**/*.keystore",
      "**/*.kdbx",
      "**/*.agekey",
      "**/id_ed25519",
      "**/id_rsa",
    ];

    for (const entry of requiredEntries) {
      expect(entries, `.dockerignore must contain ${entry}`).toContain(entry);
    }
    expect(dockerfile).not.toMatch(/COPY[^\n]*\.npmrc/u);
  });
});
