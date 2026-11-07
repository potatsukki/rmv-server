import { describe, expect, it } from 'vitest';
import { buildAppointmentStatusGroupFilter } from './appointment-status-groups.js';

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

  it('completed includes ready for ocular, cancelled, and no-show', () => {
    expect(buildAppointmentStatusGroupFilter('completed')).toEqual({
      status: { $in: ['completed', 'ready_for_ocular', 'cancelled', 'no_show'] },
    });
  });

  it.each([undefined, '', 'cancelled', 'in_progress'])('returns null for %s', (value) => {
    expect(buildAppointmentStatusGroupFilter(value)).toBeNull();
  });
});
