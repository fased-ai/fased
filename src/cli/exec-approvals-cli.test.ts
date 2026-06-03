import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalsFile } from "../infra/exec-approvals.js";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const callGatewayFromCli = vi.fn(async (method: string, _opts: unknown, params?: unknown) => {
  if (method.endsWith(".get")) {
    return {
      path: "/tmp/exec-approvals.json",
      exists: true,
      hash: "hash-1",
      file: { version: 1, agents: {} },
    };
  }
  return { method, params };
});

const { runtimeLogs, runtimeErrors, defaultRuntime, resetRuntimeCapture } =
  createCliRuntimeCapture();

const localSnapshot: {
  path: string;
  exists: boolean;
  raw: string;
  hash: string;
  file: ExecApprovalsFile;
} = {
  path: "/tmp/local-exec-approvals.json",
  exists: true,
  raw: "{}",
  hash: "hash-local",
  file: { version: 1, agents: {} },
};

function resetLocalSnapshot() {
  localSnapshot.file = { version: 1, agents: {} };
}

vi.mock("./gateway-rpc.js", () => ({
  callGatewayFromCli: (method: string, opts: unknown, params?: unknown) =>
    callGatewayFromCli(method, opts, params),
}));

vi.mock("./nodes-cli/rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./nodes-cli/rpc.js")>("./nodes-cli/rpc.js");
  return {
    ...actual,
    resolveNodeId: vi.fn(async () => "node-1"),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../infra/exec-approvals.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/exec-approvals.js")>(
    "../infra/exec-approvals.js",
  );
  return {
    ...actual,
    readExecApprovalsSnapshot: () => localSnapshot,
    saveExecApprovals: vi.fn(),
  };
});

const { registerExecApprovalsCli } = await import("./exec-approvals-cli.js");
const execApprovals = await import("../infra/exec-approvals.js");

describe("exec approvals CLI", () => {
  const createProgram = () => {
    const program = new Command();
    program.exitOverride();
    registerExecApprovalsCli(program);
    return program;
  };

  const runApprovalsCommand = async (args: string[]) => {
    const program = createProgram();
    await program.parseAsync(args, { from: "user" });
  };

  beforeEach(() => {
    resetLocalSnapshot();
    resetRuntimeCapture();
    callGatewayFromCli.mockClear();
    vi.mocked(execApprovals.saveExecApprovals).mockClear();
  });

  it("routes get command to local, gateway, and node modes", async () => {
    await runApprovalsCommand(["approvals", "get"]);

    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(runtimeErrors).toHaveLength(0);
    callGatewayFromCli.mockClear();

    await runApprovalsCommand(["approvals", "get", "--gateway"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith("exec.approvals.get", expect.anything(), {});
    expect(runtimeErrors).toHaveLength(0);
    callGatewayFromCli.mockClear();

    await runApprovalsCommand(["approvals", "get", "--node", "macbook"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith("exec.approvals.node.get", expect.anything(), {
      nodeId: "node-1",
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("shows local effective policy without writing", async () => {
    localSnapshot.file = {
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
      agents: {
        "*": {
          autoAllowSkills: true,
          allowlist: [{ pattern: "/usr/bin/uname" }],
        },
        main: {
          ask: "always",
        },
      },
    };
    const saveExecApprovals = vi.mocked(execApprovals.saveExecApprovals);
    saveExecApprovals.mockClear();

    await runApprovalsCommand(["approvals", "policy", "show", "--json"]);

    const payload = JSON.parse(runtimeLogs.at(-1) ?? "{}");
    expect(payload).toMatchObject({
      source: "local",
      target: "local",
      agentId: "main",
      policy: {
        security: "allowlist",
        ask: "always",
        askFallback: "deny",
        autoAllowSkills: true,
      },
      allowlistCount: 1,
    });
    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(saveExecApprovals).not.toHaveBeenCalled();
    expect(runtimeErrors).toHaveLength(0);
  });

  it("routes policy show to gateway and node targets", async () => {
    await runApprovalsCommand(["approvals", "policy", "show", "--gateway", "--json"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith("exec.approvals.get", expect.anything(), {});
    let payload = JSON.parse(runtimeLogs.at(-1) ?? "{}");
    expect(payload).toMatchObject({ source: "gateway", target: "gateway" });
    expect(runtimeErrors).toHaveLength(0);
    callGatewayFromCli.mockClear();
    resetRuntimeCapture();

    await runApprovalsCommand([
      "approvals",
      "policy",
      "show",
      "--node",
      "macbook",
      "--agent",
      "ops",
      "--json",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledWith("exec.approvals.node.get", expect.anything(), {
      nodeId: "node-1",
    });
    payload = JSON.parse(runtimeLogs.at(-1) ?? "{}");
    expect(payload).toMatchObject({ source: "node", target: "node:node-1", agentId: "ops" });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("sets local policy defaults without changing allowlists", async () => {
    localSnapshot.file = {
      version: 1,
      socket: { path: "/tmp/approvals.sock", token: "token-1" },
      agents: {
        "*": {
          allowlist: [{ pattern: "/usr/bin/uname" }],
        },
      },
    };
    const saveExecApprovals = vi.mocked(execApprovals.saveExecApprovals);
    saveExecApprovals.mockClear();

    await runApprovalsCommand([
      "approvals",
      "policy",
      "set",
      "--security",
      "allowlist",
      "--ask",
      "always",
      "--ask-fallback",
      "deny",
      "--auto-allow-skills",
      "off",
    ]);

    expect(saveExecApprovals).toHaveBeenCalledWith(
      expect.objectContaining({
        socket: { path: "/tmp/approvals.sock", token: "token-1" },
        defaults: {
          security: "allowlist",
          ask: "always",
          askFallback: "deny",
          autoAllowSkills: false,
        },
        agents: {
          "*": {
            allowlist: [{ pattern: "/usr/bin/uname" }],
          },
        },
      }),
    );
    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(runtimeErrors).toHaveLength(0);
  });

  it("applies local cautious policy preset without changing allowlists", async () => {
    localSnapshot.file = {
      version: 1,
      socket: { path: "/tmp/approvals.sock", token: "token-1" },
      agents: {
        "*": {
          allowlist: [{ pattern: "/usr/bin/uname" }],
        },
      },
    };
    const saveExecApprovals = vi.mocked(execApprovals.saveExecApprovals);

    await runApprovalsCommand(["approvals", "policy", "preset", "cautious"]);

    expect(saveExecApprovals).toHaveBeenCalledWith(
      expect.objectContaining({
        socket: { path: "/tmp/approvals.sock", token: "token-1" },
        defaults: {
          security: "allowlist",
          ask: "on-miss",
          askFallback: "deny",
          autoAllowSkills: false,
        },
        agents: {
          "*": {
            allowlist: [{ pattern: "/usr/bin/uname" }],
          },
        },
      }),
    );
    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(runtimeErrors).toHaveLength(0);
  });

  it("applies per-agent reviewed policy preset on gateway with base hash", async () => {
    await runApprovalsCommand([
      "approvals",
      "policy",
      "preset",
      "reviewed",
      "--gateway",
      "--agent",
      "ops",
    ]);

    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      1,
      "exec.approvals.get",
      expect.anything(),
      {},
    );
    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      2,
      "exec.approvals.set",
      expect.anything(),
      expect.objectContaining({
        baseHash: "hash-1",
        file: expect.objectContaining({
          agents: {
            ops: {
              security: "allowlist",
              ask: "always",
              askFallback: "deny",
              autoAllowSkills: false,
            },
          },
        }),
      }),
    );
    expect(runtimeErrors).toHaveLength(0);
  });

  it("requires explicit confirmation for trusted-operator policy preset", async () => {
    await expect(
      runApprovalsCommand(["approvals", "policy", "preset", "trusted-operator"]),
    ).rejects.toThrow("__exit__:1");

    expect(
      runtimeErrors.some((line) => line.includes("trusted-operator preset requires --yes")),
    ).toBe(true);
    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(execApprovals.saveExecApprovals).not.toHaveBeenCalled();
  });

  it("applies trusted-operator policy preset only with confirmation", async () => {
    const saveExecApprovals = vi.mocked(execApprovals.saveExecApprovals);

    await runApprovalsCommand(["approvals", "policy", "preset", "trusted-operator", "--yes"]);

    expect(saveExecApprovals).toHaveBeenCalledWith(
      expect.objectContaining({
        defaults: {
          security: "full",
          ask: "off",
          askFallback: "full",
          autoAllowSkills: false,
        },
      }),
    );
    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(runtimeErrors).toHaveLength(0);
  });

  it("rejects unknown policy preset names before loading approvals", async () => {
    await expect(
      runApprovalsCommand(["approvals", "policy", "preset", "reckless"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.some((line) => line.includes("Preset must be one of"))).toBe(true);
    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(execApprovals.saveExecApprovals).not.toHaveBeenCalled();
  });

  it("sets per-agent policy on gateway and node targets with base hash", async () => {
    await runApprovalsCommand([
      "approvals",
      "policy",
      "set",
      "--gateway",
      "--agent",
      "ops",
      "--security",
      "full",
      "--ask",
      "off",
    ]);

    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      1,
      "exec.approvals.get",
      expect.anything(),
      {},
    );
    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      2,
      "exec.approvals.set",
      expect.anything(),
      expect.objectContaining({
        baseHash: "hash-1",
        file: expect.objectContaining({
          agents: {
            ops: {
              security: "full",
              ask: "off",
            },
          },
        }),
      }),
    );
    expect(runtimeErrors).toHaveLength(0);
    callGatewayFromCli.mockClear();
    resetRuntimeCapture();

    await runApprovalsCommand([
      "approvals",
      "policy",
      "set",
      "--node",
      "macbook",
      "--agent",
      "ops",
      "--security",
      "deny",
    ]);

    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      1,
      "exec.approvals.node.get",
      expect.anything(),
      { nodeId: "node-1" },
    );
    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      2,
      "exec.approvals.node.set",
      expect.anything(),
      expect.objectContaining({
        nodeId: "node-1",
        baseHash: "hash-1",
        file: expect.objectContaining({
          agents: {
            ops: {
              security: "deny",
            },
          },
        }),
      }),
    );
    expect(runtimeErrors).toHaveLength(0);
  });

  it("rejects policy set without explicit fields", async () => {
    await expect(runApprovalsCommand(["approvals", "policy", "set"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.some((line) => line.includes("Provide at least one policy field"))).toBe(
      true,
    );
    expect(callGatewayFromCli).not.toHaveBeenCalled();
  });

  it("rejects invalid policy set values", async () => {
    await expect(
      runApprovalsCommand(["approvals", "policy", "set", "--security", "maybe"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.some((line) => line.includes("Security must be one of"))).toBe(true);
    expect(callGatewayFromCli).not.toHaveBeenCalled();
  });

  it("defaults allowlist add to wildcard agent", async () => {
    const saveExecApprovals = vi.mocked(execApprovals.saveExecApprovals);
    saveExecApprovals.mockClear();

    await runApprovalsCommand(["approvals", "allowlist", "add", "/usr/bin/uname"]);

    expect(callGatewayFromCli).not.toHaveBeenCalledWith(
      "exec.approvals.set",
      expect.anything(),
      {},
    );
    expect(saveExecApprovals).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          "*": expect.anything(),
        }),
      }),
    );
  });

  it("removes wildcard allowlist entry and prunes empty agent", async () => {
    localSnapshot.file = {
      version: 1,
      agents: {
        "*": {
          allowlist: [{ pattern: "/usr/bin/uname", lastUsedAt: Date.now() }],
        },
      },
    };

    const saveExecApprovals = vi.mocked(execApprovals.saveExecApprovals);
    saveExecApprovals.mockClear();

    await runApprovalsCommand(["approvals", "allowlist", "remove", "/usr/bin/uname"]);

    expect(saveExecApprovals).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        agents: undefined,
      }),
    );
    expect(runtimeErrors).toHaveLength(0);
  });
});
