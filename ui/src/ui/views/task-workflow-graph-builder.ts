import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../icons.ts";
import type {
  TaskWorkflowDraft,
  TaskWorkflowGraphDraft,
  TaskWorkflowGraphEdge,
  TaskWorkflowGraphEdgeEvent,
  TaskWorkflowGraphNode,
  TaskWorkflowGraphNodeType,
  TaskWorkflowGraphRunState,
} from "../types.ts";

const GRAPH_NODE_TYPES: TaskWorkflowGraphNodeType[] = [
  "task",
  "approval",
  "condition",
  "wait",
  "handoff",
  "notify",
  "end",
];

const GRAPH_EDGE_EVENTS: TaskWorkflowGraphEdgeEvent[] = [
  "success",
  "failure",
  "approved",
  "rejected",
  "true",
  "false",
  "next",
];

const GRAPH_NODE_WIDTH = 260;
const GRAPH_NODE_HEIGHT = 72;
const GRAPH_NODE_X_STEP = 272;
const GRAPH_NODE_Y_STEP = 142;

type GraphPosition = { x: number; y: number };

export type TaskWorkflowGraphBuilderProps = {
  agentId: string;
  draft: TaskWorkflowGraphDraft;
  busy: boolean;
  definitionsBusy: boolean;
  onPatch?: (patch: Partial<TaskWorkflowGraphDraft>) => void;
  onAddNode?: (type: TaskWorkflowGraphNodeType) => void;
  onUpdateNode?: (nodeId: string, patch: Partial<TaskWorkflowGraphNode>) => void;
  onRemoveNode?: (nodeId: string) => void;
  onMoveNode?: (nodeId: string, x: number, y: number) => void;
  onAddEdge?: (from: string, to: string, on?: TaskWorkflowGraphEdgeEvent) => void;
  onUpdateEdge?: (edgeId: string, patch: Partial<TaskWorkflowGraphEdge>) => void;
  onRemoveEdge?: (edgeId: string) => void;
  onAutoLayout?: () => void;
  onImportJson?: () => void;
  onExportJson?: () => void;
  onPreview?: (agentId: string) => void;
  onSave?: (agentId: string) => void;
  onRun?: (agentId: string) => void;
  onCancel?: () => void;
};

function nodePosition(draft: TaskWorkflowGraphDraft, nodeId: string, index: number): GraphPosition {
  return (
    draft.graph.layout?.nodes[nodeId] ?? {
      x: 32 + (index % 4) * GRAPH_NODE_X_STEP,
      y: 76 + Math.floor(index / 4) * GRAPH_NODE_Y_STEP,
    }
  );
}

function nodeCenter(position: GraphPosition): GraphPosition {
  return { x: position.x + GRAPH_NODE_WIDTH / 2, y: position.y + GRAPH_NODE_HEIGHT / 2 };
}

function viewPosition(draft: TaskWorkflowGraphDraft, position: GraphPosition): GraphPosition {
  return {
    x: draft.panX + position.x * draft.zoom,
    y: draft.panY + position.y * draft.zoom,
  };
}

function nodeTone(type: TaskWorkflowGraphNodeType): string {
  if (type === "approval") {
    return "warn";
  }
  if (type === "condition") {
    return "info";
  }
  if (type === "end") {
    return "ok";
  }
  return "muted";
}

type WorkflowRunStep = NonNullable<TaskWorkflowGraphRunState["steps"]>[number];

function runTone(status: TaskWorkflowGraphRunState["status"] | WorkflowRunStep["status"]): string {
  if (status === "succeeded") {
    return "ok";
  }
  if (status === "queued" || status === "running") {
    return "info";
  }
  if (status === "failed" || status === "blocked" || status === "lost") {
    return "danger";
  }
  if (status === "cancelled" || status === "skipped") {
    return "warn";
  }
  return "muted";
}

function normalizeRunMatchKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function runStepForNode(
  runState: TaskWorkflowGraphRunState | undefined,
  node: TaskWorkflowGraphNode,
): WorkflowRunStep | undefined {
  const steps = runState?.steps ?? [];
  const idMatch = steps.find((step) => step.id === node.id);
  if (idMatch) {
    return idMatch;
  }
  const nodeKey = normalizeRunMatchKey(node.label || node.id);
  return steps.find(
    (step) =>
      normalizeRunMatchKey(step.label ?? step.id) === nodeKey ||
      normalizeRunMatchKey(step.id) === nodeKey,
  );
}

function workflowRunSummary(runState: TaskWorkflowGraphRunState): string {
  const blocked = runState.steps?.find((step) => step.status === "blocked");
  if (blocked) {
    return `Waiting at ${blocked.label ?? blocked.id}`;
  }
  const failed = runState.steps?.find((step) => step.status === "failed" || step.status === "lost");
  if (failed) {
    return `Failed at ${failed.label ?? failed.id}`;
  }
  const running = runState.steps?.find((step) => step.status === "running");
  if (running) {
    return `Running ${running.label ?? running.id}`;
  }
  const queued = runState.steps?.find((step) => step.status === "queued");
  if (queued && runState.status !== "succeeded") {
    return `Queued ${queued.label ?? queued.id}`;
  }
  if (runState.status === "succeeded") {
    return "Workflow completed";
  }
  return runState.status.replace("_", " ");
}

function workflowRunFocusStep(runState: TaskWorkflowGraphRunState): WorkflowRunStep | undefined {
  const steps = runState.steps ?? [];
  return (
    steps.find((step) => step.status === "blocked") ??
    steps.find((step) => step.status === "failed" || step.status === "lost") ??
    steps.find((step) => step.status === "running") ??
    (runState.status !== "succeeded" ? steps.find((step) => step.status === "queued") : undefined)
  );
}

function workflowRunStepLabel(step: WorkflowRunStep): string {
  return step.label?.trim() || step.id;
}

function workflowRunStepNodeId(
  draft: TaskWorkflowGraphDraft,
  step: WorkflowRunStep,
): string | null {
  const exact = draft.graph.nodes.find((node) => node.id === step.id);
  if (exact) {
    return exact.id;
  }
  const stepKey = normalizeRunMatchKey(step.label ?? step.id);
  const labelMatch = draft.graph.nodes.find(
    (node) =>
      normalizeRunMatchKey(node.label || node.id) === stepKey ||
      normalizeRunMatchKey(node.id) === stepKey,
  );
  return labelMatch?.id ?? null;
}

function workflowRunStepMeta(step: WorkflowRunStep): string {
  const pieces = [step.status.replace("_", " ")];
  if (step.attempt) {
    pieces.push(
      step.maxAttempts ? `attempt ${step.attempt}/${step.maxAttempts}` : `attempt ${step.attempt}`,
    );
  }
  return pieces.join(" · ");
}

function renderWorkflowRunTimeline(
  params: TaskWorkflowGraphBuilderProps,
): TemplateResult | typeof nothing {
  const runState = params.draft.runState;
  if (!runState) {
    return nothing;
  }
  const steps = runState.steps ?? [];
  const focusStep = workflowRunFocusStep(runState);
  return html`
    <div class="workflow-graph-run-timeline" data-workflow-run-timeline="true">
      <div class="agent-task-section-title">
        <span>Run timeline</span>
        <span class=${`chip workflow-graph-run-chip workflow-graph-run-chip--${runTone(runState.status)}`}>
          ${runState.status.replace("_", " ")}
        </span>
      </div>
      <div class="workflow-graph-run-timeline-summary">
        <span class=${`task-status-dot task-status-dot--${runTone(runState.status)}`}></span>
        <div>
          <strong>${workflowRunSummary(runState)}</strong>
          <span>${runState.deliveryStatus.replace("_", " ")} · ${runState.source}/${runState.runtime}</span>
        </div>
      </div>
      ${
        steps.length === 0
          ? html`
              <div class="muted">No step timeline is recorded for this run yet.</div>
            `
          : html`
              <div class="workflow-graph-run-step-list">
                ${steps.map((step, index) => {
                  const nodeId = workflowRunStepNodeId(params.draft, step);
                  const isFocus = focusStep?.id === step.id;
                  return html`
                    <button
                      type="button"
                      class=${`workflow-graph-run-step workflow-graph-run-step--${step.status} ${isFocus ? "is-focus" : ""}`}
                      ?disabled=${!nodeId}
                      @click=${() =>
                        nodeId
                          ? params.onPatch?.({ selectedNodeId: nodeId, selectedEdgeId: null })
                          : undefined}
                    >
                      <span class="workflow-graph-run-step-index mono">${index + 1}</span>
                      <span class=${`task-status-dot task-status-dot--${runTone(step.status)}`}></span>
                      <span class="workflow-graph-run-step-main">
                        <strong>${workflowRunStepLabel(step)}</strong>
                        <span>${workflowRunStepMeta(step)}</span>
                        ${
                          step.error
                            ? html`
                              <em>${step.error}</em>
                            `
                            : nothing
                        }
                      </span>
                    </button>
                  `;
                })}
              </div>
            `
      }
    </div>
  `;
}

function defaultEdgeEvent(fromNode: TaskWorkflowGraphNode | undefined): TaskWorkflowGraphEdgeEvent {
  if (fromNode?.type === "approval") {
    return "approved";
  }
  if (fromNode?.type === "condition") {
    return "true";
  }
  return "success";
}

function startNodeDrag(
  event: PointerEvent,
  params: TaskWorkflowGraphBuilderProps,
  node: TaskWorkflowGraphNode,
  position: GraphPosition,
) {
  if (!params.onMoveNode || event.button !== 0) {
    return;
  }
  const startX = event.clientX;
  const startY = event.clientY;
  const onMove = (moveEvent: PointerEvent) => {
    const next = {
      x: position.x + (moveEvent.clientX - startX) / params.draft.zoom,
      y: position.y + (moveEvent.clientY - startY) / params.draft.zoom,
    };
    params.onMoveNode?.(node.id, next.x, next.y);
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  event.preventDefault();
  event.stopPropagation();
  params.onPatch?.({ selectedNodeId: node.id, selectedEdgeId: null });
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function startCanvasPan(event: PointerEvent, params: TaskWorkflowGraphBuilderProps) {
  if (event.button !== 0 || (event.target as HTMLElement).closest(".workflow-graph-node")) {
    return;
  }
  const startX = event.clientX;
  const startY = event.clientY;
  const startPanX = params.draft.panX;
  const startPanY = params.draft.panY;
  const onMove = (moveEvent: PointerEvent) => {
    params.onPatch?.({
      panX: startPanX + moveEvent.clientX - startX,
      panY: startPanY + moveEvent.clientY - startY,
    });
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  event.preventDefault();
  event.stopPropagation();
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function zoomGraph(params: TaskWorkflowGraphBuilderProps, delta: number) {
  const nextZoom = Math.max(
    0.55,
    Math.min(1.8, Math.round((params.draft.zoom + delta) * 100) / 100),
  );
  params.onPatch?.({ zoom: nextZoom });
}

function handleCanvasWheel(event: WheelEvent, params: TaskWorkflowGraphBuilderProps) {
  if (!event.ctrlKey && !event.metaKey) {
    return;
  }
  event.preventDefault();
  zoomGraph(params, event.deltaY > 0 ? -0.08 : 0.08);
}

function renderGraphCanvas(params: TaskWorkflowGraphBuilderProps): TemplateResult {
  const { draft } = params;
  const positions = new Map(
    draft.graph.nodes.map((node, index) => [node.id, nodePosition(draft, node.id, index)]),
  );
  const nodesById = new Map(draft.graph.nodes.map((node) => [node.id, node]));
  return html`
    <div
      class="workflow-graph-canvas"
      data-workflow-graph-canvas="true"
      @pointerdown=${(event: PointerEvent) => startCanvasPan(event, params)}
      @wheel=${(event: WheelEvent) => handleCanvasWheel(event, params)}
    >
      <svg class="workflow-graph-edges" aria-hidden="true">
        <defs>
          <marker
            id="workflow-graph-arrow"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="4"
            orient="auto"
          >
            <path d="M0,0 L8,4 L0,8 Z" />
          </marker>
        </defs>
        ${draft.graph.edges.map((edge) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) {
            return nothing;
          }
          const fromCenter = viewPosition(draft, nodeCenter(from));
          const toCenter = viewPosition(draft, nodeCenter(to));
          return html`
            <g
              class=${edge.id === draft.selectedEdgeId ? "selected" : ""}
              @click=${() => params.onPatch?.({ selectedEdgeId: edge.id, selectedNodeId: null })}
            >
              <path
                d=${`M ${fromCenter.x} ${fromCenter.y} C ${fromCenter.x + 80 * draft.zoom} ${fromCenter.y}, ${toCenter.x - 80 * draft.zoom} ${toCenter.y}, ${toCenter.x} ${toCenter.y}`}
                marker-end="url(#workflow-graph-arrow)"
              ></path>
              <line
                class="workflow-graph-edge-hit"
                x1=${fromCenter.x}
                y1=${fromCenter.y}
                x2=${toCenter.x}
                y2=${toCenter.y}
              ></line>
              <text x=${(fromCenter.x + toCenter.x) / 2} y=${(fromCenter.y + toCenter.y) / 2 - 8}>
                ${edge.on ?? "next"}
              </text>
            </g>
          `;
        })}
      </svg>
      ${draft.graph.nodes.map((node, index) => {
        const position = positions.get(node.id) ?? nodePosition(draft, node.id, index);
        const connectFrom = draft.connectFromNodeId;
        const isSelected = draft.selectedNodeId === node.id;
        const runStep = runStepForNode(draft.runState, node);
        const runStepTone = runStep ? runTone(runStep.status) : null;
        const view = viewPosition(draft, position);
        const connectLabel =
          connectFrom === node.id ? "Cancel link" : connectFrom ? "Set target" : "Start link";
        return html`
          <div
            class=${`workflow-graph-node ${isSelected ? "selected" : ""} ${
              runStep ? `has-run-state workflow-graph-node--run-${runStep.status}` : ""
            }`}
            style=${`left:${view.x}px;top:${view.y}px;transform:scale(${draft.zoom});transform-origin:top left;`}
            data-node-id=${node.id}
            data-run-state=${runStep?.status ?? ""}
            title=${`${node.label} · ${node.type} · ${node.id}${runStep ? ` · ${runStep.status}` : ""}`}
            @pointerdown=${(event: PointerEvent) => {
              const target = event.target as HTMLElement;
              if (target.closest("button, input, select, textarea, a")) {
                return;
              }
              startNodeDrag(event, params, node, position);
            }}
            @click=${() => params.onPatch?.({ selectedNodeId: node.id, selectedEdgeId: null })}
          >
            <button
              type="button"
              class="workflow-graph-node-drag"
              aria-label="Drag workflow node"
              title="Drag node"
              @pointerdown=${(event: PointerEvent) => startNodeDrag(event, params, node, position)}
            >
              ${icons.chevronRight}
            </button>
            <div>
              <div class="workflow-graph-node-title">
                <span class=${`task-status-dot task-status-dot--${runStepTone ?? nodeTone(node.type)}`}></span>
                <span title=${node.label}>${node.label}</span>
              </div>
              <div class="workflow-graph-node-meta mono">
                ${node.type} · ${node.id}${runStep ? html` · ${runStep.status}` : nothing}
              </div>
              ${
                runStep?.error
                  ? html`
                      <div class="workflow-graph-node-run-error">${runStep.error}</div>
                    `
                  : nothing
              }
            </div>
            <button
              type="button"
              class="btn btn--sm workflow-graph-connect"
              title=${connectLabel}
              aria-label=${connectLabel}
              @click=${(event: Event) => {
                event.stopPropagation();
                if (!connectFrom) {
                  params.onPatch?.({ connectFromNodeId: node.id });
                  return;
                }
                if (connectFrom === node.id) {
                  params.onPatch?.({ connectFromNodeId: null });
                  return;
                }
                params.onAddEdge?.(
                  connectFrom,
                  node.id,
                  defaultEdgeEvent(nodesById.get(connectFrom)),
                );
              }}
            >
              ${icons.link} <span>${connectFrom === node.id ? "Cancel" : connectFrom ? "To" : "From"}</span>
            </button>
          </div>
        `;
      })}
    </div>
  `;
}

function renderNodeEditor(params: TaskWorkflowGraphBuilderProps): TemplateResult {
  const selected = params.draft.graph.nodes.find((node) => node.id === params.draft.selectedNodeId);
  if (!selected) {
    return html`
      <div class="muted">Select a node to edit its label, type, prompt, and branch behavior.</div>
    `;
  }
  const canDelete =
    params.draft.graph.nodes.length > 1 && selected.id !== params.draft.graph.startNodeId;
  return html`
    <div class="workflow-graph-editor-panel">
      <div class="agent-task-section-title">
        <span>Node</span>
        <span class="chip mono">${selected.id}</span>
      </div>
      <label class="field">
        <span>Label</span>
        <input
          .value=${selected.label}
          @input=${(event: Event) =>
            params.onUpdateNode?.(selected.id, {
              label: (event.target as HTMLInputElement).value,
            })}
        />
      </label>
      <label class="field">
        <span>Type</span>
        <select
          .value=${selected.type}
          @change=${(event: Event) =>
            params.onUpdateNode?.(selected.id, {
              type: (event.target as HTMLSelectElement).value as TaskWorkflowGraphNodeType,
            })}
        >
          <option value="start">start</option>
          ${GRAPH_NODE_TYPES.map((type) => html`<option value=${type}>${type}</option>`)}
        </select>
      </label>
      ${
        selected.type === "approval" || selected.type === "task" || selected.type === "notify"
          ? html`
              <label class="field">
                <span>Input</span>
                <textarea
                  rows="3"
                  .value=${selected.input ?? ""}
                  @input=${(event: Event) =>
                    params.onUpdateNode?.(selected.id, {
                      input: (event.target as HTMLTextAreaElement).value,
                    })}
                ></textarea>
              </label>
            `
          : nothing
      }
      ${
        selected.type === "wait"
          ? html`
              <label class="field">
                <span>Wait ms</span>
                <input
                  type="number"
                  min="1"
                  .value=${String(selected.durationMs ?? 60_000)}
                  @input=${(event: Event) =>
                    params.onUpdateNode?.(selected.id, {
                      durationMs: Number((event.target as HTMLInputElement).value) || 1,
                    })}
                />
              </label>
            `
          : nothing
      }
      ${
        selected.type === "condition"
          ? html`
              <label class="field">
                <span>Condition</span>
                <select
                  .value=${selected.condition?.kind ?? "always"}
                  @change=${(event: Event) => {
                    const kind = (event.target as HTMLSelectElement).value;
                    params.onUpdateNode?.(selected.id, {
                      condition:
                        kind === "equals"
                          ? { kind: "equals", left: "left", right: "right" }
                          : kind === "never"
                            ? { kind: "never" }
                            : { kind: "always" },
                    });
                  }}
                >
                  <option value="always">always true</option>
                  <option value="never">always false</option>
                  <option value="equals">equals</option>
                </select>
              </label>
              ${
                selected.condition?.kind === "equals"
                  ? html`
                      <label class="field">
                        <span>Left</span>
                        <input
                          .value=${selected.condition.left}
                          @input=${(event: Event) =>
                            params.onUpdateNode?.(selected.id, {
                              condition: {
                                kind: "equals",
                                left: (event.target as HTMLInputElement).value,
                                right:
                                  selected.condition?.kind === "equals"
                                    ? selected.condition.right
                                    : "",
                              },
                            })}
                        />
                      </label>
                      <label class="field">
                        <span>Right</span>
                        <input
                          .value=${selected.condition.right}
                          @input=${(event: Event) =>
                            params.onUpdateNode?.(selected.id, {
                              condition: {
                                kind: "equals",
                                left:
                                  selected.condition?.kind === "equals"
                                    ? selected.condition.left
                                    : "",
                                right: (event.target as HTMLInputElement).value,
                              },
                            })}
                        />
                      </label>
                    `
                  : nothing
              }
            `
          : nothing
      }
      <div class="webhook-trigger-editor-actions">
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${params.draft.graph.startNodeId === selected.id}
          @click=${() =>
            params.onPatch?.({
              graph: { ...params.draft.graph, startNodeId: selected.id },
            })}
        >
          Start here
        </button>
        <button
          type="button"
          class="btn btn--sm danger"
          ?disabled=${!canDelete}
          @click=${() => params.onRemoveNode?.(selected.id)}
        >
          Delete
        </button>
      </div>
    </div>
  `;
}

function renderEdgeEditor(params: TaskWorkflowGraphBuilderProps): TemplateResult {
  const nodes = params.draft.graph.nodes;
  return html`
    <div class="workflow-graph-edge-list">
      <div class="agent-task-section-title">
        <span>Edges</span>
        <span class="chip">${params.draft.graph.edges.length}</span>
      </div>
      ${
        params.draft.graph.edges.length === 0
          ? html`
              <div class="muted">Use From/To on node cards to connect workflow steps.</div>
            `
          : params.draft.graph.edges.map(
              (edge) => html`
                <div class="workflow-graph-edge-row">
                  <select
                    .value=${edge.from}
                    @change=${(event: Event) =>
                      params.onUpdateEdge?.(edge.id, {
                        from: (event.target as HTMLSelectElement).value,
                      })}
                  >
                    ${nodes.map((node) => html`<option value=${node.id}>${node.label}</option>`)}
                  </select>
                  <select
                    .value=${edge.on ?? "next"}
                    @change=${(event: Event) =>
                      params.onUpdateEdge?.(edge.id, {
                        on: (event.target as HTMLSelectElement).value as TaskWorkflowGraphEdgeEvent,
                      })}
                  >
                    ${GRAPH_EDGE_EVENTS.map((event) => html`<option value=${event}>${event}</option>`)}
                  </select>
                  <select
                    .value=${edge.to}
                    @change=${(event: Event) =>
                      params.onUpdateEdge?.(edge.id, {
                        to: (event.target as HTMLSelectElement).value,
                      })}
                  >
                    ${nodes.map((node) => html`<option value=${node.id}>${node.label}</option>`)}
                  </select>
                  <button
                    type="button"
                    class="icon-btn"
                    aria-label="Delete workflow edge"
                    @click=${() => params.onRemoveEdge?.(edge.id)}
                  >
                    ${icons.x}
                  </button>
                </div>
              `,
            )
      }
    </div>
  `;
}

export function renderTaskWorkflowGraphBuilder(
  params: TaskWorkflowGraphBuilderProps,
): TemplateResult {
  const draft = params.draft;
  return html`
    <div class="workflow-graph-builder" data-workflow-graph-builder="true">
      <div class="workflow-graph-fields">
        <label class="field">
          <span>Name</span>
          <input
            .value=${draft.name}
            @input=${(event: Event) =>
              params.onPatch?.({ name: (event.target as HTMLInputElement).value })}
          />
          <small class="muted">
            Shown in Agent &gt; Tasks as the saved Graph Workflow definition.
          </small>
        </label>
        <label class="field">
          <span>Notify</span>
          <select
            .value=${draft.notifyPolicy}
            @change=${(event: Event) =>
              params.onPatch?.({
                notifyPolicy: (event.target as HTMLSelectElement)
                  .value as TaskWorkflowDraft["notifyPolicy"],
              })}
          >
            <option value="silent">Silent</option>
            <option value="done_only">Done only</option>
            <option value="state_changes">State changes</option>
          </select>
          <small class="muted">
            Controls run-history notifications, not whether history exists.
          </small>
        </label>
        <label class="field workflow-graph-field-wide">
          <span>Task</span>
          <input
            .value=${draft.task}
            @input=${(event: Event) =>
              params.onPatch?.({ task: (event.target as HTMLInputElement).value })}
          />
          <small class="muted">
            Run title/instruction stored with each graph workflow run.
          </small>
        </label>
      </div>
      ${
        draft.runState
          ? html`
              <div class="workflow-graph-run-state">
                <span class=${`task-status-dot task-status-dot--${runTone(draft.runState.status)}`}></span>
                <div class="workflow-graph-run-state-main">
                  <strong>${workflowRunSummary(draft.runState)}</strong>
                  <span>
                    ${draft.runState.task} · ${draft.runState.source}/${draft.runState.runtime} ·
                    ${draft.runState.deliveryStatus.replace("_", " ")}
                  </span>
                </div>
                <span class="chip mono">${draft.runState.taskId}</span>
              </div>
            `
          : nothing
      }
      <div class="workflow-graph-toolbar">
        <button type="button" class="btn btn--sm" @click=${() => zoomGraph(params, -0.1)}>
          ${icons.search} -
        </button>
        <span class="chip">${Math.round(draft.zoom * 100)}%</span>
        <button type="button" class="btn btn--sm" @click=${() => zoomGraph(params, 0.1)}>
          ${icons.search} +
        </button>
        <button type="button" class="btn btn--sm" @click=${() => params.onPatch?.({ panX: 0, panY: 0, zoom: 1 })}>
          Reset view
        </button>
        <span class="workflow-graph-toolbar-hint">
          Drag nodes or empty canvas · Ctrl/Cmd wheel zoom · link nodes with From/To
        </span>
        <button type="button" class="btn btn--sm" @click=${() => params.onAutoLayout?.()}>
          Auto layout
        </button>
        <button
          type="button"
          class="btn btn--sm"
          @click=${() => params.onPatch?.({ jsonOpen: !draft.jsonOpen, jsonText: JSON.stringify(draft.graph, null, 2) })}
        >
          JSON
        </button>
        ${GRAPH_NODE_TYPES.map(
          (type) => html`
            <button type="button" class="btn btn--sm" @click=${() => params.onAddNode?.(type)}>
              ${icons.plus} ${type}
            </button>
          `,
        )}
      </div>
      <div class="workflow-graph-layout">
        ${renderGraphCanvas(params)}
        <div class="workflow-graph-side">
          ${renderWorkflowRunTimeline(params)}
          ${renderNodeEditor(params)}
          ${renderEdgeEditor(params)}
        </div>
      </div>
      ${
        draft.jsonOpen
          ? html`
              <div class="workflow-graph-json">
                <div class="agent-task-section-title">
                  <span>Graph JSON</span>
                  <span class="chip">${draft.graph.nodes.length} nodes</span>
                  <span class="chip">${draft.graph.edges.length} edges</span>
                </div>
                <textarea
                  rows="10"
                  class="mono"
                  .value=${draft.jsonText}
                  @input=${(event: Event) =>
                    params.onPatch?.({ jsonText: (event.target as HTMLTextAreaElement).value })}
                ></textarea>
                <div class="webhook-trigger-editor-actions">
                  <button type="button" class="btn btn--sm" @click=${() => params.onImportJson?.()}>
                    Import JSON
                  </button>
                  <button type="button" class="btn btn--sm" @click=${() => params.onExportJson?.()}>
                    Refresh and copy
                  </button>
                </div>
              </div>
            `
          : nothing
      }
      <div class="webhook-trigger-editor-actions">
        <span class="muted workflow-graph-action-note">
          Preview validates graph JSON. Run creates one graph run now. Save stores the definition
          without running it.
        </span>
        <button
          class="btn btn--sm"
          type="button"
          ?disabled=${params.busy}
          @click=${() => params.onPreview?.(params.agentId)}
        >
          Preview graph
        </button>
        <button
          class="btn btn--sm primary"
          type="button"
          ?disabled=${params.busy}
          @click=${() => params.onRun?.(params.agentId)}
        >
          Run graph
        </button>
        <button
          class="btn btn--sm"
          type="button"
          ?disabled=${params.definitionsBusy}
          @click=${() => params.onSave?.(params.agentId)}
        >
          ${draft.id ? "Save graph changes" : "Save graph"}
        </button>
        <button class="btn btn--sm" type="button" @click=${() => params.onCancel?.()}>
          Cancel
        </button>
      </div>
    </div>
  `;
}
