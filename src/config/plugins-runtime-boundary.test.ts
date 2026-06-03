import { describe, expect, it } from "vitest";
import { FIELD_HELP } from "./schema.help.js";
import { FIELD_LABELS } from "./schema.labels.js";
import { FasedAgentSchema } from "./zod-schema.js";

function hasLegacyPluginsRuntimeKeys(keys: string[]): boolean {
  return keys.some((key) => key === "plugins.runtime" || key.startsWith("plugins.runtime."));
}

describe("plugins runtime boundary config", () => {
  it("omits legacy plugins.runtime keys from schema metadata", () => {
    expect(hasLegacyPluginsRuntimeKeys(Object.keys(FIELD_HELP))).toBe(false);
    expect(hasLegacyPluginsRuntimeKeys(Object.keys(FIELD_LABELS))).toBe(false);
  });

  it("omits plugins.runtime from the generated config schema", () => {
    const schema = FasedAgentSchema.toJSONSchema({
      target: "draft-7",
      io: "input",
      reused: "ref",
    }) as {
      properties?: Record<string, { properties?: Record<string, unknown> }>;
    };
    const pluginsProperties = schema.properties?.plugins?.properties ?? {};
    expect("runtime" in pluginsProperties).toBe(false);
  });

  it("rejects legacy plugins.runtime config entries", () => {
    const result = FasedAgentSchema.safeParse({
      plugins: {
        runtime: {
          allowLegacyExec: true,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts reviewed ClawHub plugin install metadata", () => {
    const result = FasedAgentSchema.safeParse({
      plugins: {
        installs: {
          demo: {
            source: "clawhub",
            clawhubUrl: "https://clawhub.com",
            clawhubArtifactUrl: "https://clawhub.com/artifacts/demo.zip",
            clawhubPackage: "@fased/demo",
            clawhubFamily: "code-plugin",
            clawhubChannel: "official",
            version: "1.0.0",
            integrity: "sha256-old",
            artifactKind: "clawpack",
            artifactFormat: "zip",
            clawpackSha256: "clawpack-sha256",
            clawpackSpecVersion: 1,
            clawpackManifestSha256: "manifest-sha256",
            clawpackSize: 1024,
            verificationHasProvenance: true,
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects unsupported plugin install sources", () => {
    const result = FasedAgentSchema.safeParse({
      plugins: {
        installs: {
          demo: {
            source: "git",
            spec: "https://example.invalid/demo.git",
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });
});
