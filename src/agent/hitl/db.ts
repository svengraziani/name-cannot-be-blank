/**
 * HITL Approval Database Schema & Persistence
 *
 * Tables:
 *   - approval_requests: Pending/resolved tool approval requests
 *   - approval_rules: Per-tool approval configuration
 */

import { v4 as uuid } from 'uuid';
import { getDb } from '../../db/sqlite';
import {
  ApprovalRequest,
  ApprovalRule,
  ApprovalStatus,
  RiskLevel,
  DEFAULT_TOOL_RISK,
  DEFAULT_TIMEOUT,
  DEFAULT_REQUIRE_APPROVAL,
} from './types';

/**
 * Initialize the HITL schema. Safe to call multiple times.
 */
export function initHitlSchema(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      run_id INTEGER NOT NULL,
      conversation_id TEXT NOT NULL,
      channel_id TEXT,
      group_id TEXT,
      tool_name TEXT NOT NULL,
      tool_input TEXT NOT NULL DEFAULT '{}',
      risk_level TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT,
      responded_by TEXT,
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      responded_at TEXT,
      timeout_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_requests(status);
    CREATE INDEX IF NOT EXISTS idx_approval_run ON approval_requests(run_id);
    CREATE INDEX IF NOT EXISTS idx_approval_requested ON approval_requests(requested_at);

    CREATE TABLE IF NOT EXISTS approval_rules (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL UNIQUE,
      risk_level TEXT NOT NULL DEFAULT 'medium',
      auto_approve INTEGER NOT NULL DEFAULT 0,
      require_approval INTEGER NOT NULL DEFAULT 1,
      timeout_seconds INTEGER NOT NULL DEFAULT 300,
      timeout_action TEXT NOT NULL DEFAULT 'reject',
      enabled INTEGER NOT NULL DEFAULT 1
    );
  `);

  console.log('[hitl] Approval schema initialized');
}

// --- Approval Requests ---

export function createApprovalRequest(req: {
  runId: number;
  conversationId: string;
  channelId?: string;
  groupId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  riskLevel: RiskLevel;
  timeoutSeconds: number;
}): ApprovalRequest {
  const id = uuid();
  const now = new Date();
  const timeoutAt = new Date(now.getTime() + req.timeoutSeconds * 1000);
  const expiresAt = new Date(now.getTime() + req.timeoutSeconds * 2 * 1000); // keep record 2x timeout

  getDb()
    .prepare(
      `INSERT INTO approval_requests (id, run_id, conversation_id, channel_id, group_id, tool_name, tool_input, risk_level, status, requested_at, timeout_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(
      id,
      req.runId,
      req.conversationId,
      req.channelId || null,
      req.groupId || null,
      req.toolName,
      JSON.stringify(req.toolInput),
      req.riskLevel,
      now.toISOString(),
      timeoutAt.toISOString(),
      expiresAt.toISOString(),
    );

  return {
    id,
    runId: req.runId,
    conversationId: req.conversationId,
    channelId: req.channelId,
    groupId: req.groupId,
    toolName: req.toolName,
    toolInput: req.toolInput,
    riskLevel: req.riskLevel,
    status: 'pending',
    requestedAt: now.toISOString(),
    timeoutAt: timeoutAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

export function resolveApproval(
  id: string,
  status: 'approved' | 'rejected' | 'timeout',
  reason?: string,
  respondedBy?: string,
): void {
  getDb()
    .prepare(
      `UPDATE approval_requests
       SET status = ?, reason = ?, responded_by = ?, responded_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
    )
    .run(status, reason || null, respondedBy || null, id);
}

export function getApprovalRequest(id: string): ApprovalRequest | undefined {
  const row = getDb().prepare('SELECT * FROM approval_requests WHERE id = ?').get(id) as any;
  return row ? rowToApproval(row) : undefined;
}

export function getPendingApprovals(): ApprovalRequest[] {
  const rows = getDb()
    .prepare("SELECT * FROM approval_requests WHERE status = 'pending' ORDER BY requested_at ASC")
    .all() as any[];
  return rows.map(rowToApproval);
}

export function getApprovalsByRun(runId: number): ApprovalRequest[] {
  const rows = getDb()
    .prepare('SELECT * FROM approval_requests WHERE run_id = ? ORDER BY requested_at ASC')
    .all(runId) as any[];
  return rows.map(rowToApproval);
}

export function getRecentApprovals(limit = 50): ApprovalRequest[] {
  const rows = getDb()
    .prepare('SELECT * FROM approval_requests ORDER BY requested_at DESC LIMIT ?')
    .all(limit) as any[];
  return rows.map(rowToApproval);
}

export function getApprovalStats(): {
  pending: number;
  approved: number;
  rejected: number;
  timeout: number;
  autoApproved: number;
} {
  const rows = getDb()
    .prepare(
      `SELECT status, COUNT(*) as count FROM approval_requests GROUP BY status`,
    )
    .all() as Array<{ status: string; count: number }>;

  const stats = { pending: 0, approved: 0, rejected: 0, timeout: 0, autoApproved: 0 };
  for (const row of rows) {
    if (row.status === 'pending') stats.pending = row.count;
    else if (row.status === 'approved') stats.approved = row.count;
    else if (row.status === 'rejected') stats.rejected = row.count;
    else if (row.status === 'timeout') stats.timeout = row.count;
    else if (row.status === 'auto_approved') stats.autoApproved = row.count;
  }
  return stats;
}

function rowToApproval(row: any): ApprovalRequest {
  return {
    id: row.id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    channelId: row.channel_id || undefined,
    groupId: row.group_id || undefined,
    toolName: row.tool_name,
    toolInput: JSON.parse(row.tool_input || '{}'),
    riskLevel: row.risk_level as RiskLevel,
    status: row.status as ApprovalStatus,
    reason: row.reason || undefined,
    respondedBy: row.responded_by || undefined,
    requestedAt: row.requested_at,
    respondedAt: row.responded_at || undefined,
    timeoutAt: row.timeout_at,
    expiresAt: row.expires_at,
  };
}

// --- Approval Rules ---

export function getApprovalRule(toolName: string): ApprovalRule | undefined {
  const row = getDb()
    .prepare('SELECT * FROM approval_rules WHERE tool_name = ? AND enabled = 1')
    .get(toolName) as any;
  return row ? rowToRule(row) : undefined;
}

export function getAllApprovalRules(): ApprovalRule[] {
  const rows = getDb()
    .prepare('SELECT * FROM approval_rules ORDER BY tool_name')
    .all() as any[];
  return rows.map(rowToRule);
}

export function upsertApprovalRule(rule: {
  toolName: string;
  riskLevel?: RiskLevel;
  autoApprove?: boolean;
  requireApproval?: boolean;
  timeoutSeconds?: number;
  timeoutAction?: 'reject' | 'approve';
  enabled?: boolean;
}): ApprovalRule {
  const id = uuid();
  const riskLevel = rule.riskLevel || DEFAULT_TOOL_RISK[rule.toolName] || 'medium';
  const timeoutSeconds = rule.timeoutSeconds ?? DEFAULT_TIMEOUT[riskLevel];
  const requireApproval = rule.requireApproval ?? DEFAULT_REQUIRE_APPROVAL[riskLevel];

  getDb()
    .prepare(
      `INSERT INTO approval_rules (id, tool_name, risk_level, auto_approve, require_approval, timeout_seconds, timeout_action, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tool_name) DO UPDATE SET
         risk_level = excluded.risk_level,
         auto_approve = excluded.auto_approve,
         require_approval = excluded.require_approval,
         timeout_seconds = excluded.timeout_seconds,
         timeout_action = excluded.timeout_action,
         enabled = excluded.enabled`,
    )
    .run(
      id,
      rule.toolName,
      riskLevel,
      rule.autoApprove ? 1 : 0,
      requireApproval ? 1 : 0,
      timeoutSeconds,
      rule.timeoutAction || 'reject',
      rule.enabled !== false ? 1 : 0,
    );

  return getApprovalRule(rule.toolName) || {
    id,
    toolName: rule.toolName,
    riskLevel,
    autoApprove: rule.autoApprove || false,
    requireApproval,
    timeoutSeconds,
    timeoutAction: rule.timeoutAction || 'reject',
    enabled: rule.enabled !== false,
  };
}

export function deleteApprovalRule(toolName: string): boolean {
  const result = getDb()
    .prepare('DELETE FROM approval_rules WHERE tool_name = ?')
    .run(toolName);
  return result.changes > 0;
}

function rowToRule(row: any): ApprovalRule {
  return {
    id: row.id,
    toolName: row.tool_name,
    riskLevel: row.risk_level as RiskLevel,
    autoApprove: row.auto_approve === 1,
    requireApproval: row.require_approval === 1,
    timeoutSeconds: row.timeout_seconds,
    timeoutAction: row.timeout_action as 'reject' | 'approve',
    enabled: row.enabled === 1,
  };
}
