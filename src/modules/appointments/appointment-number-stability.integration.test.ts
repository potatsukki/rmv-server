/**
 * An appointment keeps its public number (APT-YYYYMMDD-NNNN) for its whole life, against a REAL,
 * throwaway MongoDB database. QA 2026-11-25: APT-20261125-0003 showed as APT-20261125-0006 after its
 * automatic No Show. The every-minute job that starts consultations saved a record it had loaded
 * without its number, so the model hook gave it a new one at 9:00, before the 9:15 No Show.
 *
 * Skipped unless RMV_MONGO_TEST_URI points at a local database, e.g.
 *   RMV_MONGO_TEST_URI=mongodb://127.0.0.1:27017/rmv_repro_apt_number npx vitest run appointment-number-stability
 * The database named in the URI is dropped before and after the run. Never point it at real data.
 * With other real-DB test files, run them one at a time (--no-file-parallelism): they share the database.
 */
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const stubAll = vi.hoisted(() => (module: Record<string, unknown>) => Object.fromEntries(
  Object.entries(module).map(([key, value]) => [key, typeof value === 'function' ? vi.fn() : value]),
));

vi.mock('../notifications/socket.service.js', async (importOriginal) => stubAll(await importOriginal()));
vi.mock('../notifications/email.service.js', async (importOriginal) => stubAll(await importOriginal()));
vi.mock('../../services/paymongo.service.js', async (importOriginal) => stubAll(await importOriginal()));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { Appointment, AppointmentNumberCounter, AuditLog, Notification, User } from '../../models/index.js';
import { AppointmentAttendanceStatus, AppointmentStatus, AppointmentType, AuditAction, NotificationCategory, Role } from '../../utils/constants.js';
import { restoreAppointmentNumber } from '../../services/appointmentNumberRestore.js';
import { processAutomaticConsultationNoShows } from './appointments.service.js';
import { processAutomatedConsultationAttendance } from './consultation-attendance-automation.js';

const MONGO_URI = process.env.RMV_MONGO_TEST_URI;
const DATE = '2026-11-25';
// 9:00 AM and 9:16 AM on Nov 25 in Manila.
const NINE_AM = new Date('2026-11-25T01:00:00.000Z');
const AFTER_GRACE = new Date('2026-11-25T01:16:00.000Z');

describe.runIf(Boolean(MONGO_URI))('appointment number on a real database (QA APT-20261125-0003)', () => {
  let customerId: string;
  let salesId: string;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI!);
    if (!mongoose.connection.name.includes('repro') && !mongoose.connection.name.includes('test')) {
      throw new Error(`Refusing to use database "${mongoose.connection.name}": its name must contain "repro" or "test".`);
    }
    await mongoose.connection.dropDatabase();
    for (const model of [User, Appointment, AppointmentNumberCounter, AuditLog, Notification]) await model.syncIndexes();
  }, 60_000);

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
    customerId = await createUser('customer01@example.test', [Role.CUSTOMER]);
    salesId = await createUser('sales01@example.test', [Role.SALES_STAFF]);
  });

  async function createUser(email: string, roles: Role[]) {
    return String((await User.create({ email, firstName: email.split('@')[0], lastName: 'Test', roles, isActive: true }))._id);
  }

  /** An office consultation confirmed with the sales staff, not checked in yet. */
  function confirmedConsultation(slotCode: string) {
    return Appointment.create({
      customerId, type: AppointmentType.OFFICE, date: DATE, slotCode, status: AppointmentStatus.CONFIRMED,
      salesStaffId: salesId, attendanceStatus: AppointmentAttendanceStatus.SCHEDULED, bookedBy: customerId,
    });
  }

  async function numberOf(id: unknown) {
    return (await Appointment.findById(id).select('appointmentNumber').lean())?.appointmentNumber;
  }

  it('keeps the booking number through the 9:00 automatic start and the 9:15 automatic No Show', async () => {
    // Like QA's Nov 25: other bookings that day already used some numbers.
    await confirmedConsultation('13:00');
    await confirmedConsultation('14:00');
    const target = await confirmedConsultation('09:00');
    expect(target.appointmentNumber).toBe('APT-20261125-0003');

    // 9:00: the every-minute job starts the consultation (Scheduled → In Progress).
    await expect(processAutomatedConsultationAttendance(NINE_AM)).resolves.toBe(1);
    const started = await Appointment.findById(target._id).lean();
    expect(started?.attendanceStatus).toBe(AppointmentAttendanceStatus.IN_PROGRESS);
    expect(started?.appointmentNumber).toBe('APT-20261125-0003');

    // 9:16: still no check-in, so it closes as No Show with the same number.
    await expect(processAutomaticConsultationNoShows(AFTER_GRACE)).resolves.toBe(1);
    const closed = await Appointment.findById(target._id).lean();
    expect(closed).toMatchObject({
      status: AppointmentStatus.COMPLETED,
      attendanceStatus: AppointmentAttendanceStatus.NO_SHOW,
      appointmentNumber: 'APT-20261125-0003',
    });
    // No number was used up by the start or the No Show.
    expect((await AppointmentNumberCounter.findOne({ date: DATE }).lean())?.lastSeq).toBe(3);
  });

  it('keeps the number when a record loaded without it (a field list) is saved', async () => {
    const target = await confirmedConsultation('10:00');

    const partial = await Appointment.findById(target._id).select('date status attendanceStatus');
    partial!.attendanceStatus = AppointmentAttendanceStatus.IN_PROGRESS;
    await partial!.save();

    expect(await numberOf(target._id)).toBe(target.appointmentNumber);
    expect((await AppointmentNumberCounter.findOne({ date: DATE }).lean())?.lastSeq).toBe(1);
  });

  it('still numbers a new booking, and an old record without a number when it is fully loaded and saved', async () => {
    const fresh = await confirmedConsultation('11:00');
    expect(fresh.appointmentNumber).toBe('APT-20261125-0001');

    const customer = new mongoose.Types.ObjectId(customerId);
    const { insertedId } = await Appointment.collection.insertOne({
      customerId: customer, bookedBy: customer, type: AppointmentType.OFFICE, date: DATE, slotCode: '15:00',
      status: AppointmentStatus.CONFIRMED,
    });
    const legacy = await Appointment.findById(insertedId);
    legacy!.customerNotes = 'Booked before appointment numbers existed';
    await legacy!.save();

    expect(await numberOf(insertedId)).toBe('APT-20261125-0002');
  });

  describe('restoreAppointmentNumber (VPS script for the QA appointment)', () => {
    /** QA's case: the 9:00 consultation was booked as 0003, then replaced by 0006 (the old bug). */
    async function renumberedAppointment() {
      await confirmedConsultation('13:00');
      await confirmedConsultation('14:00');
      const target = await confirmedConsultation('09:00');
      await Appointment.updateOne({ _id: target._id }, { $set: { appointmentNumber: 'APT-20261125-0006' } });
      const noShowNotice = await Notification.create({
        userId: customerId, category: NotificationCategory.APPOINTMENT, title: 'Consultation Marked as No-Show',
        message: 'Your consultation APT-20261125-0006 on Nov 25, 2026 at 9:00 AM was marked as a no-show.',
        link: `/appointments/${String(target._id)}`,
      });
      // Another appointment's notification that happens to mention the same text stays as it is.
      const otherNotice = await Notification.create({
        userId: salesId, category: NotificationCategory.APPOINTMENT, title: 'Consultation No-Show',
        message: 'APT-20261125-0006 · Someone Else · Nov 25, 2026 at 9:00 AM',
        link: `/appointments/${String(new mongoose.Types.ObjectId())}`,
      });
      return { target, noShowNotice, otherNotice };
    }

    it('changes nothing on a dry run', async () => {
      const { target, noShowNotice } = await renumberedAppointment();

      await expect(restoreAppointmentNumber(String(target._id), 'APT-20261125-0003')).resolves.toMatchObject({
        from: 'APT-20261125-0006', to: 'APT-20261125-0003', notifications: 1, applied: false,
      });

      expect(await numberOf(target._id)).toBe('APT-20261125-0006');
      expect((await Notification.findById(noShowNotice._id).lean())?.message).toContain('APT-20261125-0006');
      expect(await AuditLog.countDocuments({ targetId: target._id })).toBe(0);
    });

    it('puts back the original number and its notifications, and records it', async () => {
      const { target, noShowNotice, otherNotice } = await renumberedAppointment();

      await expect(restoreAppointmentNumber(String(target._id), 'APT-20261125-0003', { apply: true })).resolves.toMatchObject({
        from: 'APT-20261125-0006', to: 'APT-20261125-0003', notifications: 1, applied: true,
      });

      expect(await numberOf(target._id)).toBe('APT-20261125-0003');
      expect((await Notification.findById(noShowNotice._id).lean())?.message)
        .toBe('Your consultation APT-20261125-0003 on Nov 25, 2026 at 9:00 AM was marked as a no-show.');
      expect((await Notification.findById(otherNotice._id).lean())?.message).toContain('APT-20261125-0006');
      const audit = await AuditLog.findOne({ targetId: target._id }).lean();
      expect(audit).toMatchObject({
        action: AuditAction.APPOINTMENT_UPDATED,
        details: { action: 'appointment_number_restored', from: 'APT-20261125-0006', to: 'APT-20261125-0003', notificationsUpdated: 1 },
      });
      expect(audit?.actorId).toBeUndefined();
    });

    it('refuses a number another appointment has, a number for another date, or a wrong id', async () => {
      const { target } = await renumberedAppointment();
      const id = String(target._id);

      await expect(restoreAppointmentNumber(id, 'APT-20261125-0001', { apply: true })).rejects.toThrow('already belongs to another appointment');
      await expect(restoreAppointmentNumber(id, 'APT-20261126-0003', { apply: true })).rejects.toThrow('is a number for 2026-11-26');
      await expect(restoreAppointmentNumber(id, 'APT-3', { apply: true })).rejects.toThrow('is not an appointment number');
      await expect(restoreAppointmentNumber(id, 'APT-20261125-0006', { apply: true })).rejects.toThrow('already has');
      await expect(restoreAppointmentNumber('not-an-id', 'APT-20261125-0003')).rejects.toThrow('not a valid appointment id');
      await expect(restoreAppointmentNumber(String(new mongoose.Types.ObjectId()), 'APT-20261125-0003')).rejects.toThrow('No appointment has the id');
      expect(await numberOf(target._id)).toBe('APT-20261125-0006');
    });
  });
});
