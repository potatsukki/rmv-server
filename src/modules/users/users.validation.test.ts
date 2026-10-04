import { describe, expect, it } from 'vitest';

import { StaffAvailabilityStatus } from '../../utils/constants.js';
import {
  salesStaffLookupQuerySchema,
  updateOwnAvailabilitySchema,
  updateUserSchema,
} from './users.validation.js';

describe('users.validation admin-managed availability rules', () => {
  it('requires shift bounds when marking availability as available', () => {
    const result = updateUserSchema.safeParse({
      availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
      availabilityNote: 'On-site work',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'shiftStartAt',
      'shiftEndAt',
    ]);
  });

  it('rejects shift windows where the end is not after the start', () => {
    const result = updateUserSchema.safeParse({
      availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
      shiftStartAt: '2026-04-23T08:00:00.000Z',
      shiftEndAt: '2026-04-23T08:00:00.000Z',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Shift end time must be after the shift start time');
  });

  it('allows unavailable status without shift times', () => {
    const result = updateUserSchema.safeParse({
      availabilityStatus: StaffAvailabilityStatus.UNAVAILABLE,
      availabilityNote: 'Not reporting today',
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      availabilityStatus: StaffAvailabilityStatus.UNAVAILABLE,
      availabilityNote: 'Not reporting today',
    });
  });
});

describe('users.validation employee time-in rules', () => {
  it('accepts time-in without client-selected shift times', () => {
    expect(updateOwnAvailabilitySchema.safeParse({
      availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
      availabilityNote: 'Timed in',
    }).success).toBe(true);
    expect(updateOwnAvailabilitySchema.safeParse({}).success).toBe(true);
  });

  it.each([StaffAvailabilityStatus.UNAVAILABLE, StaffAvailabilityStatus.ON_LEAVE])(
    'does not allow employees to set admin-managed status %s through time-in', (availabilityStatus) => {
      expect(updateOwnAvailabilitySchema.safeParse({ availabilityStatus }).success).toBe(false);
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
