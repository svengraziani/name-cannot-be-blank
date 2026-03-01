import Database from 'better-sqlite3';
import { config } from '../config';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
    migrateSchema(db);
  }
  return db;
}

function migrateSchema(db: Database.Database) {
  // Add branch_id to messages (nullable for backwards compat)
  const msgCols = db.pragma('table_info(messages)') as Array<{ name: string }>;
  if (!msgCols.some((c) => c.name === 'branch_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN branch_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_branch ON messages(branch_id)');
  }

  // Add active_branch_id to conversations
  const convCols = db.pragma('table_info(conversations)') as Array<{ name: string }>;
  if (!convCols.some((c) => c.name === 'active_branch_id')) {
    db.exec('ALTER TABLE conversations ADD COLUMN active_branch_id TEXT');
  }
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

    -- Conversation branches (git-style branching for conversations)
    CREATE TABLE IF NOT EXISTS conversation_branches (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      parent_branch_id TEXT,
      branch_point_message_id INTEGER,
      name TEXT NOT NULL DEFAULT 'main',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_branch_id) REFERENCES conversation_branches(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(channel_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation ON agent_runs(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_branches_conversation ON conversation_branches(conversation_id);

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

  // Create the default "main" branch for new conversations
  const branchId = require('uuid').v4();
  getDb()
    .prepare('INSERT INTO conversation_branches (id, conversation_id, name) VALUES (?, ?, ?)')
    .run(branchId, id, 'main');
  getDb()
    .prepare('UPDATE conversations SET active_branch_id = ? WHERE id = ?')
    .run(branchId, id);

  return id;
}

export function getConversation(conversationId: string): { id: string; channelId: string; externalId: string } | undefined {
  return getDb()
    .prepare('SELECT id, channel_id as channelId, external_id as externalId FROM conversations WHERE id = ?')
    .get(conversationId) as { id: string; channelId: string; externalId: string } | undefined;
}

export function getConversationMessages(conversationId: string, limit = 50): Array<{ role: string; content: string }> {
  // Get active branch for this conversation
  const conv = getDb()
    .prepare('SELECT active_branch_id FROM conversations WHERE id = ?')
    .get(conversationId) as { active_branch_id: string | null } | undefined;

  if (conv?.active_branch_id) {
    return getBranchMessages(conversationId, conv.active_branch_id, limit);
  }

  // Fallback for conversations without branches (legacy)
  return getDb()
    .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(conversationId, limit)
    .reverse() as Array<{ role: string; content: string }>;
}

/**
 * Get messages for a specific branch, following the chain up to root.
 * Messages include: parent branch messages up to the branch point, then this branch's own messages.
 */
export function getBranchMessages(
  conversationId: string,
  branchId: string,
  limit = 50,
): Array<{ role: string; content: string }> {
  // Build the branch chain from current branch to root
  const branchChain: Array<{ id: string; parent_branch_id: string | null; branch_point_message_id: number | null }> = [];
  let currentId: string | null = branchId;

  while (currentId) {
    const branch = getDb()
      .prepare('SELECT id, parent_branch_id, branch_point_message_id FROM conversation_branches WHERE id = ?')
      .get(currentId) as { id: string; parent_branch_id: string | null; branch_point_message_id: number | null } | undefined;
    if (!branch) break;
    branchChain.unshift(branch); // prepend so root is first
    currentId = branch.parent_branch_id;
  }

  if (branchChain.length === 0) {
    // Fallback: no branch found, return all messages
    return getDb()
      .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(conversationId, limit)
      .reverse() as Array<{ role: string; content: string }>;
  }

  // Collect messages following the branch chain
  const messages: Array<{ role: string; content: string }> = [];

  for (let i = 0; i < branchChain.length; i++) {
    const branch = branchChain[i];

    if (i < branchChain.length - 1) {
      // For parent branches: get messages up to the next branch's branch_point_message_id
      const nextBranch = branchChain[i + 1];
      if (nextBranch.branch_point_message_id) {
        const rows = getDb()
          .prepare(
            'SELECT role, content FROM messages WHERE conversation_id = ? AND branch_id = ? AND id <= ? ORDER BY id ASC',
          )
          .all(conversationId, branch.id, nextBranch.branch_point_message_id) as Array<{ role: string; content: string }>;
        messages.push(...rows);
      } else {
        // No branch point specified, include all messages from this branch
        const rows = getDb()
          .prepare('SELECT role, content FROM messages WHERE conversation_id = ? AND branch_id = ? ORDER BY id ASC')
          .all(conversationId, branch.id) as Array<{ role: string; content: string }>;
        messages.push(...rows);
      }
    } else {
      // For the current (leaf) branch: get all its messages
      const rows = getDb()
        .prepare('SELECT role, content FROM messages WHERE conversation_id = ? AND branch_id = ? ORDER BY id ASC')
        .all(conversationId, branch.id) as Array<{ role: string; content: string }>;
      messages.push(...rows);
    }
  }

  // Apply limit (take last N messages)
  return messages.slice(-limit);
}

export function addMessage(
  conversationId: string,
  role: string,
  content: string,
  channelType?: string,
  externalSender?: string,
  branchId?: string,
): number {
  // Resolve branch: use provided branchId, or the conversation's active branch, or null
  let effectiveBranchId = branchId;
  if (!effectiveBranchId) {
    const conv = getDb()
      .prepare('SELECT active_branch_id FROM conversations WHERE id = ?')
      .get(conversationId) as { active_branch_id: string | null } | undefined;
    effectiveBranchId = conv?.active_branch_id || undefined;
  }

  const result = getDb()
    .prepare(
      'INSERT INTO messages (conversation_id, role, content, channel_type, external_sender, branch_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(conversationId, role, content, channelType, externalSender, effectiveBranchId || null);
  return result.lastInsertRowid as number;
}

export function clearConversationMessages(conversationId: string): number {
  const result = getDb()
    .prepare('DELETE FROM messages WHERE conversation_id = ?')
    .run(conversationId);
  return result.changes;
}

export function countConversationMessages(conversationId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?')
    .get(conversationId) as { count: number };
  return row.count;
}

// --- Conversation Branching ---

export interface ConversationBranchRow {
  id: string;
  conversation_id: string;
  parent_branch_id: string | null;
  branch_point_message_id: number | null;
  name: string;
  created_at: string;
}

export function getConversationBranches(conversationId: string): ConversationBranchRow[] {
  return getDb()
    .prepare('SELECT * FROM conversation_branches WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(conversationId) as ConversationBranchRow[];
}

export function getBranch(branchId: string): ConversationBranchRow | undefined {
  return getDb()
    .prepare('SELECT * FROM conversation_branches WHERE id = ?')
    .get(branchId) as ConversationBranchRow | undefined;
}

export function createBranch(opts: {
  conversationId: string;
  parentBranchId: string;
  branchPointMessageId: number;
  name: string;
}): ConversationBranchRow {
  const id = require('uuid').v4();
  getDb()
    .prepare(
      'INSERT INTO conversation_branches (id, conversation_id, parent_branch_id, branch_point_message_id, name) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, opts.conversationId, opts.parentBranchId, opts.branchPointMessageId, opts.name);

  // Set the new branch as active
  getDb()
    .prepare('UPDATE conversations SET active_branch_id = ? WHERE id = ?')
    .run(id, opts.conversationId);

  return getBranch(id)!;
}

export function setActiveBranch(conversationId: string, branchId: string): void {
  getDb()
    .prepare('UPDATE conversations SET active_branch_id = ? WHERE id = ?')
    .run(branchId, conversationId);
}

export function getActiveBranchId(conversationId: string): string | null {
  const row = getDb()
    .prepare('SELECT active_branch_id FROM conversations WHERE id = ?')
    .get(conversationId) as { active_branch_id: string | null } | undefined;
  return row?.active_branch_id || null;
}

export function deleteBranch(branchId: string): boolean {
  const branch = getBranch(branchId);
  if (!branch) return false;

  // Don't allow deleting the main (root) branch
  if (!branch.parent_branch_id) return false;

  // Delete child branches first (cascade)
  const children = getDb()
    .prepare('SELECT id FROM conversation_branches WHERE parent_branch_id = ?')
    .all(branchId) as Array<{ id: string }>;
  for (const child of children) {
    deleteBranch(child.id);
  }

  // Delete messages on this branch
  getDb().prepare('DELETE FROM messages WHERE branch_id = ?').run(branchId);

  // If this was the active branch, switch back to parent
  const conv = getDb()
    .prepare('SELECT active_branch_id FROM conversations WHERE id = ?')
    .get(branch.conversation_id) as { active_branch_id: string | null } | undefined;
  if (conv?.active_branch_id === branchId) {
    getDb()
      .prepare('UPDATE conversations SET active_branch_id = ? WHERE id = ?')
      .run(branch.parent_branch_id, branch.conversation_id);
  }

  getDb().prepare('DELETE FROM conversation_branches WHERE id = ?').run(branchId);
  return true;
}

export function getBranchTree(conversationId: string): Array<{
  branch: ConversationBranchRow;
  messageCount: number;
  lastMessage: string | null;
}> {
  const branches = getConversationBranches(conversationId);
  return branches.map((branch) => {
    const count = getDb()
      .prepare('SELECT COUNT(*) as count FROM messages WHERE branch_id = ?')
      .get(branch.id) as { count: number };
    const last = getDb()
      .prepare('SELECT content FROM messages WHERE branch_id = ? ORDER BY id DESC LIMIT 1')
      .get(branch.id) as { content: string } | undefined;
    return {
      branch,
      messageCount: count.count,
      lastMessage: last?.content || null,
    };
  });
}

export function getBranchMessagesDetailed(
  branchId: string,
): Array<{ id: number; role: string; content: string; created_at: string }> {
  return getDb()
    .prepare('SELECT id, role, content, created_at FROM messages WHERE branch_id = ? ORDER BY id ASC')
    .all(branchId) as Array<{ id: number; role: string; content: string; created_at: string }>;
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
