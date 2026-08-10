import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockAppointmentFindById,
  mockAuditCreate,
  mockNotifyRole,
  mockAssertTransition,
} = vi.hoisted(() => ({
  mockAppointmentFindById: vi.fn(),
  mockAuditCreate: vi.fn(),
  mockNotifyRole: vi.fn(),
  mockAssertTransition: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Appointment: {
    findById: mockAppointmentFindById,
  },
  SlotLock: {},
  User: {},
  AuditLog: {
    create: mockAuditCreate,
  },
  Holiday: {},
  SalesAvailability: {},
  Config: {},
  BlockedSlot: {},
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
  autoCreateDraft: vi.fn(),
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

import { requestReschedule } from './appointments.service.js';
import { AppointmentStatus, AuditAction } from '../../utils/constants.js';

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
