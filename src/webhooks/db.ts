/**
 * Webhook persistence layer - SQLite storage for webhook registrations.
 */

import { getDb } from '../db/sqlite';
import { WebhookRegistration } from './types';

export function initWebhookSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      events TEXT NOT NULL DEFAULT '[]',
      target_url TEXT,
      platform TEXT NOT NULL DEFAULT 'generic',
      agent_group_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_triggered_at TEXT,
      trigger_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_webhooks_token ON webhooks(token);
    CREATE INDEX IF NOT EXISTS idx_webhooks_platform ON webhooks(platform);

    CREATE TABLE IF NOT EXISTS webhook_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_id TEXT NOT NULL,
      event TEXT NOT NULL,
      payload TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      response_status INTEGER,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_logs_webhook ON webhook_logs(webhook_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_logs_created ON webhook_logs(created_at);
  `);
}

interface WebhookRow {
  id: string;
  name: string;
  token: string;
  events: string;
  target_url: string | null;
  platform: string;
  agent_group_id: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_triggered_at: string | null;
  trigger_count: number;
}

function rowToWebhook(row: WebhookRow): WebhookRegistration {
  return {
    id: row.id,
    name: row.name,
    token: row.token,
    events: JSON.parse(row.events),
    targetUrl: row.target_url || undefined,
    platform: row.platform,
    agentGroupId: row.agent_group_id || undefined,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastTriggeredAt: row.last_triggered_at || undefined,
    triggerCount: row.trigger_count,
  };
}

export function createWebhook(webhook: {
  id: string;
  name: string;
  token: string;
  events: string[];
  targetUrl?: string;
  platform: string;
  agentGroupId?: string;
}): WebhookRegistration {
  getDb()
    .prepare(
      `INSERT INTO webhooks (id, name, token, events, target_url, platform, agent_group_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      webhook.id,
      webhook.name,
      webhook.token,
      JSON.stringify(webhook.events),
      webhook.targetUrl || null,
      webhook.platform,
      webhook.agentGroupId || null,
    );

  return getWebhook(webhook.id)!;
}

export function getWebhook(id: string): WebhookRegistration | undefined {
  const row = getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow | undefined;
  return row ? rowToWebhook(row) : undefined;
}

export function getWebhookByToken(token: string): WebhookRegistration | undefined {
  const row = getDb().prepare('SELECT * FROM webhooks WHERE token = ?').get(token) as WebhookRow | undefined;
  return row ? rowToWebhook(row) : undefined;
}

export function getAllWebhooks(): WebhookRegistration[] {
  const rows = getDb().prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all() as WebhookRow[];
  return rows.map(rowToWebhook);
}

export function getWebhooksByEvent(event: string): WebhookRegistration[] {
  const rows = getDb()
    .prepare('SELECT * FROM webhooks WHERE enabled = 1')
    .all() as WebhookRow[];

  return rows
    .map(rowToWebhook)
    .filter((w) => w.events.includes('*') || w.events.includes(event));
}

export function updateWebhook(
  id: string,
  updates: {
    name?: string;
    events?: string[];
    targetUrl?: string;
    platform?: string;
    agentGroupId?: string;
    enabled?: boolean;
  },
): WebhookRegistration | undefined {
  const sets: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    sets.push('name = ?');
    values.push(updates.name);
  }
  if (updates.events !== undefined) {
    sets.push('events = ?');
    values.push(JSON.stringify(updates.events));
  }
  if (updates.targetUrl !== undefined) {
    sets.push('target_url = ?');
    values.push(updates.targetUrl);
  }
  if (updates.platform !== undefined) {
    sets.push('platform = ?');
    values.push(updates.platform);
  }
  if (updates.agentGroupId !== undefined) {
    sets.push('agent_group_id = ?');
    values.push(updates.agentGroupId || null);
  }
  if (updates.enabled !== undefined) {
    sets.push('enabled = ?');
    values.push(updates.enabled ? 1 : 0);
  }

  values.push(id);
  getDb()
    .prepare(`UPDATE webhooks SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values);

  return getWebhook(id);
}

export function deleteWebhook(id: string): boolean {
  const result = getDb().prepare('DELETE FROM webhooks WHERE id = ?').run(id);
  return result.changes > 0;
}

export function recordWebhookTrigger(id: string): void {
  getDb()
    .prepare(
      `UPDATE webhooks SET trigger_count = trigger_count + 1, last_triggered_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    )
    .run(id);
}

export function logWebhookDelivery(entry: {
  webhookId: string;
  event: string;
  payload?: string;
  status: string;
  responseStatus?: number;
  error?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO webhook_logs (webhook_id, event, payload, status, response_status, error)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.webhookId,
      entry.event,
      entry.payload || null,
      entry.status,
      entry.responseStatus || null,
      entry.error || null,
    );
}

export function getWebhookLogs(webhookId: string, limit = 50): unknown[] {
  return getDb()
    .prepare('SELECT * FROM webhook_logs WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(webhookId, limit);
}
