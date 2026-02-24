/**
 * Calendar Sync - Polls iCal URLs and caches events in SQLite.
 *
 * Phase 1: Read-only via iCal URLs (Google Calendar, Outlook, Apple)
 * Phase 2: CalDAV/Google Calendar API for write access (future)
 */

import {
  getAllCalendarSources,
  updateCalendarSyncTime,
  upsertCalendarEvent,
  getUpcomingEvents,
  ensureCalendarEventsUniqueIndex,
} from './db';
import { EventEmitter } from 'events';

export const calendarEvents = new EventEmitter();

const pollingIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();

/**
 * Start polling all calendar sources.
 */
export function startCalendarPolling(): void {
  ensureCalendarEventsUniqueIndex();
  const sources = getAllCalendarSources();

  for (const source of sources) {
    scheduleCalendarPoll(source.id, source.url, source.pollIntervalMinutes || 15);
  }

  console.log(`[calendar] Polling ${sources.length} calendar source(s)`);
}

/**
 * Schedule polling for a single calendar source.
 */
export function scheduleCalendarPoll(id: string, url: string, intervalMinutes: number): void {
  // Clear existing interval
  if (pollingIntervals.has(id)) {
    clearInterval(pollingIntervals.get(id)!);
  }

  // Poll immediately
  void syncCalendar(id, url).catch((err) => {
    console.error(`[calendar] Initial sync failed for ${id}:`, err);
  });

  // Then poll periodically
  const interval = setInterval(
    () => {
      void syncCalendar(id, url).catch((err) => {
        console.error(`[calendar] Sync failed for ${id}:`, err);
      });
    },
    intervalMinutes * 60 * 1000,
  );

  pollingIntervals.set(id, interval);
}

/**
 * Stop polling for a calendar source.
 */
export function stopCalendarPoll(id: string): void {
  if (pollingIntervals.has(id)) {
    clearInterval(pollingIntervals.get(id)!);
    pollingIntervals.delete(id);
  }
}

/**
 * Stop all calendar polling.
 */
export function stopAllCalendarPolling(): void {
  for (const [_id, interval] of pollingIntervals) {
    clearInterval(interval);
  }
  pollingIntervals.clear();
}

/**
 * Sync a calendar from an iCal URL.
 */
export async function syncCalendar(calendarId: string, url: string): Promise<number> {
  try {
    const ical = await import('node-ical');
    const events = await ical.async.fromURL(url);

    let count = 0;
    for (const [key, event] of Object.entries(events)) {
      if ((event as any).type !== 'VEVENT') continue;

      const vevent = event as any;
      const uid = vevent.uid || key;
      const title = vevent.summary || 'Untitled';
      const description = vevent.description || '';
      const startAt = vevent.start ? new Date(vevent.start).toISOString() : '';
      const endAt = vevent.end ? new Date(vevent.end).toISOString() : startAt;
      const recurrence = vevent.rrule ? vevent.rrule.toString() : undefined;

      if (!startAt) continue;

      upsertCalendarEvent({
        calendarId,
        uid,
        title,
        description,
        startAt,
        endAt,
        recurrence,
      });
      count++;
    }

    updateCalendarSyncTime(calendarId);
    calendarEvents.emit('calendar:synced', { calendarId, eventCount: count });
    console.log(`[calendar] Synced ${count} events from calendar ${calendarId}`);
    return count;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[calendar] Sync error for ${calendarId}:`, msg);
    calendarEvents.emit('calendar:error', { calendarId, error: msg });
    return 0;
  }
}

/**
 * Get upcoming events for a calendar within the next N minutes.
 */
export function getUpcomingCalendarEvents(calendarId: string, withinMinutes = 60) {
  return getUpcomingEvents(calendarId, withinMinutes);
}

/**
 * Build context string from upcoming calendar events (for injection into agent prompts).
 */
export function buildCalendarContext(calendarId: string): string {
  const events = getUpcomingEvents(calendarId, 24 * 60); // next 24 hours

  if (events.length === 0) return 'No upcoming events in the next 24 hours.';

  const lines = ['## Upcoming Calendar Events (next 24h)', ''];
  for (const event of events) {
    const start = new Date(event.startAt);
    const time = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
    lines.push(`- **${time}** ${event.title || 'Untitled'}`);
    if (event.description) {
      lines.push(`  ${event.description.slice(0, 200)}`);
    }
  }
  return lines.join('\n');
}
