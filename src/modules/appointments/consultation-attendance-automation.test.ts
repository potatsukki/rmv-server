import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockAppointmentFind } = vi.hoisted(() => ({
  mockAppointmentFind: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Appointment: {
    find: mockAppointmentFind,
  },
}));

import {
  processAutomatedConsultationAttendance,
  synchronizeConsultationAttendanceByTime,
} from './consultation-attendance-automation.js';
import {
  AppointmentAttendanceStatus,
  AppointmentStatus,
  AppointmentType,
} from '../../utils/constants.js';

function appointment(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'appointment-1' },
    type: AppointmentType.OFFICE,
    status: AppointmentStatus.CONFIRMED,
    date: '2026-09-10',
    slotCode: '09:00',
    attendanceStatus: AppointmentAttendanceStatus.SCHEDULED,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('consultation attendance automation', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('changes a confirmed consultation to In Progress at its scheduled start', async () => {
    const record = appointment();
    const now = new Date('2026-09-10T01:00:00.000Z');

    await expect(synchronizeConsultationAttendanceByTime(record, now)).resolves.toBe(true);

    expect(record.attendanceStatus).toBe(AppointmentAttendanceStatus.IN_PROGRESS);
    expect(record.consultationStartedAt).toEqual(now);
    expect(record.save).toHaveBeenCalledTimes(1);
  });

  it('changes the consultation to Completed at the end of its one-hour slot', async () => {
    const record = appointment({ attendanceStatus: AppointmentAttendanceStatus.IN_PROGRESS });
    const now = new Date('2026-09-10T02:00:00.000Z');

    await expect(synchronizeConsultationAttendanceByTime(record, now)).resolves.toBe(true);

    expect(record.attendanceStatus).toBe(AppointmentAttendanceStatus.COMPLETED);
    expect(record.consultationStartedAt).toEqual(new Date('2026-09-10T01:00:00.000Z'));
    expect(record.consultationCompletedAt).toEqual(now);
    expect(record.save).toHaveBeenCalledTimes(1);
  });

  it('does not start before the scheduled time or automate an unconfirmed appointment', async () => {
    const beforeStart = appointment();
    const unconfirmed = appointment({ status: AppointmentStatus.REQUESTED });
    const now = new Date('2026-09-10T00:59:59.000Z');

    await expect(synchronizeConsultationAttendanceByTime(beforeStart, now)).resolves.toBe(false);
    await expect(synchronizeConsultationAttendanceByTime(
      unconfirmed,
      new Date('2026-09-10T01:00:00.000Z'),
    )).resolves.toBe(false);

    expect(beforeStart.save).not.toHaveBeenCalled();
    expect(unconfirmed.save).not.toHaveBeenCalled();
  });

  it('processes due consultations through the background worker', async () => {
    const record = appointment();
    mockAppointmentFind.mockReturnValueOnce({
      select: vi.fn().mockResolvedValue([record]),
    });

    const count = await processAutomatedConsultationAttendance(
      new Date('2026-09-10T01:00:00.000Z'),
    );

    expect(count).toBe(1);
    expect(record.attendanceStatus).toBe(AppointmentAttendanceStatus.IN_PROGRESS);
  });
});
