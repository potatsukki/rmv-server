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
  appointmentsConflict,
  buildAvailabilityStateSummary,
  evaluateSalesAssignmentEligibility,
  holdsStaffTime,
  legMinutes,
  roundTravelMinutes,
  SALES_SLOT_FREEING_STATUSES,
  slotsOverlap,
  staffBusyWindow,
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

  it('allows two office consultations on the same date in different slots', async () => {
    mockSameDayAppointments([{ ...nineAm, type: AppointmentType.OFFICE }]);

    const result = await evaluateSalesAssignmentEligibility({ ...newAssignment, session: buildSession() as never });

    expect(result).toEqual({ assignmentEligible: true });
  });

  // An ocular visit with no route (no site pin) still takes the sales staff member's whole day.
  it.each([
    [
      'a consultation on a day that already has an ocular visit',
      AppointmentType.OFFICE, AppointmentType.OCULAR,
      'Has an ocular visit that day (9:00 AM, Nov 14, 2026 · APT-20261114-0001); it has no site pin yet, so it takes the whole day',
    ],
    [
      'an ocular visit on a day that already has a consultation',
      AppointmentType.OCULAR, AppointmentType.OFFICE,
      'Has another appointment that day (9:00 AM, Nov 14, 2026 · APT-20261114-0001); an ocular visit without a site pin takes the whole day',
    ],
    [
      'a second ocular visit on the same day',
      AppointmentType.OCULAR, AppointmentType.OCULAR,
      'Has an ocular visit that day (9:00 AM, Nov 14, 2026 · APT-20261114-0001); it has no site pin yet, so it takes the whole day',
    ],
  ])('blocks %s without a site pin, even in a different slot', async (_label, appointmentType, existingType, reason) => {
    mockSameDayAppointments([{ ...nineAm, type: existingType }]);

    const result = await evaluateSalesAssignmentEligibility({ ...newAssignment, appointmentType, session: buildSession() as never });

    expect(result).toEqual({ assignmentEligible: false, assignmentBlockedReason: reason });
  });

  it('names the same-time appointment first when the day also has an ocular visit', async () => {
    mockSameDayAppointments([
      { ...nineAm, _id: 'appt-1pm', appointmentNumber: 'APT-20261114-0002', slotCode: '13:00', type: AppointmentType.OCULAR },
      { ...nineAm, type: AppointmentType.OFFICE },
    ]);

    const result = await evaluateSalesAssignmentEligibility({ ...newAssignment, slotCode: '09:00', session: buildSession() as never });

    expect(result.assignmentBlockedReason).toBe('Already has an appointment at this time (9:00 AM, Nov 14, 2026 · APT-20261114-0001)');
  });

  it('treats any pair with an unpinned ocular visit as a clash, and consultations only when their slots overlap', () => {
    const office = (slotCode: string) => ({ type: AppointmentType.OFFICE, slotCode });
    const ocular = (slotCode: string) => ({ type: AppointmentType.OCULAR, slotCode });

    expect(appointmentsConflict(office('09:00'), office('10:00'))).toBe(false);
    expect(appointmentsConflict(office('09:00'), office('09:00'))).toBe(true);
    expect(appointmentsConflict(office('09:00'), ocular('15:00'))).toBe(true);
    expect(appointmentsConflict(ocular('09:00'), office('15:00'))).toBe(true);
    expect(appointmentsConflict(ocular('09:00'), ocular('15:00'))).toBe(true);
  });

  describe('ocular visit busy time (15 min prep + travel + traffic + 1.5 hr on site)', () => {
    const office = (slotCode: string) => ({ type: AppointmentType.OFFICE, slotCode });
    // 45 min drive (rounded to 1 hr), 18 km away: 1 hr of traffic is added each way.
    const farOcular = (slotCode: string) => ({ type: AppointmentType.OCULAR, slotCode, travelDurationMinutes: 45, distanceKm: 18 });
    // 10 min drive (rounded to 30 min), 3 km away: near the shop, so no traffic allowance.
    const nearOcular = (slotCode: string) => ({ type: AppointmentType.OCULAR, slotCode, travelDurationMinutes: 10, distanceKm: 3 });

    it('rounds the drive time up to the next 30 min', () => {
      expect(roundTravelMinutes(0)).toBe(0);
      expect(roundTravelMinutes(10)).toBe(30);
      expect(roundTravelMinutes(30)).toBe(30);
      expect(roundTravelMinutes(31)).toBe(60);
      expect(roundTravelMinutes(48)).toBe(60);
      expect(roundTravelMinutes(70)).toBe(90);
      expect(roundTravelMinutes(90)).toBe(90);
      expect(roundTravelMinutes(91)).toBe(120);
      expect(roundTravelMinutes(-5)).toBe(0);
    });

    it('adds 1 hr of traffic to each rounded one-way trip, except for a site within 4 km of the shop', () => {
      expect(legMinutes(45, 18)).toBe(120);
      expect(legMinutes(48, 41)).toBe(120);
      expect(legMinutes(10, 3)).toBe(30);
      expect(legMinutes(10, 4)).toBe(30);
      expect(legMinutes(44.2, undefined)).toBe(120);
    });

    it('keeps the staff busy from preparing at the shop (15 min before leaving) until getting back', () => {
      // Far 1 PM: prep 10:45, leave 11:00, back 4:30 PM.
      expect(staffBusyWindow(farOcular('13:00'))).toEqual({ start: 10 * 60 + 45, end: 16 * 60 + 30 });
      // Near 1 PM: prep 12:15, leave 12:30, back 3:00 PM.
      expect(staffBusyWindow(nearOcular('13:00'))).toEqual({ start: 12 * 60 + 15, end: 15 * 60 });
      // The QA site: 48 min / 41 km at 10:00 → prep 7:45, leave 8:00 AM, back 1:30 PM.
      expect(staffBusyWindow({ type: AppointmentType.OCULAR, slotCode: '10:00', travelDurationMinutes: 48, distanceKm: 41 }))
        .toEqual({ start: 7 * 60 + 45, end: 13 * 60 + 30 });
      // Consultations have no prep: just their one-hour slot.
      expect(staffBusyWindow(office('13:00'))).toEqual({ start: 13 * 60, end: 14 * 60 });
      expect(staffBusyWindow({ type: AppointmentType.OCULAR, slotCode: '13:00' })).toBeNull();
    });

    it('rejects a booking while the staff is preparing, travelling or on site, and frees the rest of the day', () => {
      // 1 PM far ocular: busy 10:45 AM–4:30 PM.
      expect(appointmentsConflict(farOcular('13:00'), office('14:00'))).toBe(true);
      expect(appointmentsConflict(farOcular('13:00'), office('11:00'))).toBe(true);
      expect(appointmentsConflict(farOcular('13:00'), office('15:00'))).toBe(true);
      expect(appointmentsConflict(farOcular('13:00'), office('16:00'))).toBe(true);
      // The 10:00 consultation runs until 11:00, into the 10:45 prep.
      expect(appointmentsConflict(farOcular('13:00'), office('10:00'))).toBe(true);
      expect(appointmentsConflict(farOcular('13:00'), office('09:00'))).toBe(false);
      // Another far ocular at 4 PM must start preparing at 1:45 PM, while the staff is still away.
      expect(appointmentsConflict(farOcular('13:00'), farOcular('16:00'))).toBe(true);
      // 1 PM near ocular: busy 12:15–3:00 PM, so 3 PM is free and the 12:00 consultation is not.
      expect(appointmentsConflict(nearOcular('13:00'), office('15:00'))).toBe(false);
      expect(appointmentsConflict(nearOcular('13:00'), office('14:00'))).toBe(true);
      expect(appointmentsConflict(nearOcular('13:00'), office('12:00'))).toBe(true);
    });

    it('allows two ocular visits on the same day when their busy times do not overlap', () => {
      // 9 AM near ocular (8:15–11:00 AM) + 2 PM far ocular (11:45 AM–5:30 PM).
      expect(appointmentsConflict(nearOcular('09:00'), farOcular('14:00'))).toBe(false);
      // With a 1 PM far ocular (prep from 10:45) they overlap.
      expect(appointmentsConflict(nearOcular('09:00'), farOcular('13:00'))).toBe(true);
      // Two far ones: 6:45 AM–12:30 PM and 10:45 AM–4:30 PM overlap.
      expect(appointmentsConflict(farOcular('09:00'), farOcular('13:00'))).toBe(true);
    });

    it('names the busy time when a consultation falls inside an ocular visit', async () => {
      mockSameDayAppointments([{ ...nineAm, slotCode: '13:00', ...farOcular('13:00') }]);

      const result = await evaluateSalesAssignmentEligibility({ ...newAssignment, slotCode: '11:00', session: buildSession() as never });

      expect(result).toEqual({
        assignmentEligible: false,
        assignmentBlockedReason: 'Has an ocular visit that day (1:00 PM, Nov 14, 2026 · APT-20261114-0001) and is away 10:45 AM–4:30 PM, prep and travel included',
      });
    });

    it('names the new ocular visit’s busy time when it would fall over a consultation', async () => {
      mockSameDayAppointments([{ ...nineAm, slotCode: '15:00', type: AppointmentType.OFFICE }]);

      const result = await evaluateSalesAssignmentEligibility({
        ...newAssignment,
        slotCode: '13:00',
        appointmentType: AppointmentType.OCULAR,
        route: { travelDurationMinutes: 45, distanceKm: 18 },
        session: buildSession() as never,
      });

      expect(result).toEqual({
        assignmentEligible: false,
        assignmentBlockedReason: 'Has another appointment (3:00 PM, Nov 14, 2026 · APT-20261114-0001) while this ocular visit keeps them away 10:45 AM–4:30 PM, prep and travel included',
      });
    });

    it('lets a consultation outside the ocular visit through', async () => {
      mockSameDayAppointments([{ ...nineAm, slotCode: '13:00', ...farOcular('13:00') }]);

      // The 9:00 consultation ends at 10:00 AM, before the 10:45 prep for the 1 PM ocular visit.
      const result = await evaluateSalesAssignmentEligibility({ ...newAssignment, slotCode: '09:00', session: buildSession() as never });

      expect(result).toEqual({ assignmentEligible: true });
    });
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

  // User decision 2026-11-27: a finished consultation (Completed, Customer Declined, Ready for Ocular)
  // gives its staff's time back at once; a finished ocular visit holds until the trip back ends.
  it('gives the time back at once for cancelled, no-show and finished consultations; a finished ocular after the trip back', () => {
    expect(SALES_SLOT_FREEING_STATUSES).toEqual([AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW]);
    for (const occupying of [
      AppointmentStatus.REQUESTED, AppointmentStatus.CONFIRMED, AppointmentStatus.IN_PROGRESS, AppointmentStatus.READY_FOR_OCULAR, AppointmentStatus.COMPLETED,
    ]) {
      expect(SALES_SLOT_FREEING_STATUSES).not.toContain(occupying);
    }

    // 10:00 AM in Manila on Nov 26, 2026.
    const at = new Date('2026-11-26T02:00:00.000Z');
    const completed = (date: string, slotCode: string, extra: Record<string, unknown> = {}) => (
      { status: AppointmentStatus.COMPLETED, type: AppointmentType.OFFICE, date, slotCode, ...extra }
    );
    // A consultation closed early (the QA case: Customer Declined before its 1 PM / 3 PM hour) is vacant again.
    expect(holdsStaffTime(completed('2026-11-28', '10:00'), at)).toBe(false);
    expect(holdsStaffTime(completed('2026-11-28', '10:00', { attendanceStatus: 'customer_declined' }), at)).toBe(false);
    expect(holdsStaffTime({ ...completed('2026-11-28', '10:00'), status: AppointmentStatus.READY_FOR_OCULAR }, at)).toBe(false);
    expect(holdsStaffTime(completed('2026-11-26', '09:00'), at)).toBe(false);
    expect(holdsStaffTime(completed('2026-11-25', '15:00'), at)).toBe(false);
    // A far 9:00 ocular keeps its staff until 12:30 PM (on the road back), so at 10:00 it still holds.
    const farOcular = { type: AppointmentType.OCULAR, travelDurationMinutes: 45, distanceKm: 18 };
    expect(holdsStaffTime(completed('2026-11-26', '09:00', farOcular), at)).toBe(true);
    expect(holdsStaffTime(completed('2026-11-26', '09:00', farOcular), new Date('2026-11-26T05:00:00.000Z'))).toBe(false);
    expect(holdsStaffTime({ status: AppointmentStatus.CANCELLED, date: '2026-11-28', slotCode: '10:00' }, at)).toBe(false);
    expect(holdsStaffTime({ status: AppointmentStatus.NO_SHOW, date: '2026-11-28', slotCode: '10:00' }, at)).toBe(false);
    expect(holdsStaffTime({ status: AppointmentStatus.CONFIRMED, date: '2026-11-25', slotCode: '09:00' }, at)).toBe(true);
  });

  it('allows the same slot once the earlier appointment is cancelled or no-show (excluded by the status filter)', async () => {
    mockSameDayAppointments([]);

    const result = await evaluateSalesAssignmentEligibility({ ...newAssignment, slotCode: '09:00', session: buildSession() as never });

    expect(result).toEqual({ assignmentEligible: true });
    expect(mockAppointmentFind).toHaveBeenCalledWith(expect.objectContaining({
      status: { $nin: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] },
    }));
  });

  describe('a completed appointment on the same slot', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    // User decision 2026-11-27: a consultation closed early (e.g. Customer Declined) is vacant again.
    it('frees a consultation completed early, before its time', async () => {
      // 8:00 AM Manila on Nov 14: the 9:00 consultation was completed before it started.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-14T00:00:00.000Z'));
      mockSameDayAppointments([{ ...nineAm, type: AppointmentType.OFFICE, date: '2026-11-14', status: AppointmentStatus.COMPLETED }]);

      const result = await evaluateSalesAssignmentEligibility({ ...newAssignment, slotCode: '09:00', session: buildSession() as never });

      expect(result).toEqual({ assignmentEligible: true });
    });

    it('still blocks while a completed ocular visit is on the way back', async () => {
      // 8:00 AM Manila on Nov 14: a completed 9:00 ocular (45 min drive, 18 km) keeps its staff until 12:30 PM.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-14T00:00:00.000Z'));
      mockSameDayAppointments([{
        ...nineAm, type: AppointmentType.OCULAR, date: '2026-11-14', status: AppointmentStatus.COMPLETED,
        travelDurationMinutes: 45, distanceKm: 18,
      }]);

      const result = await evaluateSalesAssignmentEligibility({ ...newAssignment, slotCode: '09:00', session: buildSession() as never });

      expect(result).toMatchObject({ assignmentEligible: false });
    });

    it('frees the slot once its time has passed', async () => {
      // 11:00 AM Manila on Nov 14: the 9:00–10:00 consultation is over.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-14T03:00:00.000Z'));
      mockSameDayAppointments([{ ...nineAm, type: AppointmentType.OFFICE, date: '2026-11-14', status: AppointmentStatus.COMPLETED }]);

      const result = await evaluateSalesAssignmentEligibility({ ...newAssignment, slotCode: '09:00', session: buildSession() as never });

      expect(result).toEqual({ assignmentEligible: true });
    });
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
