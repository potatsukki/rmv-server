import { describe, expect, it } from 'vitest';
import { buildAppointmentStatusGroupFilter, isHistoryStatusGroup } from './appointment-status-groups.js';

describe('buildAppointmentStatusGroupFilter', () => {
  it('requested means no sales staff yet', () => {
    expect(buildAppointmentStatusGroupFilter('requested')).toEqual({
      status: { $in: ['requested', 'reschedule_requested'] },
      salesStaffId: null,
    });
  });

  it('assigned includes preassigned requested oculars', () => {
    expect(buildAppointmentStatusGroupFilter('assigned')).toEqual({
      $or: [
        { status: 'assigned' },
        { status: 'requested', salesStaffId: { $ne: null } },
      ],
    });
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
