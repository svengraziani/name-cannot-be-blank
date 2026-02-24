/**
 * A2A Message Bus - EventEmitter-based message routing for single-node setup.
 *
 * All A2A messages go through the gateway as hub.
 * Messages are persisted in SQLite for audit trail.
 * Future: Can be swapped for Redis/NATS for distributed setup.
 */

import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import { A2AMessage, AgentIdentity, A2AMessageStatus } from './protocol';
import { getDb } from '../../db/sqlite';

export const a2aEvents = new EventEmitter();
a2aEvents.setMaxListeners(100);

// Registry of active agents
const activeAgents = new Map<string, AgentIdentity>();

// Pending request handlers (for synchronous delegate_task with waitForResult)
const pendingRequests = new Map<
  string,
  {
    resolve: (response: A2AMessage) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

/**
 * Initialize the A2A tables in SQLite.
 */
export function initA2ASchema(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS a2a_messages (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      from_agent_id TEXT NOT NULL,
      from_role TEXT NOT NULL,
      from_group_id TEXT NOT NULL,
      to_agent_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      action TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      reply_to TEXT,
      ttl INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_a2a_conversation ON a2a_messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_a2a_to_agent ON a2a_messages(to_agent_id);
    CREATE INDEX IF NOT EXISTS idx_a2a_status ON a2a_messages(status);
  `);

  console.log('[a2a] Message bus schema initialized');
}

/**
 * Register an agent as active.
 */
export function registerAgent(identity: AgentIdentity): void {
  activeAgents.set(identity.id, identity);
  a2aEvents.emit('agent:registered', identity);
  console.log(`[a2a] Agent registered: ${identity.id} (${identity.role})`);
}

/**
 * Unregister an agent.
 */
export function unregisterAgent(agentId: string): void {
  activeAgents.delete(agentId);
  a2aEvents.emit('agent:unregistered', { agentId });
}

/**
 * Get all active agents.
 */
export function getActiveAgents(): AgentIdentity[] {
  return Array.from(activeAgents.values());
}

/**
 * Get active agents by role.
 */
export function getAgentsByRole(role: string): AgentIdentity[] {
  return Array.from(activeAgents.values()).filter((a) => a.role === role);
}

/**
 * Send an A2A message. Persists to SQLite and emits event.
 */
export function sendMessage(message: Omit<A2AMessage, 'id' | 'timestamp'>): A2AMessage {
  const fullMessage: A2AMessage = {
    ...message,
    id: uuid(),
    timestamp: Date.now(),
  };

  // Persist to SQLite
  getDb()
    .prepare(
      `
    INSERT INTO a2a_messages (id, type, from_agent_id, from_role, from_group_id, to_agent_id, conversation_id, action, content, metadata, reply_to, ttl, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `,
    )
    .run(
      fullMessage.id,
      fullMessage.type,
      fullMessage.from.id,
      fullMessage.from.role,
      fullMessage.from.groupId,
      fullMessage.to,
      fullMessage.conversationId,
      fullMessage.payload.action,
      fullMessage.payload.content,
      JSON.stringify(fullMessage.payload.metadata || {}),
      fullMessage.replyTo || null,
      fullMessage.ttl || null,
    );

  // Route message
  if (fullMessage.to === '*') {
    // Broadcast to all agents
    a2aEvents.emit('message:broadcast', fullMessage);
    for (const agent of activeAgents.values()) {
      if (agent.id !== fullMessage.from.id) {
        a2aEvents.emit(`message:${agent.id}`, fullMessage);
      }
    }
  } else {
    // Direct message to specific agent
    a2aEvents.emit(`message:${fullMessage.to}`, fullMessage);
  }

  // Global message event for monitoring
  a2aEvents.emit('message:sent', fullMessage);

  return fullMessage;
}

/**
 * Send a request and wait for a response (synchronous delegation).
 */
export function sendRequestAndWait(
  message: Omit<A2AMessage, 'id' | 'timestamp'>,
  timeoutMs = 120000,
): Promise<A2AMessage> {
  return new Promise((resolve, reject) => {
    const sent = sendMessage(message);

    const timeout = setTimeout(() => {
      pendingRequests.delete(sent.id);
      reject(new Error(`A2A request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingRequests.set(sent.id, { resolve, reject, timeout });
  });
}

/**
 * Mark a message as processed and optionally send a response.
 */
export function markProcessed(messageId: string, response?: Omit<A2AMessage, 'id' | 'timestamp'>): void {
  getDb()
    .prepare(
      `
    UPDATE a2a_messages SET status = 'processed', processed_at = datetime('now') WHERE id = ?
  `,
    )
    .run(messageId);

  if (response) {
    const sent = sendMessage(response);

    // Check if someone is waiting for this response
    const replyTo = response.replyTo;
    if (replyTo && pendingRequests.has(replyTo)) {
      const pending = pendingRequests.get(replyTo)!;
      clearTimeout(pending.timeout);
      pendingRequests.delete(replyTo);
      pending.resolve(sent);
    }
  }
}

/**
 * Update message status.
 */
export function updateMessageStatus(messageId: string, status: A2AMessageStatus): void {
  getDb().prepare('UPDATE a2a_messages SET status = ? WHERE id = ?').run(status, messageId);
}

/**
 * Get messages for a conversation.
 */
export function getConversationMessages(conversationId: string, limit = 100): A2AMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM a2a_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?')
    .all(conversationId, limit) as any[];

  return rows.map(rowToMessage);
}

/**
 * Get messages for an agent.
 */
export function getAgentMessages(agentId: string, status?: A2AMessageStatus, limit = 50): A2AMessage[] {
  let query = 'SELECT * FROM a2a_messages WHERE to_agent_id = ?';
  const params: unknown[] = [agentId];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const rows = getDb()
    .prepare(query)
    .all(...params) as any[];
  return rows.map(rowToMessage);
}

/**
 * Get all recent A2A messages (for dashboard).
 */
export function getRecentA2AMessages(limit = 100): A2AMessage[] {
  const rows = getDb().prepare('SELECT * FROM a2a_messages ORDER BY created_at DESC LIMIT ?').all(limit) as any[];
  return rows.map(rowToMessage);
}

function rowToMessage(row: any): A2AMessage {
  return {
    id: row.id,
    type: row.type,
    from: {
      id: row.from_agent_id,
      role: row.from_role,
      groupId: row.from_group_id,
      capabilities: [],
    },
    to: row.to_agent_id,
    conversationId: row.conversation_id,
    payload: {
      action: row.action,
      content: row.content,
      metadata: JSON.parse(row.metadata || '{}'),
    },
    timestamp: new Date(row.created_at).getTime(),
    replyTo: row.reply_to || undefined,
    ttl: row.ttl || undefined,
  };
}
