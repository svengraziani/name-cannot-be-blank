/**
 * A2A Agent Spawner - Spawns sub-agents for delegated tasks.
 *
 * When an agent uses delegate_task, this module:
 * 1. Finds or spawns an agent with the requested role
 * 2. Sets up message listeners for communication
 * 3. Runs the agent loop with the delegated task
 * 4. Returns results via A2A messages
 */

import { v4 as uuid } from 'uuid';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';
import { AgentIdentity, PREDEFINED_ROLES } from './protocol';
import { registerAgent, unregisterAgent, sendMessage, a2aEvents, getAgentsByRole } from './bus';
import { toolRegistry } from '../tools';
import { logApiCall } from '../../db/sqlite';
import { getGroupApiKey } from '../groups/manager';

// Track running sub-agents
const runningAgents = new Map<
  string,
  {
    identity: AgentIdentity;
    abortController: AbortController;
  }
>();

/**
 * Spawn a sub-agent to handle a delegated task.
 * Returns the agent's response content.
 */
export async function spawnSubAgent(params: {
  role: string;
  task: string;
  context?: string;
  groupId: string;
  parentAgentId: string;
  conversationId: string;
  waitForResult?: boolean;
}): Promise<string> {
  const { role, task, context, groupId, parentAgentId, conversationId } = params;

  // Find the role definition
  const roleConfig = PREDEFINED_ROLES.find((r) => r.id === role);
  if (!roleConfig) {
    return `Error: Unknown agent role "${role}". Available roles: ${PREDEFINED_ROLES.map((r) => r.id).join(', ')}`;
  }

  // Check if there's already an available agent with this role
  const existingAgents = getAgentsByRole(role);
  const maxForRole = roleConfig.maxConcurrent;
  if (existingAgents.length >= maxForRole) {
    return `Error: Maximum concurrent ${role} agents (${maxForRole}) reached. Try again later.`;
  }

  // Create agent identity
  const agentId = `agent-${role}-${uuid().slice(0, 8)}`;
  const identity: AgentIdentity = {
    id: agentId,
    role,
    groupId,
    capabilities: roleConfig.tools,
  };

  const abortController = new AbortController();
  registerAgent(identity);
  runningAgents.set(agentId, { identity, abortController });

  try {
    // Build the agent's system prompt
    const baseSystemPrompt = roleConfig.systemPrompt;
    const systemPrompt = context
      ? `${baseSystemPrompt}\n\n## Context from parent agent:\n${context}`
      : baseSystemPrompt;

    // Get API key for the group
    const apiKey = getGroupApiKey(groupId);

    // Create Anthropic client
    const client = new Anthropic({ apiKey: apiKey || config.anthropicApiKey });

    // Build messages
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: task }];

    // Get tool definitions filtered by role
    const tools = toolRegistry.getToolDefinitions(roleConfig.tools);

    // Send A2A message about task delegation
    sendMessage({
      type: 'request',
      from: { id: parentAgentId, role: 'parent', groupId, capabilities: [] },
      to: agentId,
      conversationId,
      payload: {
        action: 'delegate_task',
        content: task,
        metadata: { role, context: context?.slice(0, 500) },
      },
    });

    a2aEvents.emit('agent:spawned', { agentId, role, groupId, task: task.slice(0, 200) });

    // Run agent loop (simplified - max 10 iterations for sub-agents)
    const MAX_SUB_ITERATIONS = 10;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const currentMessages = [...messages];

    for (let iteration = 0; iteration < MAX_SUB_ITERATIONS; iteration++) {
      if (abortController.signal.aborted) {
        return '(sub-agent was cancelled)';
      }

      const response = await client.messages.create({
        model: config.agentModel,
        max_tokens: config.agentMaxTokens,
        system: systemPrompt,
        messages: currentMessages,
        ...(tools.length > 0 ? { tools } : {}),
      });

      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;

      if (response.stop_reason !== 'tool_use') {
        const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
        const result = textBlocks.map((b) => b.text).join('\n') || '(no response)';

        // Log API usage
        logApiCall({
          model: config.agentModel,
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          duration_ms: 0,
          isolated: false,
          agent_group_id: groupId,
        });

        // Send A2A result message
        sendMessage({
          type: 'response',
          from: identity,
          to: parentAgentId,
          conversationId,
          payload: {
            action: 'task_result',
            content: result,
            metadata: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
          },
        });

        return result;
      }

      // Handle tool use
      currentMessages.push({ role: 'assistant', content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === 'tool_use') {
          const toolInput = block.input as Record<string, unknown>;
          const result = await toolRegistry.execute(block.name, toolInput);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result.content,
            is_error: result.isError,
          });
        }
      }

      currentMessages.push({ role: 'user', content: toolResults });
    }

    return '(sub-agent reached max iterations)';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[a2a] Sub-agent ${agentId} error:`, msg);
    return `Error: ${msg}`;
  } finally {
    unregisterAgent(agentId);
    runningAgents.delete(agentId);
    a2aEvents.emit('agent:stopped', { agentId });
  }
}

/**
 * Cancel a running sub-agent.
 */
export function cancelSubAgent(agentId: string): boolean {
  const agent = runningAgents.get(agentId);
  if (!agent) return false;
  agent.abortController.abort();
  return true;
}

/**
 * Get stats about running sub-agents.
 */
export function getSubAgentStats(): { running: number; byRole: Record<string, number> } {
  const byRole: Record<string, number> = {};
  for (const agent of runningAgents.values()) {
    byRole[agent.identity.role] = (byRole[agent.identity.role] || 0) + 1;
  }
  return { running: runningAgents.size, byRole };
}
