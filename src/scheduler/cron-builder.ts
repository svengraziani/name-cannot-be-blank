/**
 * Cron Builder - Converts user-friendly schedule input to cron expressions.
 *
 * Users never see cron syntax. The UI presents:
 * - Daily at time X on days Y
 * - Weekly on day X at time Y
 * - Monthly on day X at time Y
 * - Every X minutes
 * - Once at datetime
 * - When calendar event happens
 */

import { ScheduleTrigger } from './types';

/**
 * Convert a ScheduleTrigger to a node-cron compatible expression.
 * node-cron uses: second minute hour dayOfMonth month dayOfWeek
 *
 * Returns null for non-cron triggers (once, interval, calendar_event).
 */
export function triggerToCron(trigger: ScheduleTrigger): string | null {
  const { type, time } = trigger;

  switch (type) {
    case 'daily': {
      const hour = time?.hour ?? 8;
      const minute = time?.minute ?? 0;
      const days = trigger.days;

      if (days && days.length > 0 && days.length < 7) {
        // Specific days of week
        return `${minute} ${hour} * * ${days.join(',')}`;
      }
      // Every day
      return `${minute} ${hour} * * *`;
    }

    case 'weekly': {
      const hour = time?.hour ?? 8;
      const minute = time?.minute ?? 0;
      const days = trigger.days || [1]; // Default: Monday
      return `${minute} ${hour} * * ${days.join(',')}`;
    }

    case 'monthly': {
      const hour = time?.hour ?? 8;
      const minute = time?.minute ?? 0;
      const dayOfMonth = trigger.dayOfMonth || 1;
      return `${minute} ${hour} ${dayOfMonth} * *`;
    }

    case 'interval': {
      const minutes = trigger.intervalMinutes || 30;
      return `*/${minutes} * * * *`;
    }

    case 'once':
    case 'calendar_event':
      return null; // Handled differently
  }
}

/**
 * Calculate the next run time for a trigger.
 */
export function calculateNextRunTime(trigger: ScheduleTrigger): Date | null {
  const now = new Date();

  switch (trigger.type) {
    case 'once': {
      if (!trigger.runAt) return null;
      const runAt = new Date(trigger.runAt);
      return runAt > now ? runAt : null;
    }

    case 'interval': {
      const minutes = trigger.intervalMinutes || 30;
      return new Date(now.getTime() + minutes * 60 * 1000);
    }

    case 'daily':
    case 'weekly':
    case 'monthly': {
      const hour = trigger.time?.hour ?? 8;
      const minute = trigger.time?.minute ?? 0;

      // Start from today
      const candidate = new Date(now);
      candidate.setHours(hour, minute, 0, 0);

      if (trigger.type === 'monthly') {
        const day = trigger.dayOfMonth || 1;
        candidate.setDate(day);
        if (candidate <= now) {
          candidate.setMonth(candidate.getMonth() + 1);
        }
        return candidate;
      }

      // For daily/weekly, find next matching day
      const days = trigger.days || [0, 1, 2, 3, 4, 5, 6];
      for (let offset = 0; offset < 8; offset++) {
        const check = new Date(candidate.getTime() + offset * 24 * 60 * 60 * 1000);
        const dayOfWeek = check.getDay();
        if (days.includes(dayOfWeek) && check > now) {
          return check;
        }
      }
      return candidate;
    }

    case 'calendar_event':
      return null; // Determined by calendar polling
  }
}

/**
 * Format a trigger for human display.
 */
export function formatTriggerDescription(trigger: ScheduleTrigger): string {
  const dayNames = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const time = trigger.time ? `${String(trigger.time.hour).padStart(2, '0')}:${String(trigger.time.minute).padStart(2, '0')}` : '08:00';

  switch (trigger.type) {
    case 'daily': {
      const days = trigger.days;
      if (!days || days.length === 7) return `Täglich um ${time}`;
      if (days.length === 5 && !days.includes(0) && !days.includes(6)) return `Mo-Fr um ${time}`;
      return `${days.map(d => dayNames[d]).join(', ')} um ${time}`;
    }
    case 'weekly':
      return `Wöchentlich ${(trigger.days || [1]).map(d => dayNames[d]).join(', ')} um ${time}`;
    case 'monthly':
      return `Monatlich am ${trigger.dayOfMonth || 1}. um ${time}`;
    case 'once':
      return `Einmalig am ${trigger.runAt || '?'}`;
    case 'interval':
      return `Alle ${trigger.intervalMinutes || 30} Minuten`;
    case 'calendar_event': {
      const ct = trigger.calendarTrigger;
      if (ct?.minutesBefore) return `${ct.minutesBefore} Min. vor Kalender-Event`;
      if (ct?.minutesAfter) return `${ct.minutesAfter} Min. nach Kalender-Event`;
      return 'Bei Kalender-Event';
    }
  }
}
