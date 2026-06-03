/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderNodes, type NodesProps } from "./nodes.ts";

function baseProps(overrides: Partial<NodesProps> = {}): NodesProps {
  return {
    loading: false,
    nodes: [],
    commandsCatalogLoading: false,
    commandsCatalogError: null,
    commandsCatalog: null,
    commandsCatalogScope: "both",
    devicesLoading: false,
    devicesError: null,
    devicesList: {
      pending: [],
      paired: [],
    },
    configForm: null,
    configLoading: false,
    configSaving: false,
    configDirty: false,
    configFormMode: "form",
    execApprovalsLoading: false,
    execApprovalsSaving: false,
    execApprovalsDirty: false,
    execApprovalsSnapshot: null,
    execApprovalsForm: null,
    execApprovalsSelectedAgent: null,
    execApprovalsTarget: "gateway",
    execApprovalsTargetNodeId: null,
    onRefresh: () => undefined,
    onCommandsRefresh: () => undefined,
    onCommandsScopeChange: () => undefined,
    onDevicesRefresh: () => undefined,
    onDeviceApprove: () => undefined,
    onDeviceReject: () => undefined,
    onDeviceRotate: () => undefined,
    onDeviceRevoke: () => undefined,
    onLoadConfig: () => undefined,
    onLoadExecApprovals: () => undefined,
    onConfigPatch: () => undefined,
    onConfigRemove: () => undefined,
    onSaveConfig: () => undefined,
    onBindDefault: () => undefined,
    onBindAgent: () => undefined,
    onSaveBindings: () => undefined,
    onExecApprovalsTargetChange: () => undefined,
    onExecApprovalsSelectAgent: () => undefined,
    onExecApprovalsPatch: () => undefined,
    onExecApprovalsRemove: () => undefined,
    onSaveExecApprovals: () => undefined,
    ...overrides,
  };
}

describe("nodes devices pending rendering", () => {
  it("shows pending role and scopes from effective pending auth", () => {
    const container = document.createElement("div");
    render(
      renderNodes(
        baseProps({
          devicesList: {
            pending: [
              {
                requestId: "req-1",
                deviceId: "device-1",
                displayName: "Device One",
                role: "operator",
                scopes: ["operator.admin", "operator.read"],
                ts: Date.now(),
              },
            ],
            paired: [],
          },
        }),
      ),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("role: operator");
    expect(text).toContain("scopes: operator.admin, operator.read");
  });

  it("falls back to roles when role is absent", () => {
    const container = document.createElement("div");
    render(
      renderNodes(
        baseProps({
          devicesList: {
            pending: [
              {
                requestId: "req-2",
                deviceId: "device-2",
                roles: ["node", "operator"],
                scopes: ["operator.read"],
                ts: Date.now(),
              },
            ],
            paired: [],
          },
        }),
      ),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("role: node, operator");
    expect(text).toContain("scopes: operator.read");
  });
});

describe("nodes command catalog rendering", () => {
  it("renders an end-user overview before advanced node controls", () => {
    const container = document.createElement("div");
    render(
      renderNodes(
        baseProps({
          nodes: [
            {
              nodeId: "node-1",
              connected: true,
              paired: true,
              caps: ["system.run"],
              commands: ["system.run", "status"],
            },
          ],
          devicesList: {
            pending: [
              {
                requestId: "req-1",
                deviceId: "device-2",
                scopes: ["operator.read"],
                ts: Date.now(),
              },
            ],
            paired: [
              {
                deviceId: "device-1",
                roles: ["node"],
                scopes: ["operator.read"],
                tokens: [
                  {
                    role: "node",
                    scopes: ["operator.read"],
                    createdAtMs: Date.now(),
                  },
                ],
              },
            ],
          },
        }),
      ),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Pair local devices or host nodes");
    expect(text).toContain("Pair Devices");
    expect(text).toContain("1/1 live nodes");
    expect(text).toContain("1 pending approval");
    expect(text).toContain("Live Nodes");
    expect(text).toContain("Remote Execution");
    expect(text).toContain("Gateway Node Settings");
  });

  it("summarizes runtime/node status before detailed controls", () => {
    const container = document.createElement("div");
    render(
      renderNodes(
        baseProps({
          nodes: [
            {
              nodeId: "node-1",
              connected: true,
              paired: true,
              caps: ["system.run"],
              commands: ["system.run", "status"],
            },
          ],
          devicesList: {
            pending: [
              {
                requestId: "req-1",
                deviceId: "device-2",
                scopes: ["operator.read"],
                ts: Date.now(),
              },
            ],
            paired: [
              {
                deviceId: "device-1",
                roles: ["node"],
                scopes: ["operator.read"],
                tokens: [
                  {
                    role: "node",
                    scopes: ["operator.read"],
                    createdAtMs: Date.now(),
                  },
                ],
              },
            ],
          },
          commandsCatalog: { commands: [] },
        }),
      ),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Nodes");
    expect(text).toContain("Runtime");
    expect(text).toContain("connected");
    expect(text).toContain("exec");
    expect(text).toContain("tokens");
    expect(text).toContain("commands");
  });

  it("surfaces command list counts and aliases", () => {
    const container = document.createElement("div");
    render(
      renderNodes(
        baseProps({
          commandsCatalog: {
            commands: [
              {
                name: "status",
                textAliases: ["/status"],
                description: "Show status",
                source: "native",
                scope: "both",
                acceptsArgs: false,
              },
              {
                name: "wallet_quote",
                description: "Quote wallet action",
                source: "skill",
                scope: "native",
                acceptsArgs: true,
                args: [
                  {
                    name: "mint",
                    description: "Token mint",
                    type: "string",
                    required: true,
                  },
                ],
              },
            ],
          },
        }),
      ),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Command Catalog");
    expect(text).toContain("2 total");
    expect(text).toContain("native 1");
    expect(text).toContain("skills 1");
    expect(text).toContain("Aliases: /status");
    expect(text).toContain("Args: mint*");
  });
});

describe("nodes exec approval forwarding rendering", () => {
  it("surfaces gateway discovery controls from config in Nodes", () => {
    const container = document.createElement("div");
    const onConfigPatch = vi.fn();
    const onConfigRemove = vi.fn();
    const onSaveConfig = vi.fn();
    render(
      renderNodes(
        baseProps({
          configDirty: true,
          configForm: {
            discovery: {
              mdns: { mode: "minimal" },
              wideArea: { enabled: true, domain: "fased.internal" },
            },
          },
          onConfigPatch,
          onConfigRemove,
          onSaveConfig,
        }),
      ),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Gateway Discovery");
    expect(text).toContain("mDNS and wide-area DNS-SD");

    const mdns = container.querySelector<HTMLSelectElement>(
      'select[aria-label="mDNS discovery mode"]',
    );
    expect(mdns?.value).toBe("minimal");
    mdns!.value = "full";
    mdns!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onConfigPatch).toHaveBeenCalledWith(["discovery", "mdns", "mode"], "full");

    const wideArea = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Wide-area discovery"]',
    );
    expect(wideArea?.value).toBe("on");
    wideArea!.value = "";
    wideArea!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onConfigRemove).toHaveBeenCalledWith(["discovery", "wideArea", "enabled"]);

    const domain = container.querySelector<HTMLInputElement>(
      'input[aria-label="Wide-area discovery domain"]',
    );
    expect(domain?.value).toBe("fased.internal");
    domain!.value = "tailnet.internal";
    domain!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onConfigPatch).toHaveBeenCalledWith(
      ["discovery", "wideArea", "domain"],
      "tailnet.internal",
    );

    const saveButton = container.querySelector<HTMLButtonElement>(
      'button[data-test-id="node-discovery-save"]',
    );
    expect(saveButton).toBeTruthy();
    saveButton?.click();
    expect(onSaveConfig).toHaveBeenCalled();
  });

  it("surfaces canvas host controls from config in Nodes", () => {
    const container = document.createElement("div");
    const onConfigPatch = vi.fn();
    const onConfigRemove = vi.fn();
    const onSaveConfig = vi.fn();
    render(
      renderNodes(
        baseProps({
          configDirty: true,
          configForm: {
            canvasHost: {
              enabled: true,
              root: "/tmp/fased-canvas",
              port: 18793,
              liveReload: false,
            },
          },
          onConfigPatch,
          onConfigRemove,
          onSaveConfig,
        }),
      ),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Node Canvas Host");
    expect(text).toContain("node canvas presentation");

    const enabled = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Canvas host enabled"]',
    );
    expect(enabled?.value).toBe("on");
    enabled!.value = "";
    enabled!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onConfigRemove).toHaveBeenCalledWith(["canvasHost", "enabled"]);

    const root = container.querySelector<HTMLInputElement>('input[aria-label="Canvas host root"]');
    expect(root?.value).toBe("/tmp/fased-canvas");
    root!.value = "/tmp/fased-canvas-next";
    root!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onConfigPatch).toHaveBeenCalledWith(["canvasHost", "root"], "/tmp/fased-canvas-next");

    const port = container.querySelector<HTMLInputElement>('input[aria-label="Canvas host port"]');
    expect(port?.value).toBe("18793");
    port!.value = "18794";
    port!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onConfigPatch).toHaveBeenCalledWith(["canvasHost", "port"], 18794);

    const liveReload = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Canvas host live reload"]',
    );
    expect(liveReload?.value).toBe("off");
    liveReload!.value = "on";
    liveReload!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onConfigPatch).toHaveBeenCalledWith(["canvasHost", "liveReload"], true);

    const saveButton = container.querySelector<HTMLButtonElement>(
      'button[data-test-id="node-canvas-host-save"]',
    );
    expect(saveButton).toBeTruthy();
    saveButton?.click();
    expect(onSaveConfig).toHaveBeenCalled();
  });

  it("surfaces approval prompt forwarding from config in Nodes", () => {
    const container = document.createElement("div");
    const onConfigPatch = vi.fn();
    const onSaveConfig = vi.fn();
    render(
      renderNodes(
        baseProps({
          configDirty: true,
          configForm: {
            approvals: {
              exec: {
                enabled: true,
                mode: "both",
                agentFilter: ["main"],
                sessionFilter: ["telegram:"],
                targets: [
                  {
                    channel: "telegram",
                    to: "397848047",
                    accountId: "default",
                    threadId: "root",
                  },
                ],
              },
            },
          },
          execApprovalsForm: {
            defaults: {
              security: "allowlist",
              ask: "on-miss",
              askFallback: "deny",
            },
            agents: {},
          },
          onConfigPatch,
          onSaveConfig,
        }),
      ),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Prompt forwarding");
    expect(text).toContain("forwarding on");
    expect(text).toContain("This does not change host security");
    expect(text).toContain("telegram");
    expect(text).toContain("397848047");

    const checkbox = Array.from(container.querySelectorAll("input")).find(
      (input) => input.type === "checkbox" && input.checked,
    );
    expect(checkbox).toBeTruthy();
    if (checkbox) {
      checkbox.checked = false;
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    }
    expect(onConfigPatch).toHaveBeenCalledWith(["approvals", "exec", "enabled"], false);

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save forwarding",
    );
    expect(saveButton).toBeTruthy();
    expect(saveButton?.disabled).toBe(false);
    saveButton?.click();
    expect(onSaveConfig).toHaveBeenCalled();
  });
});
