/**
 * Time Awareness - Provides temporal context to the agent.
 *
 * Builds a context block with current time, day of week, holidays (from iCal),
 * and behavioral hints that help the agent adapt its responses.
 *
 * Examples:
 * - "It's Friday 17:30 – the user probably wants a quick answer, not a long analysis."
 * - "Today is a public holiday in Austria – adjust delivery times accordingly."
 */

import { config } from '../config';
import { getAllCalendarSources, getUpcomingEvents } from '../scheduler/db';

// Day names in German (index 0 = Sunday)
const GERMAN_DAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

// Common holiday keywords that indicate a public/bank holiday in calendar events
const HOLIDAY_KEYWORDS = [
  'feiertag',
  'holiday',
  'frei',
  'bank holiday',
  'public holiday',
  'nationalfeiertag',
  'staatsfeiertag',
  'christmas',
  'weihnacht',
  'ostern',
  'easter',
  'pfingsten',
  'neujahr',
  'new year',
  'karfreitag',
  'christi himmelfahrt',
  'fronleichnam',
  'mariä himmelfahrt',
  'allerheiligen',
  'maria empfängnis',
  'stefanitag',
];

interface TimeContext {
  /** ISO date string (YYYY-MM-DD) */
  date: string;
  /** Formatted time (HH:MM) */
  time: string;
  /** Day of week in German */
  dayOfWeek: string;
  /** Day of week number (0=Sunday) */
  dayOfWeekNum: number;
  /** Whether it's a weekend (Saturday/Sunday) */
  isWeekend: boolean;
  /** Time-of-day category */
  timeOfDay: 'morning' | 'midday' | 'afternoon' | 'evening' | 'night';
  /** Hour (0-23) */
  hour: number;
  /** Today's holidays from calendar (empty if none) */
  holidays: string[];
  /** Whether today is a holiday */
  isHoliday: boolean;
  /** Today's calendar events (non-holiday) */
  todayEvents: string[];
}

/**
 * Get the current date/time in the configured timezone.
 */
function getNow(): Date {
  return new Date();
}

/**
 * Format a Date to the configured timezone, returning components.
 */
function formatInTimezone(date: Date, timezone: string): { dateStr: string; timeStr: string; hour: number; minute: number; dayOfWeek: number } {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };

  const parts = new Intl.DateTimeFormat('de-AT', options).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '00';

  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = parseInt(get('hour'), 10);
  const minute = parseInt(get('minute'), 10);

  // Get day of week in the target timezone
  const dayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' });
  const dayStr = dayFormatter.format(date);
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = dayMap[dayStr] ?? date.getDay();

  return {
    dateStr: `${year}-${month}-${day}`,
    timeStr: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    hour,
    minute,
    dayOfWeek,
  };
}

/**
 * Determine the time-of-day category.
 */
function getTimeOfDay(hour: number): 'morning' | 'midday' | 'afternoon' | 'evening' | 'night' {
  if (hour >= 5 && hour < 10) return 'morning';
  if (hour >= 10 && hour < 13) return 'midday';
  if (hour >= 13 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

/**
 * Check if a calendar event title looks like a holiday.
 */
function isHolidayEvent(title: string): boolean {
  const lower = title.toLowerCase();
  return HOLIDAY_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Get today's events from all calendar sources, split into holidays and regular events.
 */
function getTodayCalendarInfo(dateStr: string): { holidays: string[]; events: string[] } {
  const holidays: string[] = [];
  const events: string[] = [];

  try {
    const sources = getAllCalendarSources();
    for (const source of sources) {
      // Get events for the next 24 hours (covers today)
      const upcoming = getUpcomingEvents(source.id, 24 * 60);
      for (const evt of upcoming) {
        const evtDate = evt.startAt.split('T')[0];
        // Only include events that start today
        if (evtDate === dateStr || evt.startAt.startsWith(dateStr)) {
          if (isHolidayEvent(evt.title)) {
            holidays.push(evt.title);
          } else {
            const startTime = new Date(evt.startAt);
            const time = `${String(startTime.getHours()).padStart(2, '0')}:${String(startTime.getMinutes()).padStart(2, '0')}`;
            events.push(`${time} ${evt.title}`);
          }
        }
      }
    }
  } catch {
    // Calendar may not be available - that's fine
  }

  return { holidays, events };
}

/**
 * Build the full time context.
 */
export function getTimeContext(): TimeContext {
  const timezone = config.timeAwareness.timezone;
  const now = getNow();
  const { dateStr, timeStr, hour, dayOfWeek } = formatInTimezone(now, timezone);

  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const timeOfDay = getTimeOfDay(hour);
  const calInfo = getTodayCalendarInfo(dateStr);

  return {
    date: dateStr,
    time: timeStr,
    dayOfWeek: GERMAN_DAYS[dayOfWeek] || 'Unbekannt',
    dayOfWeekNum: dayOfWeek,
    isWeekend,
    timeOfDay,
    hour,
    holidays: calInfo.holidays,
    isHoliday: calInfo.holidays.length > 0,
    todayEvents: calInfo.events,
  };
}

/**
 * Generate a behavioral hint based on the time context.
 */
function getBehavioralHint(ctx: TimeContext): string {
  const hints: string[] = [];

  // Weekend/holiday hints
  if (ctx.isHoliday) {
    hints.push(`Heute ist Feiertag (${ctx.holidays.join(', ')}). Lieferzeiten, Öffnungszeiten und Erreichbarkeit können abweichen.`);
  }
  if (ctx.isWeekend) {
    hints.push('Es ist Wochenende. Geschäftszeiten und Erreichbarkeit können eingeschränkt sein.');
  }

  // Time-of-day hints
  if (ctx.timeOfDay === 'evening' && (ctx.dayOfWeekNum === 5 || ctx.isWeekend)) {
    hints.push('Freitagabend/Wochenende – der User bevorzugt vermutlich kürzere, pragmatische Antworten.');
  } else if (ctx.timeOfDay === 'night') {
    hints.push('Es ist spät. Halte Antworten kompakt, außer der User wünscht explizit eine ausführliche Analyse.');
  } else if (ctx.timeOfDay === 'morning' && !ctx.isWeekend) {
    hints.push('Morgens an einem Werktag – der User startet wahrscheinlich in den Arbeitstag.');
  }

  // Friday afternoon
  if (ctx.dayOfWeekNum === 5 && ctx.hour >= 15) {
    hints.push('Freitagnachmittag – kurze, actionable Antworten bevorzugen.');
  }

  return hints.join(' ');
}

/**
 * Build the time awareness context block for injection into the system prompt.
 * Returns an empty string if time awareness is disabled.
 */
export function buildTimeAwarenessContext(): string {
  if (!config.timeAwareness.enabled) return '';

  const ctx = getTimeContext();

  const lines: string[] = [
    '',
    '## Zeitkontext (Time Awareness)',
    '',
    `- **Datum:** ${ctx.dayOfWeek}, ${ctx.date}`,
    `- **Uhrzeit:** ${ctx.time} (${config.timeAwareness.timezone})`,
    `- **Tageszeit:** ${ctx.timeOfDay}`,
    `- **Werktag:** ${ctx.isWeekend ? 'Nein (Wochenende)' : 'Ja'}`,
  ];

  if (ctx.isHoliday) {
    lines.push(`- **Feiertag:** Ja (${ctx.holidays.join(', ')})`);
  }

  if (ctx.todayEvents.length > 0) {
    lines.push('', '### Heutige Termine');
    for (const evt of ctx.todayEvents) {
      lines.push(`- ${evt}`);
    }
  }

  const hint = getBehavioralHint(ctx);
  if (hint) {
    lines.push('', `> ${hint}`);
  }

  return lines.join('\n');
}
