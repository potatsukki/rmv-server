import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAppointmentExists,
  mockAppointmentCountDocuments,
  mockAppointmentFind,
  mockSalesAvailabilityFindOne,
} = vi.hoisted(() => ({
  mockAppointmentExists: vi.fn(),
  mockAppointmentCountDocuments: vi.fn(),
  mockAppointmentFind: vi.fn(),
  mockSalesAvailabilityFindOne: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Appointment: {
    exists: mockAppointmentExists,
    countDocuments: mockAppointmentCountDocuments,
    find: mockAppointmentFind,
  },
  AvailabilitySession: {},
  SalesAvailability: {
    findOne: mockSalesAvailabilityFindOne,
  },
}));

import {
  buildAvailabilityStateSummary,
  evaluateSalesAssignmentEligibility,
  SALES_SLOT_FREEING_STATUSES,
  slotsOverlap,
} from './availability-session.service.js';
import { AppointmentStatus, AppointmentType, Role, StaffAvailabilityStatus } from '../../utils/constants.js';

function mockSelectable<T>(value: T) {
  return {
    select: vi.fn().mockResolvedValue(value),
  };
}

/** The staff member's other (non-freeing) appointments on the queried date. */
function mockSameDayAppointments(value: unknown[]) {
  mockAppointmentFind.mockReturnValueOnce({
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
    mockAppointmentFind.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
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
    expect(mockAppointmentFind).not.toHaveBeenCalled();
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
    expect(mockAppointmentFind).not.toHaveBeenCalled();
  });

  it('returns eligible when status, shift, date blocks, and conflicts all pass', async () => {
    mockSalesAvailabilityFindOne.mockReturnValueOnce(mockSelectable(null));

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
    expect(mockAppointmentFind).not.toHaveBeenCalled();
  });
});

describe('slotsOverlap', () => {
  it.each([
    ['09:00', '10:00', false],
    ['10:00', '09:00', false],
    ['09:00', '09:00', true],
    ['09:30', '10:00', true],
    ['11:00', '13:00', false],
  ])('%s vs %s → %s', (a, b, expected) => {
    expect(slotsOverlap(a, b)).toBe(expected);
  });

  it('only matches identical codes when a slot cannot be parsed', () => {
    expect(slotsOverlap('sales-day', 'sales-day')).toBe(true);
    expect(slotsOverlap('sales-day', '09:00')).toBe(false);
    expect(slotsOverlap(undefined, '09:00')).toBe(false);
  });
});

describe('availability-session.service sales staff appointment conflicts per time slot', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T02:00:00.000Z'));
    mockSalesAvailabilityFindOne.mockReturnValue(mockSelectable(null));
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // Bugoy's case: an existing Nov 14, 2026 9:00–10:00 AM appointment.
  const newAssignment = {
    salesStaffId: 'sales-1',
    userAvailabilityStatus: StaffAvailabilityStatus.AVAILABLE,
    dateStr: '2026-11-14',
    slotCode: '10:00',
    appointmentType: AppointmentType.OFFICE,
    appointmentId: 'appt-new',
  };
  const nineAm = { _id: 'appt-9am', appointmentNumber: 'APT-20261114-0001', slotCode: '09:00', status: AppointmentStatus.CONFIRMED };

  it.each([
    ['an office consultation next to an office consultation', AppointmentType.OFFICE, AppointmentType.OFFICE],
    ['an ocular visit next to an office consultation', AppointmentType.OCULAR, AppointmentType.OFFICE],
    ['an office consultation next to an ocular visit', AppointmentType.OFFICE, AppointmentType.OCULAR],
    ['an ocular visit next to an ocular visit', AppointmentType.OCULAR, AppointmentType.OCULAR],
  ])('allows the same date + a different slot: %s', async (_label, appointmentType, existingType) => {
    mockSameDayAppointments([{ ...nineAm, type: existingType }]);

    const result = await evaluateSalesAssignmentEligibility({ ...newAssignment, appointmentType, session: buildSession() as never });

    expect(result).toEqual({ assignmentEligible: true });
  });

  it('blocks the same date + the same slot', async () => {
    mockSameDayAppointments([nineAm]);

    const result = await evaluateSalesAssignmentEligibility({ ...newAssignment, slotCode: '09:00', session: buildSession() as never });

    expect(result).toEqual({
      assignmentEligible: false,
      assignmentBlockedReason: 'Already has an appointment at this time (9:00 AM, Nov 14, 2026 · APT-20261114-0001)',
    });
    expect(mockAppointmentFind).toHaveBeenCalledWith({
      salesStaffId: 'sales-1',
      date: '2026-11-14',
      status: { $nin: SALES_SLOT_FREEING_STATUSES },
      _id: { $ne: 'appt-new' },
    });
  });

  it('blocks a truly overlapping time range on the same date', async () => {
    mockSameDayAppointments([{ ...nineAm, slotCode: '09:30', appointmentNumber: undefined }]);

    const result = await evaluateSalesAssignmentEligibility({ ...newAssignment, slotCode: '10:00', session: buildSession() as never });

    expect(result).toEqual({
      assignmentEligible: false,
      assignmentBlockedReason: 'Already has an appointment at this time (9:30 AM, Nov 14, 2026)',
    });
  });

  it('allows a different date (the lookup only matches the target date)', async () => {
    mockSameDayAppointments([]);

    const result = await evaluateSalesAssignmentEligibility({
      ...newAssignment, dateStr: '2026-11-15', slotCode: '09:00', session: buildSession() as never,
    });

    expect(result).toEqual({ assignmentEligible: true });
    expect(mockAppointmentFind).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-11-15' }));
  });

  it('does not let cancelled, completed or no-show appointments block their slot', () => {
    expect(SALES_SLOT_FREEING_STATUSES).toEqual([
      AppointmentStatus.CANCELLED,
      AppointmentStatus.COMPLETED,
      AppointmentStatus.NO_SHOW,
    ]);
    for (const occupying of [AppointmentStatus.REQUESTED, AppointmentStatus.CONFIRMED, AppointmentStatus.IN_PROGRESS, AppointmentStatus.READY_FOR_OCULAR]) {
      expect(SALES_SLOT_FREEING_STATUSES).not.toContain(occupying);
    }
  });

  it('allows the same slot once the earlier appointment is final (excluded by the status filter)', async () => {
    // The completed/cancelled 9:00 appointment is filtered out by `$nin`, so nothing comes back.
    mockSameDayAppointments([]);

    const result = await evaluateSalesAssignmentEligibility({ ...newAssignment, slotCode: '09:00', session: buildSession() as never });

    expect(result).toEqual({ assignmentEligible: true });
    expect(mockAppointmentFind).toHaveBeenCalledWith(expect.objectContaining({
      status: { $nin: [AppointmentStatus.CANCELLED, AppointmentStatus.COMPLETED, AppointmentStatus.NO_SHOW] },
    }));
  });

  it('applies the rule to a brand-new appointment too (no id to exclude)', async () => {
    mockSameDayAppointments([]);

    const { appointmentId: _omit, ...withoutId } = newAssignment;
    const result = await evaluateSalesAssignmentEligibility({
      ...withoutId,
      appointmentType: AppointmentType.OCULAR,
      session: buildSession() as never,
    });

    expect(result).toEqual({ assignmentEligible: true });
    expect(mockAppointmentFind).toHaveBeenCalledWith({
      salesStaffId: 'sales-1',
      status: { $nin: SALES_SLOT_FREEING_STATUSES },
      date: '2026-11-14',
    });
  });
});
