/**
 * A2A Protocol Types - Message format for Agent-to-Agent communication.
 *
 * All A2A messages flow through the Gateway as hub.
 * Messages are persisted in SQLite for audit trail and debugging.
 */

export interface A2AMessage {
  id: string;
  type: 'request' | 'response' | 'event';
  from: AgentIdentity;
  to: string; // Target agent ID or '*' for broadcast
  conversationId: string; // Shared context thread
  payload: {
    action: string; // e.g. "delegate_task", "report_result", "ask_question"
    content: string;
    metadata?: Record<string, unknown>;
  };
  timestamp: number;
  replyTo?: string; // Reference to previous message ID
  ttl?: number; // Time-to-live in ms
}

export interface AgentIdentity {
  id: string;
  role: string; // e.g. "planner", "builder", "reviewer", "researcher"
  groupId: string; // Which agent group this agent belongs to
  capabilities: string[]; // e.g. ["code_generation", "web_browse"]
}

export interface AgentRole {
  id: string;
  name: string; // e.g. "planner", "builder", "reviewer"
  systemPrompt: string;
  tools: string[]; // Which tools this role can use
  maxConcurrent: number; // Max parallel instances
}

export type A2AMessageStatus = 'pending' | 'delivered' | 'processed' | 'failed' | 'expired';

export interface A2AMessageRow {
  id: string;
  type: string;
  from_agent_id: string;
  from_role: string;
  from_group_id: string;
  to_agent_id: string;
  conversation_id: string;
  action: string;
  content: string;
  metadata: string; // JSON
  reply_to: string | null;
  ttl: number | null;
  status: A2AMessageStatus;
  created_at: string;
  processed_at: string | null;
}

// Predefined roles
export const PREDEFINED_ROLES: AgentRole[] = [
  {
    id: 'planner',
    name: 'Planner',
    systemPrompt:
      'You are a planning agent. Break complex tasks into subtasks and delegate them to specialized agents using the delegate_task tool. Coordinate results and synthesize final answers.',
    tools: ['delegate_task', 'broadcast_event', 'query_agents'],
    maxConcurrent: 1,
  },
  {
    id: 'builder',
    name: 'Builder',
    systemPrompt:
      'You are a builder agent specialized in code generation and implementation. Execute tasks delegated to you and report results back.',
    tools: ['run_script', 'http_request', 'web_browse'],
    maxConcurrent: 3,
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    systemPrompt:
      'You are a review agent. Analyze code, results, and outputs for correctness, quality, and completeness. Provide constructive feedback.',
    tools: ['web_browse'],
    maxConcurrent: 2,
  },
  {
    id: 'researcher',
    name: 'Researcher',
    systemPrompt:
      'You are a research agent. Gather information from the web, APIs, and other sources. Summarize findings concisely.',
    tools: ['web_browse', 'http_request'],
    maxConcurrent: 3,
  },
];
