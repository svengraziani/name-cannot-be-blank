/**
 * Workflow DB - SQLite persistence for workflow definitions and run history.
 */

import { v4 as uuid } from 'uuid';
import { getDb } from '../../db/sqlite';
import {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRow,
  WorkflowRunRow,
  WorkflowNode,
  WorkflowEdge,
  WorkflowNodeResult,
} from './types';

// ── Schema ──────────────────────────────────────────────────────────

export function initWorkflowSchema(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      definition TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
      enabled INTEGER NOT NULL DEFAULT 1,
      trigger_channel_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      input TEXT NOT NULL DEFAULT '',
      current_node_id TEXT,
      node_results TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      error TEXT,
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
  `);

  console.log('[workflows] Schema initialized');
}

// ── Workflow CRUD ───────────────────────────────────────────────────

function rowToWorkflow(row: WorkflowRow): WorkflowDefinition {
  const def = JSON.parse(row.definition) as { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    nodes: def.nodes,
    edges: def.edges,
    enabled: row.enabled === 1,
    triggerChannelIds: JSON.parse(row.trigger_channel_ids),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createWorkflow(params: {
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  triggerChannelIds?: string[];
}): WorkflowDefinition {
  const id = uuid();
  const definition = JSON.stringify({ nodes: params.nodes, edges: params.edges });
  const triggerChannelIds = JSON.stringify(params.triggerChannelIds || []);

  getDb()
    .prepare(`INSERT INTO workflows (id, name, description, definition, trigger_channel_ids) VALUES (?, ?, ?, ?, ?)`)
    .run(id, params.name, params.description || '', definition, triggerChannelIds);

  return getWorkflow(id)!;
}

export function getWorkflow(id: string): WorkflowDefinition | undefined {
  const row = getDb().prepare('SELECT * FROM workflows WHERE id = ?').get(id) as WorkflowRow | undefined;
  return row ? rowToWorkflow(row) : undefined;
}

export function getAllWorkflows(): WorkflowDefinition[] {
  const rows = getDb().prepare('SELECT * FROM workflows ORDER BY created_at DESC').all() as WorkflowRow[];
  return rows.map(rowToWorkflow);
}

export function updateWorkflow(
  id: string,
  update: {
    name?: string;
    description?: string;
    nodes?: WorkflowNode[];
    edges?: WorkflowEdge[];
    enabled?: boolean;
    triggerChannelIds?: string[];
  },
): WorkflowDefinition {
  const existing = getWorkflow(id);
  if (!existing) throw new Error(`Workflow ${id} not found`);

  const sets: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];

  if (update.name !== undefined) {
    sets.push('name = ?');
    values.push(update.name);
  }
  if (update.description !== undefined) {
    sets.push('description = ?');
    values.push(update.description);
  }
  if (update.nodes !== undefined || update.edges !== undefined) {
    const nodes = update.nodes ?? existing.nodes;
    const edges = update.edges ?? existing.edges;
    sets.push('definition = ?');
    values.push(JSON.stringify({ nodes, edges }));
  }
  if (update.enabled !== undefined) {
    sets.push('enabled = ?');
    values.push(update.enabled ? 1 : 0);
  }
  if (update.triggerChannelIds !== undefined) {
    sets.push('trigger_channel_ids = ?');
    values.push(JSON.stringify(update.triggerChannelIds));
  }

  values.push(id);
  getDb()
    .prepare(`UPDATE workflows SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values);

  return getWorkflow(id)!;
}

export function deleteWorkflow(id: string): boolean {
  const result = getDb().prepare('DELETE FROM workflows WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Find workflows that are triggered by a specific channel.
 */
export function getWorkflowsForChannel(channelId: string): WorkflowDefinition[] {
  const all = getAllWorkflows();
  return all.filter((w) => w.enabled && w.triggerChannelIds.includes(channelId));
}

// ── Workflow Run Tracking ───────────────────────────────────────────

function rowToRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    status: row.status as WorkflowRun['status'],
    input: row.input,
    currentNodeId: row.current_node_id,
    nodeResults: JSON.parse(row.node_results) as WorkflowNodeResult[],
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
  };
}

export function createWorkflowRun(workflowId: string, input: string): WorkflowRun {
  const id = uuid();
  getDb().prepare(`INSERT INTO workflow_runs (id, workflow_id, input) VALUES (?, ?, ?)`).run(id, workflowId, input);
  return getWorkflowRun(id)!;
}

export function getWorkflowRun(id: string): WorkflowRun | undefined {
  const row = getDb().prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as WorkflowRunRow | undefined;
  return row ? rowToRun(row) : undefined;
}

export function getWorkflowRuns(workflowId: string, limit = 20): WorkflowRun[] {
  const rows = getDb()
    .prepare('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(workflowId, limit) as WorkflowRunRow[];
  return rows.map(rowToRun);
}

export function updateWorkflowRun(
  id: string,
  update: {
    status?: WorkflowRun['status'];
    currentNodeId?: string | null;
    nodeResults?: WorkflowNodeResult[];
    error?: string;
  },
): void {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (update.status !== undefined) {
    sets.push('status = ?');
    values.push(update.status);
    if (update.status === 'completed' || update.status === 'failed') {
      sets.push("completed_at = datetime('now')");
    }
  }
  if (update.currentNodeId !== undefined) {
    sets.push('current_node_id = ?');
    values.push(update.currentNodeId);
  }
  if (update.nodeResults !== undefined) {
    sets.push('node_results = ?');
    values.push(JSON.stringify(update.nodeResults));
  }
  if (update.error !== undefined) {
    sets.push('error = ?');
    values.push(update.error);
  }

  if (sets.length === 0) return;
  values.push(id);
  getDb()
    .prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values);
}

export function getWorkflowStats(): {
  totalWorkflows: number;
  enabledWorkflows: number;
  totalRuns: number;
  runningRuns: number;
  completedRuns: number;
  failedRuns: number;
} {
  const db = getDb();
  const wf = db.prepare('SELECT COUNT(*) as total, SUM(enabled) as enabled FROM workflows').get() as {
    total: number;
    enabled: number;
  };
  const runs = db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM workflow_runs`,
    )
    .get() as { total: number; running: number; completed: number; failed: number };

  return {
    totalWorkflows: wf.total,
    enabledWorkflows: wf.enabled || 0,
    totalRuns: runs.total,
    runningRuns: runs.running || 0,
    completedRuns: runs.completed || 0,
    failedRuns: runs.failed || 0,
  };
}
