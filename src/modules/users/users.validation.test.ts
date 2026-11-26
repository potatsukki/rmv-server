import { describe, expect, it } from 'vitest';

import { StaffAvailabilityStatus } from '../../utils/constants.js';
import {
  salesStaffLookupQuerySchema,
  updateUserSchema,
} from './users.validation.js';

describe('users.validation admin-managed availability rules', () => {
  // QA 2026-11-26: editing an Available staff (new password + contract date) failed with
  // "shiftStartAt: Shift start time is required when setting staff available".
  it('accepts Available without shift times, together with other edits', () => {
    const result = updateUserSchema.safeParse({
      password: 'Pa$$w0rd1',
      expiresAt: '2026-11-27T00:00:00.000Z',
      availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
      availabilityNote: 'Timed in',
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
      availabilityNote: 'Timed in',
    });
  });

  it('strips the shift fields an older web still sends', () => {
    const result = updateUserSchema.safeParse({
      availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
      shiftStartAt: '',
      shiftEndAt: null,
    });

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('shiftStartAt');
    expect(result.data).not.toHaveProperty('shiftEndAt');
  });

  it.each([StaffAvailabilityStatus.UNAVAILABLE, StaffAvailabilityStatus.ON_LEAVE])(
    'accepts %s with a note', (availabilityStatus) => {
      const result = updateUserSchema.safeParse({
        availabilityStatus,
        availabilityNote: 'Not reporting today',
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        availabilityStatus,
        availabilityNote: 'Not reporting today',
      });
    },
  );
});

describe('users.validation sales staff lookup query', () => {
  it('requires date and slot code together', () => {
    const result = salesStaffLookupQuerySchema.safeParse({
      date: '2026-04-23',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Date and slot code must be provided together');
  });

  it('accepts assignment context plus search', () => {
    const result = salesStaffLookupQuerySchema.safeParse({
      date: '2026-04-23',
      slotCode: '09:00',
      appointmentId: 'appt-1',
      search: 'bugoy',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      date: '2026-04-23',
      slotCode: '09:00',
      appointmentId: 'appt-1',
      search: 'bugoy',
    });
  });
});

describe('users.validation admin edit of contact details', () => {
  it('accepts a changed email (normalized to lowercase) and rejects an invalid one', () => {
    expect(updateUserSchema.parse({ email: '  New.Staff@Gmail.com ' }).email).toBe('new.staff@gmail.com');
    expect(updateUserSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });

  it('allows clearing the phone number with null', () => {
    expect(updateUserSchema.parse({ phone: null }).phone).toBeNull();
    expect(updateUserSchema.safeParse({ phone: '12345' }).success).toBe(false);
  });
});
