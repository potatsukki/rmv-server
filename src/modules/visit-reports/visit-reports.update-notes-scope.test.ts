import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockVisitReportFindById,
  mockVisitReportFindOne,
  mockAuditCreate,
  mockSyncAppointmentSalesNotes,
} = vi.hoisted(() => ({
  mockVisitReportFindById: vi.fn(),
  mockVisitReportFindOne: vi.fn(),
  mockAuditCreate: vi.fn(),
  mockSyncAppointmentSalesNotes: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  VisitReport: {
    findById: mockVisitReportFindById,
    findOne: mockVisitReportFindOne,
  },
  Appointment: {},
  Project: {},
  ProjectItem: {},
  User: {},
  AuditLog: { create: mockAuditCreate },
  SlotLock: {},
}));

vi.mock('../../services/sales-notes.service.js', () => ({
  syncAppointmentSalesNotes: mockSyncAppointmentSalesNotes,
}));

vi.mock('../notifications/socket.service.js', () => ({
  createAndSendNotification: vi.fn(),
  notifyBookingAgentAppointmentSuccessful: vi.fn(),
  notifyRole: vi.fn(),
}));

vi.mock('../appointments/appointments.service.js', () => ({
  resolveOcularVisitData: vi.fn(),
}));

vi.mock('../appointments/consultation-attendance-automation.js', () => ({
  synchronizeConsultationAttendanceByTime: vi.fn(),
}));

import { updateReport } from './visit-reports.service.js';
import { VisitReportStatus } from '../../models/VisitReport.js';
import { AuditAction } from '../../utils/constants.js';

function createReport(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'report-1',
    appointmentId: 'appointment-1',
    salesStaffId: { toString: () => 'sales-1' },
    status: VisitReportStatus.DRAFT,
    visitType: 'consultation',
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function mockFindByIdChain(report: unknown) {
  // First call (the actual report lookup) resolves directly; the final
  // populateVisitReportDetail(VisitReport.findById(...)) call needs a chainable query.
  mockVisitReportFindById.mockResolvedValueOnce(report);
  mockVisitReportFindById.mockReturnValueOnce({
    populate: vi.fn().mockReturnThis(),
  });
}

describe('updateReport — sales notes stay scoped per visit stage', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('syncs notes to the appointment and sibling reports for a consultation report', async () => {
    const report = createReport({ visitType: 'consultation' });
    mockFindByIdChain(report);
    mockVisitReportFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(null) });
    mockAuditCreate.mockResolvedValueOnce({});

    await updateReport('report-1', { initialDesignNotes: 'Customer wants grade 316.' }, 'sales-1');

    expect(mockSyncAppointmentSalesNotes).toHaveBeenCalledExactlyOnceWith(
      'appointment-1',
      'Customer wants grade 316.',
    );
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.VISIT_REPORT_UPDATED,
    }));
  });

  it('does not sync notes anywhere for an ocular report — they stay on that report only', async () => {
    const report = createReport({ visitType: 'ocular' });
    mockFindByIdChain(report);
    mockAuditCreate.mockResolvedValueOnce({});

    await updateReport('report-1', { initialDesignNotes: 'Site has uneven flooring.' }, 'sales-1');

    expect(mockSyncAppointmentSalesNotes).not.toHaveBeenCalled();
    expect(report.initialDesignNotes).toBe('Site has uneven flooring.');
  });
});
