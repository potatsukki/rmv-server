/**
 * QA 2026-11-26 (Notifications "1 day ago" and a No Show that looked delayed), against a REAL,
 * throwaway MongoDB. A 9:00 AM office consultation without a check-in becomes a No Show from 9:15
 * (Manila), its notifications are created at that moment (their createdAt is what "x minutes ago"
 * counts from), and a checked-in consultation is never closed as No Show.
 *
 * Skipped unless RMV_MONGO_TEST_URI points at a local database, e.g.
 *   RMV_MONGO_TEST_URI=mongodb://127.0.0.1:27017/rmv_repro_no_show_timing npx vitest run consultation-no-show-timing
 * The database named in the URI is dropped before and after the run. Never point it at real data.
 * With other real-DB test files, run them one at a time (--no-file-parallelism): they share the database.
 */
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const stubAll = vi.hoisted(() => (module: Record<string, unknown>) => Object.fromEntries(
  Object.entries(module).map(([key, value]) => [key, typeof value === 'function' ? vi.fn() : value]),
));

// Notifications stay real (they are what this checks); email and payments are stubbed.
vi.mock('../notifications/email.service.js', async (importOriginal) => stubAll(await importOriginal()));
vi.mock('../../services/paymongo.service.js', async (importOriginal) => stubAll(await importOriginal()));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { Appointment, AppointmentNumberCounter, AppointmentQueueCounter, AuditLog, Notification, User } from '../../models/index.js';
import { AppointmentAttendanceStatus, AppointmentStatus, AppointmentType, Role } from '../../utils/constants.js';
import { processAutomaticConsultationNoShows, updateConsultationAttendance } from './appointments.service.js';
import { processAutomatedConsultationAttendance } from './consultation-attendance-automation.js';

const MONGO_URI = process.env.RMV_MONGO_TEST_URI;
const DATE = '2026-11-25';
/** A Manila time on Nov 25, 2026. */
const at = (time: string) => new Date(`${DATE}T${time}+08:00`);

describe.runIf(Boolean(MONGO_URI))('consultation No Show timing on a real database (QA 2026-11-26)', () => {
  let customerId: string;
  let salesId: string;
  let agentId: string;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI!);
    if (!mongoose.connection.name.includes('repro') && !mongoose.connection.name.includes('test')) {
      throw new Error(`Refusing to use database "${mongoose.connection.name}": its name must contain "repro" or "test".`);
    }
    await mongoose.connection.dropDatabase();
    for (const model of [User, Appointment, AppointmentNumberCounter, AppointmentQueueCounter, AuditLog, Notification]) {
      await model.syncIndexes();
    }
  }, 60_000);

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    // Only Date is faked: the "server clock" the services and Mongoose timestamps read.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at('08:00:00'));
    await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
    customerId = await createUser('customer01@example.test', [Role.CUSTOMER]);
    salesId = await createUser('sales01@example.test', [Role.SALES_STAFF]);
    agentId = await createUser('agent01@example.test', [Role.APPOINTMENT_AGENT]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function createUser(email: string, roles: Role[]) {
    return String((await User.create({ email, firstName: email.split('@')[0], lastName: 'Test', roles, isActive: true }))._id);
  }

  /** A 9:00 AM office consultation confirmed with the sales staff, not checked in yet. */
  async function nineAmConsultation() {
    const appointment = await Appointment.create({
      customerId, type: AppointmentType.OFFICE, date: DATE, slotCode: '09:00', status: AppointmentStatus.CONFIRMED,
      salesStaffId: salesId, attendanceStatus: AppointmentAttendanceStatus.SCHEDULED, bookedBy: customerId,
    });
    return String(appointment._id);
  }

  async function noShowNotifications() {
    return Notification.find({ title: /no-show/i }).sort({ title: 1 }).lean();
  }

  it('no check-in: still open at 9:14:59, closed by the automatic job at 9:15:00, notifications stamped 9:15:00', async () => {
    const id = await nineAmConsultation();

    vi.setSystemTime(at('09:00:00'));
    await expect(processAutomatedConsultationAttendance(new Date())).resolves.toBe(1);

    vi.setSystemTime(at('09:14:59'));
    await expect(processAutomaticConsultationNoShows(new Date())).resolves.toBe(0);
    expect((await Appointment.findById(id).lean())?.status).toBe(AppointmentStatus.CONFIRMED);
    expect(await noShowNotifications()).toHaveLength(0);

    vi.setSystemTime(at('09:15:00'));
    await expect(processAutomaticConsultationNoShows(new Date())).resolves.toBe(1);

    const closed = await Appointment.findById(id).lean();
    expect(closed).toMatchObject({ status: AppointmentStatus.COMPLETED, attendanceStatus: AppointmentAttendanceStatus.NO_SHOW });
    expect(closed?.consultationCompletedAt?.toISOString()).toBe(at('09:15:00').toISOString());

    const notifications = await noShowNotifications();
    expect(notifications.map((notification) => [String(notification.userId), notification.title])).toEqual(
      expect.arrayContaining([
        [customerId, 'Consultation Marked as No-Show'],
        [salesId, 'Consultation No-Show'],
        [agentId, 'Consultation No-Show'],
      ]),
    );
    expect(notifications).toHaveLength(3);
    // "x minutes ago" counts from here: the moment of the No Show, not the appointment date.
    for (const notification of notifications) {
      expect(notification.createdAt.toISOString()).toBe(at('09:15:00').toISOString());
    }
  });

  it('no check-in: the sales staff can mark No Show from 9:15:00, not at 9:14:59', async () => {
    const id = await nineAmConsultation();
    vi.setSystemTime(at('09:00:00'));
    await processAutomatedConsultationAttendance(new Date());

    vi.setSystemTime(at('09:14:59'));
    await expect(updateConsultationAttendance(id, { action: 'no_show', notes: 'Did not arrive' }, salesId, [Role.SALES_STAFF]))
      .rejects.toThrow(/from 9:15 AM/);

    vi.setSystemTime(at('09:15:00'));
    await updateConsultationAttendance(id, { action: 'no_show', notes: 'Did not arrive' }, salesId, [Role.SALES_STAFF]);

    expect(await Appointment.findById(id).lean()).toMatchObject({
      status: AppointmentStatus.COMPLETED,
      attendanceStatus: AppointmentAttendanceStatus.NO_SHOW,
    });
    const notifications = await noShowNotifications();
    // Everyone affected except the sales staff who recorded it.
    expect(notifications.map((notification) => String(notification.userId)).sort()).toEqual([agentId, customerId].sort());
    for (const notification of notifications) {
      expect(notification.createdAt.toISOString()).toBe(at('09:15:00').toISOString());
    }
  });

  it('checked in at 9:05: never closed as No Show, and the No Show button is refused', async () => {
    const id = await nineAmConsultation();
    vi.setSystemTime(at('09:00:00'));
    await processAutomatedConsultationAttendance(new Date());

    vi.setSystemTime(at('09:05:00'));
    await updateConsultationAttendance(id, { action: 'check_in' }, salesId, [Role.SALES_STAFF]);

    vi.setSystemTime(at('09:15:00'));
    await expect(processAutomaticConsultationNoShows(new Date())).resolves.toBe(0);
    vi.setSystemTime(at('09:30:00'));
    await expect(processAutomaticConsultationNoShows(new Date())).resolves.toBe(0);
    await expect(updateConsultationAttendance(id, { action: 'no_show', notes: 'Left' }, salesId, [Role.SALES_STAFF]))
      .rejects.toThrow(/already checked in/);

    const open = await Appointment.findById(id).lean();
    expect(open?.status).toBe(AppointmentStatus.CONFIRMED);
    expect(open?.attendanceStatus).not.toBe(AppointmentAttendanceStatus.NO_SHOW);
    expect(open?.actualArrivalAt?.toISOString()).toBe(at('09:05:00').toISOString());
    expect(await noShowNotifications()).toHaveLength(0);
  });
});
