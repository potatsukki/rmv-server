import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockAppointmentFindById,
  mockAppointmentFindOne,
  mockAppointmentFind,
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
} = vi.hoisted(() => ({
  mockAppointmentFindById: vi.fn(),
  mockAppointmentFindOne: vi.fn(),
  mockAppointmentFind: vi.fn(),
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
}));

vi.mock('../../models/index.js', () => ({
  Appointment: {
    findById: mockAppointmentFindById,
    findOne: mockAppointmentFindOne,
    find: mockAppointmentFind,
    create: mockAppointmentCreate,
    countDocuments: mockAppointmentCountDocuments,
  },
  SlotLock: {},
  User: {
    find: mockUserFind,
    findOne: mockUserFindOne,
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
  VisitReport: {},
  VisitReportStatus: {},
  Project: {},
  AppointmentQueueCounter: {
    findOneAndUpdate: mockQueueCounterFindOneAndUpdate,
  },
}));

vi.mock('../../utils/stateMachine.js', () => ({
  appointmentStateMachine: {
    assertTransition: mockAssertTransition,
  },
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
  sendAppointmentConfirmedEmail: vi.fn(),
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
  getAvailableSlots,
  reassignAppointmentSales,
  reviewAssignedAppointment,
  requestAppointment,
  requestReschedule,
  submitSiteDetails,
  updateConsultationAttendance,
  getCustomerQueueStatus,
  handlePaymongoPayment,
  listPendingOcularFees,
} from './appointments.service.js';
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
    rescheduleReason: 'old reason',
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('prepareProjectOcularSchedule', () => {
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it('rejects a second active appointment before scheduling a pending ocular', async () => {
    mockAppointmentFindOne.mockResolvedValue({ _id: 'active-1', status: AppointmentStatus.REQUESTED });
    await expect(prepareProjectOcularSchedule({ customerId: 'customer-1', date: '2026-10-08', slotCode: '09:00', salesStaffId: 'sales-1' })).rejects.toThrow('already have an active appointment');
  });

  it('rejects an ocular scheduled less than 3 days after its consultation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-08T01:00:00Z'));
    mockAppointmentFindOne.mockResolvedValue(null);
    // Consultation held Nov 7 → the ocular opens on Nov 10.
    await expect(prepareProjectOcularSchedule({
      customerId: 'customer-1', date: '2026-11-09', slotCode: '09:00', salesStaffId: 'sales-1', consultationDate: '2026-11-07',
    })).rejects.toThrow('at least 3 days after the consultation (2026-11-07)');
    expect(mockAppointmentFindOne).not.toHaveBeenCalled();
  });

  it('counts from today when the consultation finished before its scheduled date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-08T01:00:00Z'));
    mockAppointmentFindOne.mockResolvedValue({ _id: 'active-1', status: AppointmentStatus.REQUESTED });
    // Scheduled Nov 17 but held on Nov 8: Nov 11 passes the consultation rule and reaches the next check.
    await expect(prepareProjectOcularSchedule({
      customerId: 'customer-1', date: '2026-11-11', slotCode: '09:00', salesStaffId: 'sales-1', consultationDate: '2026-11-17',
    })).rejects.toThrow('already have an active appointment');
  });

  it('enforces the existing advance booking rule', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T01:00:00Z'));
    mockAppointmentFindOne.mockResolvedValue(null);
    await expect(prepareProjectOcularSchedule({ customerId: 'customer-1', date: '2026-10-06', slotCode: '09:00', salesStaffId: 'sales-1' })).rejects.toThrow('at least 3 days');
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
      assignmentBlockedReason: 'Already has an appointment on this date (APT-20261109-0006)',
    });

    await expect(reassignAppointmentSales(
      'appointment-1',
      { salesStaffId: 'sales-1' },
      'agent-1',
      [Role.APPOINTMENT_AGENT],
    )).rejects.toThrow('Already has an appointment on this date (APT-20261109-0006)');

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

describe('one appointment per sales staff per day', () => {
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

  it('takes a staff member with any appointment that day out of every slot of the day', async () => {
    twoAvailableStaff();
    // sales-a has an ocular visit at 14:00 that day.
    mockAppointmentFind.mockImplementation(() => selectLeanResult([{ salesStaffId: 'sales-a' }]));

    const result = await getAvailableSlots({ date: '2026-09-10', type: AppointmentType.OFFICE });

    expect(result.slots.every((slot) => slot.available && slot.remaining === 1)).toBe(true);
    expect(mockAppointmentFind).toHaveBeenCalledWith(expect.objectContaining({
      date: '2026-09-10',
      $or: [
        { status: { $in: expect.arrayContaining([AppointmentStatus.CONFIRMED, AppointmentStatus.ON_THE_WAY]) } },
        { slotCode: '09:00', status: { $nin: ['completed', 'cancelled', 'no_show'] } },
      ],
    }));
  });

  it('closes the day for customers once every staff member is taken or awaited', async () => {
    twoAvailableStaff();
    // sales-a is booked that day and one request is still waiting for a staff member.
    mockAppointmentFind.mockImplementation(() => selectLeanResult([{ salesStaffId: 'sales-a' }, { salesStaffId: undefined }]));

    const result = await getAvailableSlots({ date: '2026-09-10', type: AppointmentType.OFFICE });

    expect(result.slots.every((slot) => !slot.available && slot.remaining === 0)).toBe(true);
  });

  it("shows only the given sales staff member's own free day", async () => {
    twoAvailableStaff();
    mockUserFind.mockImplementation(() => selectLeanResult([
      { _id: 'sales-b', roles: [Role.SALES_STAFF], availabilityStatus: StaffAvailabilityStatus.AVAILABLE },
    ]));
    // An unassigned request that day does not take sales-b's own day.
    mockAppointmentFind.mockImplementation(() => selectLeanResult([{ salesStaffId: undefined }]));

    const result = await getAvailableSlots({ date: '2026-09-10', type: AppointmentType.OCULAR, salesStaffId: 'sales-b' });

    expect(mockUserFind).toHaveBeenCalledWith(expect.objectContaining({ _id: 'sales-b' }));
    expect(result.slots.every((slot) => slot.available && slot.remaining === 1)).toBe(true);
  });

  it('counts an ocular visit already under way as an active appointment of the customer', async () => {
    mockAppointmentFindOne.mockResolvedValue({ _id: 'ocular-1', status: AppointmentStatus.ON_THE_WAY });

    await expect(prepareProjectOcularSchedule({ customerId: 'customer-1', date: '2026-10-08', slotCode: '09:00', salesStaffId: 'sales-1' }))
      .rejects.toThrow('already have an active appointment');
    expect(mockAppointmentFindOne).toHaveBeenCalledWith({
      customerId: 'customer-1',
      status: { $in: expect.arrayContaining([AppointmentStatus.ON_THE_WAY, AppointmentStatus.IN_PROGRESS]) },
    });
  });

  it('rejects an ocular visit at a time that is not a real slot', async () => {
    await expect(assertConsultationOcularSchedule({
      customerId: 'customer-1', salesStaffId: 'sales-1', date: '2026-10-08', slotCode: '09:30',
      consultationAppointmentId: 'consult-1',
    })).rejects.toThrow('Choose a valid ocular visit time.');
  });

  it('never lets the source consultation or the moved ocular visit block itself', async () => {
    mockAppointmentFindOne.mockResolvedValue({ _id: 'other-1', status: AppointmentStatus.CONFIRMED });

    await expect(assertConsultationOcularSchedule({
      customerId: 'customer-1', salesStaffId: 'sales-1', date: '2026-10-08', slotCode: '09:00',
      consultationAppointmentId: 'consult-1', existingOcularId: 'ocular-1',
    })).rejects.toThrow('already have an active appointment');
    expect(mockAppointmentFindOne).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      _id: { $nin: ['consult-1', 'ocular-1'] },
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

  it('persists multiple selected designs and keeps the first as the legacy snapshot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));

    mockAppointmentFindOne.mockResolvedValueOnce(null);
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
    mockAppointmentCreate.mockImplementationOnce(async (payload) => ({
      _id: 'appointment-new',
      ...payload,
    }));
    mockAuditCreate.mockResolvedValueOnce({});
    mockNotifyRole.mockResolvedValueOnce(undefined);

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

  it('records a no-show consultation as completed and keeps the no-show outcome', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T03:30:00.000Z'));
    const appointment = createAppointment({
      type: AppointmentType.OFFICE,
      status: AppointmentStatus.CONFIRMED,
      date: '2026-09-17',
      slotCode: '13:00',
      attendanceStatus: AppointmentAttendanceStatus.SCHEDULED,
      salesStaffId: { toString: () => 'sales-1' },
    });
    mockAppointmentFindById.mockResolvedValueOnce(appointment);

    await updateConsultationAttendance(
      'appointment-1',
      { action: 'no_show', notes: 'Customer did not arrive' },
      'sales-1',
      [Role.SALES_STAFF],
    );

    expect(appointment.status).toBe(AppointmentStatus.COMPLETED);
    expect(appointment.attendanceStatus).toBe(AppointmentAttendanceStatus.NO_SHOW);
    expect(mockAssertTransition).toHaveBeenCalledWith(AppointmentStatus.CONFIRMED, AppointmentStatus.COMPLETED);

    vi.useRealTimers();
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
