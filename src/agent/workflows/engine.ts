/**
 * Workflow Engine - Executes DAG-based agent pipelines.
 *
 * Traverses a directed acyclic graph of nodes:
 *   input → classifier/agent → condition → agent → output
 *
 * Each node transforms or routes the data flowing through the workflow.
 * The engine supports branching (condition nodes) and sequential chaining.
 */

import Anthropic from '@anthropic-ai/sdk';
import { EventEmitter } from 'events';
import { config } from '../../config';
import { logApiCall } from '../../db/sqlite';
import { getGroupApiKey } from '../groups/manager';
import { spawnSubAgent } from '../a2a/spawner';
import { v4 as uuid } from 'uuid';
import { WorkflowDefinition, WorkflowNode, WorkflowEdge, WorkflowNodeResult, WorkflowRun } from './types';
import { createWorkflowRun, updateWorkflowRun, getWorkflowRun } from './db';

export const workflowEvents = new EventEmitter();
workflowEvents.setMaxListeners(50);

// Track running workflow executions
const runningWorkflows = new Map<string, { abortController: AbortController }>();

/**
 * Execute a workflow with the given input message.
 * Traverses the DAG from the input node to output nodes.
 */
export async function executeWorkflow(
  workflow: WorkflowDefinition,
  input: string,
  sourceChannelId?: string,
): Promise<WorkflowRun> {
  const run = createWorkflowRun(workflow.id, input);
  const abortController = new AbortController();
  runningWorkflows.set(run.id, { abortController });

  workflowEvents.emit('workflow:start', {
    runId: run.id,
    workflowId: workflow.id,
    workflowName: workflow.name,
  });

  try {
    // Find the input node (entry point)
    const inputNode = workflow.nodes.find((n) => n.type === 'input');
    if (!inputNode) {
      throw new Error('Workflow has no input node');
    }

    // Build adjacency list from edges
    const adjacency = buildAdjacencyList(workflow.edges);

    // Execute the DAG starting from the input node
    const nodeResults: WorkflowNodeResult[] = [];
    await executeNode(
      inputNode,
      input,
      workflow,
      adjacency,
      nodeResults,
      run.id,
      abortController.signal,
      sourceChannelId,
    );

    // Mark run as completed
    updateWorkflowRun(run.id, {
      status: 'completed',
      currentNodeId: null,
      nodeResults,
    });

    workflowEvents.emit('workflow:complete', {
      runId: run.id,
      workflowId: workflow.id,
      nodeCount: nodeResults.length,
    });

    return getWorkflowRun(run.id)!;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    updateWorkflowRun(run.id, {
      status: 'failed',
      error: errorMsg,
    });

    workflowEvents.emit('workflow:error', {
      runId: run.id,
      workflowId: workflow.id,
      error: errorMsg,
    });

    return getWorkflowRun(run.id)!;
  } finally {
    runningWorkflows.delete(run.id);
  }
}

/**
 * Cancel a running workflow.
 */
export function cancelWorkflowRun(runId: string): boolean {
  const running = runningWorkflows.get(runId);
  if (!running) return false;
  running.abortController.abort();
  updateWorkflowRun(runId, { status: 'failed', error: 'Cancelled by user' });
  return true;
}

/**
 * Get the number of currently running workflows.
 */
export function getRunningWorkflowCount(): number {
  return runningWorkflows.size;
}

// ── Internal DAG Execution ──────────────────────────────────────────

function buildAdjacencyList(edges: WorkflowEdge[]): Map<string, WorkflowEdge[]> {
  const adj = new Map<string, WorkflowEdge[]>();
  for (const edge of edges) {
    const existing = adj.get(edge.from) || [];
    existing.push(edge);
    adj.set(edge.from, existing);
  }
  return adj;
}

/**
 * Recursively execute a node and its downstream neighbors.
 */
async function executeNode(
  node: WorkflowNode,
  input: string,
  workflow: WorkflowDefinition,
  adjacency: Map<string, WorkflowEdge[]>,
  results: WorkflowNodeResult[],
  runId: string,
  signal: AbortSignal,
  sourceChannelId?: string,
): Promise<void> {
  if (signal.aborted) return;

  updateWorkflowRun(runId, { currentNodeId: node.id, nodeResults: results });
  workflowEvents.emit('workflow:node:start', {
    runId,
    nodeId: node.id,
    nodeLabel: node.label,
    nodeType: node.type,
  });

  const startTime = Date.now();
  let output: string;

  try {
    switch (node.type) {
      case 'input':
        output = input;
        break;
      case 'agent':
        output = await executeAgentNode(node, input, workflow.id);
        break;
      case 'classifier':
        output = await executeClassifierNode(node, input);
        break;
      case 'condition':
        // Condition nodes route but don't transform -- pass input through
        output = input;
        break;
      case 'output':
        output = input;
        await executeOutputNode(node, input, sourceChannelId);
        break;
      default:
        output = input;
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    output = `[Error in ${node.label}]: ${errorMsg}`;
    workflowEvents.emit('workflow:node:error', { runId, nodeId: node.id, error: errorMsg });
  }

  const completedAt = Date.now();
  results.push({
    nodeId: node.id,
    nodeLabel: node.label,
    nodeType: node.type,
    output,
    durationMs: completedAt - startTime,
    startedAt: startTime,
    completedAt,
  });

  workflowEvents.emit('workflow:node:complete', {
    runId,
    nodeId: node.id,
    nodeLabel: node.label,
    outputLength: output.length,
    durationMs: completedAt - startTime,
  });

  // Find downstream edges
  const outEdges = adjacency.get(node.id) || [];
  if (outEdges.length === 0) return;

  if (node.type === 'condition' || node.type === 'classifier') {
    // Conditional routing: find the edge whose condition matches the output
    const matchedEdge = outEdges.find((e) => {
      if (!e.condition) return false;
      return output.toLowerCase().trim() === e.condition.toLowerCase().trim();
    });
    // Fallback: try edge without condition (default path)
    const defaultEdge = outEdges.find((e) => !e.condition);
    const selectedEdge = matchedEdge || defaultEdge;

    if (selectedEdge) {
      const nextNode = workflow.nodes.find((n) => n.id === selectedEdge.to);
      if (nextNode) {
        // For condition nodes pass the original input, for classifier pass the input
        const nextInput = node.type === 'condition' ? input : input;
        await executeNode(nextNode, nextInput, workflow, adjacency, results, runId, signal, sourceChannelId);
      }
    }
  } else {
    // Sequential: execute all downstream nodes with this node's output
    for (const edge of outEdges) {
      if (signal.aborted) return;
      const nextNode = workflow.nodes.find((n) => n.id === edge.to);
      if (nextNode) {
        await executeNode(nextNode, output, workflow, adjacency, results, runId, signal, sourceChannelId);
      }
    }
  }
}

// ── Node Executors ──────────────────────────────────────────────────

/**
 * Execute an agent node: runs a sub-agent or calls Claude directly.
 */
async function executeAgentNode(node: WorkflowNode, input: string, workflowId: string): Promise<string> {
  const { role, agentGroupId, systemPrompt } = node.config;

  if (role) {
    // Use A2A sub-agent spawning with predefined role
    const result = await spawnSubAgent({
      role,
      task: input,
      context: systemPrompt,
      groupId: agentGroupId || '',
      parentAgentId: `workflow-${workflowId}`,
      conversationId: `wf-${workflowId}-${uuid().slice(0, 8)}`,
    });
    return result;
  }

  // Direct Claude call with custom system prompt
  const apiKey = agentGroupId ? getGroupApiKey(agentGroupId) : null;
  const client = new Anthropic({ apiKey: apiKey || config.anthropicApiKey });

  const startTime = Date.now();
  const response = await client.messages.create({
    model: config.agentModel,
    max_tokens: config.agentMaxTokens,
    system: systemPrompt || 'You are a helpful AI assistant. Process the input and produce output.',
    messages: [{ role: 'user', content: input }],
  });

  const durationMs = Date.now() - startTime;
  logApiCall({
    model: config.agentModel,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    duration_ms: durationMs,
    isolated: false,
    agent_group_id: agentGroupId,
  });

  const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
  return textBlocks.map((b) => b.text).join('\n') || '(no response)';
}

/**
 * Execute a classifier node: uses Claude to classify input into categories.
 * Returns the category name as output for condition routing.
 */
async function executeClassifierNode(node: WorkflowNode, input: string): Promise<string> {
  const categories = node.config.categories || [];
  if (categories.length === 0) {
    return 'unknown';
  }

  const categoryList = categories.map((c) => `- "${c.name}": ${c.description}`).join('\n');

  const classifierPrompt = `Classify the following input into exactly one of these categories. Respond with ONLY the category name, nothing else.

Categories:
${categoryList}

Input:
${input}

Category:`;

  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const startTime = Date.now();
  const response = await client.messages.create({
    model: config.agentModel,
    max_tokens: 100,
    messages: [{ role: 'user', content: classifierPrompt }],
  });

  const durationMs = Date.now() - startTime;
  logApiCall({
    model: config.agentModel,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    duration_ms: durationMs,
    isolated: false,
  });

  const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
  const classification = textBlocks
    .map((b) => b.text)
    .join('')
    .trim();

  // Match to a known category (case-insensitive)
  const matched = categories.find((c) => c.name.toLowerCase() === classification.toLowerCase());
  return matched ? matched.name : classification;
}

/**
 * Execute an output node: send result to channel or webhook.
 */
async function executeOutputNode(node: WorkflowNode, input: string, sourceChannelId?: string): Promise<void> {
  const { channelId, webhook } = node.config;

  if (channelId || sourceChannelId) {
    const targetChannelId = channelId || sourceChannelId;
    try {
      const { getChannelAdapter } = await import('../../channels/manager');
      const adapter = getChannelAdapter(targetChannelId!);
      if (adapter) {
        await adapter.sendMessage('default', input);
        console.log(`[workflow] Output sent to channel ${targetChannelId}`);
      }
    } catch (err) {
      console.error(`[workflow] Failed to send to channel:`, err);
    }
  }

  if (webhook) {
    try {
      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          result: input,
          timestamp: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        console.error(`[workflow] Webhook returned ${response.status}`);
      }
    } catch (err) {
      console.error(`[workflow] Webhook failed:`, err);
    }
  }
}

/**
 * Validate a workflow definition (check for cycles, missing nodes, etc.).
 */
export function validateWorkflow(workflow: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const nodeIds = new Set(workflow.nodes.map((n) => n.id));

  // Must have at least one input node
  const inputNodes = workflow.nodes.filter((n) => n.type === 'input');
  if (inputNodes.length === 0) {
    errors.push('Workflow must have at least one input node');
  }
  if (inputNodes.length > 1) {
    errors.push('Workflow must have exactly one input node');
  }

  // Must have at least one output node
  const outputNodes = workflow.nodes.filter((n) => n.type === 'output');
  if (outputNodes.length === 0) {
    errors.push('Workflow must have at least one output node');
  }

  // All edges must reference existing nodes
  for (const edge of workflow.edges) {
    if (!nodeIds.has(edge.from)) {
      errors.push(`Edge ${edge.id} references unknown source node: ${edge.from}`);
    }
    if (!nodeIds.has(edge.to)) {
      errors.push(`Edge ${edge.id} references unknown target node: ${edge.to}`);
    }
  }

  // Check for cycles using DFS
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const adj = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    const existing = adj.get(edge.from) || [];
    existing.push(edge.to);
    adj.set(edge.from, existing);
  }

  function hasCycle(nodeId: string): boolean {
    visited.add(nodeId);
    recStack.add(nodeId);
    for (const neighbor of adj.get(nodeId) || []) {
      if (!visited.has(neighbor)) {
        if (hasCycle(neighbor)) return true;
      } else if (recStack.has(neighbor)) {
        return true;
      }
    }
    recStack.delete(nodeId);
    return false;
  }

  for (const node of workflow.nodes) {
    if (!visited.has(node.id)) {
      if (hasCycle(node.id)) {
        errors.push('Workflow contains a cycle -- only DAGs are supported');
        break;
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
