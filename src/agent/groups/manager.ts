/**
 * Agent Group Manager - CRUD operations and database schema for agent groups.
 */

import { v4 as uuid } from 'uuid';
import { getDb } from '../../db/sqlite';
import type { AgentGroup, CreateAgentGroupInput, UpdateAgentGroupInput, AgentGroupStats, PersonaConfig } from './types';
import { DEFAULT_PERSONA } from './types';
import { encrypt, decrypt } from './encryption';

/**
 * Initialize the agent_groups table and add agent_group_id to channels.
 * Called at startup as part of DB initialization.
 */
export function initAgentGroupsSchema(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      system_prompt TEXT NOT NULL,
      api_key_encrypted TEXT,
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
      max_tokens INTEGER NOT NULL DEFAULT 16384,
      skills TEXT NOT NULL DEFAULT '[]',
      roles TEXT NOT NULL DEFAULT '[]',
      container_mode INTEGER NOT NULL DEFAULT 0,
      max_concurrent_agents INTEGER NOT NULL DEFAULT 3,
      budget_max_tokens_day INTEGER NOT NULL DEFAULT 0,
      budget_max_tokens_month INTEGER NOT NULL DEFAULT 0,
      budget_alert_threshold INTEGER NOT NULL DEFAULT 80,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Add agent_group_id column to channels if it doesn't exist
  const channelColumns = db.pragma('table_info(channels)') as Array<{ name: string }>;
  const hasGroupColumn = channelColumns.some((c) => c.name === 'agent_group_id');
  if (!hasGroupColumn) {
    db.exec(`ALTER TABLE channels ADD COLUMN agent_group_id TEXT REFERENCES agent_groups(id) ON DELETE SET NULL`);
    console.log('[groups] Added agent_group_id column to channels table');
  }

  // Add agent_group_id column to api_calls for per-group usage tracking
  const apiCallColumns = db.pragma('table_info(api_calls)') as Array<{ name: string }>;
  const hasApiCallGroupColumn = apiCallColumns.some((c) => c.name === 'agent_group_id');
  if (!hasApiCallGroupColumn) {
    db.exec(`ALTER TABLE api_calls ADD COLUMN agent_group_id TEXT`);
    console.log('[groups] Added agent_group_id column to api_calls table');
  }

  // Migrate old groups with low max_tokens default
  db.exec(`UPDATE agent_groups SET max_tokens = 16384 WHERE max_tokens <= 8192`);

  // Add github_repo and github_token_encrypted columns if they don't exist
  const groupColumns = db.pragma('table_info(agent_groups)') as Array<{ name: string }>;
  if (!groupColumns.some((c) => c.name === 'github_repo')) {
    db.exec(`ALTER TABLE agent_groups ADD COLUMN github_repo TEXT DEFAULT ''`);
    console.log('[groups] Added github_repo column to agent_groups table');
  }
  if (!groupColumns.some((c) => c.name === 'github_token_encrypted')) {
    db.exec(`ALTER TABLE agent_groups ADD COLUMN github_token_encrypted TEXT`);
    console.log('[groups] Added github_token_encrypted column to agent_groups table');
  }

  // Re-read columns after potential migrations above
  const updatedGroupColumns = db.pragma('table_info(agent_groups)') as Array<{ name: string }>;
  if (!updatedGroupColumns.some((c) => c.name === 'persona')) {
    db.exec(`ALTER TABLE agent_groups ADD COLUMN persona TEXT DEFAULT '${JSON.stringify(DEFAULT_PERSONA)}'`);
    console.log('[groups] Added persona column to agent_groups table');
  }

  console.log('[groups] Agent groups schema initialized');
}

function parsePersona(raw: string | null): PersonaConfig {
  if (!raw) return { ...DEFAULT_PERSONA };
  try {
    const parsed = JSON.parse(raw) as Partial<PersonaConfig>;
    return { ...DEFAULT_PERSONA, ...parsed };
  } catch {
    return { ...DEFAULT_PERSONA };
  }
}

/**
 * Convert a DB row to an AgentGroup object.
 */
function rowToGroup(row: Record<string, unknown>): AgentGroup {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) || '',
    systemPrompt: row.system_prompt as string,
    apiKeyEncrypted: row.api_key_encrypted as string | null,
    model: row.model as string,
    maxTokens: row.max_tokens as number,
    githubRepo: (row.github_repo as string) || '',
    githubTokenEncrypted: row.github_token_encrypted as string | null,
    budgetMaxTokensDay: row.budget_max_tokens_day as number,
    budgetMaxTokensMonth: row.budget_max_tokens_month as number,
    budgetAlertThreshold: row.budget_alert_threshold as number,
    skills: JSON.parse((row.skills as string) || '[]'),
    roles: JSON.parse((row.roles as string) || '[]'),
    persona: parsePersona(row.persona as string | null),
    containerMode: (row.container_mode as number) === 1,
    maxConcurrentAgents: row.max_concurrent_agents as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// --- CRUD ---

export function createAgentGroup(input: CreateAgentGroupInput): AgentGroup {
  const id = uuid();
  const db = getDb();

  let apiKeyEncrypted: string | null = null;
  if (input.apiKey) {
    apiKeyEncrypted = encrypt(input.apiKey);
  }

  let githubTokenEncrypted: string | null = null;
  if (input.githubToken) {
    githubTokenEncrypted = encrypt(input.githubToken);
  }

  const persona: PersonaConfig = { ...DEFAULT_PERSONA, ...input.persona };

  db.prepare(
    `
    INSERT INTO agent_groups (
      id, name, description, system_prompt, api_key_encrypted,
      model, max_tokens, github_repo, github_token_encrypted,
      skills, roles, persona,
      container_mode, max_concurrent_agents,
      budget_max_tokens_day, budget_max_tokens_month, budget_alert_threshold
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    input.name,
    input.description || '',
    input.systemPrompt,
    apiKeyEncrypted,
    input.model || 'claude-sonnet-4-20250514',
    input.maxTokens || 16384,
    input.githubRepo || '',
    githubTokenEncrypted,
    JSON.stringify(input.skills || []),
    JSON.stringify(input.roles || []),
    JSON.stringify(persona),
    input.containerMode ? 1 : 0,
    input.maxConcurrentAgents || 3,
    input.budgetMaxTokensDay || 0,
    input.budgetMaxTokensMonth || 0,
    input.budgetAlertThreshold || 80,
  );

  return getAgentGroup(id)!;
}

export function getAgentGroup(id: string): AgentGroup | undefined {
  const row = getDb().prepare('SELECT * FROM agent_groups WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToGroup(row);
}

export function getAllAgentGroups(): AgentGroup[] {
  const rows = getDb().prepare('SELECT * FROM agent_groups ORDER BY created_at DESC').all() as Array<
    Record<string, unknown>
  >;
  return rows.map(rowToGroup);
}

export function updateAgentGroup(id: string, input: UpdateAgentGroupInput): AgentGroup {
  const existing = getAgentGroup(id);
  if (!existing) throw new Error(`Agent group ${id} not found`);

  const sets: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    sets.push('name = ?');
    values.push(input.name);
  }
  if (input.description !== undefined) {
    sets.push('description = ?');
    values.push(input.description);
  }
  if (input.systemPrompt !== undefined) {
    sets.push('system_prompt = ?');
    values.push(input.systemPrompt);
  }
  if (input.model !== undefined) {
    sets.push('model = ?');
    values.push(input.model);
  }
  if (input.maxTokens !== undefined) {
    sets.push('max_tokens = ?');
    values.push(input.maxTokens);
  }
  if (input.skills !== undefined) {
    sets.push('skills = ?');
    values.push(JSON.stringify(input.skills));
  }
  if (input.roles !== undefined) {
    sets.push('roles = ?');
    values.push(JSON.stringify(input.roles));
  }
  if (input.containerMode !== undefined) {
    sets.push('container_mode = ?');
    values.push(input.containerMode ? 1 : 0);
  }
  if (input.maxConcurrentAgents !== undefined) {
    sets.push('max_concurrent_agents = ?');
    values.push(input.maxConcurrentAgents);
  }
  if (input.budgetMaxTokensDay !== undefined) {
    sets.push('budget_max_tokens_day = ?');
    values.push(input.budgetMaxTokensDay);
  }
  if (input.budgetMaxTokensMonth !== undefined) {
    sets.push('budget_max_tokens_month = ?');
    values.push(input.budgetMaxTokensMonth);
  }
  if (input.budgetAlertThreshold !== undefined) {
    sets.push('budget_alert_threshold = ?');
    values.push(input.budgetAlertThreshold);
  }

  if (input.persona !== undefined) {
    // Merge with existing persona so partial updates work
    const merged: PersonaConfig = { ...existing.persona, ...input.persona };
    sets.push('persona = ?');
    values.push(JSON.stringify(merged));
  }
  if (input.githubRepo !== undefined) {
    sets.push('github_repo = ?');
    values.push(input.githubRepo);
  }

  // Handle API key: null = clear, string = encrypt, undefined = no change
  if (input.apiKey === null) {
    sets.push('api_key_encrypted = ?');
    values.push(null);
  } else if (input.apiKey !== undefined) {
    sets.push('api_key_encrypted = ?');
    values.push(encrypt(input.apiKey));
  }

  // Handle GitHub token: null = clear, string = encrypt, undefined = no change
  if (input.githubToken === null) {
    sets.push('github_token_encrypted = ?');
    values.push(null);
  } else if (input.githubToken !== undefined) {
    sets.push('github_token_encrypted = ?');
    values.push(encrypt(input.githubToken));
  }

  values.push(id);
  getDb()
    .prepare(`UPDATE agent_groups SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values);

  return getAgentGroup(id)!;
}

export function deleteAgentGroup(id: string): void {
  // Unassign all channels first
  getDb().prepare('UPDATE channels SET agent_group_id = NULL WHERE agent_group_id = ?').run(id);
  getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run(id);
}

// --- Channel Binding ---

export function assignChannelToGroup(channelId: string, groupId: string): void {
  // Verify group exists
  const group = getAgentGroup(groupId);
  if (!group) throw new Error(`Agent group ${groupId} not found`);

  getDb()
    .prepare("UPDATE channels SET agent_group_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(groupId, channelId);
}

export function unassignChannelFromGroup(channelId: string): void {
  getDb()
    .prepare("UPDATE channels SET agent_group_id = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(channelId);
}

export function getGroupForChannel(channelId: string): AgentGroup | undefined {
  const row = getDb()
    .prepare(
      `
    SELECT ag.* FROM agent_groups ag
    INNER JOIN channels c ON c.agent_group_id = ag.id
    WHERE c.id = ?
  `,
    )
    .get(channelId) as Record<string, unknown> | undefined;

  if (!row) return undefined;
  return rowToGroup(row);
}

// --- Usage / Stats ---

export function getGroupTokenUsageToday(groupId: string): number {
  const row = getDb()
    .prepare(
      `
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total
    FROM api_calls
    WHERE agent_group_id = ? AND date(created_at) = date('now')
  `,
    )
    .get(groupId) as { total: number };
  return row.total;
}

export function getGroupTokenUsageMonth(groupId: string): number {
  const row = getDb()
    .prepare(
      `
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total
    FROM api_calls
    WHERE agent_group_id = ? AND created_at >= datetime('now', 'start of month')
  `,
    )
    .get(groupId) as { total: number };
  return row.total;
}

export function getAgentGroupStats(groupId: string): AgentGroupStats {
  const todayTokens = getGroupTokenUsageToday(groupId);
  const monthTokens = getGroupTokenUsageMonth(groupId);

  const runsRow = getDb()
    .prepare(
      `
    SELECT COUNT(*) as total FROM agent_runs ar
    INNER JOIN conversations c ON ar.conversation_id = c.id
    INNER JOIN channels ch ON c.channel_id = ch.id
    WHERE ch.agent_group_id = ?
  `,
    )
    .get(groupId) as { total: number };

  return {
    groupId,
    todayTokens,
    monthTokens,
    activeAgents: 0, // TODO: track when A2A is implemented
    totalRuns: runsRow.total,
  };
}

/**
 * Get the decrypted GitHub PAT for a group, or fall back to GITHUB_TOKEN env var.
 */
export function getGroupGithubToken(groupId: string): string {
  const group = getAgentGroup(groupId);
  if (group?.githubTokenEncrypted) {
    try {
      return decrypt(group.githubTokenEncrypted);
    } catch (err) {
      console.error(`[groups] Failed to decrypt GitHub token for group ${groupId}:`, err);
    }
  }
  return process.env.GITHUB_TOKEN || '';
}

/**
 * Get the decrypted API key for a group, or fall back to global key.
 */
export function getGroupApiKey(groupId: string): string {
  const group = getAgentGroup(groupId);
  if (group?.apiKeyEncrypted) {
    try {
      return decrypt(group.apiKeyEncrypted);
    } catch (err) {
      console.error(`[groups] Failed to decrypt API key for group ${groupId}:`, err);
    }
  }
  // Fallback to global key
  return process.env.ANTHROPIC_API_KEY || '';
}
