import type { OpenStatus, ScheduleEntry } from './types.js';

/**
 * Open/closed is computed locally from the vendor's published schedule rather
 * than read from upstream, because the listing endpoint does not expose a
 * reliable "is open right now" flag.
 *
 * Weekday encoding is ISO-8601 (1 = Monday … 7 = Sunday). This was verified
 * empirically: across six sampled vendors the distinct weekday values were
 * exactly [1,2,3,4,5,6,7] with no 0, ruling out 0-indexing.
 */

/** Current wall-clock time in an IANA timezone, without pulling in a date library. */
export function nowInTimezone(timezone: string, now: Date = new Date()): {
  weekday: number;
  minutes: number;
  hhmm: string;
  iso: string;
} {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
  } catch {
    // Unknown timezone: fall back to UTC rather than throwing.
    return nowInTimezone('UTC', now);
  }

  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const wdMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const weekday = wdMap[get('weekday')] ?? 1;
  // Intl renders midnight as "24" in some locales; normalise it to 0.
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return {
    weekday,
    minutes: hour * 60 + minute,
    hhmm,
    iso: `${get('year')}-${get('month')}-${get('day')} ${hhmm} (${timezone})`,
  };
}

function toMinutes(hhmm: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return undefined;
  return h * 60 + min;
}

export function computeOpenStatus(
  schedules: ScheduleEntry[] | undefined,
  timezone: string,
  now: Date = new Date(),
): OpenStatus {
  const local = nowInTimezone(timezone, now);

  if (!schedules || schedules.length === 0) {
    return {
      isOpen: false,
      localTime: local.iso,
      timezone,
      scheduleUnavailable: true,
    };
  }

  // Only delivery windows count towards "can I order right now".
  const relevant = schedules.filter(
    (s) => !s.openingType || /deliver/i.test(s.openingType) || s.openingType === 'delivering',
  );
  const windows = (relevant.length ? relevant : schedules).filter(
    (s) => Number.isFinite(s.weekday) && s.opensAt && s.closesAt,
  );

  if (windows.length === 0) {
    return { isOpen: false, localTime: local.iso, timezone, scheduleUnavailable: true };
  }

  for (const w of windows) {
    if (w.weekday !== local.weekday) continue;
    const open = toMinutes(w.opensAt);
    const close = toMinutes(w.closesAt);
    if (open === undefined || close === undefined) continue;

    // A window whose close time is not after its open time wraps past midnight.
    const wraps = close <= open;
    const isOpen = wraps
      ? local.minutes >= open || local.minutes <= close
      : local.minutes >= open && local.minutes <= close;

    if (isOpen) {
      return {
        isOpen: true,
        localTime: local.iso,
        timezone,
        closesAt: w.closesAt,
        scheduleUnavailable: false,
      };
    }
  }

  // Closed: find the next opening, scanning forward up to a full week.
  for (let ahead = 0; ahead < 8; ahead++) {
    const day = ((local.weekday - 1 + ahead) % 7) + 1;
    const candidates = windows
      .filter((w) => w.weekday === day)
      .map((w) => ({ w, open: toMinutes(w.opensAt) }))
      .filter((c): c is { w: ScheduleEntry; open: number } => c.open !== undefined)
      .filter((c) => ahead > 0 || c.open > local.minutes)
      .sort((a, b) => a.open - b.open);

    const next = candidates[0];
    if (next) {
      return {
        isOpen: false,
        localTime: local.iso,
        timezone,
        opensNext: { weekday: day, time: next.w.opensAt },
        scheduleUnavailable: false,
      };
    }
  }

  return { isOpen: false, localTime: local.iso, timezone, scheduleUnavailable: false };
}

export const WEEKDAY_NAMES: Record<number, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};
