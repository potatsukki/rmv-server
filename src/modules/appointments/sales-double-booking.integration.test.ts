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

import { Appointment, BlockedSlot, SalesAvailability, SlotLock, User } from '../../models/index.js';
import { AppointmentStatus, AppointmentType, Role } from '../../utils/constants.js';
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
    await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
    staffA = await createUser('salesa@example.test', [Role.SALES_STAFF]);
    customers = [];
    for (let i = 1; i <= 4; i += 1) customers.push(await createUser(`customer0${i}@example.test`, [Role.CUSTOMER]));
  });

  async function freeSlots() {
    const { slots } = await appointments.getAvailableSlots({ date: DATE, type: AppointmentType.OFFICE });
    return slots.filter((slot) => slot.available).map((slot) => slot.slotCode);
  }

  function book(customerIndex: number, slotCode: string) {
    return appointments.requestAppointment(
      { type: AppointmentType.OFFICE, date: DATE, slotCode, purpose: 'Railings', serviceTypes: ['railings'] } as never,
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
    await expect(book(0, '11:00')).resolves.toBeDefined();
  });

  it('an ocular visit closes its whole busy time (travel + traffic + 1.5 hr on site)', async () => {
    // 13:00 ocular, 48 min / 41 km away: away 11:00 AM – 4:30 PM.
    await staffAppointment({ type: AppointmentType.OCULAR, slotCode: '13:00', travelDurationMinutes: 48, distanceKm: 41 });

    expect(await freeSlots()).toEqual(['09:00', '10:00']);
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

  // Reproduces the QA bug (fails today); enabled again with the Travel Time S4 fix (holdsStaffTime).
  it.skip('an appointment completed early (before its time) still holds that time', async () => {
    // Completed on Nov 26 (day check bypassed) although it is scheduled for Nov 28 at 10:00.
    await staffAppointment({ status: AppointmentStatus.COMPLETED });

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
});
