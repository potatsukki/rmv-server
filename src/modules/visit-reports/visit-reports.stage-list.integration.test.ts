/**
 * Visit report lists split by stage, against a REAL, throwaway MongoDB database:
 * Appointments → Visit Reports (stage=appointment) vs Projects → Visit Reports (stage=project).
 *
 * Skipped unless RMV_MONGO_TEST_URI points at a local database, e.g.
 *   RMV_MONGO_TEST_URI=mongodb://127.0.0.1:27017/rmv_repro_stage npx vitest run visit-reports.stage-list
 * The database named in the URI is dropped before and after the run. Never point it at real data.
 */
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { Appointment, Project, VisitReport } from '../../models/index.js';
import * as visitReports from './visit-reports.service.js';

const MONGO_URI = process.env.RMV_MONGO_TEST_URI;

describe.runIf(Boolean(MONGO_URI))('visit report lists by stage on a real database', () => {
  const salesId = new Types.ObjectId();
  const customerId = new Types.ObjectId();
  const ids = {
    noProject: new Types.ObjectId(),
    draftProject: new Types.ObjectId(),
    createdProject: new Types.ObjectId(),
    legacyCreated: new Types.ObjectId(),
    cancelledDraft: new Types.ObjectId(),
  };

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI!);
    if (!mongoose.connection.name.includes('repro') && !mongoose.connection.name.includes('test')) {
      throw new Error(`Refusing to use database "${mongoose.connection.name}": its name must contain "repro" or "test".`);
    }
    await mongoose.connection.dropDatabase();

    const forOcular = new Types.ObjectId();
    const submitted = new Types.ObjectId();
    const legacy = new Types.ObjectId();
    const cancelledAppointment = new Types.ObjectId();
    const openAppointment = new Types.ObjectId();
    // Raw inserts: only the fields the list filters read.
    await Appointment.collection.insertMany([
      { _id: cancelledAppointment, status: 'cancelled', type: 'consultation', salesStaffId: salesId, customerId },
      { _id: openAppointment, status: 'completed', type: 'consultation', salesStaffId: salesId, customerId },
    ]);
    await Project.collection.insertMany([
      { _id: forOcular, projectNumber: 'PRJ-T-1', status: 'draft', salesStaffId: salesId, customerId },
      { _id: submitted, projectNumber: 'PRJ-T-2', status: 'submitted', salesStaffId: salesId, customerId },
      { _id: legacy, projectNumber: 'PRJ-T-3', status: 'blueprint', salesStaffId: salesId, customerId, visitReportId: ids.legacyCreated },
    ]);
    const report = (_id: Types.ObjectId, extra: Record<string, unknown>) => ({
      _id, salesStaffId: salesId, customerId, appointmentId: openAppointment,
      status: 'submitted', visitType: 'ocular', serviceType: 'railings', updatedAt: new Date(), ...extra,
    });
    await VisitReport.collection.insertMany([
      report(ids.noProject, { status: 'draft' }),
      report(ids.draftProject, { linkedProjectId: forOcular }),
      report(ids.createdProject, { linkedProjectId: submitted, status: 'returned' }),
      report(ids.legacyCreated, {}),
      report(ids.cancelledDraft, { status: 'draft', appointmentId: cancelledAppointment }),
    ]);
  }, 60_000);

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  const listed = (result: { items: Array<{ _id: Types.ObjectId }> }) => result.items.map((item) => String(item._id)).sort();
  const expected = (...keys: Array<keyof typeof ids>) => keys.map((key) => String(ids[key])).sort();

  it.each([
    ['admin', () => visitReports.listAll({ stage: 'appointment' })],
    ['sales staff', () => visitReports.listForSalesStaff(String(salesId), { stage: 'appointment' })],
  ])('%s: appointment stage keeps reports with no project or a draft (For Ocular) project', async (_role, list) => {
    expect(listed(await list())).toEqual(expected('noProject', 'draftProject'));
  });

  it.each([
    ['admin', () => visitReports.listAll({ stage: 'project' })],
    ['sales staff', () => visitReports.listForSalesStaff(String(salesId), { stage: 'project' })],
  ])('%s: project stage lists reports of created projects, linked or legacy', async (_role, list) => {
    expect(listed(await list())).toEqual(expected('createdProject', 'legacyCreated'));
  });

  it('combines the stage with the status filter and still hides cancelled drafts', async () => {
    expect(listed(await visitReports.listAll({ stage: 'project', status: 'returned' }))).toEqual(expected('createdProject'));
    expect(listed(await visitReports.listForSalesStaff(String(salesId), { stage: 'appointment', status: 'pending' }))).toEqual(expected('noProject'));
    expect(listed(await visitReports.listAll({}))).toEqual(expected('noProject', 'draftProject', 'createdProject', 'legacyCreated'));
  });
});
