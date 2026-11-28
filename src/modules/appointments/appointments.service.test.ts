import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockAppointmentFindById,
  mockAppointmentFindOne,
  mockAppointmentFind,
  mockAppointmentFindOneAndUpdate,
  mockAppointmentCreate,
  mockAppointmentCountDocuments,
  mockAuditCreate,
  mockNotifyRole,
  mockNotifyBookingAgent,
  mockAssertTransition,
  mockHolidayFindOne,
  mockBlockedSlotExists,
  mockUserFind,
  mockUserFindOne,
  mockAvailabilitySessionFind,
  mockSalesAvailabilityFind,
  mockAutoCreateDraft,
  mockQueueCounterFindOneAndUpdate,
  mockProjectFindOne,
  mockUserFindById,
  mockAssertCustomerScheduleFree,
  mockGetCustomerBookedSlots,
} = vi.hoisted(() => ({
  // The customer overlap rule has its own tests (customer-schedule-conflict*.test.ts); here it
  // passes unless a test makes it reject.
  mockAssertCustomerScheduleFree: vi.fn(),
  mockGetCustomerBookedSlots: vi.fn().mockResolvedValue(new Map()),
  mockAppointmentFindById: vi.fn(),
  mockAppointmentFindOne: vi.fn(),
  mockAppointmentFind: vi.fn(),
  mockAppointmentFindOneAndUpdate: vi.fn(),
  mockAppointmentCreate: vi.fn(),
  mockAppointmentCountDocuments: vi.fn(),
  mockAuditCreate: vi.fn(),
  mockNotifyRole: vi.fn(),
  mockNotifyBookingAgent: vi.fn(),
  mockAssertTransition: vi.fn(),
  mockHolidayFindOne: vi.fn(),
  mockBlockedSlotExists: vi.fn(),
  mockUserFind: vi.fn(),
  mockUserFindOne: vi.fn(),
  mockAvailabilitySessionFind: vi.fn(),
  mockSalesAvailabilityFind: vi.fn(),
  mockAutoCreateDraft: vi.fn(),
  mockQueueCounterFindOneAndUpdate: vi.fn(),
  mockProjectFindOne: vi.fn(() => ({ select: () => ({ lean: async () => null }) })),
  // The customer's email, for the "request received" and "confirmed" emails.
  mockUserFindById: vi.fn(() => ({ select: () => ({ lean: async () => ({ email: 'customer@example.test' }) }) })),
}));

vi.mock('../../models/index.js', () => ({
  Appointment: {
    findById: mockAppointmentFindById,
    findOne: mockAppointmentFindOne,
    find: mockAppointmentFind,
    findOneAndUpdate: mockAppointmentFindOneAndUpdate,
    create: mockAppointmentCreate,
    countDocuments: mockAppointmentCountDocuments,
  },
  SlotLock: {
    deleteOne: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({}),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
  },
  User: {
    find: mockUserFind,
    findOne: mockUserFindOne,
    findById: mockUserFindById,
  },
  AvailabilitySession: {
    find: mockAvailabilitySessionFind,
  },
  AuditLog: {
    create: mockAuditCreate,
  },
  Holiday: {
    findOne: mockHolidayFindOne,
  },
  SalesAvailability: {
    find: mockSalesAvailabilityFind,
  },
  Config: {},
  BlockedSlot: {
    exists: mockBlockedSlotExists,
  },
  VisitReport: { updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }) },
  VisitReportStatus: {},
  Project: { findOne: mockProjectFindOne, updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }) },
  AppointmentQueueCounter: {
    findOneAndUpdate: mockQueueCounterFindOneAndUpdate,
  },
}));

vi.mock('../../utils/stateMachine.js', () => ({
  appointmentStateMachine: {
    assertTransition: mockAssertTransition,
  },
}));

vi.mock('./customer-schedule-conflict.js', () => ({
  assertCustomerScheduleFree: mockAssertCustomerScheduleFree,
  getCustomerBookedSlots: mockGetCustomerBookedSlots,
}));

vi.mock('../users/availability-session.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../users/availability-session.service.js')>()),
  evaluateSalesAssignmentEligibility: vi.fn().mockResolvedValue({ assignmentEligible: true }),
  getOpenAvailabilitySession: vi.fn().mockResolvedValue(null),
}));

vi.mock('../notifications/socket.service.js', () => ({
  createAndSendNotification: vi.fn(),
  notifyRole: mockNotifyRole,
  emitRoleEvent: vi.fn(),
  notifyBookingAgentAppointmentSuccessful: mockNotifyBookingAgent,
  notifyBookingAgents: vi.fn(),
  notifyRoleExcept: vi.fn(),
  notifyUsers: vi.fn(),
}));

vi.mock('../notifications/email.service.js', () => ({
  sendAppointmentConfirmedEmail: vi.fn(), sendAppointmentRequestedEmail: vi.fn(),
}));

vi.mock('../visit-reports/visit-reports.service.js', () => ({
  autoCreateDraft: mockAutoCreateDraft,
}));

vi.mock('../maps/maps.service.js', () => ({
  computeOcularFee: vi.fn(),
  reverseGeocode: vi.fn(),
}));

vi.mock('../../services/paymongo.service.js', () => ({
  createCheckoutSession: vi.fn(),
  retrieveCheckoutSession: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  assertConsultationOcularSchedule,
  completeAppointment,
  prepareProjectOcularSchedule,
  assertOcularWindowFree,
  getAvailableSlots,
  ocularArrivalEstimate,
  reassignAppointmentSales,
  reviewAssignedAppointment,
  requestAppointment,
  requestReschedule,
  submitSiteDetails,
  updateConsultationAttendance,
  getCustomerQueueStatus,
  handlePaymongoPayment,
  listPendingOcularFees,
  processAutomaticConsultationNoShows,
  AUTO_NO_SHOW_NOTE,
} from './appointments.service.js';
import { createAndSendNotification, notifyBookingAgents, notifyUsers } from '../notifications/socket.service.js';
import {
  AppointmentAttendanceStatus,
  AppointmentStatus,
  AppointmentType,
  AuditAction,
  Role,
  ServiceType,
  StaffAvailabilityStatus,
} from '../../utils/constants.js';
import { evaluateSalesAssignmentEligibility } from '../users/availability-session.service.js';
import { sendAppointmentConfirmedEmail, sendAppointmentRequestedEmail } from '../notifications/email.service.js';

function createAppointment(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'appointment-1',
    customerId: {
      toString: () => 'customer-1',
    },
    status: AppointmentStatus.RESCHEDULE_REQUESTED,
    rescheduleCount: 1,
    maxReschedules: 3,
    date: '2026-08-15',
    slotCode: '10:00',
    rescheduleReason: 'old reason',
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('prepareProjectOcularSchedule', () => {
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it("is not blocked by the customer's other active appointment (another project's booking); only a time overlap blocks it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T01:00:00Z'));
    mockAppointmentFindOne.mockResolvedValue({ _id: 'active-1', status: AppointmentStatus.REQUESTED });
    mockHolidayFindOne.mockResolvedValue(null);
    // Stops at the slot check, which runs after every customer check.
    mockBlockedSlotExists.mockResolvedValueOnce(true);

    await expect(prepareProjectOcularSchedule({ customerId: 'customer-1', date: '2026-10-08', slotCode: '09:00', salesStaffId: 'sales-1' }))
      .rejects.toThrow('blocked by an administrator');
    expect(mockAppointmentFind).not.toHaveBeenCalledWith(expect.objectContaining({ customerId: 'customer-1' }));
    expect(mockAssertCustomerScheduleFree).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1', date: '2026-10-08', slotCode: '09:00', incomingType: AppointmentType.OCULAR,
    }));
  });

  it('rejects an ocular scheduled less than 3 days after its consultation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-08T01:00:00Z'));
    mockAppointmentFindOne.mockResolvedValue(null);
    // Consultation held Nov 7 → the ocular opens on Nov 10.
    await expect(prepareProjectOcularSchedule({
      customerId: 'customer-1', date: '2026-11-09', slotCode: '09:00', salesStaffId: 'sales-1', consultationDate: '2026-11-07',
    })).rejects.toThrow('at least 3 days after the consultation on Nov 7, 2026');
    expect(mockAppointmentFindOne).not.toHaveBeenCalled();
  });

  it('counts from the booked consultation date even when the consultation finished early', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T01:00:00Z'));
    mockAppointmentFindOne.mockResolvedValue(null);
    // PRJ-2026-00094: consultation booked Nov 13, completed early on Nov 10 → an ocular on Nov 13 is rejected.
    await expect(prepareProjectOcularSchedule({
      customerId: 'customer-1', date: '2026-11-13', slotCode: '09:00', salesStaffId: 'sales-1', consultationDate: '2026-11-13',
    })).rejects.toThrow('Choose Nov 16, 2026 or later.');
    expect(mockAppointmentFindOne).not.toHaveBeenCalled();
  });

  it('enforces the existing advance booking rule', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T01:00:00Z'));
    mockAppointmentFindOne.mockResolvedValue(null);
    await expect(prepareProjectOcularSchedule({ customerId: 'customer-1', date: '2026-10-05', slotCode: '09:00', salesStaffId: 'sales-1' })).rejects.toThrow('in advance');
  });

  it('rejects a blocked ocular slot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T01:00:00Z'));
    mockAppointmentFindOne.mockResolvedValue(null);
    mockHolidayFindOne.mockResolvedValue(null);
    mockBlockedSlotExists.mockResolvedValue(true);
    await expect(prepareProjectOcularSchedule({ customerId: 'customer-1', date: '2026-10-08', slotCode: '09:00', salesStaffId: 'sales-1' })).rejects.toThrow('blocked by an administrator');
  });
});

function selectLeanResult<T>(value: T) {
  return {
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(value),
    }),
  };
}

describe('completeAppointment', () => {
  afterEach(() => vi.clearAllMocks());

  it.each([true, false])('keeps consultation completed when report submitted is %s', async (consultationReportSubmitted) => {
    const appointment = createAppointment({
      type: AppointmentType.OFFICE,
      status: AppointmentStatus.CONFIRMED,
      salesStaffId: 'sales-1',
      slotCode: '09:00',
      consultationReportSubmitted,
    });
    mockAppointmentFindById.mockResolvedValue(appointment);

    const result = await completeAppointment('appointment-1', 'sales-1');

    expect(result.status).toBe(AppointmentStatus.COMPLETED);
    expect(appointment.save).toHaveBeenCalledOnce();
    expect(mockAssertTransition).toHaveBeenCalledExactlyOnceWith(
      AppointmentStatus.CONFIRMED,
      AppointmentStatus.COMPLETED,
    );
    expect(mockNotifyBookingAgent).toHaveBeenCalledExactlyOnceWith(appointment);
  });
});

describe('reassignAppointmentSales', () => {
  afterEach(() => vi.clearAllMocks());

  function mockSalesStaffLookup() {
    mockUserFindOne.mockImplementation(() => ({
      select: vi.fn().mockResolvedValue({ _id: 'sales-1', availabilityStatus: StaffAvailabilityStatus.AVAILABLE }),
    }));
    mockUserFindOne.mockResolvedValueOnce({ _id: 'sales-1', firstName: 'Sam', lastName: 'Cruz' });
  }

  it('confirms a requested office appointment as soon as the agent assigns sales staff', async () => {
    const appointment = createAppointment({
      type: AppointmentType.OFFICE,
      status: AppointmentStatus.REQUESTED,
      slotCode: '09:00',
      salesStaffId: undefined,
    });
    mockAppointmentFindById.mockResolvedValue(appointment);
    mockSalesStaffLookup();

    const result = await reassignAppointmentSales(
      'appointment-1',
      { salesStaffId: 'sales-1' },
      'agent-1',
      [Role.APPOINTMENT_AGENT],
    );

    expect(result.status).toBe(AppointmentStatus.CONFIRMED);
    expect(result.assignedBy).toBe('agent-1');
    expect(result.confirmedBy).toBe('agent-1');
    expect(mockAssertTransition).toHaveBeenCalledExactlyOnceWith(
      AppointmentStatus.REQUESTED,
      AppointmentStatus.CONFIRMED,
    );
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.SALES_ASSIGNED,
    }));
    expect(mockAutoCreateDraft).toHaveBeenCalledTimes(1);
    expect(evaluateSalesAssignmentEligibility).toHaveBeenCalledWith(expect.objectContaining({
      salesStaffId: 'sales-1',
      appointmentId: 'appointment-1',
    }));
    // The customer gets the confirmation they were waiting for, by email too.
    expect(sendAppointmentConfirmedEmail).toHaveBeenCalledExactlyOnceWith('customer@example.test', {
      date: '2026-08-15', time: '9:00 AM', type: 'Office Consultation',
    });
    // An office consultation keeps its title.
    expect(createAndSendNotification).toHaveBeenCalledWith(
      'sales-1', 'appointment', 'New Appointment Assigned', expect.stringContaining('It is now confirmed on your schedule.'), '/appointments/appointment-1',
    );
  });

  it('titles an ocular visit handed to other sales staff "Ocular Visit Assigned" (2026-11-28)', async () => {
    const appointment = createAppointment({
      type: AppointmentType.OCULAR,
      status: AppointmentStatus.CONFIRMED,
      slotCode: '09:00',
      salesStaffId: { toString: () => 'sales-0' },
    });
    mockAppointmentFindById.mockResolvedValue(appointment);
    mockSalesStaffLookup();

    await reassignAppointmentSales('appointment-1', { salesStaffId: 'sales-1', reason: 'Transfer' }, 'agent-1', [Role.APPOINTMENT_AGENT]);

    const notice = vi.mocked(createAndSendNotification).mock.calls.find((call) => call[0] === 'sales-1')!;
    expect(notice.slice(1, 3)).toEqual(['appointment', 'Ocular Visit Assigned']);
    expect(notice[3]).toMatch(/^You were assigned to the ocular visit /);
  });

  it('confirms an older assigned appointment when it is transferred', async () => {
    const appointment = createAppointment({
      type: AppointmentType.OFFICE,
      status: AppointmentStatus.ASSIGNED,
      slotCode: '09:00',
      salesStaffId: { toString: () => 'sales-0' },
    });
    mockAppointmentFindById.mockResolvedValue(appointment);
    mockSalesStaffLookup();

    const result = await reassignAppointmentSales(
      'appointment-1',
      { salesStaffId: 'sales-1', reason: 'Transfer' },
      'agent-1',
      [Role.APPOINTMENT_AGENT],
    );

    expect(result.status).toBe(AppointmentStatus.CONFIRMED);
    expect(mockAssertTransition).toHaveBeenCalledExactlyOnceWith(
      AppointmentStatus.ASSIGNED,
      AppointmentStatus.CONFIRMED,
    );
    expect(mockAutoCreateDraft).toHaveBeenCalledTimes(1);
  });

  it('refuses sales staff who already have an appointment on the same date', async () => {
    const appointment = createAppointment({
      type: AppointmentType.OFFICE,
      status: AppointmentStatus.REQUESTED,
      slotCode: '09:00',
      salesStaffId: undefined,
    });
    mockAppointmentFindById.mockResolvedValue(appointment);
    mockSalesStaffLookup();
    vi.mocked(evaluateSalesAssignmentEligibility).mockResolvedValueOnce({
      assignmentEligible: false,
      assignmentBlockedReason: 'Already has an appointment at this time (9:00 AM, Nov 9, 2026 · APT-20261109-0006)',
    });

    await expect(reassignAppointmentSales(
      'appointment-1',
      { salesStaffId: 'sales-1' },
      'agent-1',
      [Role.APPOINTMENT_AGENT],
    )).rejects.toThrow('Already has an appointment at this time (9:00 AM, Nov 9, 2026 · APT-20261109-0006)');

    expect(appointment.save).not.toHaveBeenCalled();
    expect(mockAutoCreateDraft).not.toHaveBeenCalled();
  });
});

describe('reviewAssignedAppointment', () => {
  afterEach(() => vi.clearAllMocks());

  it('still lets sales staff confirm an older assigned appointment', async () => {
    const appointment = createAppointment({
      type: AppointmentType.OFFICE,
      status: AppointmentStatus.ASSIGNED,
      slotCode: '09:00',
      salesStaffId: { toString: () => 'sales-1' },
    });
    mockAppointmentFindById.mockResolvedValue(appointment);
    mockUserFindOne.mockImplementation(() => ({
      select: vi.fn().mockResolvedValue({ _id: 'sales-1', availabilityStatus: StaffAvailabilityStatus.AVAILABLE }),
    }));

    await reviewAssignedAppointment('appointment-1', { decision: 'accept' }, 'sales-1');

    expect(appointment.status).toBe(AppointmentStatus.CONFIRMED);
    expect(appointment.confirmedBy).toBe('sales-1');
    expect(mockAssertTransition).toHaveBeenCalledWith(AppointmentStatus.ASSIGNED, AppointmentStatus.CONFIRMED);
    expect(mockAutoCreateDraft).toHaveBeenCalledTimes(1);
  });

  it('does not let sales staff decline an assigned appointment', async () => {
    const appointment = createAppointment({
      type: AppointmentType.OFFICE,
      status: AppointmentStatus.ASSIGNED,
      slotCode: '09:00',
      salesStaffId: { toString: () => 'sales-1' },
    });
    mockAppointmentFindById.mockResolvedValue(appointment);

    await expect(reviewAssignedAppointment('appointment-1', { decision: 'decline' } as never, 'sales-1'))
      .rejects.toThrow('can no longer be declined');

    expect(appointment.status).toBe(AppointmentStatus.ASSIGNED);
    expect(appointment.save).not.toHaveBeenCalled();
    expect(mockAutoCreateDraft).not.toHaveBeenCalled();
  });

  it('rejects a review when the appointment is not waiting for acceptance', async () => {
    const appointment = createAppointment({
      type: AppointmentType.OFFICE,
      status: AppointmentStatus.CONFIRMED,
      salesStaffId: { toString: () => 'sales-1' },
    });
    mockAppointmentFindById.mockResolvedValue(appointment);

    await expect(reviewAssignedAppointment('appointment-1', { decision: 'accept' }, 'sales-1'))
      .rejects.toThrow('This appointment is not waiting for your confirmation');
  });
});

describe('getAvailableSlots', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('counts every sales staff an admin has not marked Unavailable or On Leave', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T01:00:00.000Z'));

    const timedInStaff = {
      _id: 'sales-timed-in',
      roles: [Role.SALES_STAFF],
      availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
    };
    // No time-in session at all: available by default now that staff no longer time in.
    const noSessionStaff = {
      _id: 'sales-no-session',
      roles: [Role.SALES_STAFF],
      availabilityStatus: undefined,
    };
    // An admin marked this one unavailable through an open availability session.
    const unavailableSessionStaff = {
      _id: 'sales-unavailable',
      roles: [Role.SALES_STAFF],
      availabilityStatus: undefined,
    };

    mockHolidayFindOne.mockResolvedValue(null);
    mockBlockedSlotExists.mockResolvedValue(false);
    mockUserFind.mockImplementation(() => selectLeanResult([
      timedInStaff,
      noSessionStaff,
      unavailableSessionStaff,
    ]));
    mockAvailabilitySessionFind.mockReturnValue({
      sort: vi.fn().mockResolvedValue([
        {
          _id: { toString: () => 'session-timed-in' },
          userId: { toString: () => 'sales-timed-in' },
          availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
          shiftStartAt: new Date('2026-09-06T00:00:00.000Z'),
        },
        {
          _id: { toString: () => 'session-unavailable' },
          userId: { toString: () => 'sales-unavailable' },
          availabilityStatus: StaffAvailabilityStatus.UNAVAILABLE,
          shiftStartAt: new Date('2026-09-06T00:00:00.000Z'),
        },
      ]),
    });
    mockSalesAvailabilityFind.mockImplementation(() => selectLeanResult([]));
    mockAppointmentFind.mockImplementation(() => selectLeanResult([]));

    const result = await getAvailableSlots({
      date: '2026-09-10',
      type: AppointmentType.OFFICE,
    });

    expect(result.slots).toHaveLength(7);
    expect(result.slots.every((slot) => slot.available && slot.remaining === 2)).toBe(true);
    expect(mockUserFind).toHaveBeenCalledWith({
      roles: Role.SALES_STAFF,
      isActive: true,
      availabilityStatus: { $nin: [StaffAvailabilityStatus.UNAVAILABLE, StaffAvailabilityStatus.ON_LEAVE] },
    });
  });

  it('keeps staff with a missing or ended shift in the slot count', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T01:00:00.000Z'));

    const activeStaff = {
      _id: 'sales-active',
      roles: [Role.SALES_STAFF],
      availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
    };
    const noShiftStaff = {
      _id: 'sales-no-shift',
      roles: [Role.SALES_STAFF],
      availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
    };
    const endedShiftStaff = {
      _id: 'sales-ended-shift',
      roles: [Role.SALES_STAFF],
      availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
    };

    mockHolidayFindOne.mockResolvedValue(null);
    mockBlockedSlotExists.mockResolvedValue(false);
    mockUserFind.mockImplementation(() => selectLeanResult([
      activeStaff,
      noShiftStaff,
      endedShiftStaff,
    ]));
    mockAvailabilitySessionFind.mockReturnValue({
      sort: vi.fn().mockResolvedValue([
        {
          _id: { toString: () => 'session-active' },
          userId: { toString: () => 'sales-active' },
          availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
          shiftStartAt: new Date('2026-09-06T00:00:00.000Z'),
          shiftEndAt: new Date('2026-09-07T00:00:00.000Z'),
          closedAt: undefined,
        },
        {
          _id: { toString: () => 'session-no-shift' },
          userId: { toString: () => 'sales-no-shift' },
          availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
          shiftStartAt: undefined,
          shiftEndAt: undefined,
          closedAt: undefined,
        },
        {
          _id: { toString: () => 'session-ended' },
          userId: { toString: () => 'sales-ended-shift' },
          availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
          shiftStartAt: new Date('2026-09-05T00:00:00.000Z'),
          shiftEndAt: new Date('2026-09-05T12:00:00.000Z'),
          closedAt: undefined,
        },
      ]),
    });
    mockSalesAvailabilityFind.mockImplementation(() => selectLeanResult([]));
    mockAppointmentFind.mockImplementation(() => selectLeanResult([]));

    const result = await getAvailableSlots({
      date: '2026-09-10',
      type: AppointmentType.OFFICE,
    });

    expect(result.slots.every((slot) => slot.available && slot.remaining === 3)).toBe(true);
  });
});

describe('ocularArrivalEstimate (On The Way notification)', () => {
  // 8:20 AM in Manila.
  const now = new Date('2026-09-10T00:20:00.000Z');

  it('gives the rounded drive time up to that plus 1 hr of traffic for a far site', () => {
    // 45 min drive → 1 hr; + 1 hr traffic → 2 hr.
    expect(ocularArrivalEstimate({ type: AppointmentType.OCULAR, travelDurationMinutes: 45, distanceKm: 18 }, now))
      .toBe(' Estimated arrival: around 9:20–10:20 AM.');
    // Left 10:30 AM.
    expect(ocularArrivalEstimate({ type: AppointmentType.OCULAR, travelDurationMinutes: 45, distanceKm: 18 }, new Date('2026-09-10T02:30:00.000Z')))
      .toBe(' Estimated arrival: around 11:30 AM–12:30 PM.');
  });

  it('gives a single time for a site near the shop, and nothing without a route or for a consultation', () => {
    // 10 min drive → 30 min, no traffic allowance within 4 km.
    expect(ocularArrivalEstimate({ type: AppointmentType.OCULAR, travelDurationMinutes: 10, distanceKm: 3 }, now))
      .toBe(' Estimated arrival: around 8:50 AM.');
    expect(ocularArrivalEstimate({ type: AppointmentType.OCULAR }, now)).toBe('');
    expect(ocularArrivalEstimate({ type: AppointmentType.OFFICE, travelDurationMinutes: 10, distanceKm: 3 }, now)).toBe('');
  });
});

describe('assertOcularWindowFree (a new site pin on a scheduled ocular visit)', () => {
  afterEach(() => vi.clearAllMocks());

  const ocular = { _id: 'ocular-1', type: AppointmentType.OCULAR, salesStaffId: 'sales-a', date: '2026-09-10', slotCode: '13:00' };

  it('rejects a farther site that would run into the staff member’s next appointment', async () => {
    mockAppointmentFind.mockImplementation(() => selectLeanResult([
      { appointmentNumber: 'APT-1', slotCode: '15:00', type: AppointmentType.OFFICE, status: AppointmentStatus.CONFIRMED },
    ]));

    await expect(assertOcularWindowFree(ocular, { travelDurationMinutes: 45, distanceKm: 18 }))
      .rejects.toThrow('the visit would keep the sales staff away 10:45 AM–4:30 PM, which runs into their 3:00 PM appointment (APT-1)');
    expect(mockAppointmentFind).toHaveBeenCalledWith(expect.objectContaining({
      salesStaffId: 'sales-a', date: '2026-09-10', _id: { $ne: 'ocular-1' },
    }));
  });

  it('accepts a site near the shop that still fits before the next appointment', async () => {
    mockAppointmentFind.mockImplementation(() => selectLeanResult([
      { appointmentNumber: 'APT-1', slotCode: '15:00', type: AppointmentType.OFFICE, status: AppointmentStatus.CONFIRMED },
    ]));

    // 10 min (rounded to 30), 3 km: away 12:15 (15 min prep) – 3:00 PM.
    await expect(assertOcularWindowFree(ocular, { travelDurationMinutes: 10, distanceKm: 3 })).resolves.toBeUndefined();
  });

  it('skips an ocular visit with no sales staff yet', async () => {
    await expect(assertOcularWindowFree({ ...ocular, salesStaffId: undefined }, { travelDurationMinutes: 45, distanceKm: 18 }))
      .resolves.toBeUndefined();
    expect(mockAppointmentFind).not.toHaveBeenCalled();
  });
});

describe('sales staff availability per time slot', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function twoAvailableStaff() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T01:00:00.000Z'));
    mockHolidayFindOne.mockResolvedValue(null);
    mockBlockedSlotExists.mockResolvedValue(false);
    mockUserFind.mockImplementation(() => selectLeanResult([
      { _id: 'sales-a', roles: [Role.SALES_STAFF], availabilityStatus: StaffAvailabilityStatus.AVAILABLE },
      { _id: 'sales-b', roles: [Role.SALES_STAFF], availabilityStatus: StaffAvailabilityStatus.AVAILABLE },
    ]));
    mockAvailabilitySessionFind.mockReturnValue({ sort: vi.fn().mockResolvedValue([]) });
    mockSalesAvailabilityFind.mockImplementation(() => selectLeanResult([]));
  }

  const slotByCode = (slots: Array<{ slotCode: string; available: boolean; remaining: number }>, code: string) =>
    slots.find((slot) => slot.slotCode === code)!;

  it('offers only upcoming slots for customer self-booking shortly before the cutoff', async () => {
    twoAvailableStaff();
    vi.setSystemTime(new Date('2026-11-27T15:59:59+08:00'));
    mockAppointmentFind.mockImplementation(() => selectLeanResult([]));

    const result = await getAvailableSlots({ date: '2026-11-27', type: AppointmentType.OFFICE, flow: 'customer_booking' });

    expect(result.slots.filter((slot) => slot.available).map((slot) => slot.slotCode)).toEqual(['16:00']);
    expect(slotByCode(result.slots, '15:00')).toMatchObject({ available: false, remaining: 0 });
  });

  it('closes today for customer self-booking at 4 PM while leaving tomorrow bookable', async () => {
    twoAvailableStaff();
    vi.setSystemTime(new Date('2026-11-27T16:00:00+08:00'));
    mockAppointmentFind.mockImplementation(() => selectLeanResult([]));

    const query = { date: '2026-11-27', type: AppointmentType.OFFICE, flow: 'customer_booking' } as const;
    await expect(getAvailableSlots(query)).rejects.toMatchObject({ code: 'BOOKING_TIME_UNAVAILABLE' });
    const tomorrow = await getAvailableSlots({ ...query, date: '2026-11-28' });
    expect(slotByCode(tomorrow.slots, '09:00')).toMatchObject({ available: true, remaining: 2 });
  });

  it('marks the customer own reserved slot unavailable even when other staff are free', async () => {
    twoAvailableStaff();
    vi.setSystemTime(new Date('2026-11-26T20:00:00+08:00'));
    mockAppointmentFind.mockImplementation(() => selectLeanResult([]));
    const booking = { appointmentId: 'appt-1', appointmentNumber: 'APT-20261127-0001', type: 'office', date: '2026-11-27', slotCode: '09:00', status: 'confirmed', salesStaffAssigned: true };
    mockGetCustomerBookedSlots.mockResolvedValueOnce(new Map([['09:00', booking]]));

    const result = await getAvailableSlots({ date: '2026-11-27', type: AppointmentType.OFFICE, flow: 'customer_booking' }, 'customer-1');
    expect(mockGetCustomerBookedSlots).toHaveBeenCalledExactlyOnceWith('customer-1', '2026-11-27', expect.arrayContaining(['09:00', '10:00']));
    expect(slotByCode(result.slots, '09:00')).toMatchObject({ customerBooked: true, available: false, remaining: 0, customerBooking: booking });
    expect(slotByCode(result.slots, '10:00')).toMatchObject({ available: true, remaining: 2 });
  });

  it('retains advance booking for shared slots outside customer office self-booking', async () => {
    twoAvailableStaff();
    vi.setSystemTime(new Date('2026-11-26T08:00:00+08:00'));
    const date = '2026-11-26';

    await expect(getAvailableSlots({ date, type: AppointmentType.OFFICE })).rejects.toThrow('in advance');
    await expect(getAvailableSlots({ date, type: AppointmentType.OCULAR, flow: 'customer_booking' })).rejects.toThrow('in advance');
  });

  it('takes a staff member out of only the slot of their consultation, not the whole day', async () => {
    twoAvailableStaff();
    // sales-a has an office consultation at 14:00 that day.
    mockAppointmentFind.mockImplementation(() => selectLeanResult([{ salesStaffId: 'sales-a', slotCode: '14:00', type: AppointmentType.OFFICE }]));

    const result = await getAvailableSlots({ date: '2026-09-10', type: AppointmentType.OFFICE });

    expect(slotByCode(result.slots, '14:00')).toMatchObject({ available: true, remaining: 1 });
    expect(result.slots.filter((slot) => slot.slotCode !== '14:00')
      .every((slot) => slot.available && slot.remaining === 2)).toBe(true);
    // Cancelled and no-show appointments never take a slot; a completed one only until its time has passed.
    expect(mockAppointmentFind).toHaveBeenCalledWith(expect.objectContaining({
      date: '2026-09-10',
      status: { $nin: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] },
    }));
  });

  // User decision 2026-11-27 ("kung declined or completed dapat balik na to sa vacant"): a consultation
  // closed early gives its staff back; a completed ocular still holds its staff until the trip back.
  it('frees the staff of a consultation completed early; a completed ocular keeps its staff away until back', async () => {
    twoAvailableStaff();
    // "Now" is Sep 6; the 2 PM consultation on Sep 10 was already closed (e.g. Customer Declined).
    mockAppointmentFind.mockImplementation(() => selectLeanResult([
      { salesStaffId: 'sales-a', date: '2026-09-10', slotCode: '14:00', type: AppointmentType.OFFICE, status: AppointmentStatus.COMPLETED },
    ]));
    expect(slotByCode((await getAvailableSlots({ date: '2026-09-10', type: AppointmentType.OFFICE })).slots, '14:00'))
      .toMatchObject({ available: true, remaining: 2 });

    mockAppointmentFind.mockImplementation(() => selectLeanResult([
      { salesStaffId: 'sales-a', date: '2026-09-10', slotCode: '14:00', type: AppointmentType.OCULAR, status: AppointmentStatus.COMPLETED, travelDurationMinutes: 45, distanceKm: 18 },
    ]));
    expect(slotByCode((await getAvailableSlots({ date: '2026-09-10', type: AppointmentType.OFFICE })).slots, '14:00'))
      .toMatchObject({ available: true, remaining: 1 });
  });

  it('takes a staff member with an ocular visit out of every consultation slot that day', async () => {
    twoAvailableStaff();
    // sales-a has an ocular visit at 14:00: travel to the site and back takes the whole day.
    mockAppointmentFind.mockImplementation(() => selectLeanResult([{ salesStaffId: 'sales-a', slotCode: '14:00', type: AppointmentType.OCULAR }]));

    const result = await getAvailableSlots({ date: '2026-09-10', type: AppointmentType.OFFICE });

    expect(result.slots.every((slot) => slot.available && slot.remaining === 1)).toBe(true);
  });

  it('with a pinned site, takes a staff member out only while away for the ocular visit', async () => {
    twoAvailableStaff();
    // sales-a has a 1 PM ocular visit, 45 min drive (→ 1 hr), 18 km: busy 10:45 AM (15 min prep) – 4:30 PM (1 hr traffic each way).
    mockAppointmentFind.mockImplementation(() => selectLeanResult([
      { salesStaffId: 'sales-a', slotCode: '13:00', type: AppointmentType.OCULAR, travelDurationMinutes: 45, distanceKm: 18 },
    ]));

    const result = await getAvailableSlots({ date: '2026-09-10', type: AppointmentType.OFFICE });

    // The 10:00 consultation would run until 11:00, into the 10:45 prep.
    for (const code of ['10:00', '11:00', '13:00', '14:00', '15:00', '16:00']) expect(slotByCode(result.slots, code).remaining).toBe(1);
    expect(slotByCode(result.slots, '09:00').remaining).toBe(2);
  });

  it('offers a pinned ocular visit wherever its travel time and site visit fit around a consultation', async () => {
    twoAvailableStaff();
    // sales-a has a 9:00 consultation. A new 45 min / 18 km ocular visit needs 1.5 hr + 1 hr drive + 1 hr traffic each way.
    mockAppointmentFind.mockImplementation(() => selectLeanResult([{ salesStaffId: 'sales-a', slotCode: '09:00', type: AppointmentType.OFFICE }]));

    // Query strings, as the route sends them.
    const result = await getAvailableSlots({
      date: '2026-09-10', type: AppointmentType.OCULAR, travelMinutes: '45', distanceKm: '18',
    } as never);

    // Leaving at 9:00 for an 11:00 visit still clashes with the 9:00–10:00 consultation.
    for (const code of ['09:00', '10:00', '11:00']) expect(slotByCode(result.slots, code).remaining).toBe(1);
    for (const code of ['13:00', '14:00', '15:00', '16:00']) expect(slotByCode(result.slots, code).remaining).toBe(2);
  });

  it('offers an ocular visit only with staff whose whole day is free', async () => {
    twoAvailableStaff();
    // sales-a has a 9:00 consultation; only sales-b is free for an ocular visit at any time.
    mockAppointmentFind.mockImplementation(() => selectLeanResult([{ salesStaffId: 'sales-a', slotCode: '09:00', type: AppointmentType.OFFICE }]));

    const result = await getAvailableSlots({ date: '2026-09-10', type: AppointmentType.OCULAR });

    expect(result.slots.every((slot) => slot.available && slot.remaining === 1)).toBe(true);
  });

  it('closes the ocular day when every staff member has something that day', async () => {
    twoAvailableStaff();
    mockAppointmentFind.mockImplementation(() => selectLeanResult([
      { salesStaffId: 'sales-a', slotCode: '09:00', type: AppointmentType.OFFICE },
      { salesStaffId: 'sales-b', slotCode: '16:00', type: AppointmentType.OFFICE },
    ]));

    const result = await getAvailableSlots({ date: '2026-09-10', type: AppointmentType.OCULAR });

    expect(result.slots.every((slot) => !slot.available && slot.remaining === 0)).toBe(true);
    // A consultation can still go into a slot neither of them holds.
    const office = await getAvailableSlots({ date: '2026-09-10', type: AppointmentType.OFFICE });
    expect(slotByCode(office.slots, '11:00')).toMatchObject({ available: true, remaining: 2 });
  });

  it('lets unassigned consultations in different slots share one staff member when counting an ocular day', async () => {
    twoAvailableStaff();
    mockAppointmentFind.mockImplementation(() => selectLeanResult([
      { salesStaffId: undefined, slotCode: '09:00', type: AppointmentType.OFFICE },
      { salesStaffId: undefined, slotCode: '10:00', type: AppointmentType.OFFICE },
    ]));

    const result = await getAvailableSlots({ date: '2026-09-10', type: AppointmentType.OCULAR });
    expect(result.slots.every((slot) => slot.remaining === 1)).toBe(true);

    // An unassigned ocular request needs a whole staff member of its own.
    mockAppointmentFind.mockImplementation(() => selectLeanResult([
      { salesStaffId: undefined, slotCode: '09:00', type: AppointmentType.OFFICE },
      { salesStaffId: undefined, slotCode: '13:00', type: AppointmentType.OCULAR },
    ]));
    const withOcularRequest = await getAvailableSlots({ date: '2026-09-10', type: AppointmentType.OCULAR });
    expect(withOcularRequest.slots.every((slot) => slot.remaining === 0)).toBe(true);
  });

  it('keeps the next slot open for a staff member booked 9:00–10:00 (same date, different slot)', async () => {
    twoAvailableStaff();
    mockUserFind.mockImplementation(() => selectLeanResult([
      { _id: 'sales-a', roles: [Role.SALES_STAFF], availabilityStatus: StaffAvailabilityStatus.AVAILABLE },
    ]));
    mockAppointmentFind.mockImplementation(() => selectLeanResult([{ salesStaffId: 'sales-a', slotCode: '09:00' }]));

    const result = await getAvailableSlots({ date: '2026-11-14', type: AppointmentType.OFFICE, salesStaffId: 'sales-a' });

    expect(slotByCode(result.slots, '09:00')).toMatchObject({ available: false, remaining: 0 });
    expect(slotByCode(result.slots, '10:00')).toMatchObject({ available: true, remaining: 1 });
  });

  it('closes a slot for customers once every staff member is taken or awaited in it', async () => {
    twoAvailableStaff();
    // At 10:00, sales-a is booked and one request is still waiting for a staff member.
    mockAppointmentFind.mockImplementation(() => selectLeanResult([
      { salesStaffId: 'sales-a', slotCode: '10:00' },
      { salesStaffId: undefined, slotCode: '10:00' },
    ]));

    const result = await getAvailableSlots({ date: '2026-09-10', type: AppointmentType.OFFICE });

    expect(slotByCode(result.slots, '10:00')).toMatchObject({ available: false, remaining: 0 });
    expect(slotByCode(result.slots, '11:00')).toMatchObject({ available: true, remaining: 2 });
  });

  it("shows only the given sales staff member's own free slots", async () => {
    twoAvailableStaff();
    mockUserFind.mockImplementation(() => selectLeanResult([
      { _id: 'sales-b', roles: [Role.SALES_STAFF], availabilityStatus: StaffAvailabilityStatus.AVAILABLE },
    ]));
    // An unassigned request does not take sales-b's own slot.
    mockAppointmentFind.mockImplementation(() => selectLeanResult([{ salesStaffId: undefined, slotCode: '09:00' }]));

    const result = await getAvailableSlots({ date: '2026-09-10', type: AppointmentType.OCULAR, salesStaffId: 'sales-b' });

    expect(mockUserFind).toHaveBeenCalledWith(expect.objectContaining({ _id: 'sales-b' }));
    expect(result.slots.every((slot) => slot.available && slot.remaining === 1)).toBe(true);
  });

  it('rejects an ocular visit at a time that is not a real slot', async () => {
    await expect(assertConsultationOcularSchedule({
      customerId: 'customer-1', salesStaffId: 'sales-1', date: '2026-10-08', slotCode: '09:30',
      consultationAppointmentId: 'consult-1',
    })).rejects.toThrow('Choose a valid ocular visit time.');
  });

  it("never lets the source consultation or the moved ocular visit block itself, nor the customer's other active appointment", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T01:00:00Z'));
    mockAppointmentFindOne.mockResolvedValue({ _id: 'other-1', status: AppointmentStatus.CONFIRMED });
    mockHolidayFindOne.mockResolvedValue(null);
    // Stops at the slot check, which runs after every customer check.
    mockBlockedSlotExists.mockResolvedValueOnce(true);

    await expect(assertConsultationOcularSchedule({
      customerId: 'customer-1', salesStaffId: 'sales-1', date: '2026-10-08', slotCode: '09:00',
      consultationAppointmentId: 'consult-1', existingOcularId: 'ocular-1',
    })).rejects.toThrow('blocked by an administrator');
    expect(mockAppointmentFind).not.toHaveBeenCalledWith(expect.objectContaining({ customerId: 'customer-1' }));
    expect(mockAssertCustomerScheduleFree).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      excludeAppointmentIds: ['consult-1', 'ocular-1'],
    }));
  });
});

describe('customer consultation queue', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('returns the customer position, active ticket, and estimated wait', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T03:00:00.000Z'));
    const appointment = createAppointment({
      attendanceStatus: AppointmentAttendanceStatus.ON_TIME,
      queueDate: '2026-09-17',
      queueSequence: 3,
      queueNumber: 'Q-003',
      queueIssuedAt: new Date('2026-09-17T02:50:00.000Z'),
      attendanceUpdatedAt: new Date('2026-09-17T02:50:00.000Z'),
    });
    mockAppointmentFindOne
      .mockReturnValueOnce({ sort: vi.fn().mockResolvedValue(appointment) })
      .mockReturnValueOnce({
        sort: vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue({ queueNumber: 'Q-001' }),
        }),
      });
    mockAppointmentCountDocuments.mockResolvedValueOnce(2);

    await expect(getCustomerQueueStatus('customer-1')).resolves.toEqual(
      expect.objectContaining({
        appointmentId: 'appointment-1',
        queueNumber: 'Q-003',
        status: 'waiting',
        position: 3,
        aheadCount: 2,
        nowServing: 'Q-001',
        estimatedWaitMinutes: 60,
      }),
    );
  });
});

describe('requestAppointment', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /** Booking on Aug 24, 2026 by a customer who holds `activeAppointments` (the first find: the cap). */
  function mockActiveAppointments(activeAppointments: Array<{ appointmentNumber: string }>) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));
    mockAppointmentFind.mockReturnValueOnce(selectLeanResult(activeAppointments));
  }

  /** A free 9:00 AM office slot on Sep 1, 2026, booked by a customer who holds `activeAppointments`. */
  function mockBookableOfficeSlot(activeAppointments: Array<{ appointmentNumber: string }> = [], checkBlocked = async () => false) {
    mockActiveAppointments(activeAppointments);
    mockHolidayFindOne.mockResolvedValueOnce(null);
    mockBlockedSlotExists.mockImplementationOnce(checkBlocked);
    mockUserFind.mockReturnValueOnce(selectLeanResult([{
      _id: 'sales-1',
      roles: [Role.SALES_STAFF],
      availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
    }]));
    mockAvailabilitySessionFind.mockReturnValueOnce({
      sort: vi.fn().mockResolvedValue([{
        _id: { toString: () => 'session-sales-1' },
        userId: { toString: () => 'sales-1' },
        availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
        shiftStartAt: new Date('2026-08-24T00:00:00.000Z'),
      }]),
    });
    mockSalesAvailabilityFind.mockReturnValueOnce(selectLeanResult([]));
    mockAppointmentFind.mockReturnValueOnce(selectLeanResult([]));
    mockAppointmentCreate.mockImplementationOnce(async (payload) => ({
      _id: 'appointment-new',
      ...payload,
    }));
    mockAuditCreate.mockResolvedValueOnce({});
    mockNotifyRole.mockResolvedValueOnce(undefined);
  }

  const officeRequest = {
    type: AppointmentType.OFFICE,
    date: '2026-09-01',
    slotCode: '09:00',
    serviceTypes: [ServiceType.RAILINGS],
  } as Parameters<typeof requestAppointment>[0];

  it('accepts a same-day 4 PM request just before the Manila cutoff', async () => {
    mockBookableOfficeSlot();
    vi.setSystemTime(new Date('2026-11-27T15:59:59+08:00'));

    await expect(requestAppointment({ ...officeRequest, date: '2026-11-27', slotCode: '16:00' }, 'customer-1', [Role.CUSTOMER]))
      .resolves.toMatchObject({ date: '2026-11-27', slotCode: '16:00', status: AppointmentStatus.REQUESTED });
  });

  it.each([
    ['09:00:00', '09:00'],
    ['16:00:00', '16:00'],
  ] as const)('rejects a stale booking at %s Manila time for %s', async (now, slotCode) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`2026-11-27T${now}+08:00`));

    await expect(requestAppointment({ ...officeRequest, date: '2026-11-27', slotCode }, 'customer-1', [Role.CUSTOMER]))
      .rejects.toMatchObject({ code: 'BOOKING_TIME_UNAVAILABLE' });
    expect(mockAppointmentCreate).not.toHaveBeenCalled();
  });

  it('rechecks the cutoff if the booking becomes stale while capacity is being checked', async () => {
    mockBookableOfficeSlot([], async () => {
      vi.setSystemTime(new Date('2026-11-27T16:00:00+08:00'));
      return false;
    });
    vi.setSystemTime(new Date('2026-11-27T15:59:59+08:00'));

    await expect(requestAppointment({ ...officeRequest, date: '2026-11-27', slotCode: '16:00' }, 'customer-1', [Role.CUSTOMER]))
      .rejects.toMatchObject({ code: 'BOOKING_TIME_UNAVAILABLE' });
    expect(mockAppointmentCreate).not.toHaveBeenCalled();
    mockAppointmentCreate.mockReset();
    mockAuditCreate.mockReset();
    mockNotifyRole.mockReset();
  });

  it('books another appointment while the customer already holds 2 active ones (each at its own date and time)', async () => {
    mockBookableOfficeSlot([{ appointmentNumber: 'APT-20261126-0001' }, { appointmentNumber: 'APT-20261127-0001' }]);

    await requestAppointment(officeRequest, 'customer-1', [Role.CUSTOMER]);

    expect(mockAppointmentFind).toHaveBeenNthCalledWith(1, {
      customerId: 'customer-1',
      status: { $in: expect.arrayContaining([AppointmentStatus.REQUESTED, AppointmentStatus.ON_THE_WAY, AppointmentStatus.IN_PROGRESS]) },
    });
    // Only an overlapping time blocks the customer.
    expect(mockAssertCustomerScheduleFree).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1', date: '2026-09-01', slotCode: '09:00',
    }));
    expect(mockAppointmentCreate).toHaveBeenCalledOnce();
  });

  it('rejects a 4th booking while the customer holds 3 active appointments', async () => {
    mockActiveAppointments([
      { appointmentNumber: 'APT-20261126-0001' },
      { appointmentNumber: 'APT-20261127-0001' },
      { appointmentNumber: 'APT-20261128-0001' },
    ]);

    await expect(requestAppointment(officeRequest, 'customer-1', [Role.CUSTOMER])).rejects.toMatchObject({
      code: 'ACTIVE_APPOINTMENT_LIMIT',
      message: 'You already have 3 active appointments (APT-20261126-0001, APT-20261127-0001, APT-20261128-0001). Please complete or cancel one before booking another.',
      details: expect.objectContaining({ activeAppointmentLimit: 3, activeAppointmentCount: 3 }),
    });
    expect(mockAppointmentCreate).not.toHaveBeenCalled();
    expect(mockAssertCustomerScheduleFree).not.toHaveBeenCalled();
  });

  it('persists multiple selected designs and keeps the first as the legacy snapshot', async () => {
    mockBookableOfficeSlot();

    await requestAppointment(
      {
        type: AppointmentType.OFFICE,
        date: '2026-09-01',
        slotCode: '09:00',
        serviceTypes: [ServiceType.RAILINGS, ServiceType.GATES],
        selectedDesignTemplates: [
          {
            id: 'railings-commercial-guardrail',
            name: 'Commercial Stainless Guardrail',
            imageUrl: '/landing/services/railings/guardrail.png',
            serviceId: 'railings',
            serviceLabel: 'Railings',
            serviceType: ServiceType.RAILINGS,
          },
          {
            id: 'gates-double-swing',
            name: 'Double Swing Gate',
            imageUrl: '/landing/services/gates/double-swing.png',
            serviceId: 'gates',
            serviceLabel: 'Gates',
            serviceType: ServiceType.GATES,
          },
        ],
      },
      'customer-1',
      [Role.CUSTOMER],
    );

    expect(mockAppointmentCreate).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      selectedDesignTemplateId: 'railings-commercial-guardrail',
      selectedDesignTemplateName: 'Commercial Stainless Guardrail',
      selectedDesignTemplateImageUrl: '/landing/services/railings/guardrail.png',
      selectedDesignTemplates: expect.arrayContaining([
        expect.objectContaining({ id: 'railings-commercial-guardrail' }),
        expect.objectContaining({ id: 'gates-double-swing' }),
      ]),
    }));
    // The request goes to the agents; the customer is told it is received and not yet confirmed.
    expect(mockAppointmentCreate).toHaveBeenCalledWith(expect.objectContaining({ status: AppointmentStatus.REQUESTED }));
    expect(mockNotifyRole).toHaveBeenCalledWith(Role.APPOINTMENT_AGENT, expect.anything(), 'New Appointment Request', expect.any(String), '/appointments/appointment-new');
    expect(sendAppointmentRequestedEmail).toHaveBeenCalledExactlyOnceWith('customer@example.test', {
      date: '2026-09-01', time: '9:00 AM', type: 'Office Consultation',
    });
    expect(sendAppointmentConfirmedEmail).not.toHaveBeenCalled();
  });
});

describe('requestReschedule', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function mockAvailableSlot() {
    mockHolidayFindOne.mockResolvedValueOnce(null);
    mockBlockedSlotExists.mockResolvedValueOnce(false);
    mockUserFind.mockReturnValueOnce(selectLeanResult([{
      _id: 'sales-1',
      roles: [Role.SALES_STAFF],
      availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
    }]));
    mockAvailabilitySessionFind.mockReturnValueOnce({
      sort: vi.fn().mockResolvedValue([{
        _id: { toString: () => 'session-sales-1' },
        userId: { toString: () => 'sales-1' },
        availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
        shiftStartAt: new Date('2026-08-24T00:00:00.000Z'),
      }]),
    });
    mockSalesAvailabilityFind.mockReturnValueOnce(selectLeanResult([]));
    mockAppointmentFind.mockReturnValueOnce(selectLeanResult([]));
  }

  it('applies an agent-initiated reschedule immediately without a pending/agent-review status', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));

    const appointment = createAppointment({
      status: AppointmentStatus.REQUESTED,
      type: AppointmentType.OFFICE,
      salesStaffId: undefined,
    });
    mockAppointmentFindById.mockResolvedValueOnce(appointment);
    mockAvailableSlot();
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await requestReschedule(
      'appointment-1',
      { reason: 'Need a later schedule', newDate: '2026-09-01', newSlotCode: '09:00' },
      'agent-1',
      [Role.APPOINTMENT_AGENT],
      '127.0.0.1',
      'vitest-agent',
    );

    expect(mockAssertTransition).not.toHaveBeenCalled();
    expect(appointment.status).toBe(AppointmentStatus.REQUESTED);
    expect(appointment.date).toBe('2026-09-01');
    expect(appointment.slotCode).toBe('09:00');
    expect(appointment.rescheduleReason).toBe('Need a later schedule');
    expect(appointment.save).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.APPOINTMENT_RESCHEDULED,
        actorId: 'agent-1',
      }),
    );
    expect(result).toBe(appointment);
  });

  it('lets an admin reschedule a confirmed appointment and keeps its assigned sales staff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));

    const appointment = createAppointment({
      status: AppointmentStatus.CONFIRMED,
      type: AppointmentType.OFFICE,
      salesStaffId: { toString: () => 'sales-1' },
    });
    mockAppointmentFindById.mockResolvedValueOnce(appointment);
    mockAvailableSlot();
    mockUserFindOne.mockReturnValueOnce({
      select: vi.fn().mockResolvedValue({ _id: 'sales-1', availabilityStatus: StaffAvailabilityStatus.AVAILABLE }),
    });
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await requestReschedule(
      'appointment-1',
      { reason: 'Staff conflict', newDate: '2026-09-01', newSlotCode: '09:00' },
      'admin-1',
      [Role.ADMIN],
    );

    expect(result.status).toBe(AppointmentStatus.CONFIRMED);
    expect(result.date).toBe('2026-09-01');
    expect(result.salesStaffId).toEqual({ toString: expect.any(Function) });
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.APPOINTMENT_RESCHEDULED, actorId: 'admin-1' }),
    );
  });

  it('tells the booking agent when someone else reschedules, never the person who rescheduled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));
    const appointment = createAppointment({
      status: AppointmentStatus.CONFIRMED,
      type: AppointmentType.OFFICE,
      appointmentNumber: 'APT-20260815-0001',
      salesStaffId: undefined,
    });
    mockAppointmentFindById.mockResolvedValueOnce(appointment);
    mockAvailableSlot();
    mockAuditCreate.mockResolvedValueOnce({});
    mockUserFindById.mockReturnValueOnce({
      select: () => ({ lean: async () => ({ firstName: 'Alice', lastName: 'Admin' }) }),
    });

    await requestReschedule(
      'appointment-1',
      { reason: 'Staff conflict', newDate: '2026-09-01', newSlotCode: '09:00' },
      'admin-1',
      [Role.ADMIN],
    );

    expect(notifyBookingAgents).toHaveBeenCalledExactlyOnceWith(
      appointment,
      'appointment',
      'Appointment Rescheduled',
      expect.stringMatching(/^APT-20260815-0001 was rescheduled from 2026-08-15 at .+ to 2026-09-01 at .+ by Alice Admin\. Reason: Staff conflict$/),
      '/appointments/appointment-1',
      'admin-1',
    );
  });

  it("checks the customer's other appointments at the new time, never the appointment being moved", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));
    const appointment = createAppointment({ status: AppointmentStatus.REQUESTED, type: AppointmentType.OCULAR, salesStaffId: undefined });
    mockAppointmentFindById.mockResolvedValueOnce(appointment);
    mockAvailableSlot();
    mockAuditCreate.mockResolvedValueOnce({});

    await requestReschedule(
      'appointment-1',
      { reason: 'Customer asked', newDate: '2026-09-01', newSlotCode: '09:00' },
      'agent-1',
      [Role.APPOINTMENT_AGENT],
    );

    expect(mockAssertCustomerScheduleFree).toHaveBeenCalledExactlyOnceWith({
      customerId: 'customer-1',
      date: '2026-09-01',
      slotCode: '09:00',
      incomingType: AppointmentType.OCULAR,
      excludeAppointmentIds: ['appointment-1'],
      audience: 'staff',
    });
  });

  it('keeps the appointment where it is when the new time overlaps another appointment of the customer', async () => {
    const appointment = createAppointment({ status: AppointmentStatus.CONFIRMED, type: AppointmentType.OFFICE, slotCode: '10:00' });
    mockAppointmentFindById.mockResolvedValueOnce(appointment);
    mockAssertCustomerScheduleFree.mockRejectedValueOnce(new Error('This customer already has an ocular visit on Sep 1, 2026'));

    await expect(requestReschedule(
      'appointment-1',
      { reason: 'Customer asked', newDate: '2026-09-01', newSlotCode: '09:00' },
      'agent-1',
      [Role.APPOINTMENT_AGENT],
    )).rejects.toThrow('This customer already has an ocular visit on Sep 1, 2026');

    expect(appointment.date).toBe('2026-08-15');
    expect(appointment.slotCode).toBe('10:00');
    expect(appointment.save).not.toHaveBeenCalled();
  });

  it('rejects reschedule attempts from the customer or the assigned sales staff', async () => {
    const appointment = createAppointment({
      status: AppointmentStatus.CONFIRMED,
      type: AppointmentType.OFFICE,
      salesStaffId: { toString: () => 'sales-1' },
    });
    mockAppointmentFindById.mockResolvedValue(appointment);

    await expect(requestReschedule(
      'appointment-1',
      { reason: 'Staff conflict', newDate: '2026-09-01', newSlotCode: '09:00' },
      'sales-1',
      [Role.SALES_STAFF],
    )).rejects.toThrow('Only an appointment agent or admin can reschedule this appointment');

    await expect(requestReschedule(
      'appointment-1',
      { reason: 'Need a later schedule', newDate: '2026-09-01', newSlotCode: '09:00' },
      'customer-1',
      [Role.CUSTOMER],
    )).rejects.toThrow('Only an appointment agent or admin can reschedule this appointment');
  });
});

describe('submitSiteDetails', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('accepts details after confirmation and refreshes the consultation draft', async () => {
    const appointment = createAppointment({
      type: AppointmentType.OFFICE,
      status: AppointmentStatus.CONFIRMED,
      siteDetailsStatus: 'pending',
      serviceTypes: [ServiceType.CUSTOM],
      serviceTypeCustom: 'Custom food cart',
      salesStaffId: 'sales-1',
      slotCode: '09:00',
    });
    mockAppointmentFindById.mockResolvedValueOnce(appointment);
    mockNotifyRole.mockResolvedValueOnce(undefined);
    mockAutoCreateDraft.mockResolvedValueOnce({});

    const input = {
      serviceTypes: [ServiceType.CUSTOM],
      serviceTypeCustom: 'Custom food cart',
      customerRequirements: 'Mobile stainless cart with two shelves',
    };

    await submitSiteDetails('appointment-1', input, 'customer-1');

    expect(appointment.siteDetailsStatus).toBe('submitted');
    expect(appointment.customerSiteDetails).toEqual(input);
    expect(appointment.save).toHaveBeenCalledTimes(1);
    expect(mockAutoCreateDraft).toHaveBeenCalledWith(
      'appointment-1',
      appointment.customerId,
      'sales-1',
      'consultation',
      input,
      input.serviceTypes,
      ServiceType.CUSTOM,
      'Custom food cart',
    );
  });

  it('rejects late details after the consultation has started', async () => {
    const appointment = createAppointment({
      type: AppointmentType.OFFICE,
      status: AppointmentStatus.CONFIRMED,
      attendanceStatus: AppointmentAttendanceStatus.IN_PROGRESS,
      consultationStartedAt: new Date('2026-08-15T01:00:00.000Z'),
      siteDetailsStatus: 'pending',
      serviceTypes: [ServiceType.CUSTOM],
      salesStaffId: 'sales-1',
    });
    mockAppointmentFindById.mockResolvedValueOnce(appointment);

    await expect(submitSiteDetails(
      'appointment-1',
      { customerRequirements: 'Late request' },
      'customer-1',
    )).rejects.toThrow('Site details can only be submitted before the consultation begins');

    expect(appointment.save).not.toHaveBeenCalled();
    expect(mockAutoCreateDraft).not.toHaveBeenCalled();
  });
});

describe('updateConsultationAttendance', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('records a customer-declined consultation as completed instead of cancelled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T02:00:00.000Z'));
    const appointment = createAppointment({
      type: AppointmentType.OFFICE,
      status: AppointmentStatus.CONFIRMED,
      attendanceStatus: AppointmentAttendanceStatus.ON_TIME,
      salesStaffId: { toString: () => 'sales-1' },
    });
    mockAppointmentFindById.mockResolvedValueOnce(appointment);

    await updateConsultationAttendance(
      'appointment-1',
      { action: 'customer_declined', notes: 'Customer decided not to proceed' },
      'sales-1',
      [Role.SALES_STAFF],
      '127.0.0.1',
      'vitest-agent',
    );

    expect(appointment.status).toBe(AppointmentStatus.COMPLETED);
    expect(appointment.attendanceStatus).toBe(AppointmentAttendanceStatus.CUSTOMER_DECLINED);
    expect(appointment.cancellationReason).toBeUndefined();
    expect(appointment.cancelledBy).toBeUndefined();
    expect(appointment.consultationCompletedAt).toEqual(new Date('2026-09-17T02:00:00.000Z'));
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.APPOINTMENT_ATTENDANCE_UPDATED,
      details: expect.objectContaining({
        action: 'customer_declined',
        appointmentStatus: AppointmentStatus.COMPLETED,
        attendanceStatus: AppointmentAttendanceStatus.CUSTOMER_DECLINED,
      }),
    }));

    vi.useRealTimers();
  });

  // A 1:00 PM consultation on Sep 17, 2026 (Manila is UTC+8).
  const noShowAppointment = (overrides: Record<string, unknown> = {}) => createAppointment({
    type: AppointmentType.OFFICE,
    status: AppointmentStatus.CONFIRMED,
    date: '2026-09-17',
    slotCode: '13:00',
    attendanceStatus: AppointmentAttendanceStatus.SCHEDULED,
    salesStaffId: { toString: () => 'sales-1' },
    ...overrides,
  });
  const markNoShowAt = (isoTime: string, appointment: ReturnType<typeof createAppointment>) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(isoTime));
    mockAppointmentFindById.mockResolvedValueOnce(appointment);
    return updateConsultationAttendance(
      'appointment-1',
      { action: 'no_show', notes: 'Customer did not arrive' },
      'sales-1',
      [Role.SALES_STAFF],
    ).finally(() => vi.useRealTimers());
  };

  it('records a no-show on the appointment date, 15 minutes after the scheduled time', async () => {
    // 1:20 PM Manila: the consultation has already started automatically (In Progress).
    const appointment = noShowAppointment();
    await markNoShowAt('2026-09-17T05:20:00.000Z', appointment);

    expect(appointment.status).toBe(AppointmentStatus.COMPLETED);
    expect(appointment.attendanceStatus).toBe(AppointmentAttendanceStatus.NO_SHOW);
    expect(mockAssertTransition).toHaveBeenCalledWith(AppointmentStatus.CONFIRMED, AppointmentStatus.COMPLETED);
  });

  it.each([
    ['before the scheduled time', '2026-09-17T03:30:00.000Z', 'from 1:15 PM'],
    ['inside the 15-minute grace period', '2026-09-17T05:10:00.000Z', 'from 1:15 PM'],
    ['the day before', '2026-09-16T05:20:00.000Z', 'only be recorded on the appointment date (2026-09-17)'],
    ['the day after', '2026-09-18T05:20:00.000Z', 'That day has passed'],
  ])('refuses a no-show %s', async (_when, isoTime, message) => {
    const appointment = noShowAppointment();
    await expect(markNoShowAt(isoTime, appointment)).rejects.toThrow(message);

    expect(appointment.status).toBe(AppointmentStatus.CONFIRMED);
    expect(appointment.attendanceStatus).toBe(AppointmentAttendanceStatus.SCHEDULED);
    expect(appointment.save).not.toHaveBeenCalled();
  });

  it('refuses a no-show for a customer who already checked in', async () => {
    const appointment = noShowAppointment({
      attendanceStatus: AppointmentAttendanceStatus.IN_PROGRESS,
      actualArrivalAt: new Date('2026-09-17T04:55:00.000Z'),
    });
    await expect(markNoShowAt('2026-09-17T05:20:00.000Z', appointment)).rejects.toThrow('already checked in');

    expect(appointment.status).toBe(AppointmentStatus.CONFIRMED);
    expect(appointment.save).not.toHaveBeenCalled();
  });

  it('issues a daily queue number when an office customer checks in', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T01:50:00.000Z'));
    const appointment = createAppointment({
      type: AppointmentType.OFFICE,
      status: AppointmentStatus.CONFIRMED,
      date: '2026-09-17',
      slotCode: '10:00',
      attendanceStatus: AppointmentAttendanceStatus.SCHEDULED,
      salesStaffId: { toString: () => 'sales-1' },
    });
    mockAppointmentFindById.mockResolvedValueOnce(appointment);
    mockQueueCounterFindOneAndUpdate.mockResolvedValueOnce({ lastSeq: 7 });

    await updateConsultationAttendance(
      'appointment-1',
      { action: 'check_in' },
      'sales-1',
      [Role.SALES_STAFF],
    );

    expect(mockQueueCounterFindOneAndUpdate).toHaveBeenCalledWith(
      { date: '2026-09-17' },
      { $inc: { lastSeq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    expect(appointment.queueNumber).toBe('Q-007');
    expect(appointment.queueSequence).toBe(7);
    expect(appointment.queueDate).toBe('2026-09-17');
    expect(appointment.queueIssuedAt).toEqual(new Date('2026-09-17T01:50:00.000Z'));
    expect(appointment.save).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('checks in a customer who arrives after the consultation started automatically', async () => {
    vi.useFakeTimers();
    // 1:05 PM Manila for a 1:00 PM consultation: the scheduled time already started it.
    vi.setSystemTime(new Date('2026-09-17T05:05:00.000Z'));
    const appointment = noShowAppointment();
    mockAppointmentFindById.mockResolvedValueOnce(appointment);
    mockQueueCounterFindOneAndUpdate.mockResolvedValueOnce({ lastSeq: 3 });

    await updateConsultationAttendance('appointment-1', { action: 'check_in' }, 'sales-1', [Role.SALES_STAFF]);

    expect(appointment.attendanceStatus).toBe(AppointmentAttendanceStatus.IN_PROGRESS);
    expect(appointment.actualArrivalAt).toEqual(new Date('2026-09-17T05:05:00.000Z'));
    expect(appointment.queueNumber).toBe('Q-003');
    expect(appointment.status).toBe(AppointmentStatus.CONFIRMED);

    vi.useRealTimers();
  });

  it('refuses a second check-in once the customer has arrived', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T05:10:00.000Z'));
    const appointment = noShowAppointment({
      attendanceStatus: AppointmentAttendanceStatus.IN_PROGRESS,
      actualArrivalAt: new Date('2026-09-17T05:02:00.000Z'),
    });
    mockAppointmentFindById.mockResolvedValueOnce(appointment);

    await expect(updateConsultationAttendance('appointment-1', { action: 'check_in' }, 'sales-1', [Role.SALES_STAFF]))
      .rejects.toThrow('already checked in');

    vi.useRealTimers();
  });

});

describe('processAutomaticConsultationNoShows', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // A 1:00 PM consultation on Sep 17, 2026 (Manila is UTC+8).
  const candidate = { _id: 'appointment-1', date: '2026-09-17', slotCode: '13:00' };
  const mockCandidates = (items: unknown[]) => {
    mockAppointmentFind.mockReturnValueOnce({ select: vi.fn().mockResolvedValue(items) });
  };

  it('closes a confirmed office consultation without check-in 15 minutes after its time', async () => {
    mockCandidates([candidate]);
    mockAppointmentFindOneAndUpdate.mockResolvedValueOnce({
      ...candidate,
      customerId: 'customer-1',
      salesStaffId: 'sales-1',
      appointmentNumber: 'APT-1',
    });

    const closed = await processAutomaticConsultationNoShows(new Date('2026-09-17T05:16:00.000Z'));

    expect(closed).toBe(1);
    expect(mockAppointmentFind).toHaveBeenCalledWith(expect.objectContaining({
      type: AppointmentType.OFFICE,
      status: AppointmentStatus.CONFIRMED,
      actualArrivalAt: null,
      date: '2026-09-17',
    }));
    expect(mockAppointmentFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'appointment-1', status: AppointmentStatus.CONFIRMED, actualArrivalAt: null }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: AppointmentStatus.COMPLETED,
          attendanceStatus: AppointmentAttendanceStatus.NO_SHOW,
          attendanceNotes: AUTO_NO_SHOW_NOTE,
        }),
      }),
      { new: true },
    );
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.APPOINTMENT_ATTENDANCE_UPDATED,
      details: expect.objectContaining({ automatic: true, attendanceStatus: AppointmentAttendanceStatus.NO_SHOW }),
    }));
    expect(mockAuditCreate.mock.calls[0]![0]).not.toHaveProperty('actorId');
    expect(notifyUsers).toHaveBeenCalledWith(
      ['customer-1'],
      expect.anything(),
      'Consultation Marked as No-Show',
      expect.stringContaining('no check-in within 15 minutes'),
      '/appointments/appointment-1',
    );
  });

  it('waits until the 15-minute grace period has passed', async () => {
    mockCandidates([candidate]);

    const closed = await processAutomaticConsultationNoShows(new Date('2026-09-17T05:10:00.000Z'));

    expect(closed).toBe(0);
    expect(mockAppointmentFindOneAndUpdate).not.toHaveBeenCalled();
  });

  // QA 2026-11-26: a 9:00 AM consultation without a check-in is a No Show from 9:15 sharp (Manila).
  const nineAm = { _id: 'appointment-9', date: '2026-11-25', slotCode: '09:00' };

  it('keeps a 9:00 AM consultation open at 9:14:59', async () => {
    mockCandidates([nineAm]);

    const closed = await processAutomaticConsultationNoShows(new Date('2026-11-25T01:14:59.000Z'));

    expect(closed).toBe(0);
    expect(mockAppointmentFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('closes a 9:00 AM consultation without check-in at 9:15:00 and stamps that time', async () => {
    mockCandidates([nineAm]);
    mockAppointmentFindOneAndUpdate.mockResolvedValueOnce({ ...nineAm, customerId: 'customer-1', salesStaffId: 'sales-1' });
    const at915 = new Date('2026-11-25T01:15:00.000Z');

    const closed = await processAutomaticConsultationNoShows(at915);

    expect(closed).toBe(1);
    expect(mockAppointmentFind).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-11-25', actualArrivalAt: null }));
    expect(mockAppointmentFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'appointment-9', actualArrivalAt: null }),
      expect.objectContaining({
        $set: expect.objectContaining({ attendanceUpdatedAt: at915, consultationCompletedAt: at915 }),
      }),
      { new: true },
    );
  });

  it('leaves the appointment open when a check-in landed first', async () => {
    mockCandidates([candidate]);
    mockAppointmentFindOneAndUpdate.mockResolvedValueOnce(null);

    const closed = await processAutomaticConsultationNoShows(new Date('2026-09-17T05:16:00.000Z'));

    expect(closed).toBe(0);
    expect(mockAuditCreate).not.toHaveBeenCalled();
    expect(notifyUsers).not.toHaveBeenCalled();
  });

  it('only looks at the current Manila date', async () => {
    mockCandidates([]);

    // 11:30 PM UTC on Sep 17 is already Sep 18 in Manila.
    await processAutomaticConsultationNoShows(new Date('2026-09-17T23:30:00.000Z'));

    expect(mockAppointmentFind).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-09-18' }));
  });
});

describe('ocular fee paid through PayMongo QR Ph', () => {
  afterEach(() => vi.clearAllMocks());

  it('waits for the cashier instead of marking the fee paid', async () => {
    const appointment = createAppointment({
      appointmentNumber: 'APT-20261022-0003',
      ocularFee: 658,
      ocularFeePaid: false,
      ocularFeeStatus: 'pending',
      ocularFeePaymentMethod: 'qrph',
    });
    mockAppointmentFindOne.mockReturnValue({ populate: vi.fn().mockResolvedValue(appointment) });

    await handlePaymongoPayment('cs_123');

    expect(appointment).toMatchObject({ ocularFeePaid: false, ocularFeeStatus: 'proof_submitted', ocularFeePaymentMethod: 'qrph' });
    expect(appointment.save).toHaveBeenCalledTimes(1);
    expect(mockNotifyRole).toHaveBeenCalledWith(
      Role.CASHIER,
      expect.anything(),
      'Ocular Fee Paid via QR Ph',
      expect.stringContaining('APT-20261022-0003'),
      '/payments?tab=ocular-fees',
    );
  });

  it('does nothing when the payment is already waiting for the cashier', async () => {
    const appointment = createAppointment({ ocularFee: 658, ocularFeePaid: false, ocularFeeStatus: 'proof_submitted', ocularFeePaymentMethod: 'qrph' });
    mockAppointmentFindOne.mockReturnValue({ populate: vi.fn().mockResolvedValue(appointment) });

    await handlePaymongoPayment('cs_123');

    expect(appointment.save).not.toHaveBeenCalled();
    expect(mockNotifyRole).not.toHaveBeenCalled();
  });

  it('lists every unpaid ocular booking that has a fee in the cashier queue', async () => {
    const sort = vi.fn().mockResolvedValue([]);
    mockAppointmentFind.mockReturnValue({ populate: vi.fn().mockReturnValue({ sort }) });

    await listPendingOcularFees();

    const filter = mockAppointmentFind.mock.calls[0]![0];
    expect(filter).toMatchObject({ ocularFee: { $gt: 0 }, type: AppointmentType.OCULAR });
    expect(filter).not.toHaveProperty('ocularFeeBreakdown.isWithinNCR');
  });
});
