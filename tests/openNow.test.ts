import { describe, it, expect } from 'vitest';
import { computeOpenStatus, nowInTimezone } from '../src/domain/openNow.js';
import type { ScheduleEntry } from '../src/domain/types.js';

const sched = (weekday: number, opensAt: string, closesAt: string): ScheduleEntry => ({
  weekday,
  openingType: 'delivering',
  opensAt,
  closesAt,
});

// 2026-07-27 is a Monday. 12:00 UTC = 17:00 in Asia/Karachi (UTC+5).
const MON_1200_UTC = new Date('2026-07-27T12:00:00Z');

describe('nowInTimezone', () => {
  it('resolves ISO weekday and local time for a known instant', () => {
    const t = nowInTimezone('Asia/Karachi', MON_1200_UTC);
    expect(t.weekday).toBe(1); // Monday
    expect(t.hhmm).toBe('17:00');
  });

  it('shifts weekday correctly across a date line', () => {
    // 20:00 UTC Monday is 01:00 Tuesday in Karachi.
    const t = nowInTimezone('Asia/Karachi', new Date('2026-07-27T20:00:00Z'));
    expect(t.weekday).toBe(2);
    expect(t.hhmm).toBe('01:00');
  });

  it('falls back to UTC for an unknown timezone instead of throwing', () => {
    expect(() => nowInTimezone('Not/AZone', MON_1200_UTC)).not.toThrow();
    expect(nowInTimezone('Not/AZone', MON_1200_UTC).hhmm).toBe('12:00');
  });
});

describe('computeOpenStatus', () => {
  it('reports open inside the window', () => {
    const st = computeOpenStatus([sched(1, '09:00', '23:00')], 'Asia/Karachi', MON_1200_UTC);
    expect(st.isOpen).toBe(true);
    expect(st.closesAt).toBe('23:00');
  });

  it('reports closed before opening and names the next opening', () => {
    const st = computeOpenStatus([sched(1, '18:00', '23:00')], 'Asia/Karachi', MON_1200_UTC);
    expect(st.isOpen).toBe(false);
    expect(st.opensNext).toEqual({ weekday: 1, time: '18:00' });
  });

  it('handles a window that wraps past midnight', () => {
    // 22:00-04:00 on Monday; local time is 17:00, so still closed.
    const closed = computeOpenStatus([sched(1, '22:00', '04:00')], 'Asia/Karachi', MON_1200_UTC);
    expect(closed.isOpen).toBe(false);

    // At 01:00 local (Tuesday) a Tuesday 22:00-04:00 window should read open.
    const open = computeOpenStatus(
      [sched(2, '22:00', '04:00')],
      'Asia/Karachi',
      new Date('2026-07-27T20:00:00Z'),
    );
    expect(open.isOpen).toBe(true);
  });

  it('rolls to the next day when today has no remaining window', () => {
    const st = computeOpenStatus(
      [sched(1, '06:00', '09:00'), sched(2, '10:00', '20:00')],
      'Asia/Karachi',
      MON_1200_UTC,
    );
    expect(st.isOpen).toBe(false);
    expect(st.opensNext).toEqual({ weekday: 2, time: '10:00' });
  });

  it('flags unknown rather than closed when no schedule is published', () => {
    const st = computeOpenStatus(undefined, 'Asia/Karachi', MON_1200_UTC);
    expect(st.scheduleUnavailable).toBe(true);
    expect(st.isOpen).toBe(false);
  });

  it('ignores non-delivery windows when delivery windows exist', () => {
    const st = computeOpenStatus(
      [
        { weekday: 1, openingType: 'pickup', opensAt: '00:00', closesAt: '23:59' },
        { weekday: 1, openingType: 'delivering', opensAt: '18:00', closesAt: '23:00' },
      ],
      'Asia/Karachi',
      MON_1200_UTC,
    );
    expect(st.isOpen).toBe(false); // pickup-only window must not count
  });

  it('picks the earliest of several windows on the same day', () => {
    const st = computeOpenStatus(
      [sched(1, '21:00', '23:00'), sched(1, '19:00', '20:00')],
      'Asia/Karachi',
      MON_1200_UTC,
    );
    expect(st.opensNext?.time).toBe('19:00');
  });

  it('does not throw on malformed time strings', () => {
    expect(() => computeOpenStatus([sched(1, 'garbage', '??')], 'Asia/Karachi', MON_1200_UTC)).not.toThrow();
  });
});
