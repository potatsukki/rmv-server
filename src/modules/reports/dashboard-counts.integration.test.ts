/**
 * Dashboard counts against a REAL, throwaway MongoDB database (user decision 2026-11-27: finished
 * appointments are not counted on the dashboard).
 *
 * Skipped unless RMV_MONGO_TEST_URI points at a local database, e.g.
 *   RMV_MONGO_TEST_URI=mongodb://127.0.0.1:27017/rmv_repro_dashboard npx vitest run dashboard-counts
 * The database named in the URI is dropped before and after the run. Never point it at real data.
 */
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { Appointment, VisitReport } from '../../models/index.js';
import { getDashboardSummary } from './reports.service.js';

const MONGO_URI = process.env.RMV_MONGO_TEST_URI;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());

describe.runIf(Boolean(MONGO_URI))('dashboard counts on a real database', () => {
  const salesId = new Types.ObjectId();
  const otherSalesId = new Types.ObjectId();
  const customerId = new Types.ObjectId();
  let testDatabaseInitialized = false;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI!);
    if (!mongoose.connection.name.includes('repro') && !mongoose.connection.name.includes('test')) {
      throw new Error(`Refusing to use database "${mongoose.connection.name}": its name must contain "repro" or "test".`);
    }
    await mongoose.connection.dropDatabase();
    testDatabaseInitialized = true;

    const appointment = (slotCode: string, extra: Record<string, unknown>) => ({
      _id: new Types.ObjectId(), customerId, salesStaffId: salesId, type: 'office', date: today, slotCode,
      status: 'confirmed', attendanceStatus: 'scheduled', ...extra,
    });
    const upcoming = appointment('09:00', {});
    const completed = appointment('10:00', { status: 'completed', attendanceStatus: 'completed' });
    const declined = appointment('11:00', { status: 'completed', attendanceStatus: 'customer_declined' });
    const noShow = appointment('13:00', { status: 'completed', attendanceStatus: 'no_show' });
    const inProgress = appointment('14:00', { status: 'in_progress', attendanceStatus: 'in_progress' });
    const othersToday = appointment('09:00', { salesStaffId: otherSalesId });
    await Appointment.collection.insertMany([upcoming, completed, declined, noShow, inProgress, othersToday]);

    const report = (appointmentId: Types.ObjectId, status: string) => ({
      appointmentId, customerId, salesStaffId: salesId, status, visitType: 'consultation', serviceType: 'railings',
      createdAt: new Date(), updatedAt: new Date(),
    });
    await VisitReport.collection.insertMany([
      report(upcoming._id, 'draft'),
      report(completed._id, 'submitted'),
      report(declined._id, 'draft'),
      report(noShow._id, 'draft'),
      report(inProgress._id, 'draft'),
    ]);
  }, 60_000);

  afterAll(async () => {
    if (mongoose.connection.readyState !== 1) return;
    try {
      if (testDatabaseInitialized) await mongoose.connection.dropDatabase();
    } finally {
      await mongoose.disconnect();
    }
  });

  it("Sales Staff: Today's Schedule counts their own appointments still to happen or under way", async () => {
    const summary = await getDashboardSummary(String(salesId), ['sales_staff']);
    // 09:00 appointed + 14:00 in progress; not completed / Customer Declined / No Show, not the other staff's.
    expect(summary.totalAppointmentsToday).toBe(2);
  });

  it('Sales Staff: Pending Reports leaves out drafts that can never be submitted (Customer Declined, No Show)', async () => {
    const summary = await getDashboardSummary(String(salesId), ['sales_staff']);
    // Drafts of 09:00 and 14:00 count; 10:00 is submitted; 11:00 declined and 13:00 no-show are closed.
    expect(summary.pendingVisitReports).toBe(2);
  });

  it("Admin: Today's Schedule counts the whole operation, still without finished appointments", async () => {
    const summary = await getDashboardSummary(String(new Types.ObjectId()), ['admin']);
    expect(summary.totalAppointmentsToday).toBe(3);
  });
});
