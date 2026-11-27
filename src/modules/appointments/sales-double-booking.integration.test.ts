/**
 * QA 2026-11-26 "customers can still book while the sales staff already has an appointment":
 * customer booking against the sales staff's existing consultations and ocular visits, on a REAL,
 * throwaway MongoDB database.
 *
 * Skipped unless RMV_MONGO_TEST_URI points at a local database, e.g.
 *   RMV_MONGO_TEST_URI=mongodb://127.0.0.1:27017/rmv_repro_double_booking npx vitest run sales-double-booking
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

import { Appointment, BlockedSlot, Holiday, SalesAvailability, SlotLock, User } from '../../models/index.js';
import { AppointmentStatus, AppointmentType, Role, ServiceType, type SlotCode } from '../../utils/constants.js';
import * as appointments from './appointments.service.js';

const MONGO_URI = process.env.RMV_MONGO_TEST_URI;
const DATE = '2026-11-28';

describe.runIf(Boolean(MONGO_URI))('customer booking vs the sales staff schedule (real database)', () => {
  let staffA: string;
  let customers: string[];

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-26T02:00:00Z'));
    await mongoose.connect(MONGO_URI!);
    if (!mongoose.connection.name.includes('repro') && !mongoose.connection.name.includes('test')) {
      throw new Error(`Refusing to use database "${mongoose.connection.name}": its name must contain "repro" or "test".`);
    }
    await mongoose.connection.dropDatabase();
    for (const model of [User, Appointment, SalesAvailability, BlockedSlot, SlotLock]) await model.syncIndexes();
  }, 60_000);

  afterAll(async () => {
    vi.useRealTimers();
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  async function createUser(email: string, roles: Role[]) {
    return String((await User.create({ email, firstName: email.split('@')[0], lastName: 'Test', roles, isActive: true }))._id);
  }

  beforeEach(async () => {
    vi.setSystemTime(new Date('2026-11-26T02:00:00Z'));
    await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
    staffA = await createUser('salesa@example.test', [Role.SALES_STAFF]);
    customers = [];
    for (let i = 1; i <= 4; i += 1) customers.push(await createUser(`customer0${i}@example.test`, [Role.CUSTOMER]));
  });

  async function freeSlots() {
    const { slots } = await appointments.getAvailableSlots({ date: DATE, type: AppointmentType.OFFICE });
    return slots.filter((slot) => slot.available).map((slot) => slot.slotCode);
  }

  function book(customerIndex: number, slotCode: SlotCode, date = DATE) {
    return appointments.requestAppointment(
      { type: AppointmentType.OFFICE, date, slotCode, purpose: 'Railings', serviceTypes: [ServiceType.RAILINGS] },
      customers[customerIndex]!,
      [Role.CUSTOMER],
    );
  }

  function staffAppointment(fields: Record<string, unknown>) {
    return Appointment.create({
      customerId: customers[3], bookedBy: staffA, salesStaffId: staffA, date: DATE,
      type: AppointmentType.OFFICE, slotCode: '10:00', status: AppointmentStatus.CONFIRMED, ...fields,
    });
  }

  it('one sales staff with a 10:00 consultation: 10:00 is closed and refused, other hours stay open', async () => {
    await staffAppointment({});

    expect(await freeSlots()).toEqual(['09:00', '11:00', '13:00', '14:00', '15:00', '16:00']);
    await expect(book(0, '10:00')).rejects.toThrow('No sales staff is available');
    await expect(book(0, '09:00')).resolves.toBeDefined();
  });

  it('closes 9:00 for the staff member travelling to a 10:00 ocular visit and reopens it when another staff member is free', async () => {
    await staffAppointment({ type: AppointmentType.OCULAR, travelDurationMinutes: 30, distanceKm: 3 });

    expect(await freeSlots()).not.toContain('09:00');
    await expect(book(0, '09:00')).rejects.toThrow('No sales staff is available');

    await createUser('salesb@example.test', [Role.SALES_STAFF]);
    expect(await freeSlots()).toContain('09:00');
    await expect(book(0, '09:00')).resolves.toBeDefined();
  });

  it('an ocular visit closes its whole busy time (15 min prep + travel + traffic + 1.5 hr on site)', async () => {
    // 13:00 ocular, 48 min / 41 km away: busy 10:45 AM (prep) – 4:30 PM, so a 10:00 consultation (until 11:00) no longer fits.
    await staffAppointment({ type: AppointmentType.OCULAR, slotCode: '13:00', travelDurationMinutes: 48, distanceKm: 41 });

    expect(await freeSlots()).toEqual(['09:00']);
    await expect(book(0, '10:00')).rejects.toThrow('No sales staff is available');
    await expect(book(0, '16:00')).rejects.toThrow('No sales staff is available');
  });

  it('an ocular visit without a route (no site pin yet) takes the whole day', async () => {
    await staffAppointment({ type: AppointmentType.OCULAR, slotCode: '13:00' });

    expect(await freeSlots()).toEqual([]);
  });

  it('every active status holds the time; a cancelled appointment gives it back', async () => {
    for (const status of [AppointmentStatus.REQUESTED, AppointmentStatus.CONFIRMED, AppointmentStatus.ON_THE_WAY, AppointmentStatus.IN_PROGRESS]) {
      await Appointment.deleteMany({});
      await staffAppointment({ status });
      expect(await freeSlots(), status).not.toContain('10:00');
    }

    await Appointment.updateMany({}, { $set: { status: AppointmentStatus.CANCELLED } });
    expect(await freeSlots()).toContain('10:00');
    await expect(book(0, '10:00')).resolves.toBeDefined();
  });

  // User decision 2026-11-27 ("kung declined or completed dapat balik na to sa vacant"): a consultation
  // closed early gives its hour back; a completed ocular keeps its staff until the trip back ends.
  it('a consultation completed early (e.g. Customer Declined) makes its hour vacant again', async () => {
    // Closed on Nov 26 although it is scheduled for Nov 28 at 10:00.
    await staffAppointment({ status: AppointmentStatus.COMPLETED, attendanceStatus: 'customer_declined' });

    expect(await freeSlots()).toContain('10:00');
    await expect(book(0, '10:00')).resolves.toBeDefined();
  });

  it('an ocular visit completed early still keeps its staff away until the trip back ends', async () => {
    // A 10:00 ocular 45 min away (18 km) keeps staff A busy 6:45 AM – 3:30 PM on Nov 28.
    await staffAppointment({ type: AppointmentType.OCULAR, status: AppointmentStatus.COMPLETED, travelDurationMinutes: 45, distanceKm: 18 });

    expect(await freeSlots()).not.toContain('10:00');
    await expect(book(0, '10:00')).rejects.toThrow('No sales staff is available');
  });

  it('a second qualified sales staff keeps the slot open until both are taken', async () => {
    await createUser('salesb@example.test', [Role.SALES_STAFF]);
    await staffAppointment({});

    expect(await freeSlots()).toContain('10:00');
    await book(0, '10:00'); // unassigned request: it will need staff B
    expect(await freeSlots()).not.toContain('10:00');
    await expect(book(1, '10:00')).rejects.toThrow('No sales staff is available');
  });

  it('saves an upcoming same-day slot before 4 PM and refuses any same-day booking at the cutoff', async () => {
    const date = '2026-11-26';
    const query = { date, type: AppointmentType.OFFICE, flow: 'customer_booking' } as const;
    vi.setSystemTime(new Date(`${date}T15:59:59+08:00`));

    const { slots } = await appointments.getAvailableSlots(query);
    expect(slots.filter((slot) => slot.available).map((slot) => slot.slotCode)).toEqual(['16:00']);
    const saved = await book(0, '16:00', date);
    expect(saved).toMatchObject({ status: AppointmentStatus.REQUESTED, date, slotCode: '16:00' });

    vi.setSystemTime(new Date(`${date}T16:00:00+08:00`));
    await expect(appointments.getAvailableSlots(query)).rejects.toMatchObject({ code: 'BOOKING_TIME_UNAVAILABLE' });
    await expect(book(1, '16:00', date)).rejects.toMatchObject({ code: 'BOOKING_TIME_UNAVAILABLE' });
    expect(await Appointment.countDocuments({ date })).toBe(1);
  });

  it('keeps the holiday restriction on same-day bookings', async () => {
    const date = '2026-11-26';
    await Holiday.create({ date, name: 'Test holiday', createdBy: staffA });

    await expect(appointments.getAvailableSlots({ date, type: AppointmentType.OFFICE, flow: 'customer_booking' }))
      .rejects.toThrow('Test holiday');
    await expect(book(0, '16:00', date)).rejects.toThrow('Test holiday');
  });
});
