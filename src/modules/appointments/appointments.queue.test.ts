import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockAppointmentFind, mockVisitReportFind, mockProjectFind } = vi.hoisted(() => ({
  mockAppointmentFind: vi.fn(),
  mockVisitReportFind: vi.fn(),
  mockProjectFind: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Appointment: { find: mockAppointmentFind },
  SlotLock: {},
  User: {},
  AvailabilitySession: {},
  AuditLog: {},
  Holiday: {},
  SalesAvailability: {},
  Config: {},
  BlockedSlot: {},
  VisitReport: { find: mockVisitReportFind },
  VisitReportStatus: {},
  Project: { find: mockProjectFind },
  AppointmentQueueCounter: {},
}));

vi.mock('../../utils/stateMachine.js', () => ({
  appointmentStateMachine: { assertTransition: vi.fn() },
}));

vi.mock('../notifications/socket.service.js', () => ({
  createAndSendNotification: vi.fn(),
  notifyRole: vi.fn(),
  emitRoleEvent: vi.fn(),
  notifyBookingAgentAppointmentSuccessful: vi.fn(),
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
  logger: { info: vi.fn(), error: vi.fn() },
}));

import { listAppointmentQueue } from './appointments.service.js';
import { AppointmentStatus, AppointmentType, Role } from '../../utils/constants.js';

const SALES_ID = 'sales-1';

function mockAppointments(appointments: unknown[]) {
  const chain = {
    populate: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(appointments),
  };
  mockAppointmentFind.mockReturnValue(chain);
  return chain;
}

function mockLeanQuery(mock: ReturnType<typeof vi.fn>, rows: unknown[]) {
  mock.mockReturnValue({
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(rows),
  });
}

function appointment(overrides: Record<string, unknown>) {
  return {
    customerId: { _id: 'customer-1', firstName: 'Michael', lastName: 'Dela Rosa' },
    salesStaffId: { _id: SALES_ID, firstName: 'Kendl', lastName: 'Johnson' },
    createdAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

// Old consultations whose report is in: these used to be pinned first as "ready for ocular".
const oldConsultations = [
  appointment({
    _id: 'consult-0900',
    type: AppointmentType.OFFICE,
    status: AppointmentStatus.COMPLETED,
    consultationReportSubmitted: true,
    date: '2026-10-05',
    slotCode: '09:00',
  }),
  appointment({
    _id: 'consult-1000',
    type: AppointmentType.OFFICE,
    status: AppointmentStatus.COMPLETED,
    consultationReportSubmitted: true,
    date: '2026-10-05',
    slotCode: '10:00',
  }),
];

// An ocular scheduled from a project and finished before its scheduled date.
const projectOcular = appointment({
  _id: 'ocular-1',
  type: AppointmentType.OCULAR,
  status: AppointmentStatus.COMPLETED,
  date: '2026-11-12',
  slotCode: '10:00',
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('listAppointmentQueue', () => {
  it('lists the Completed tab newest first, so a new ocular is not buried under old consultations', async () => {
    const chain = mockAppointments([...oldConsultations, projectOcular]);
    mockLeanQuery(mockVisitReportFind, []);
    mockLeanQuery(mockProjectFind, []);

    const result = await listAppointmentQueue({ statusGroup: 'completed' } as never, SALES_ID, [Role.SALES_STAFF]);

    expect(chain.sort).toHaveBeenCalledWith({ date: -1, slotCode: -1, createdAt: -1 });
    expect(result.items.map((item) => String(item.appointment._id))).toEqual(['ocular-1', 'consult-1000', 'consult-0900']);
    expect(result.items.every((item) => item.segment === 'recent')).toBe(true);
  });

  it('keeps a completed ocular dated in the future inside the default All window', async () => {
    mockAppointments([]);

    await listAppointmentQueue({} as never, SALES_ID, [Role.SALES_STAFF]);

    const filter = JSON.stringify(mockAppointmentFind.mock.calls[0]?.[0]);
    expect(filter).toContain('$gte');
    expect(filter).not.toContain('$lte');
  });

  it('links an ocular appointment to the project that scheduled it', async () => {
    mockAppointments([projectOcular]);
    mockLeanQuery(mockVisitReportFind, []);
    mockLeanQuery(mockProjectFind, [{
      _id: 'project-1',
      appointmentId: 'consult-original',
      ocularAppointmentId: 'ocular-1',
      title: 'Railings Project',
      serviceType: 'railings',
      status: 'submitted',
    }]);

    const result = await listAppointmentQueue({ statusGroup: 'completed' } as never, SALES_ID, [Role.SALES_STAFF]);

    expect(JSON.stringify(mockProjectFind.mock.calls[0]?.[0])).toContain('ocularAppointmentId');
    const [item] = result.items;
    expect(item?.actions.projectPath).toBe('/projects/project-1');
    expect(item?.actions.createProjectPath).toBeUndefined();
    expect(item?.sampleProjects).toEqual([expect.objectContaining({ projectId: 'project-1', title: 'Railings Project' })]);
  });
});
