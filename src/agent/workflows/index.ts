/**
 * Workflows Module - Declarative DAG-based agent pipeline builder.
 */

export type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowEdge,
  WorkflowNodeConfig,
  WorkflowCategory,
  WorkflowNodeType,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowNodeResult,
} from './types';

export {
  initWorkflowSchema,
  createWorkflow,
  getWorkflow,
  getAllWorkflows,
  updateWorkflow,
  deleteWorkflow,
  getWorkflowsForChannel,
  getWorkflowRun,
  getWorkflowRuns,
  getWorkflowStats,
} from './db';

export {
  executeWorkflow,
  cancelWorkflowRun,
  getRunningWorkflowCount,
  validateWorkflow,
  workflowEvents,
} from './engine';
