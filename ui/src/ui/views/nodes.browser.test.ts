import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderNodes, type NodesProps } from "./nodes.ts";

function createProps(overrides: Partial<NodesProps> = {}): NodesProps {
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

function text(node: Element | DocumentFragment): string {
  return node.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

describe("nodes view browser", () => {
  it("keeps node operations compact and pushes advanced controls behind expandable sections", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const onRefresh = vi.fn();
    const onDevicesRefresh = vi.fn();

    render(
      renderNodes(
        createProps({
          onRefresh,
          onDevicesRefresh,
          nodes: [
            {
              nodeId: "node-1234567890abcdefghijklmnopqrstuvwxyz",
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
                deviceId: "device-1234567890abcdefghijklmnopqrstuvwxyz",
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

    const content = text(container);
    expect(content).toContain("Pair local devices or host nodes");
    expect(content).toContain("1/1 live nodes");
    expect(content).toContain("1 pending approval");
    expect(content).toContain("node-12345...stuvwxyz");
    expect(content).toContain("device-123...stuvwxyz");
    expect(content).toContain("Paired device");
    expect(content).not.toContain("device-1234567890abcdefghijklmnopqrstuvwxyz");
    expect(content).toContain("Live Nodes");
    expect(content).toContain("Remote Execution");
    expect(content).toContain("Gateway Node Settings");

    const advancedSections = Array.from(
      container.querySelectorAll<HTMLDetailsElement>("details.nodes-advanced-section"),
    );
    expect(advancedSections).toHaveLength(2);
    expect(advancedSections.every((section) => !section.open)).toBe(true);
    expect(container.querySelectorAll<HTMLButtonElement>(".node-id-copy").length).toBeGreaterThan(
      0,
    );

    container.querySelector<HTMLButtonElement>("button")?.click();
    expect(onDevicesRefresh).toHaveBeenCalledOnce();

    container.remove();
  });
});
