/**
 * Scheduler Engine - Manages cron jobs, one-time tasks, and calendar-triggered actions.
 *
 * Uses node-cron for cron-based scheduling.
 * Interval and one-time jobs use setTimeout/setInterval.
 * Calendar-event triggers are evaluated during calendar polling.
 */

import * as cron from 'node-cron';
import { EventEmitter } from 'events';
import { getAllJobs, getJob, updateJob, updateJobRunStatus, createJobRun, completeJobRun } from './db';
import { triggerToCron, calculateNextRunTime } from './cron-builder';
import { routeOutput } from './output-router';
import { processMessage, getSystemPrompt } from '../agent/loop';
import { resolveAgentConfig } from '../agent/groups/resolver';
import { getOrCreateConversation } from '../db/sqlite';

export const schedulerEvents = new EventEmitter();

// Track active cron tasks
const activeCronTasks = new Map<string, cron.ScheduledTask>();
const activeTimers = new Map<string, ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>();

/**
 * Start the scheduler engine. Loads all enabled jobs and schedules them.
 */
export function startScheduler(): void {
  const jobs = getAllJobs();
  let scheduled = 0;

  for (const job of jobs) {
    if (!job.enabled) continue;
    scheduleJob(job.id);
    scheduled++;
  }

  console.log(`[scheduler] Started with ${scheduled} active job(s)`);
}

/**
 * Stop the scheduler engine.
 */
export function stopScheduler(): void {
  for (const [_id, task] of activeCronTasks) {
    void task.stop();
  }
  activeCronTasks.clear();

  for (const [_id, timer] of activeTimers) {
    if (typeof timer === 'object' && 'unref' in timer) {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
      clearInterval(timer as ReturnType<typeof setInterval>);
    }
  }
  activeTimers.clear();

  console.log('[scheduler] Stopped');
}

/**
 * Schedule a single job by ID.
 */
export function scheduleJob(jobId: string): void {
  // Unschedule first if already running
  unscheduleJob(jobId);

  const job = getJob(jobId);
  if (!job || !job.enabled) return;

  const { trigger } = job;

  switch (trigger.type) {
    case 'daily':
    case 'weekly':
    case 'monthly': {
      const cronExpr = triggerToCron(trigger);
      if (!cronExpr) break;

      const options = { timezone: trigger.timezone || 'UTC' };
      const task = cron.schedule(
        cronExpr,
        () => {
          void executeJob(jobId);
        },
        options,
      );
      activeCronTasks.set(jobId, task);

      // Calculate next run
      const nextRun = calculateNextRunTime(trigger);
      if (nextRun) {
        updateJob(jobId, { nextRunAt: nextRun.toISOString() });
      }

      console.log(`[scheduler] Scheduled cron job "${job.name}": ${cronExpr} (${trigger.timezone || 'UTC'})`);
      break;
    }

    case 'interval': {
      const minutes = trigger.intervalMinutes || 30;
      const interval = setInterval(
        () => {
          void executeJob(jobId);
        },
        minutes * 60 * 1000,
      );
      activeTimers.set(jobId, interval);

      const nextRun = new Date(Date.now() + minutes * 60 * 1000);
      updateJob(jobId, { nextRunAt: nextRun.toISOString() });

      console.log(`[scheduler] Scheduled interval job "${job.name}": every ${minutes}m`);
      break;
    }

    case 'once': {
      if (!trigger.runAt) break;
      const runAt = new Date(trigger.runAt);
      const delay = runAt.getTime() - Date.now();
      if (delay <= 0) {
        console.log(`[scheduler] One-time job "${job.name}" already past, running now`);
        void executeJob(jobId);
      } else {
        const timer = setTimeout(() => {
          void executeJob(jobId);
        }, delay);
        activeTimers.set(jobId, timer);
        updateJob(jobId, { nextRunAt: runAt.toISOString() });
        console.log(`[scheduler] Scheduled one-time job "${job.name}": ${trigger.runAt}`);
      }
      break;
    }

    case 'calendar_event':
      // Calendar events are triggered by the calendar polling system
      console.log(`[scheduler] Calendar-triggered job "${job.name}" registered`);
      break;
  }
}

/**
 * Unschedule a job.
 */
export function unscheduleJob(jobId: string): void {
  const cronTask = activeCronTasks.get(jobId);
  if (cronTask) {
    void cronTask.stop();
    activeCronTasks.delete(jobId);
  }

  const timer = activeTimers.get(jobId);
  if (timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
    clearInterval(timer as ReturnType<typeof setInterval>);
    activeTimers.delete(jobId);
  }
}

/**
 * Execute a scheduled job.
 */
export async function executeJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) {
    console.error(`[scheduler] Job ${jobId} not found`);
    return;
  }

  console.log(`[scheduler] Executing job: ${job.name}`);
  schedulerEvents.emit('job:start', { jobId, name: job.name });

  const runId = createJobRun(jobId);

  try {
    // Build the prompt with template variables
    let prompt = job.action.prompt;
    const now = new Date();
    prompt = prompt.replace(/\{\{date\}\}/g, now.toISOString().split('T')[0] ?? '');
    prompt = prompt.replace(/\{\{time\}\}/g, now.toTimeString().slice(0, 5));
    prompt = prompt.replace(/\{\{datetime\}\}/g, now.toISOString());

    if (job.action.contextTemplate) {
      prompt = `${prompt}\n\n## Additional Context\n${job.action.contextTemplate}`;
    }

    // Create a dedicated conversation for this job run
    const conversationId = getOrCreateConversation('scheduler', `job-${jobId}`, `Scheduler: ${job.name}`);

    // Resolve agent config from the assigned group
    const agentConfig = resolveAgentConfig('scheduler', getSystemPrompt());
    // Override with job-specific group if set
    if (job.action.agentGroupId) {
      const { getAgentGroup, getGroupApiKey } = await import('../agent/groups/manager');
      const group = getAgentGroup(job.action.agentGroupId);
      if (group) {
        agentConfig.systemPrompt = group.systemPrompt;
        agentConfig.model = group.model;
        agentConfig.maxTokens = group.maxTokens;
        agentConfig.apiKey = getGroupApiKey(group.id);
        agentConfig.enabledSkills = group.skills.length > 0 ? group.skills : undefined;
        agentConfig.groupId = group.id;
      }
    }

    // Run the agent
    const result = await processMessage(
      conversationId,
      prompt,
      'scheduler',
      'scheduler',
      agentConfig.enabledSkills,
      agentConfig,
    );

    // Route output
    await routeOutput(job.output, result, job.name);

    // Update status
    completeJobRun(runId, { status: 'success', output: result });
    updateJobRunStatus(jobId, 'success', result);

    // Calculate next run
    const nextRun = calculateNextRunTime(job.trigger);
    if (nextRun) {
      updateJob(jobId, { nextRunAt: nextRun.toISOString() });
    }

    schedulerEvents.emit('job:complete', { jobId, name: job.name, resultLength: result.length });
    console.log(`[scheduler] Job "${job.name}" completed (${result.length} chars)`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    completeJobRun(runId, { status: 'error', error: errorMsg });
    updateJobRunStatus(jobId, 'error', errorMsg);
    schedulerEvents.emit('job:error', { jobId, name: job.name, error: errorMsg });
    console.error(`[scheduler] Job "${job.name}" failed:`, errorMsg);
  }
}

/**
 * Get scheduler status.
 */
export function getSchedulerStats(): {
  activeJobs: number;
  cronJobs: number;
  intervalJobs: number;
  timerJobs: number;
} {
  return {
    activeJobs: activeCronTasks.size + activeTimers.size,
    cronJobs: activeCronTasks.size,
    intervalJobs: activeTimers.size,
    timerJobs: activeTimers.size,
  };
}
