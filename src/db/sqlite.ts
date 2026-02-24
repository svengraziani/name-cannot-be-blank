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

    -- API call logging for usage tracking (Feature 3)
    CREATE TABLE IF NOT EXISTS api_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      isolated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_api_calls_created ON api_calls(created_at);

    -- Loop mode tasks (Feature 2)
    CREATE TABLE IF NOT EXISTS loop_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      prompt_file TEXT NOT NULL,
      output_file TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      iteration INTEGER NOT NULL DEFAULT 0,
      max_iterations INTEGER NOT NULL DEFAULT 10,
      last_output TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Auth users (Feature 4)
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Auth sessions (Feature 4)
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Rate limiting (Feature 4)
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      window_start TEXT NOT NULL DEFAULT (datetime('now'))
    );
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

export function upsertChannel(channel: {
  id: string;
  type: string;
  name: string;
  config: string;
  enabled: number;
}): void {
  getDb()
    .prepare(
      `
    INSERT INTO channels (id, type, name, config, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      config = excluded.config,
      enabled = excluded.enabled,
      updated_at = datetime('now')
  `,
    )
    .run(channel.id, channel.type, channel.name, channel.config, channel.enabled);
}

export function updateChannelStatus(id: string, status: string): void {
  getDb().prepare("UPDATE channels SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

export function deleteChannel(id: string): void {
  getDb().prepare('DELETE FROM channels WHERE id = ?').run(id);
}

// --- Conversation helpers ---

export function getOrCreateConversation(channelId: string, externalId: string, title?: string): string {
  const existing = getDb()
    .prepare('SELECT id FROM conversations WHERE channel_id = ? AND external_id = ?')
    .get(channelId, externalId) as { id: string } | undefined;

  if (existing) return existing.id;

  const id = require('uuid').v4();
  getDb()
    .prepare('INSERT INTO conversations (id, channel_id, external_id, title) VALUES (?, ?, ?, ?)')
    .run(id, channelId, externalId, title || externalId);
  return id;
}

export function getConversationMessages(conversationId: string, limit = 50): Array<{ role: string; content: string }> {
  return getDb()
    .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(conversationId, limit)
    .reverse() as Array<{ role: string; content: string }>;
}

export function addMessage(
  conversationId: string,
  role: string,
  content: string,
  channelType?: string,
  externalSender?: string,
): number {
  const result = getDb()
    .prepare(
      'INSERT INTO messages (conversation_id, role, content, channel_type, external_sender) VALUES (?, ?, ?, ?, ?)',
    )
    .run(conversationId, role, content, channelType, externalSender);
  return result.lastInsertRowid as number;
}

// --- Agent run tracking ---

export function createAgentRun(conversationId: string, inputMessageId: number): number {
  const result = getDb()
    .prepare("INSERT INTO agent_runs (conversation_id, input_message_id, status) VALUES (?, ?, 'pending')")
    .run(conversationId, inputMessageId);
  return result.lastInsertRowid as number;
}

export function updateAgentRun(
  id: number,
  update: { status?: string; input_tokens?: number; output_tokens?: number; error?: string },
): void {
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
  if (update.input_tokens !== undefined) {
    sets.push('input_tokens = ?');
    values.push(update.input_tokens);
  }
  if (update.output_tokens !== undefined) {
    sets.push('output_tokens = ?');
    values.push(update.output_tokens);
  }
  if (update.error !== undefined) {
    sets.push('error = ?');
    values.push(update.error);
  }

  if (sets.length === 0) return;
  values.push(id);
  getDb()
    .prepare(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values);
}

export function getRecentRuns(limit = 20): unknown[] {
  return getDb().prepare('SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?').all(limit);
}

// --- API Call Logging (Feature 3) ---

export function logApiCall(call: {
  conversation_id?: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  isolated: boolean;
  agent_group_id?: string;
}): void {
  // Check if agent_group_id column exists (added by groups schema migration)
  const columns = getDb().pragma('table_info(api_calls)') as Array<{ name: string }>;
  const hasGroupColumn = columns.some((c) => c.name === 'agent_group_id');

  if (hasGroupColumn && call.agent_group_id) {
    getDb()
      .prepare(
        'INSERT INTO api_calls (conversation_id, model, input_tokens, output_tokens, duration_ms, isolated, agent_group_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        call.conversation_id || null,
        call.model,
        call.input_tokens,
        call.output_tokens,
        call.duration_ms,
        call.isolated ? 1 : 0,
        call.agent_group_id,
      );
  } else {
    getDb()
      .prepare(
        'INSERT INTO api_calls (conversation_id, model, input_tokens, output_tokens, duration_ms, isolated) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        call.conversation_id || null,
        call.model,
        call.input_tokens,
        call.output_tokens,
        call.duration_ms,
        call.isolated ? 1 : 0,
      );
  }
}

export function getUsageSummary(): {
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  avg_duration_ms: number;
} {
  const row = getDb()
    .prepare(
      `
    SELECT
      COUNT(*) as total_calls,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COALESCE(AVG(duration_ms), 0) as avg_duration_ms
    FROM api_calls
  `,
    )
    .get() as any;

  // Approximate cost: Sonnet input=$3/MTok, output=$15/MTok
  const inputCost = (row.total_input_tokens / 1_000_000) * 3;
  const outputCost = (row.total_output_tokens / 1_000_000) * 15;

  return {
    ...row,
    total_cost_usd: Math.round((inputCost + outputCost) * 100) / 100,
  };
}

export function getUsageDaily(days = 30): Array<{
  date: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
}> {
  return getDb()
    .prepare(
      `
    SELECT
      date(created_at) as date,
      COUNT(*) as calls,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens
    FROM api_calls
    WHERE created_at >= datetime('now', ?)
    GROUP BY date(created_at)
    ORDER BY date ASC
  `,
    )
    .all(`-${days} days`) as any[];
}

export function getUsageByModel(): Array<{
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
}> {
  return getDb()
    .prepare(
      `
    SELECT
      model,
      COUNT(*) as calls,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens
    FROM api_calls
    GROUP BY model
    ORDER BY calls DESC
  `,
    )
    .all() as any[];
}

export function getRecentApiCalls(limit = 50): unknown[] {
  return getDb().prepare('SELECT * FROM api_calls ORDER BY created_at DESC LIMIT ?').all(limit);
}

// --- Loop Tasks (Feature 2) ---

export interface LoopTaskRow {
  id: number;
  name: string;
  prompt_file: string;
  output_file: string | null;
  status: string;
  iteration: number;
  max_iterations: number;
  last_output: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export function createLoopTask(task: {
  name: string;
  prompt_file: string;
  output_file?: string;
  max_iterations?: number;
}): number {
  const result = getDb()
    .prepare('INSERT INTO loop_tasks (name, prompt_file, output_file, max_iterations) VALUES (?, ?, ?, ?)')
    .run(task.name, task.prompt_file, task.output_file || null, task.max_iterations || 10);
  return result.lastInsertRowid as number;
}

export function getLoopTask(id: number): LoopTaskRow | undefined {
  return getDb().prepare('SELECT * FROM loop_tasks WHERE id = ?').get(id) as LoopTaskRow | undefined;
}

export function getAllLoopTasks(): LoopTaskRow[] {
  return getDb().prepare('SELECT * FROM loop_tasks ORDER BY created_at DESC').all() as LoopTaskRow[];
}

export function updateLoopTask(
  id: number,
  update: {
    status?: string;
    iteration?: number;
    last_output?: string;
    error?: string;
  },
): void {
  const sets: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];

  if (update.status !== undefined) {
    sets.push('status = ?');
    values.push(update.status);
  }
  if (update.iteration !== undefined) {
    sets.push('iteration = ?');
    values.push(update.iteration);
  }
  if (update.last_output !== undefined) {
    sets.push('last_output = ?');
    values.push(update.last_output);
  }
  if (update.error !== undefined) {
    sets.push('error = ?');
    values.push(update.error);
  }

  values.push(id);
  getDb()
    .prepare(`UPDATE loop_tasks SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values);
}

export function deleteLoopTask(id: number): void {
  getDb().prepare('DELETE FROM loop_tasks WHERE id = ?').run(id);
}

// --- Auth (Feature 4) ---

export function getUserByUsername(
  username: string,
): { id: number; username: string; password_hash: string; role: string } | undefined {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
}

export function createUser(username: string, passwordHash: string, role = 'admin'): number {
  const result = getDb()
    .prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, passwordHash, role);
  return result.lastInsertRowid as number;
}

export function getUserCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  return row.count;
}

export function createSession(id: string, userId: number, expiresAt: string): void {
  getDb().prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, expiresAt);
}

export function getSession(id: string): { id: string; user_id: number; expires_at: string } | undefined {
  return getDb().prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')").get(id) as any;
}

export function deleteSession(id: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function cleanExpiredSessions(): void {
  getDb().prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
}

// --- Rate Limiting (Feature 4) ---

export function checkRateLimit(key: string, maxRequests: number, windowSeconds: number): boolean {
  const now = new Date().toISOString();
  const row = getDb().prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').get(key) as
    | { count: number; window_start: string }
    | undefined;

  if (!row) {
    getDb().prepare('INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)').run(key, now);
    return true;
  }

  const windowStart = new Date(row.window_start);
  const windowEnd = new Date(windowStart.getTime() + windowSeconds * 1000);

  if (new Date(now) > windowEnd) {
    // Window expired, reset
    getDb().prepare('UPDATE rate_limits SET count = 1, window_start = ? WHERE key = ?').run(now, key);
    return true;
  }

  if (row.count >= maxRequests) {
    return false; // Rate limited
  }

  getDb().prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(key);
  return true;
}
