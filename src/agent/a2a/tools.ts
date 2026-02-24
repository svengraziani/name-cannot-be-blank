/**
 * A2A Tools - Tools that agents can use for inter-agent communication.
 *
 * These are registered in the ToolRegistry alongside built-in tools.
 * - delegate_task: Delegate a sub-task to a specialized agent
 * - broadcast_event: Broadcast an event to all active agents
 * - query_agents: Query available agents and their capabilities
 */

import { AgentTool, ToolResult } from '../tools/types';
import { spawnSubAgent, getSubAgentStats } from './spawner';
import { sendMessage, getActiveAgents } from './bus';
import { PREDEFINED_ROLES } from './protocol';

// Context injected per-request (set before each agent loop iteration)
let currentContext: {
  groupId: string;
  agentId: string;
  conversationId: string;
} = { groupId: '', agentId: 'gateway', conversationId: '' };

export function setA2AContext(ctx: typeof currentContext): void {
  currentContext = ctx;
}

export const delegateTaskTool: AgentTool = {
  name: 'delegate_task',
  description: `Delegate a sub-task to another agent with a specific role. The sub-agent will work on the task autonomously and return results. Available roles: planner (plans & coordinates), builder (code & implementation), reviewer (analysis & feedback), researcher (web research & information gathering).`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      role: {
        type: 'string',
        description: 'Agent role: planner, builder, reviewer, researcher',
        enum: ['planner', 'builder', 'reviewer', 'researcher'],
      },
      task: {
        type: 'string',
        description: 'Clear description of what the sub-agent should do',
      },
      context: {
        type: 'string',
        description: 'Relevant context from current work to share with the sub-agent',
      },
    },
    required: ['role', 'task'],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const role = input.role as string;
    const task = input.task as string;
    const context = input.context as string | undefined;

    if (!currentContext.groupId) {
      return {
        content: 'Error: A2A context not initialized. delegate_task requires an agent group context.',
        isError: true,
      };
    }

    try {
      const result = await spawnSubAgent({
        role,
        task,
        context,
        groupId: currentContext.groupId,
        parentAgentId: currentContext.agentId,
        conversationId: currentContext.conversationId,
      });

      return { content: `[${role} agent result]:\n\n${result}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `delegate_task error: ${msg}`, isError: true };
    }
  },
};

export const broadcastEventTool: AgentTool = {
  name: 'broadcast_event',
  description:
    'Broadcast an event to all active agents in the current group. Use for sharing status updates, completion notifications, or coordination signals.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      event: {
        type: 'string',
        description: 'Event type (e.g. "task_complete", "status_update", "error")',
      },
      data: {
        type: 'string',
        description: 'Event data/message content',
      },
    },
    required: ['event', 'data'],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const event = input.event as string;
    const data = input.data as string;

    sendMessage({
      type: 'event',
      from: {
        id: currentContext.agentId,
        role: 'broadcaster',
        groupId: currentContext.groupId,
        capabilities: [],
      },
      to: '*',
      conversationId: currentContext.conversationId,
      payload: {
        action: event,
        content: data,
      },
    });

    const activeCount = getActiveAgents().filter((a) => a.groupId === currentContext.groupId).length;
    return { content: `Event "${event}" broadcast to ${activeCount} active agent(s).` };
  },
};

export const queryAgentsTool: AgentTool = {
  name: 'query_agents',
  description:
    'Query available agent roles and currently active agents. Use to understand what capabilities are available before delegating tasks.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      filter_role: {
        type: 'string',
        description: 'Optional: filter by role name',
      },
    },
    required: [],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filterRole = input.filter_role as string | undefined;
    const agents = getActiveAgents();
    const stats = getSubAgentStats();

    const roles = filterRole ? PREDEFINED_ROLES.filter((r) => r.id === filterRole) : PREDEFINED_ROLES;

    const lines = [
      '## Available Roles',
      '',
      ...roles.map((r) => {
        const activeCount = agents.filter((a) => a.role === r.id).length;
        return `- **${r.name}** (${r.id}): ${r.systemPrompt.slice(0, 100)}... | Tools: [${r.tools.join(', ')}] | Active: ${activeCount}/${r.maxConcurrent}`;
      }),
      '',
      `## Stats`,
      `- Running sub-agents: ${stats.running}`,
      `- By role: ${JSON.stringify(stats.byRole)}`,
    ];

    return { content: lines.join('\n') };
  },
};
