import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockAppointmentExists,
  mockSalesAvailabilityFindOne,
} = vi.hoisted(() => ({
  mockAppointmentExists: vi.fn(),
  mockSalesAvailabilityFindOne: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Appointment: {
    exists: mockAppointmentExists,
  },
  AvailabilitySession: {},
  SalesAvailability: {
    findOne: mockSalesAvailabilityFindOne,
  },
}));

import {
  buildAvailabilityStateSummary,
  evaluateSalesAssignmentEligibility,
} from './availability-session.service.js';
import { Role, StaffAvailabilityStatus } from '../../utils/constants.js';

function mockSelectable<T>(value: T) {
  return {
    select: vi.fn().mockResolvedValue(value),
  };
}

function buildSession(overrides: Record<string, unknown> = {}) {
  return {
    _id: {
      toString: () => 'session-1',
    },
    availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
    shiftStartAt: new Date('2026-04-23T00:00:00.000Z'),
    shiftEndAt: new Date('2026-04-24T12:00:00.000Z'),
    reminderSentAt: undefined,
    closedAt: undefined,
    ...overrides,
  };
}

describe('availability-session.service summary', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('requires setup for internal users without an open session', () => {
    const summary = buildAvailabilityStateSummary({
      roles: [Role.SALES_STAFF],
    });

    expect(summary).toMatchObject({
      availabilityStatus: undefined,
      availabilitySetupRequired: true,
    });
    expect(summary.activeShift).toBeUndefined();
    expect(summary.expiredShift).toBeUndefined();
  });

  it('preserves admin-set unavailable override even without an open session', () => {
    const summary = buildAvailabilityStateSummary({
      roles: [Role.SALES_STAFF],
      availabilityStatus: StaffAvailabilityStatus.UNAVAILABLE,
      availabilityNote: 'Emergency leave',
      availabilityUpdatedAt: new Date('2026-04-23T01:00:00.000Z'),
    });

    expect(summary).toMatchObject({
      availabilityStatus: StaffAvailabilityStatus.UNAVAILABLE,
      availabilityNote: 'Emergency leave',
      availabilitySetupRequired: false,
    });
  });

  it('marks ended shifts as expired and requires another setup action', () => {
    const summary = buildAvailabilityStateSummary(
      {
        roles: [Role.SALES_STAFF],
      },
      buildSession({
        shiftStartAt: new Date('2026-04-22T00:00:00.000Z'),
        shiftEndAt: new Date('2026-04-22T09:00:00.000Z'),
      }) as never,
      new Date('2026-04-23T01:00:00.000Z'),
    );

    expect(summary.activeShift).toBeUndefined();
    expect(summary.expiredShift).toMatchObject({
      sessionId: 'session-1',
    });
    expect(summary.availabilitySetupRequired).toBe(true);
  });
});

describe('availability-session.service sales assignment eligibility', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('respects unavailable overrides even when an old available session exists', async () => {
    const result = await evaluateSalesAssignmentEligibility({
      salesStaffId: 'sales-1',
      userAvailabilityStatus: StaffAvailabilityStatus.UNAVAILABLE,
      session: buildSession() as never,
      dateStr: '2026-04-23',
      slotCode: '09:00',
    });

    expect(result).toEqual({
      assignmentEligible: false,
      assignmentBlockedReason: 'Unavailable',
    });
    expect(mockSalesAvailabilityFindOne).not.toHaveBeenCalled();
    expect(mockAppointmentExists).not.toHaveBeenCalled();
  });

  it('blocks sales staff when the admin date block matches the appointment date', async () => {
    mockSalesAvailabilityFindOne.mockReturnValueOnce(
      mockSelectable({ unavailableDates: ['2026-04-23'] }),
    );

    const result = await evaluateSalesAssignmentEligibility({
      salesStaffId: 'sales-1',
      userAvailabilityStatus: StaffAvailabilityStatus.AVAILABLE,
      session: buildSession() as never,
      dateStr: '2026-04-23',
      slotCode: '09:00',
    });

    expect(result).toEqual({
      assignmentEligible: false,
      assignmentBlockedReason: 'Blocked on this date',
    });
    expect(mockAppointmentExists).not.toHaveBeenCalled();
  });

  it('blocks sales staff who already have another non-final appointment in the same slot', async () => {
    mockSalesAvailabilityFindOne.mockReturnValueOnce(mockSelectable(null));
    mockAppointmentExists
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 'appt-conflict' });

    const result = await evaluateSalesAssignmentEligibility({
      salesStaffId: 'sales-1',
      userAvailabilityStatus: StaffAvailabilityStatus.AVAILABLE,
      session: buildSession() as never,
      dateStr: '2026-04-23',
      slotCode: '09:00',
      appointmentId: 'appt-current',
    });

    expect(result).toEqual({
      assignmentEligible: false,
      assignmentBlockedReason: 'Booked in another appointment',
    });
    expect(mockAppointmentExists).toHaveBeenNthCalledWith(2, {
      salesStaffId: 'sales-1',
      date: '2026-04-23',
      slotCode: '09:00',
      status: { $nin: ['completed', 'cancelled', 'no_show'] },
      _id: { $ne: 'appt-current' },
    });
  });

  it('blocks sales staff for the whole date when they have an active ocular visit', async () => {
    mockSalesAvailabilityFindOne.mockReturnValueOnce(mockSelectable(null));
    mockAppointmentExists.mockResolvedValueOnce({ _id: 'ocular-conflict' });

    const result = await evaluateSalesAssignmentEligibility({
      salesStaffId: 'sales-1',
      userAvailabilityStatus: StaffAvailabilityStatus.AVAILABLE,
      session: buildSession() as never,
      dateStr: '2026-04-23',
      slotCode: '13:00',
    });

    expect(result).toEqual({
      assignmentEligible: false,
      assignmentBlockedReason: 'In ocular visit for this date',
    });
  });

  it('returns eligible when status, shift, date blocks, and conflicts all pass', async () => {
    mockSalesAvailabilityFindOne.mockReturnValueOnce(mockSelectable(null));
    mockAppointmentExists
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const result = await evaluateSalesAssignmentEligibility({
      salesStaffId: 'sales-1',
      userAvailabilityStatus: StaffAvailabilityStatus.AVAILABLE,
      session: buildSession() as never,
      dateStr: '2026-04-23',
      slotCode: '09:00',
    });

    expect(result).toEqual({ assignmentEligible: true });
  });
});
