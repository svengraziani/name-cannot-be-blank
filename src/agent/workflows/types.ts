/**
 * Workflow Builder Types - Declarative DAG-based agent pipelines.
 *
 * A workflow is a directed acyclic graph (DAG) of nodes connected by edges.
 * Messages flow through the graph: input → processing nodes → output.
 *
 * Node types:
 * - input:      Entry point, receives the trigger message
 * - agent:      Runs an agent with a specific role/prompt
 * - classifier: Uses an LLM to classify input into categories for routing
 * - condition:  Routes based on a field match (e.g. classifier output)
 * - output:     Sends the result to a channel or webhook
 */

// ── Node Types ──────────────────────────────────────────────────────

export type WorkflowNodeType = 'input' | 'agent' | 'classifier' | 'condition' | 'output';

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label: string;
  config: WorkflowNodeConfig;
  position?: { x: number; y: number };
}

export interface WorkflowNodeConfig {
  // Agent node
  role?: string; // predefined role: planner, builder, reviewer, researcher
  agentGroupId?: string; // run under a specific agent group
  systemPrompt?: string; // override system prompt for this node

  // Classifier node
  categories?: WorkflowCategory[];

  // Condition node
  field?: string; // field to match (default: "category")
  // Edges define the match values via their `condition` field

  // Output node
  channelId?: string; // send result to a channel
  webhook?: string; // POST result to a webhook URL
}

export interface WorkflowCategory {
  name: string;
  description: string;
}

// ── Edges ───────────────────────────────────────────────────────────

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  condition?: string; // match value for condition/classifier routing (e.g. "support", "order")
}

// ── Workflow Definition ─────────────────────────────────────────────

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  enabled: boolean;
  triggerChannelIds: string[];
  createdAt: string;
  updatedAt: string;
}

// ── Workflow Run (execution instance) ───────────────────────────────

export type WorkflowRunStatus = 'running' | 'completed' | 'failed';

export interface WorkflowNodeResult {
  nodeId: string;
  nodeLabel: string;
  nodeType: WorkflowNodeType;
  output: string;
  durationMs: number;
  startedAt: number;
  completedAt: number;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  input: string;
  currentNodeId: string | null;
  nodeResults: WorkflowNodeResult[];
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

// ── DB Row ──────────────────────────────────────────────────────────

export interface WorkflowRow {
  id: string;
  name: string;
  description: string;
  definition: string; // JSON of { nodes, edges }
  enabled: number;
  trigger_channel_ids: string; // JSON array
  created_at: string;
  updated_at: string;
}

export interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  status: string;
  input: string;
  current_node_id: string | null;
  node_results: string; // JSON array
  started_at: string;
  completed_at: string | null;
  error: string | null;
}
