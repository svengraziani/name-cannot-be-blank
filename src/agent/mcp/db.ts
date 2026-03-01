/**
 * MCP Server Database Layer
 *
 * Schema and CRUD operations for MCP server configurations.
 * Uses the same SQLite database and encryption patterns as agent groups.
 */

import { v4 as uuid } from 'uuid';
import { getDb } from '../../db/sqlite';
import { encrypt, decrypt } from '../groups/encryption';
import type { McpServerConfig, McpToolInfo, CreateMcpServerInput, UpdateMcpServerInput } from './types';

/**
 * Initialize the MCP server database tables.
 * Called at startup — safe to run multiple times (CREATE IF NOT EXISTS).
 */
export function initMcpSchema(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      image TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'stdio',
      port INTEGER,
      command TEXT,
      args TEXT NOT NULL DEFAULT '[]',
      env_encrypted TEXT NOT NULL DEFAULT '{}',
      volumes TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'stopped',
      container_id TEXT,
      host_port INTEGER,
      tools_cache TEXT,
      catalog_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mcp_server_groups (
      mcp_server_id TEXT NOT NULL,
      agent_group_id TEXT NOT NULL,
      PRIMARY KEY (mcp_server_id, agent_group_id)
    );
  `);

  console.log('[mcp] MCP server schema initialized');
}

// --- Row conversion ---

function rowToConfig(row: Record<string, unknown>): McpServerConfig {
  let env: Record<string, string> = {};
  const envEncrypted = row.env_encrypted as string;
  if (envEncrypted && envEncrypted !== '{}') {
    try {
      env = JSON.parse(decrypt(envEncrypted));
    } catch {
      // If decryption fails, try parsing as plain JSON (migration)
      try {
        env = JSON.parse(envEncrypted);
      } catch {
        env = {};
      }
    }
  }

  let toolsCache: McpToolInfo[] | undefined;
  if (row.tools_cache) {
    try {
      toolsCache = JSON.parse(row.tools_cache as string);
    } catch {
      toolsCache = undefined;
    }
  }

  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) || '',
    image: row.image as string,
    transport: (row.transport as 'stdio' | 'sse') || 'stdio',
    port: row.port as number | undefined,
    command: row.command as string | undefined,
    args: JSON.parse((row.args as string) || '[]'),
    env,
    volumes: JSON.parse((row.volumes as string) || '[]'),
    status: (row.status as McpServerConfig['status']) || 'stopped',
    containerId: row.container_id as string | undefined,
    hostPort: row.host_port as number | undefined,
    toolsCache,
    catalogId: row.catalog_id as string | undefined,
    error: row.error as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// --- CRUD ---

export function createMcpServer(input: CreateMcpServerInput): McpServerConfig {
  const id = uuid();
  const db = getDb();

  const envEncrypted = input.env && Object.keys(input.env).length > 0 ? encrypt(JSON.stringify(input.env)) : '{}';

  db.prepare(
    `
    INSERT INTO mcp_servers (id, name, description, image, transport, port, command, args, env_encrypted, volumes, catalog_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    input.name,
    input.description || '',
    input.image,
    input.transport || 'stdio',
    input.port || null,
    input.command || null,
    JSON.stringify(input.args || []),
    envEncrypted,
    JSON.stringify(input.volumes || []),
    input.catalogId || null,
  );

  return getMcpServer(id)!;
}

export function getMcpServer(id: string): McpServerConfig | undefined {
  const row = getDb().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToConfig(row);
}

export function getAllMcpServers(): McpServerConfig[] {
  const rows = getDb().prepare('SELECT * FROM mcp_servers ORDER BY created_at DESC').all() as Array<
    Record<string, unknown>
  >;
  return rows.map(rowToConfig);
}

export function updateMcpServer(id: string, input: UpdateMcpServerInput): McpServerConfig {
  const existing = getMcpServer(id);
  if (!existing) throw new Error(`MCP server ${id} not found`);

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
  if (input.image !== undefined) {
    sets.push('image = ?');
    values.push(input.image);
  }
  if (input.transport !== undefined) {
    sets.push('transport = ?');
    values.push(input.transport);
  }
  if (input.port !== undefined) {
    sets.push('port = ?');
    values.push(input.port);
  }
  if (input.command !== undefined) {
    sets.push('command = ?');
    values.push(input.command);
  }
  if (input.args !== undefined) {
    sets.push('args = ?');
    values.push(JSON.stringify(input.args));
  }
  if (input.volumes !== undefined) {
    sets.push('volumes = ?');
    values.push(JSON.stringify(input.volumes));
  }
  if (input.env !== undefined) {
    sets.push('env_encrypted = ?');
    values.push(Object.keys(input.env).length > 0 ? encrypt(JSON.stringify(input.env)) : '{}');
  }

  values.push(id);
  getDb()
    .prepare(`UPDATE mcp_servers SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values);

  return getMcpServer(id)!;
}

export function deleteMcpServer(id: string): boolean {
  const db = getDb();
  db.prepare('DELETE FROM mcp_server_groups WHERE mcp_server_id = ?').run(id);
  const result = db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  return result.changes > 0;
}

// --- Status updates ---

export function updateMcpServerStatus(
  id: string,
  status: McpServerConfig['status'],
  extra?: { containerId?: string; hostPort?: number; error?: string },
): void {
  const sets = ["status = ?", "updated_at = datetime('now')"];
  const values: unknown[] = [status];

  if (extra?.containerId !== undefined) {
    sets.push('container_id = ?');
    values.push(extra.containerId);
  }
  if (extra?.hostPort !== undefined) {
    sets.push('host_port = ?');
    values.push(extra.hostPort);
  }
  if (extra?.error !== undefined) {
    sets.push('error = ?');
    values.push(extra.error);
  }
  if (status !== 'error') {
    sets.push('error = NULL');
  }

  values.push(id);
  getDb()
    .prepare(`UPDATE mcp_servers SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values);
}

export function updateMcpServerToolsCache(id: string, tools: McpToolInfo[]): void {
  getDb()
    .prepare("UPDATE mcp_servers SET tools_cache = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(tools), id);
}

export function clearMcpServerRuntime(id: string): void {
  getDb()
    .prepare(
      "UPDATE mcp_servers SET status = 'stopped', container_id = NULL, host_port = NULL, error = NULL, updated_at = datetime('now') WHERE id = ?",
    )
    .run(id);
}

// --- Group assignment ---

export function assignMcpServerToGroup(mcpServerId: string, agentGroupId: string): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO mcp_server_groups (mcp_server_id, agent_group_id) VALUES (?, ?)')
    .run(mcpServerId, agentGroupId);
}

export function unassignMcpServerFromGroup(mcpServerId: string, agentGroupId: string): void {
  getDb()
    .prepare('DELETE FROM mcp_server_groups WHERE mcp_server_id = ? AND agent_group_id = ?')
    .run(mcpServerId, agentGroupId);
}

export function getMcpServerGroupIds(mcpServerId: string): string[] {
  const rows = getDb()
    .prepare('SELECT agent_group_id FROM mcp_server_groups WHERE mcp_server_id = ?')
    .all(mcpServerId) as Array<{ agent_group_id: string }>;
  return rows.map((r) => r.agent_group_id);
}

export function getMcpServersByGroup(agentGroupId: string): McpServerConfig[] {
  const rows = getDb()
    .prepare(
      `
    SELECT ms.* FROM mcp_servers ms
    INNER JOIN mcp_server_groups msg ON ms.id = msg.mcp_server_id
    WHERE msg.agent_group_id = ?
    ORDER BY ms.name ASC
  `,
    )
    .all(agentGroupId) as Array<Record<string, unknown>>;
  return rows.map(rowToConfig);
}

/**
 * Get all MCP tool names available to a specific agent group.
 * Only includes tools from running MCP servers assigned to the group.
 */
export function getMcpToolNamesForGroup(agentGroupId: string): string[] {
  const servers = getMcpServersByGroup(agentGroupId);
  const toolNames: string[] = [];

  for (const server of servers) {
    if (server.status === 'running' && server.toolsCache) {
      for (const tool of server.toolsCache) {
        toolNames.push(`mcp_${sanitizeName(server.name)}_${tool.name}`);
      }
    }
  }

  return toolNames;
}

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}
