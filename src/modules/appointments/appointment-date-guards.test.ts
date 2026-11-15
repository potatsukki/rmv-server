import { describe, expect, it } from 'vitest';
import { APPOINTMENT_DAY_CHECK_BYPASSED, assertAppointmentDayReached, assertNoShowAllowed } from './appointment-date-guards.js';

// Nov 8, 2026, 11:42 AM in Manila.
const NOV_8 = new Date('2026-11-08T03:42:00Z');
// The rule itself, checked with enforcement on regardless of the temporary bypass.
const ENFORCE = true;

describe('assertAppointmentDayReached', () => {
  it('blocks a visit action before the appointment day', () => {
    expect(() => assertAppointmentDayReached('2026-11-11', 'submit this visit report', NOV_8, ENFORCE))
      .toThrow('You can submit this visit report starting on 2026-11-11, the day of the appointment.');
  });

  it('allows the action on the appointment day and after', () => {
    expect(() => assertAppointmentDayReached('2026-11-08', 'start this visit', NOV_8, ENFORCE)).not.toThrow();
    expect(() => assertAppointmentDayReached('2026-11-05', 'start this visit', NOV_8, ENFORCE)).not.toThrow();
  });

  it('uses the Manila date, not UTC', () => {
    // 4:30 PM UTC on Nov 10 is already Nov 11 in Manila.
    expect(() => assertAppointmentDayReached('2026-11-11', 'start this visit', new Date('2026-11-10T16:30:00Z'), ENFORCE)).not.toThrow();
    // 3:30 PM UTC on Nov 10 is still Nov 10 in Manila.
    expect(() => assertAppointmentDayReached('2026-11-11', 'start this visit', new Date('2026-11-10T15:30:00Z'), ENFORCE)).toThrow();
  });

  it('skips the check when the appointment has no date', () => {
    expect(() => assertAppointmentDayReached(undefined, 'start this visit', NOV_8, ENFORCE)).not.toThrow();
  });

  it.runIf(APPOINTMENT_DAY_CHECK_BYPASSED)('allows early visit actions while the temporary bypass is on', () => {
    expect(() => assertAppointmentDayReached('2026-11-12', 'update consultation attendance', NOV_8)).not.toThrow();
  });
});

describe('assertNoShowAllowed (appointment date only, 15 minutes after the scheduled time)', () => {
  // A 10:00 AM appointment on Nov 15, 2026 (Manila is UTC+8).
  const at = (manilaTime: string, day = '2026-11-15') => new Date(`${day}T${manilaTime}:00+08:00`);
  const check = (now: Date) => () => assertNoShowAllowed('2026-11-15', '10:00', now);

  it('refuses before the scheduled time and during the 15-minute grace period', () => {
    expect(check(at('08:00'))).toThrow('A no-show can be recorded from 10:15 AM, 15 minutes after the scheduled time.');
    expect(check(at('10:00'))).toThrow('from 10:15 AM');
    expect(check(at('10:14'))).toThrow('from 10:15 AM');
  });

  it('allows it from 15 minutes after the scheduled time until the end of that day', () => {
    expect(check(at('10:15'))).not.toThrow();
    expect(check(at('16:30'))).not.toThrow();
    expect(check(at('23:59'))).not.toThrow();
  });

  it('refuses on any earlier day, even while the day-check bypass is on', () => {
    expect(check(at('10:30', '2026-11-14')))
      .toThrow('A no-show can only be recorded on the appointment date (2026-11-15), from 10:15 AM.');
    expect(check(at('10:30', '2026-11-12'))).toThrow('only be recorded on the appointment date');
  });

  it('refuses once the appointment date has passed', () => {
    expect(check(at('00:05', '2026-11-16')))
      .toThrow('A no-show can only be recorded on the appointment date (2026-11-15). That day has passed.');
  });

  it('uses the Manila date, not UTC', () => {
    // 11:30 PM Manila on Nov 15 is 3:30 PM UTC, still the appointment date.
    expect(check(new Date('2026-11-15T15:30:00Z'))).not.toThrow();
    // 12:30 AM Manila on Nov 16 is 4:30 PM UTC on Nov 15.
    expect(check(new Date('2026-11-15T16:30:00Z'))).toThrow('That day has passed');
  });

  it('refuses an appointment without a date or time', () => {
    expect(() => assertNoShowAllowed(undefined, '10:00', at('10:30'))).toThrow('no scheduled date and time');
    expect(() => assertNoShowAllowed('2026-11-15', undefined, at('10:30'))).toThrow('no scheduled date and time');
  });
});
