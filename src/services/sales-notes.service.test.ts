import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  appointmentFindById: vi.fn(), appointmentFind: vi.fn(), appointmentUpdate: vi.fn(),
  projectFind: vi.fn(), projectExists: vi.fn(), projectUpdate: vi.fn(), itemUpdate: vi.fn(), reportUpdate: vi.fn(), audit: vi.fn(),
}));
vi.mock('../models/index.js', () => ({
  Appointment: { findById: mocks.appointmentFindById, find: mocks.appointmentFind, updateMany: mocks.appointmentUpdate },
  Project: { find: mocks.projectFind, exists: mocks.projectExists, updateMany: mocks.projectUpdate },
  ProjectItem: { updateMany: mocks.itemUpdate }, VisitReport: { updateMany: mocks.reportUpdate }, AuditLog: { create: mocks.audit },
}));
import { syncAppointmentSalesNotes, updateAppointmentSalesNotes } from './sales-notes.service.js';
import { Role } from '../utils/constants.js';
import { cleanSalesNotes } from '../utils/salesNotes.js';
const generated = 'Commercial Stainless Guardrail selected from the RMV design catalog. A heavy-duty stainless guardrail. Confirm final measurements, material grade, finish, mounting details, and customer-requested changes before fabrication.';
const query = (value: unknown) => ({ select: () => ({ lean: async () => value }) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.appointmentFindById.mockResolvedValue({ _id: 'ocular-1', sourceConsultationAppointmentId: 'consultation-1', salesStaffId: 'sales-1' });
  mocks.appointmentFind.mockReturnValue(query([{ _id: 'ocular-1' }]));
  mocks.projectFind.mockReturnValue(query([{ _id: 'project-1' }]));
  mocks.projectExists.mockResolvedValue(null);
});

it('carries handwritten edits back to the consultation and forward to reports and the draft project', async () => {
  const notes = 'Use grade 316. Customer confirmed the mounting height.';
  await updateAppointmentSalesNotes('ocular-1', notes, 'sales-1', [Role.SALES_STAFF]);
  const update = { $set: { initialDesignNotes: notes } };
  expect(mocks.appointmentUpdate).toHaveBeenCalledWith({ _id: { $in: ['consultation-1', 'ocular-1'] } }, update);
  expect(mocks.reportUpdate).toHaveBeenCalledWith({ appointmentId: { $in: ['consultation-1', 'ocular-1'] } }, update);
  expect(mocks.projectUpdate).toHaveBeenCalledWith({ _id: { $in: ['project-1'] }, status: 'draft' }, update);
  expect(mocks.itemUpdate).toHaveBeenCalledWith({ projectId: { $in: ['project-1'] }, status: 'draft' }, update);
  expect(mocks.audit).toHaveBeenCalledOnce();
});

it('saves an intentional empty value across the same notes field', async () => {
  await syncAppointmentSalesNotes('ocular-1', '');
  expect(mocks.reportUpdate).toHaveBeenCalledWith(expect.anything(), { $set: { initialDesignNotes: '' } });
  expect(mocks.projectUpdate).toHaveBeenCalledWith(expect.anything(), { $set: { initialDesignNotes: '' } });
});

it('removes old generated text and keeps handwritten additions', async () => {
  await syncAppointmentSalesNotes('ocular-1', `${generated}\n\nSales measured the ramp on site.`);
  expect(mocks.reportUpdate).toHaveBeenCalledWith(expect.anything(), { $set: { initialDesignNotes: 'Sales measured the ramp on site.' } });
  expect(cleanSalesNotes(generated.replace('Confirm final measurements', 'Sales confirmed final measurements'))).toContain('Sales confirmed');
});

it('rejects another salesperson before making any writes', async () => {
  await expect(updateAppointmentSalesNotes('ocular-1', 'Changed', 'sales-2', [Role.SALES_STAFF])).rejects.toThrow('Only the assigned sales staff');
  expect(mocks.appointmentUpdate).not.toHaveBeenCalled();
  expect(mocks.reportUpdate).not.toHaveBeenCalled();
});

it('keeps changes to an engineering package on the existing project revision flow', async () => {
  mocks.projectExists.mockResolvedValue({ _id: 'project-1' });
  await expect(updateAppointmentSalesNotes('ocular-1', 'Changed', 'sales-1', [Role.SALES_STAFF])).rejects.toThrow('through the project');
  expect(mocks.appointmentUpdate).not.toHaveBeenCalled();
  expect(mocks.projectUpdate).not.toHaveBeenCalled();
});
