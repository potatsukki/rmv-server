import { describe, expect, it } from 'vitest';
import { APPOINTMENT_STATUS_GROUPS, buildAppointmentStatusGroupFilter, isHistoryStatusGroup } from './appointment-status-groups.js';

describe('buildAppointmentStatusGroupFilter', () => {
  it('requested includes legacy assigned records and requests with or without sales staff', () => {
    expect(buildAppointmentStatusGroupFilter('requested')).toEqual({
      $or: [
        { status: { $in: ['requested', 'assigned'] } },
        { status: 'reschedule_requested', salesStaffId: null },
      ],
    });
  });

  it('no longer exposes Assigned as a separate status group', () => {
    expect(APPOINTMENT_STATUS_GROUPS).toEqual(['requested', 'confirmed', 'completed', 'no_show']);
  });

  it('redirects an older Assigned group request to Requested', () => {
    expect(buildAppointmentStatusGroupFilter('assigned')).toEqual(buildAppointmentStatusGroupFilter('requested'));
  });

  it('confirmed includes the visit steps and staffed reschedules', () => {
    expect(buildAppointmentStatusGroupFilter('confirmed')).toEqual({
      $or: [
        { status: { $in: ['confirmed', 'preparing', 'on_the_way', 'arrived_at_site', 'in_progress'] } },
        { status: 'reschedule_requested', salesStaffId: { $ne: null } },
      ],
    });
  });

  it('completed includes ready for ocular and cancelled, but not no-shows', () => {
    expect(buildAppointmentStatusGroupFilter('completed')).toEqual({
      $or: [
        { status: { $in: ['ready_for_ocular', 'cancelled'] } },
        { status: 'completed', attendanceStatus: { $ne: 'no_show' } },
      ],
    });
  });

  it('no_show includes ocular no-shows and consultations closed as no-show', () => {
    expect(buildAppointmentStatusGroupFilter('no_show')).toEqual({
      $or: [
        { status: 'no_show' },
        { status: 'completed', attendanceStatus: 'no_show' },
      ],
    });
  });

  it.each([undefined, '', 'cancelled', 'in_progress'])('returns null for %s', (value) => {
    expect(buildAppointmentStatusGroupFilter(value)).toBeNull();
  });
});

describe('isHistoryStatusGroup', () => {
  it.each([
    ['completed', true],
    ['no_show', true],
    ['requested', false],
    ['confirmed', false],
    [undefined, false],
  ])('%s → %s', (value, expected) => {
    expect(isHistoryStatusGroup(value)).toBe(expected);
  });
});
