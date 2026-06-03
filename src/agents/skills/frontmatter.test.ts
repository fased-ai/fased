import { describe, expect, it } from "vitest";
import { resolveFasedAgentMetadata, resolveSkillInvocationPolicy } from "./frontmatter.js";

describe("resolveSkillInvocationPolicy", () => {
  it("defaults to enabled behaviors", () => {
    const policy = resolveSkillInvocationPolicy({});
    expect(policy.userInvocable).toBe(true);
    expect(policy.disableModelInvocation).toBe(false);
  });

  it("parses frontmatter boolean strings", () => {
    const policy = resolveSkillInvocationPolicy({
      "user-invocable": "no",
      "disable-model-invocation": "yes",
    });
    expect(policy.userInvocable).toBe(false);
    expect(policy.disableModelInvocation).toBe(true);
  });
});

describe("resolveFasedAgentMetadata install parsing", () => {
  function resolveInstall(frontmatter: Record<string, string>) {
    return resolveFasedAgentMetadata(frontmatter)?.install;
  }

  it("accepts safe install specs", () => {
    const install = resolveInstall({
      metadata:
        '{"fased":{"install":[{"kind":"brew","formula":"python@3.12"},{"kind":"node","package":"@scope/pkg@1.2.3"},{"kind":"go","module":"example.com/tool/cmd@v1.2.3"},{"kind":"uv","package":"uvicorn[standard]==0.31.0"},{"kind":"download","url":"https://example.com/tool.tar.gz"}]}}',
    });
    expect(install).toEqual([
      { kind: "brew", formula: "python@3.12" },
      { kind: "node", package: "@scope/pkg@1.2.3" },
      { kind: "go", module: "example.com/tool/cmd@v1.2.3" },
      { kind: "uv", package: "uvicorn[standard]==0.31.0" },
      { kind: "download", url: "https://example.com/tool.tar.gz" },
    ]);
  });

  it("preserves brew formula strings without installer policy validation", () => {
    const install = resolveInstall({
      metadata: '{"fased":{"install":[{"kind":"brew","formula":"wget --HEAD"}]}}',
    });
    expect(install).toEqual([{ kind: "brew", formula: "wget --HEAD" }]);
  });

  it("preserves node package specs without installer policy validation", () => {
    const install = resolveInstall({
      metadata: '{"fased":{"install":[{"kind":"node","package":"file:../malicious"}]}}',
    });
    expect(install).toEqual([{ kind: "node", package: "file:../malicious" }]);
  });

  it("preserves go module specs without installer policy validation", () => {
    const install = resolveInstall({
      metadata: '{"fased":{"install":[{"kind":"go","module":"https://evil.example/mod"}]}}',
    });
    expect(install).toEqual([{ kind: "go", module: "https://evil.example/mod" }]);
  });

  it("preserves download urls without installer policy validation", () => {
    const install = resolveInstall({
      metadata: '{"fased":{"install":[{"kind":"download","url":"file:///tmp/payload.tgz"}]}}',
    });
    expect(install).toEqual([{ kind: "download", url: "file:///tmp/payload.tgz" }]);
  });
});

describe("resolveFasedAgentMetadata config fields", () => {
  it("parses typed local and root config fields", () => {
    const metadata = resolveFasedAgentMetadata({
      metadata:
        '{"fased":{"configFields":[{"key":"mode","label":"Mode","type":"string"},{"path":"channels.discord.token","label":"Discord token","type":"secret","required":true}]}}',
    });

    expect(metadata?.configFields).toEqual([
      { key: "mode", label: "Mode", type: "string" },
      {
        path: "channels.discord.token",
        label: "Discord token",
        type: "secret",
        required: true,
      },
    ]);
  });
});
