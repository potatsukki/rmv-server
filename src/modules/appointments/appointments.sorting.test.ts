import { describe, expect, it } from 'vitest';

import { defaultAppointmentSort } from './appointments.service.js';
import { AppointmentStatus } from '../../utils/constants.js';

describe('defaultAppointmentSort', () => {
  it('sorts actionable appointment queues by appointment date ascending', () => {
    expect(defaultAppointmentSort(AppointmentStatus.READY_FOR_OCULAR)).toEqual({
      date: 1,
      slotCode: 1,
      createdAt: 1,
    });
  });

  it('sorts completed history by appointment date descending', () => {
    expect(defaultAppointmentSort(AppointmentStatus.COMPLETED)).toEqual({
      date: -1,
      slotCode: -1,
      createdAt: -1,
    });
  });

  it('sorts the Completed status group newest first', () => {
    expect(defaultAppointmentSort(undefined, 'completed')).toEqual({
      date: -1,
      slotCode: -1,
      createdAt: -1,
    });
    expect(defaultAppointmentSort(undefined, 'requested')).toEqual({
      date: 1,
      slotCode: 1,
      createdAt: 1,
    });
  });

  it('sorts cancelled history by appointment date descending', () => {
    expect(defaultAppointmentSort(AppointmentStatus.CANCELLED)).toEqual({
      date: -1,
      slotCode: -1,
      createdAt: -1,
    });
  });
});
