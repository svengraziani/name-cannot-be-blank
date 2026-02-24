/**
 * Scheduler Database - SQLite schema and CRUD for scheduled jobs, calendars, and runs.
 */

import { v4 as uuid } from 'uuid';
import { getDb } from '../db/sqlite';
import { ScheduledJob, CalendarSource, CalendarEvent, JobRun, ScheduleTrigger, ScheduleAction, ScheduleOutput } from './types';

/**
 * Initialize scheduler tables. Called at startup.
 */
export function initSchedulerSchema(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      trigger_config TEXT NOT NULL,
      action_config TEXT NOT NULL,
      output_config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      last_run_status TEXT,
      last_run_output TEXT,
      next_run_at TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS calendar_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      poll_interval_minutes INTEGER NOT NULL DEFAULT 15,
      agent_group_id TEXT,
      synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      calendar_id TEXT NOT NULL REFERENCES calendar_sources(id) ON DELETE CASCADE,
      uid TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      recurrence TEXT,
      triggered_job_id TEXT REFERENCES scheduled_jobs(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS job_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'running',
      output TEXT,
      error TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job_id);
    CREATE INDEX IF NOT EXISTS idx_calendar_events_calendar ON calendar_events(calendar_id);
    CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(start_at);
  `);

  console.log('[scheduler] Database schema initialized');
}

// --- Scheduled Jobs CRUD ---

function rowToJob(row: any): ScheduledJob {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    trigger: JSON.parse(row.trigger_config),
    action: JSON.parse(row.action_config),
    output: JSON.parse(row.output_config),
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at || undefined,
    lastRunStatus: row.last_run_status || undefined,
    lastRunOutput: row.last_run_output || undefined,
    nextRunAt: row.next_run_at || undefined,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createJob(input: {
  name: string;
  description?: string;
  trigger: ScheduleTrigger;
  action: ScheduleAction;
  output: ScheduleOutput;
}): ScheduledJob {
  const id = uuid();
  getDb().prepare(`
    INSERT INTO scheduled_jobs (id, name, description, trigger_config, action_config, output_config)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, input.name, input.description || '', JSON.stringify(input.trigger), JSON.stringify(input.action), JSON.stringify(input.output));
  return getJob(id)!;
}

export function getJob(id: string): ScheduledJob | undefined {
  const row = getDb().prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(id) as any;
  return row ? rowToJob(row) : undefined;
}

export function getAllJobs(): ScheduledJob[] {
  return (getDb().prepare('SELECT * FROM scheduled_jobs ORDER BY created_at DESC').all() as any[]).map(rowToJob);
}

export function updateJob(id: string, updates: Partial<{
  name: string;
  description: string;
  trigger: ScheduleTrigger;
  action: ScheduleAction;
  output: ScheduleOutput;
  enabled: boolean;
  nextRunAt: string;
}>): void {
  const sets: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];

  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.description !== undefined) { sets.push('description = ?'); values.push(updates.description); }
  if (updates.trigger !== undefined) { sets.push('trigger_config = ?'); values.push(JSON.stringify(updates.trigger)); }
  if (updates.action !== undefined) { sets.push('action_config = ?'); values.push(JSON.stringify(updates.action)); }
  if (updates.output !== undefined) { sets.push('output_config = ?'); values.push(JSON.stringify(updates.output)); }
  if (updates.enabled !== undefined) { sets.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }
  if (updates.nextRunAt !== undefined) { sets.push('next_run_at = ?'); values.push(updates.nextRunAt); }

  values.push(id);
  getDb().prepare(`UPDATE scheduled_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function updateJobRunStatus(id: string, status: string, output?: string): void {
  getDb().prepare(`
    UPDATE scheduled_jobs SET
      last_run_at = datetime('now'),
      last_run_status = ?,
      last_run_output = ?,
      run_count = run_count + 1,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(status, output?.slice(0, 10000) || null, id);
}

export function deleteJob(id: string): void {
  getDb().prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(id);
}

// --- Job Runs ---

export function createJobRun(jobId: string): number {
  const result = getDb().prepare(
    "INSERT INTO job_runs (job_id, status) VALUES (?, 'running')"
  ).run(jobId);
  return result.lastInsertRowid as number;
}

export function completeJobRun(runId: number, update: {
  status: 'success' | 'error';
  output?: string;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
}): void {
  getDb().prepare(`
    UPDATE job_runs SET
      status = ?,
      output = ?,
      error = ?,
      input_tokens = ?,
      output_tokens = ?,
      completed_at = datetime('now')
    WHERE id = ?
  `).run(
    update.status,
    update.output?.slice(0, 50000) || null,
    update.error || null,
    update.inputTokens || 0,
    update.outputTokens || 0,
    runId,
  );
}

export function getJobRuns(jobId: string, limit = 20): JobRun[] {
  return getDb().prepare(
    'SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?'
  ).all(jobId, limit) as any[];
}

// --- Calendar Sources ---

export function createCalendarSource(input: {
  name: string;
  url: string;
  pollIntervalMinutes?: number;
  agentGroupId?: string;
}): CalendarSource {
  const id = uuid();
  getDb().prepare(`
    INSERT INTO calendar_sources (id, name, url, poll_interval_minutes, agent_group_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, input.name, input.url, input.pollIntervalMinutes || 15, input.agentGroupId || null);
  return getCalendarSource(id)!;
}

function rowToCalendarSource(row: any): CalendarSource {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    pollIntervalMinutes: row.poll_interval_minutes,
    agentGroupId: row.agent_group_id || undefined,
    syncedAt: row.synced_at || undefined,
    createdAt: row.created_at,
  };
}

export function getCalendarSource(id: string): CalendarSource | undefined {
  const row = getDb().prepare('SELECT * FROM calendar_sources WHERE id = ?').get(id) as any;
  return row ? rowToCalendarSource(row) : undefined;
}

export function getAllCalendarSources(): CalendarSource[] {
  return (getDb().prepare('SELECT * FROM calendar_sources ORDER BY created_at DESC').all() as any[]).map(rowToCalendarSource);
}

export function updateCalendarSyncTime(id: string): void {
  getDb().prepare("UPDATE calendar_sources SET synced_at = datetime('now') WHERE id = ?").run(id);
}

export function deleteCalendarSource(id: string): void {
  getDb().prepare('DELETE FROM calendar_sources WHERE id = ?').run(id);
}

// --- Calendar Events ---

export function upsertCalendarEvent(event: {
  calendarId: string;
  uid: string;
  title: string;
  description?: string;
  startAt: string;
  endAt: string;
  recurrence?: string;
}): void {
  getDb().prepare(`
    INSERT INTO calendar_events (calendar_id, uid, title, description, start_at, end_at, recurrence)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(calendar_id, uid) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      start_at = excluded.start_at,
      end_at = excluded.end_at,
      recurrence = excluded.recurrence
  `).run(
    event.calendarId, event.uid, event.title,
    event.description || null, event.startAt, event.endAt,
    event.recurrence || null,
  );
}

function rowToCalendarEvent(row: any): CalendarEvent {
  return {
    id: row.id,
    calendarId: row.calendar_id,
    uid: row.uid,
    title: row.title,
    description: row.description || undefined,
    startAt: row.start_at,
    endAt: row.end_at,
    recurrence: row.recurrence || undefined,
    triggeredJobId: row.triggered_job_id || undefined,
    createdAt: row.created_at,
  };
}

export function getUpcomingEvents(calendarId: string, withinMinutes = 60): CalendarEvent[] {
  return (getDb().prepare(`
    SELECT * FROM calendar_events
    WHERE calendar_id = ?
      AND start_at >= datetime('now')
      AND start_at <= datetime('now', '+${withinMinutes} minutes')
    ORDER BY start_at ASC
  `).all(calendarId) as any[]).map(rowToCalendarEvent);
}

export function getCalendarEvents(calendarId: string, limit = 100): CalendarEvent[] {
  return (getDb().prepare(
    'SELECT * FROM calendar_events WHERE calendar_id = ? ORDER BY start_at DESC LIMIT ?'
  ).all(calendarId, limit) as any[]).map(rowToCalendarEvent);
}

// Add unique index for upsert
export function ensureCalendarEventsUniqueIndex(): void {
  try {
    getDb().exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_events_unique ON calendar_events(calendar_id, uid)');
  } catch {
    // Index may already exist
  }
}
