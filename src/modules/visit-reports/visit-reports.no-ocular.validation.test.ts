import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  reportFindById: vi.fn(), reportFind: vi.fn(), appointmentFindById: vi.fn(),
  appointmentFindOne: vi.fn(), appointmentCreate: vi.fn(),
  projectCreate: vi.fn(), projectFindOne: vi.fn(), projectFindById: vi.fn(),
  auditCreate: vi.fn(), releaseSlot: vi.fn(),
}));
vi.mock('../../models/index.js', () => ({
  VisitReport: { findById: mocks.reportFindById, find: mocks.reportFind },
  Appointment: { findById: mocks.appointmentFindById, findOne: mocks.appointmentFindOne, create: mocks.appointmentCreate },
  Project: { create: mocks.projectCreate, findOne: mocks.projectFindOne, findById: mocks.projectFindById },
  ProjectItem: {}, User: {}, AuditLog: { create: mocks.auditCreate },
  SlotLock: { deleteOne: mocks.releaseSlot },
}));
vi.mock('../notifications/socket.service.js', () => ({
  createAndSendNotification: vi.fn(), notifyRole: vi.fn(),
}));
vi.mock('../appointments/appointments.service.js', () => ({ resolveOcularVisitData: vi.fn() }));
vi.mock('../appointments/consultation-attendance-automation.js', () => ({
  synchronizeConsultationAttendanceByTime: vi.fn(),
}));

import { submitReport } from './visit-reports.service.js';

function setupReport(reportFields: Record<string, unknown>, appointmentFields: Record<string, unknown> = {}) {
  const report = {
    _id: 'report-1', customerId: 'customer-1', salesStaffId: 'sales-1', appointmentId: 'appointment-1',
    status: 'draft', visitType: 'consultation', consultationOutcome: 'no_ocular',
    noOcularReason: 'Customer supplied the site information.',
    save: vi.fn().mockResolvedValue(undefined), ...reportFields,
  };
  const appointment = {
    _id: 'appointment-1', status: 'confirmed', attendanceStatus: 'in_progress',
    salesStaffId: 'sales-1', date: '2026-09-17', slotCode: '09:00',
    save: vi.fn().mockResolvedValue(undefined), ...appointmentFields,
  };
  const query = { populate: vi.fn(), then: (resolve: (value: unknown) => unknown) => Promise.resolve(report).then(resolve) };
  query.populate.mockReturnValue(query);
  mocks.reportFindById.mockReturnValue(query);
  mocks.appointmentFindById.mockResolvedValue(appointment);
  mocks.reportFind.mockResolvedValue([]);
  mocks.projectFindOne.mockResolvedValue(null);
  return { report, appointment };
}

beforeEach(() => vi.resetAllMocks());

describe('appointment report submission without project creation', () => {
  it('completes a no-ocular consultation without requiring project fields or creating a project', async () => {
    const { report, appointment } = setupReport({});
    await submitReport('report-1', 'sales-1');
    expect(report.status).toBe('submitted');
    expect(appointment.status).toBe('completed');
    expect(appointment.save).toHaveBeenCalled();
    expect(mocks.projectCreate).not.toHaveBeenCalled();
    expect(mocks.projectFindOne).not.toHaveBeenCalled();
  });

  it('still requires the reason for skipping an ocular visit', async () => {
    const { report } = setupReport({ noOcularReason: '' });
    await expect(submitReport('report-1', 'sales-1')).rejects.toThrow('Explain why ocular is not needed');
    expect(report.save).not.toHaveBeenCalled();
    expect(mocks.projectCreate).not.toHaveBeenCalled();
  });

  it('completes a standalone ocular report without selecting another project for the customer', async () => {
    const { report, appointment } = setupReport({
      visitType: 'ocular', actualVisitDateTime: new Date('2026-09-17T01:00:00Z'),
      measurements: { length: 20, width: 10, height: 30, thickness: 2, area: 200, raw: 'Measured on site' },
      siteConditions: { environment: 'outdoor', floorType: 'Concrete', wallMaterial: 'Concrete', accessNotes: 'Street access', obstaclesOrConstraints: 'None' },
      materials: 'Steel', finishes: 'Paint', preferredDesign: 'Simple', photoKeys: ['site/photo.jpg'],
      initialDesignKeys: ['site/sketch.jpg'],
    }, { status: 'in_progress', ocularFee: 0 });
    await submitReport('report-1', 'sales-1');
    expect(report.status).toBe('submitted');
    expect(appointment.status).toBe('completed');
    expect(mocks.releaseSlot).toHaveBeenCalled();
    expect(mocks.projectCreate).not.toHaveBeenCalled();
    expect(mocks.projectFindOne).toHaveBeenCalledWith({ visitReportId: 'report-1', customerId: 'customer-1' });
  });

  it('accepts site measurements and conditions without project design information', async () => {
    const { report, appointment } = setupReport({
      visitType: 'ocular', actualVisitDateTime: new Date('2026-09-17T01:00:00Z'),
      specifications: {
        measurements: { height: 180, width: 300, quantity: 1 },
        siteConditions: { environment: 'outdoor', access: 'Street access' },
      },
      photoKeys: ['site/photo.jpg'],
    }, { status: 'in_progress', ocularFee: 0 });
    await submitReport('report-1', 'sales-1');
    expect(report.status).toBe('submitted');
    expect(appointment.status).toBe('completed');
    expect(mocks.projectCreate).not.toHaveBeenCalled();
  });

  it('schedules the follow-up ocular appointment without a project', async () => {
    const { report, appointment } = setupReport({
      consultationOutcome: 'schedule_ocular', serviceType: 'gates',
      recommendedOcularDate: new Date('2026-09-18T12:00:00Z'), recommendedOcularSlot: '09:00',
    });
    mocks.appointmentFindById.mockReturnValue({
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(appointment).then(resolve),
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ serviceTypes: ['gates'] }) }),
    });
    mocks.appointmentFindOne.mockReturnValue({ sort: vi.fn().mockResolvedValue(null) });
    mocks.appointmentCreate.mockResolvedValue({ _id: 'ocular-1', salesStaffId: 'sales-1' });
    mocks.reportFind.mockImplementation((filter) => ({
      then: (resolve: (value: unknown) => unknown) => Promise.resolve([]).then(resolve),
      sort: vi.fn().mockResolvedValue(filter.appointmentId === 'appointment-1' ? [report] : []),
    }));
    await submitReport('report-1', 'sales-1');
    expect(appointment.status).toBe('completed');
    expect(mocks.appointmentCreate).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ocular', date: '2026-09-18', slotCode: '09:00', sourceConsultationAppointmentId: 'appointment-1',
    }));
    expect(report.visitType).toBe('ocular');
    expect(report.appointmentId).toBe('ocular-1');
    expect(report.status).toBe('draft');
    expect(mocks.projectCreate).not.toHaveBeenCalled();
    expect(mocks.projectFindOne).not.toHaveBeenCalled();
  });

  it('leaves an ocular appointment in progress when required report information is missing', async () => {
    const { appointment } = setupReport({ visitType: 'ocular' }, { status: 'in_progress', ocularFee: 0 });
    await expect(submitReport('report-1', 'sales-1')).rejects.toThrow('You have not yet provided information');
    expect(appointment.save).not.toHaveBeenCalled();
    expect(mocks.releaseSlot).not.toHaveBeenCalled();
  });
});
