import type { TaskNotifyPolicy } from "./task-registry.types.js";
import type { TaskWorkflowGraphDefinition } from "./workflow-graph.js";
import type { SimpleTaskWorkflowStep } from "./workflow.js";

export type TaskWorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  task: string;
  notifyPolicy: TaskNotifyPolicy;
  steps: SimpleTaskWorkflowStep[];
  graph?: TaskWorkflowGraphDefinition;
  tags: string[];
};

export type TaskWorkflowTemplatesResult = {
  templates: TaskWorkflowTemplate[];
};

export function listTaskWorkflowTemplates(): TaskWorkflowTemplatesResult {
  return { templates: [] };
}
