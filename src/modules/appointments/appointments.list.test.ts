import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appointmentFind: vi.fn(),
  appointmentCountDocuments: vi.fn(),
  projectDistinct: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Appointment: { find: mocks.appointmentFind, countDocuments: mocks.appointmentCountDocuments },
  SlotLock: {},
  User: {},
  AvailabilitySession: {},
  AuditLog: {},
  Holiday: {},
  SalesAvailability: {},
  Config: {},
  BlockedSlot: {},
  VisitReport: {},
  VisitReportStatus: {},
  Project: { distinct: mocks.projectDistinct },
  AppointmentQueueCounter: {},
}));
vi.mock('../notifications/socket.service.js', () => ({
  createAndSendNotification: vi.fn(), notifyRole: vi.fn(), emitRoleEvent: vi.fn(), notifyBookingAgentAppointmentSuccessful: vi.fn(),
}));
vi.mock('../notifications/email.service.js', () => ({ sendAppointmentConfirmedEmail: vi.fn() }));
vi.mock('../visit-reports/visit-reports.service.js', () => ({ autoCreateDraft: vi.fn() }));
vi.mock('../maps/maps.service.js', () => ({ computeOcularFee: vi.fn(), reverseGeocode: vi.fn() }));
vi.mock('../../services/paymongo.service.js', () => ({ createCheckoutSession: vi.fn(), retrieveCheckoutSession: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

import { listAppointments } from './appointments.service.js';
import { Role } from '../../utils/constants.js';

describe('listAppointments for Create Project', () => {
  it('leaves out appointments that a project already uses', async () => {
    const chain = { populate: vi.fn(), sort: vi.fn(), skip: vi.fn(), limit: vi.fn().mockResolvedValue([]) };
    chain.populate.mockReturnValue(chain);
    chain.sort.mockReturnValue(chain);
    chain.skip.mockReturnValue(chain);
    mocks.appointmentFind.mockReturnValue(chain);
    mocks.appointmentCountDocuments.mockResolvedValue(0);
    mocks.projectDistinct
      .mockResolvedValueOnce(['consultation-1'])
      .mockResolvedValueOnce(['ocular-1', null]);

    await listAppointments(
      { customerId: 'customer-1', status: 'completed', withoutProject: 'true' },
      'agent-1',
      [Role.APPOINTMENT_AGENT],
    );

    expect(mocks.projectDistinct).toHaveBeenCalledWith('appointmentId', { status: { $ne: 'cancelled' }, customerId: 'customer-1' });
    const filter = mocks.appointmentFind.mock.calls[0]![0];
    expect(JSON.stringify(filter)).toContain('"$nin":["consultation-1","ocular-1"]');
  });
});
