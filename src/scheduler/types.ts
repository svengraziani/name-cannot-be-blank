/**
 * Scheduler Types - Data models for scheduled jobs, calendars, and job runs.
 */

export interface ScheduledJob {
  id: string;
  name: string;
  description: string;

  // Trigger configuration
  trigger: ScheduleTrigger;

  // Action: what happens when triggered
  action: ScheduleAction;

  // Output: where results go
  output: ScheduleOutput;

  // Status
  enabled: boolean;
  lastRunAt?: string;
  lastRunStatus?: 'success' | 'error';
  lastRunOutput?: string;
  nextRunAt?: string;
  runCount: number;

  createdAt: string;
  updatedAt: string;
}

export interface ScheduleTrigger {
  type: 'daily' | 'weekly' | 'monthly' | 'once' | 'interval' | 'calendar_event';

  // Daily/Weekly/Monthly
  time?: { hour: number; minute: number };
  days?: number[]; // 0=Sun, 1=Mon, ..., 6=Sat
  dayOfMonth?: number; // 1-31 for monthly

  // Timezone (IANA format)
  timezone: string;

  // Once
  runAt?: string; // ISO datetime

  // Interval
  intervalMinutes?: number;

  // Calendar event trigger
  calendarTrigger?: {
    calendarId: string;
    minutesBefore?: number;
    minutesAfter?: number;
    titleFilter?: string;
  };
}

export interface ScheduleAction {
  agentGroupId: string;
  prompt: string;
  contextTemplate?: string; // Template with {{date}}, {{event_title}}, etc.
  maxIterations: number;
}

export interface ScheduleOutput {
  type: 'channel' | 'webhook' | 'file' | 'email';
  channelId?: string;
  chatId?: string;
  webhookUrl?: string;
  filePath?: string;
  emailTo?: string;
}

export interface CalendarSource {
  id: string;
  name: string;
  url: string;
  pollIntervalMinutes: number;
  agentGroupId?: string;
  syncedAt?: string;
  createdAt: string;
}

export interface CalendarEvent {
  id: number;
  calendarId: string;
  uid: string;
  title: string;
  description?: string;
  startAt: string;
  endAt: string;
  recurrence?: string;
  triggeredJobId?: string;
  createdAt: string;
}

export interface JobRun {
  id: number;
  jobId: string;
  status: 'running' | 'success' | 'error';
  output?: string;
  error?: string;
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
  completedAt?: string;
}

// Helper: UI-friendly schedule input → cron expression
export interface ScheduleUIInput {
  type: 'daily' | 'weekly' | 'monthly' | 'once' | 'interval' | 'calendar_event';
  time?: { hour: number; minute: number };
  days?: number[];
  dayOfMonth?: number;
  timezone: string;
  intervalMinutes?: number;
  runAt?: string;
  calendarTrigger?: {
    calendarId: string;
    minutesBefore?: number;
    minutesAfter?: number;
    titleFilter?: string;
  };
}
