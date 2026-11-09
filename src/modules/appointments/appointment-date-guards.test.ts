import { describe, expect, it } from 'vitest';
import { APPOINTMENT_DAY_CHECK_BYPASSED, assertAppointmentDayReached } from './appointment-date-guards.js';

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
