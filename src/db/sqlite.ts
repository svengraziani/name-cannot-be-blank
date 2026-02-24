import Database from 'better-sqlite3';
import { config } from '../config';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,          -- 'telegram' | 'whatsapp' | 'email'
      name TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'disconnected',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      external_id TEXT NOT NULL,   -- chat id from the channel
      title TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,           -- 'user' | 'assistant'
      content TEXT NOT NULL,
      channel_type TEXT,
      external_sender TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      input_message_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'running' | 'completed' | 'error'
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(channel_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation ON agent_runs(conversation_id);
  `);
}

// --- Channel CRUD ---

export interface ChannelRow {
  id: string;
  type: string;
  name: string;
  config: string;
  enabled: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export function getAllChannels(): ChannelRow[] {
  return getDb().prepare('SELECT * FROM channels ORDER BY created_at DESC').all() as ChannelRow[];
}

export function getChannel(id: string): ChannelRow | undefined {
  return getDb().prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow | undefined;
}

export function upsertChannel(channel: { id: string; type: string; name: string; config: string; enabled: number }): void {
  getDb().prepare(`
    INSERT INTO channels (id, type, name, config, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      config = excluded.config,
      enabled = excluded.enabled,
      updated_at = datetime('now')
  `).run(channel.id, channel.type, channel.name, channel.config, channel.enabled);
}

export function updateChannelStatus(id: string, status: string): void {
  getDb().prepare("UPDATE channels SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

export function deleteChannel(id: string): void {
  getDb().prepare('DELETE FROM channels WHERE id = ?').run(id);
}

// --- Conversation helpers ---

export function getOrCreateConversation(channelId: string, externalId: string, title?: string): string {
  const existing = getDb().prepare(
    'SELECT id FROM conversations WHERE channel_id = ? AND external_id = ?'
  ).get(channelId, externalId) as { id: string } | undefined;

  if (existing) return existing.id;

  const id = require('uuid').v4();
  getDb().prepare(
    "INSERT INTO conversations (id, channel_id, external_id, title) VALUES (?, ?, ?, ?)"
  ).run(id, channelId, externalId, title || externalId);
  return id;
}

export function getConversationMessages(conversationId: string, limit = 50): Array<{ role: string; content: string }> {
  return getDb().prepare(
    'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(conversationId, limit).reverse() as Array<{ role: string; content: string }>;
}

export function addMessage(conversationId: string, role: string, content: string, channelType?: string, externalSender?: string): number {
  const result = getDb().prepare(
    "INSERT INTO messages (conversation_id, role, content, channel_type, external_sender) VALUES (?, ?, ?, ?, ?)"
  ).run(conversationId, role, content, channelType, externalSender);
  return result.lastInsertRowid as number;
}

// --- Agent run tracking ---

export function createAgentRun(conversationId: string, inputMessageId: number): number {
  const result = getDb().prepare(
    "INSERT INTO agent_runs (conversation_id, input_message_id, status) VALUES (?, ?, 'pending')"
  ).run(conversationId, inputMessageId);
  return result.lastInsertRowid as number;
}

export function updateAgentRun(id: number, update: { status?: string; input_tokens?: number; output_tokens?: number; error?: string }): void {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (update.status) {
    sets.push('status = ?');
    values.push(update.status);
    if (update.status === 'running') {
      sets.push("started_at = datetime('now')");
    } else if (update.status === 'completed' || update.status === 'error') {
      sets.push("completed_at = datetime('now')");
    }
  }
  if (update.input_tokens !== undefined) { sets.push('input_tokens = ?'); values.push(update.input_tokens); }
  if (update.output_tokens !== undefined) { sets.push('output_tokens = ?'); values.push(update.output_tokens); }
  if (update.error !== undefined) { sets.push('error = ?'); values.push(update.error); }

  if (sets.length === 0) return;
  values.push(id);
  getDb().prepare(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function getRecentRuns(limit = 20): unknown[] {
  return getDb().prepare(
    'SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
}
