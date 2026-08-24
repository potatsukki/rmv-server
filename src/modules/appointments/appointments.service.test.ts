import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockAppointmentFindById,
  mockAppointmentFindOne,
  mockAppointmentFind,
  mockAppointmentCreate,
  mockAuditCreate,
  mockNotifyRole,
  mockAssertTransition,
  mockHolidayFindOne,
  mockBlockedSlotExists,
  mockUserFind,
  mockSalesAvailabilityFind,
  mockAutoCreateDraft,
} = vi.hoisted(() => ({
  mockAppointmentFindById: vi.fn(),
  mockAppointmentFindOne: vi.fn(),
  mockAppointmentFind: vi.fn(),
  mockAppointmentCreate: vi.fn(),
  mockAuditCreate: vi.fn(),
  mockNotifyRole: vi.fn(),
  mockAssertTransition: vi.fn(),
  mockHolidayFindOne: vi.fn(),
  mockBlockedSlotExists: vi.fn(),
  mockUserFind: vi.fn(),
  mockSalesAvailabilityFind: vi.fn(),
  mockAutoCreateDraft: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Appointment: {
    findById: mockAppointmentFindById,
    findOne: mockAppointmentFindOne,
    find: mockAppointmentFind,
    create: mockAppointmentCreate,
  },
  SlotLock: {},
  User: {
    find: mockUserFind,
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
}));

vi.mock('../../utils/stateMachine.js', () => ({
  appointmentStateMachine: {
    assertTransition: mockAssertTransition,
  },
}));

vi.mock('../notifications/socket.service.js', () => ({
  createAndSendNotification: vi.fn(),
  notifyRole: mockNotifyRole,
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

import { requestAppointment, requestReschedule, submitSiteDetails } from './appointments.service.js';
import {
  AppointmentAttendanceStatus,
  AppointmentStatus,
  AppointmentType,
  AuditAction,
  Role,
  ServiceType,
} from '../../utils/constants.js';

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

function selectLeanResult<T>(value: T) {
  return {
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(value),
    }),
  };
}

describe('requestAppointment', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('persists the selected design snapshot on the appointment', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));

    mockAppointmentFindOne.mockResolvedValueOnce(null);
    mockHolidayFindOne.mockResolvedValueOnce(null);
    mockBlockedSlotExists.mockResolvedValueOnce(false);
    mockUserFind.mockReturnValueOnce(selectLeanResult([{ _id: 'sales-1' }]));
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
        serviceTypes: [ServiceType.RAILINGS],
        selectedDesignTemplateId: 'railings-commercial-guardrail',
        selectedDesignTemplateName: 'Commercial Stainless Guardrail',
        selectedDesignTemplateImageUrl: '/landing/services/railings/guardrail.png',
      },
      'customer-1',
      [Role.CUSTOMER],
    );

    expect(mockAppointmentCreate).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      selectedDesignTemplateId: 'railings-commercial-guardrail',
      selectedDesignTemplateName: 'Commercial Stainless Guardrail',
      selectedDesignTemplateImageUrl: '/landing/services/railings/guardrail.png',
    }));
  });
});

describe('requestReschedule', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('updates an already requested reschedule without re-triggering the transition guard', async () => {
    const appointment = createAppointment();
    mockAppointmentFindById.mockResolvedValueOnce(appointment);
    mockAuditCreate.mockResolvedValueOnce({});

    const result = await requestReschedule(
      'appointment-1',
      { reason: 'Need a later schedule' },
      'customer-1',
      '127.0.0.1',
      'vitest-agent',
    );

    expect(mockAssertTransition).not.toHaveBeenCalled();
    expect(appointment.status).toBe(AppointmentStatus.RESCHEDULE_REQUESTED);
    expect(appointment.rescheduleReason).toBe('Need a later schedule');
    expect(appointment.save).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.APPOINTMENT_RESCHEDULE_REQUESTED,
        actorId: 'customer-1',
        targetType: 'appointment',
        targetId: 'appointment-1',
        details: {
          reason: 'Need a later schedule',
          count: 1,
        },
        ipAddress: '127.0.0.1',
        userAgent: 'vitest-agent',
      }),
    );
    expect(mockNotifyRole).toHaveBeenCalledWith(
      'appointment_agent',
      expect.anything(),
      'Reschedule Request Updated',
      'Customer updated the reschedule request for appointment on 2026-08-15. New reason: Need a later schedule',
      '/appointments/appointment-1',
    );
    expect(result).toBe(appointment);
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
