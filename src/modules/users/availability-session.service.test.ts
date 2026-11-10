import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAppointmentExists,
  mockAppointmentCountDocuments,
  mockAppointmentFindOne,
  mockSalesAvailabilityFindOne,
} = vi.hoisted(() => ({
  mockAppointmentExists: vi.fn(),
  mockAppointmentCountDocuments: vi.fn(),
  mockAppointmentFindOne: vi.fn(),
  mockSalesAvailabilityFindOne: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Appointment: {
    exists: mockAppointmentExists,
    countDocuments: mockAppointmentCountDocuments,
    findOne: mockAppointmentFindOne,
  },
  AvailabilitySession: {},
  SalesAvailability: {
    findOne: mockSalesAvailabilityFindOne,
  },
}));

import {
  buildAvailabilityStateSummary,
  evaluateSalesAssignmentEligibility,
  SALES_DAY_FREEING_STATUSES,
} from './availability-session.service.js';
import { AppointmentStatus, AppointmentType, Role, StaffAvailabilityStatus } from '../../utils/constants.js';

function mockSelectable<T>(value: T) {
  return {
    select: vi.fn().mockResolvedValue(value),
  };
}

function mockActiveAssignment(value: unknown) {
  mockAppointmentFindOne.mockReturnValueOnce({
    select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }),
  });
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

  it('treats internal users without an open session as available by default', () => {
    const summary = buildAvailabilityStateSummary({
      roles: [Role.SALES_STAFF],
    });

    expect(summary).toMatchObject({
      availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
      availabilitySetupRequired: false,
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

  it('keeps an ended shift for display without requiring setup', () => {
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
    expect(summary.availabilityStatus).toBe(StaffAvailabilityStatus.AVAILABLE);
    expect(summary.availabilitySetupRequired).toBe(false);
  });
});

describe('availability-session.service sales assignment eligibility', () => {
  beforeEach(() => {
    // Exercise the April fixture during its active shift, independently of the
    // date on which the suite runs. Other tests still check expired shifts.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-23T00:30:00.000Z'));
    // By default the staff has no other appointment that day.
    mockAppointmentFindOne.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
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

  it('blocks the staff over a COMPLETED consultation on the same date (PRJ-2026-00094)', async () => {
    // The Nov 13 consultation was completed early (Nov 10); an ocular on Nov 13 must still be blocked.
    mockSalesAvailabilityFindOne.mockReturnValueOnce(mockSelectable(null));
    mockActiveAssignment({ _id: 'consultation-1', appointmentNumber: 'APT-20261113-0004', status: AppointmentStatus.COMPLETED });

    const result = await evaluateSalesAssignmentEligibility({
      salesStaffId: 'sales-1',
      userAvailabilityStatus: StaffAvailabilityStatus.AVAILABLE,
      session: buildSession() as never,
      dateStr: '2026-11-13',
      slotCode: '09:00',
      appointmentType: AppointmentType.OCULAR,
    });

    expect(result).toEqual({
      assignmentEligible: false,
      assignmentBlockedReason: 'Already has an appointment on Nov 13, 2026 (APT-20261113-0004)',
    });
    expect(mockAppointmentFindOne).toHaveBeenCalledWith({
      salesStaffId: 'sales-1',
      date: '2026-11-13',
      status: { $nin: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] },
    });
  });

  it.each([
    ['an ocular visit on a day with an office consultation', AppointmentType.OCULAR, 'office'],
    ['an office consultation on a day with an ocular visit', AppointmentType.OFFICE, 'ocular'],
    ['a second ocular visit on the same day', AppointmentType.OCULAR, 'ocular'],
    ['a second office consultation on the same day', AppointmentType.OFFICE, 'office'],
  ])('blocks %s (one appointment per day)', async (_label, appointmentType, existingType) => {
    mockSalesAvailabilityFindOne.mockReturnValueOnce(mockSelectable(null));
    mockActiveAssignment({ _id: 'appt-same-day', appointmentNumber: 'APT-20260423-0001', type: existingType });

    const result = await evaluateSalesAssignmentEligibility({
      salesStaffId: 'sales-1',
      userAvailabilityStatus: StaffAvailabilityStatus.AVAILABLE,
      session: buildSession() as never,
      dateStr: '2026-04-23',
      slotCode: '14:00',
      appointmentType,
    });

    expect(result).toEqual({
      assignmentEligible: false,
      assignmentBlockedReason: 'Already has an appointment on Apr 23, 2026 (APT-20260423-0001)',
    });
    expect(mockAppointmentExists).not.toHaveBeenCalled();
  });

  it('returns eligible when status, shift, date blocks, and conflicts all pass', async () => {
    mockSalesAvailabilityFindOne.mockReturnValueOnce(mockSelectable(null));
    mockAppointmentExists.mockResolvedValueOnce(null);

    const result = await evaluateSalesAssignmentEligibility({
      salesStaffId: 'sales-1',
      userAvailabilityStatus: StaffAvailabilityStatus.AVAILABLE,
      session: buildSession() as never,
      dateStr: '2026-04-23',
      slotCode: '09:00',
      appointmentType: AppointmentType.OFFICE,
    });

    expect(result).toEqual({ assignmentEligible: true });
  });

  it('allows a timed-in employee without a scheduled shift end', async () => {
    mockSalesAvailabilityFindOne.mockReturnValueOnce(mockSelectable(null));
    mockAppointmentExists.mockResolvedValueOnce(null);
    const result = await evaluateSalesAssignmentEligibility({
      salesStaffId: 'sales-1', userAvailabilityStatus: StaffAvailabilityStatus.AVAILABLE,
      session: buildSession({ shiftEndAt: undefined }) as never,
      dateStr: '2026-04-23', slotCode: '09:00', appointmentType: AppointmentType.OFFICE,
    });
    expect(result).toEqual({ assignmentEligible: true });
  });

  it.each([
    ['no session', null],
    ['an ended shift', buildSession({ shiftEndAt: new Date('2026-04-23T00:00:00Z') })],
    ['a closed session', buildSession({ closedAt: new Date('2026-04-23T00:00:00Z') })],
    ['a shift that starts after the slot', buildSession({ shiftStartAt: new Date('2026-04-23T03:00:00Z') })],
  ])('keeps staff assignable with %s now that there is no time-in', async (_label, session) => {
    mockSalesAvailabilityFindOne.mockReturnValueOnce(mockSelectable(null));
    mockAppointmentExists.mockResolvedValueOnce(null);

    const result = await evaluateSalesAssignmentEligibility({
      salesStaffId: 'sales-1', userAvailabilityStatus: undefined,
      session: session as never, dateStr: '2026-04-23', slotCode: '09:00', appointmentType: AppointmentType.OFFICE,
    });
    expect(result).toEqual({ assignmentEligible: true });
  });

  it.each([
    [StaffAvailabilityStatus.UNAVAILABLE, 'Unavailable'],
    [StaffAvailabilityStatus.ON_LEAVE, 'On leave'],
  ])('still blocks staff an admin marked %s', async (status, reason) => {
    const result = await evaluateSalesAssignmentEligibility({
      salesStaffId: 'sales-1', userAvailabilityStatus: status,
      session: null, dateStr: '2026-04-23', slotCode: '09:00', appointmentType: AppointmentType.OFFICE,
    });
    expect(result).toEqual({ assignmentEligible: false, assignmentBlockedReason: reason });
    expect(mockAppointmentExists).not.toHaveBeenCalled();
  });
});

describe('availability-session.service one appointment per day per sales staff', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-23T00:30:00.000Z'));
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  const newAssignment = {
    salesStaffId: 'sales-1',
    userAvailabilityStatus: StaffAvailabilityStatus.AVAILABLE,
    dateStr: '2026-04-23',
    slotCode: '09:00',
    appointmentType: AppointmentType.OFFICE,
    appointmentId: 'appt-new',
  };

  it('blocks a new assignment while the staff has another active appointment on the same date', async () => {
    mockSalesAvailabilityFindOne.mockReturnValueOnce(mockSelectable(null));
    mockActiveAssignment({ _id: 'appt-active', appointmentNumber: 'APT-20260423-0006' });

    const result = await evaluateSalesAssignmentEligibility({ ...newAssignment, session: buildSession() as never });

    expect(result).toEqual({
      assignmentEligible: false,
      assignmentBlockedReason: 'Already has an appointment on Apr 23, 2026 (APT-20260423-0006)',
    });
    expect(mockAppointmentFindOne).toHaveBeenCalledWith({
      salesStaffId: 'sales-1',
      status: { $nin: SALES_DAY_FREEING_STATUSES },
      date: '2026-04-23',
      _id: { $ne: 'appt-new' },
    });
  });

  it('does not block the staff over an active appointment on another date', async () => {
    // e.g. a project ocular on Nov 11 must not block an office appointment on Nov 12:
    // the lookup only matches the target date, so nothing is found.
    mockSalesAvailabilityFindOne.mockReturnValueOnce(mockSelectable(null));
    mockActiveAssignment(null);
    mockAppointmentExists.mockResolvedValueOnce(null);

    const result = await evaluateSalesAssignmentEligibility({
      ...newAssignment,
      dateStr: '2026-11-12',
      session: buildSession() as never,
    });

    expect(result).toEqual({ assignmentEligible: true });
    expect(mockAppointmentFindOne).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-11-12' }));
  });

  it('makes the staff assignable again once their appointment is no longer active', async () => {
    mockSalesAvailabilityFindOne.mockReturnValueOnce(mockSelectable(null));
    mockActiveAssignment(null);
    mockAppointmentExists.mockResolvedValueOnce(null);

    const result = await evaluateSalesAssignmentEligibility({ ...newAssignment, session: buildSession() as never });

    expect(result).toEqual({ assignmentEligible: true });
  });

  it('frees the day only for cancelled and no-show appointments', () => {
    expect(SALES_DAY_FREEING_STATUSES).toEqual([AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW]);
    for (const occupying of [AppointmentStatus.COMPLETED, AppointmentStatus.READY_FOR_OCULAR, AppointmentStatus.CONFIRMED]) {
      expect(SALES_DAY_FREEING_STATUSES).not.toContain(occupying);
    }
  });

  it('applies the rule to a brand-new appointment too (no id to exclude)', async () => {
    mockSalesAvailabilityFindOne.mockReturnValueOnce(mockSelectable(null));
    mockActiveAssignment(null);
    mockAppointmentExists.mockResolvedValueOnce(null);

    const { appointmentId: _omit, ...withoutId } = newAssignment;
    const result = await evaluateSalesAssignmentEligibility({
      ...withoutId,
      appointmentType: AppointmentType.OCULAR,
      session: buildSession() as never,
    });

    expect(result).toEqual({ assignmentEligible: true });
    expect(mockAppointmentFindOne).toHaveBeenCalledWith({
      salesStaffId: 'sales-1',
      status: { $nin: SALES_DAY_FREEING_STATUSES },
      date: '2026-04-23',
    });
  });
});
