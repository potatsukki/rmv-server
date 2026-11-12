/**
 * Sales staff availability against a REAL, throwaway MongoDB database: the agent's assignment list
 * (every staff member, busy ones disabled with a reason), the customer's slot capacity for the same
 * date and time, and the booking-agent attribution through assignment and transfer.
 *
 * Skipped unless RMV_MONGO_TEST_URI points at a local database, e.g.
 *   RMV_MONGO_TEST_URI=mongodb://127.0.0.1:27017/rmv_repro_capacity npx vitest run sales-capacity-eligibility
 * The database named in the URI is dropped before and after the run. Never point it at real data.
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

import { Appointment, BlockedSlot, Project, SalesAvailability, SlotLock, User, VisitReport } from '../../models/index.js';
import { AppointmentStatus, AppointmentType, Role, StaffAvailabilityStatus } from '../../utils/constants.js';
import * as appointments from './appointments.service.js';
import { listByRole } from '../users/users.service.js';

const MONGO_URI = process.env.RMV_MONGO_TEST_URI;
const DATE = '2026-11-15';
const SLOT = '10:00';

type ListedStaff = { _id: unknown; assignmentEligible?: boolean; assignmentBlockedReason?: string };

describe.runIf(Boolean(MONGO_URI))('sales staff capacity and assignment on a real database (Nov 15, 10 AM retest)', () => {
  let agentId: string;
  let adminId: string;
  let customerId: string;
  let staff: Record<'s1' | 's2' | 's3' | 's4' | 's5' | 's6' | 'unavailable' | 'blocked', string>;
  let targetId: string;
  let conflictNumber: string;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Nov 11, 2026: Nov 15 is past the 3-day minimum lead time.
    vi.setSystemTime(new Date('2026-11-11T02:00:00Z'));
    await mongoose.connect(MONGO_URI!);
    if (!mongoose.connection.name.includes('repro') && !mongoose.connection.name.includes('test')) {
      throw new Error(`Refusing to use database "${mongoose.connection.name}": its name must contain "repro" or "test".`);
    }
    await mongoose.connection.dropDatabase();
    for (const model of [User, Appointment, SalesAvailability, BlockedSlot, SlotLock, VisitReport, Project]) await model.syncIndexes();
  }, 60_000);

  afterAll(async () => {
    vi.useRealTimers();
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  async function createUser(email: string, roles: Role[], extra: Record<string, unknown> = {}) {
    return String((await User.create({ email, firstName: email.split('@')[0], lastName: 'Test', roles, isActive: true, ...extra }))._id);
  }

  async function officeAppointment(fields: Record<string, unknown>) {
    return Appointment.create({
      customerId, type: AppointmentType.OFFICE, date: DATE, slotCode: SLOT, bookedBy: customerId, ...fields,
    });
  }

  async function listForTarget(): Promise<Map<string, ListedStaff>> {
    const listed = await listByRole(Role.SALES_STAFF, undefined, { date: DATE, slotCode: SLOT, appointmentId: targetId }) as ListedStaff[];
    return new Map(listed.map((member) => [String(member._id), member]));
  }

  async function customerCapacity() {
    const { slots } = await appointments.getAvailableSlots({ date: DATE, type: AppointmentType.OFFICE });
    return slots.find((slot) => slot.slotCode === SLOT)!.remaining;
  }

  beforeEach(async () => {
    await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
    agentId = await createUser('agent01@example.test', [Role.APPOINTMENT_AGENT]);
    adminId = await createUser('admin01@example.test', [Role.ADMIN]);
    customerId = await createUser('customer01@example.test', [Role.CUSTOMER]);
    staff = {
      s1: await createUser('sales01@example.test', [Role.SALES_STAFF]),
      s2: await createUser('sales02@example.test', [Role.SALES_STAFF]),
      s3: await createUser('sales03@example.test', [Role.SALES_STAFF]),
      s4: await createUser('sales04@example.test', [Role.SALES_STAFF]),
      s5: await createUser('sales05@example.test', [Role.SALES_STAFF]),
      s6: await createUser('sales06@example.test', [Role.SALES_STAFF]),
      unavailable: await createUser('sales07@example.test', [Role.SALES_STAFF], { availabilityStatus: StaffAvailabilityStatus.UNAVAILABLE }),
      blocked: await createUser('sales08@example.test', [Role.SALES_STAFF]),
    };
    await SalesAvailability.create({ salesStaffId: staff.blocked, unavailableDates: [DATE], updatedBy: adminId });

    // The appointment being reassigned: booked and confirmed by the agent, assigned to S6.
    const target = await officeAppointment({
      status: AppointmentStatus.CONFIRMED, salesStaffId: staff.s6,
      bookedBy: agentId, assignedBy: agentId, confirmedBy: agentId,
    });
    targetId = String(target._id);
    // S5 already has another consultation at the same time.
    const otherCustomer = await createUser('customer02@example.test', [Role.CUSTOMER]);
    const conflict = await officeAppointment({ customerId: otherCustomer, bookedBy: otherCustomer, status: AppointmentStatus.CONFIRMED, salesStaffId: staff.s5 });
    conflictNumber = conflict.appointmentNumber!;
  });

  it('lists every sales staff member; busy ones stay in the list, disabled with a reason', async () => {
    const listed = await listForTarget();

    expect(listed.size).toBe(8);
    for (const id of [staff.s1, staff.s2, staff.s3, staff.s4, staff.s6]) {
      expect(listed.get(id)?.assignmentEligible).toBe(true);
    }
    expect(conflictNumber).toBeTruthy();
    expect(listed.get(staff.s5)).toMatchObject({ assignmentEligible: false });
    expect(listed.get(staff.s5)?.assignmentBlockedReason).toContain('Already has an appointment at this time');
    expect(listed.get(staff.s5)?.assignmentBlockedReason).toContain(conflictNumber);
    expect(listed.get(staff.unavailable)).toMatchObject({ assignmentEligible: false, assignmentBlockedReason: 'Unavailable' });
    expect(listed.get(staff.blocked)).toMatchObject({ assignmentEligible: false, assignmentBlockedReason: 'Blocked on this date' });
  });

  it('shows customers as many free staff as the agent can assign for the same date and time', async () => {
    const listed = await listForTarget();
    // Assignable to the appointment = eligible and not already its staff (S6).
    const assignable = [...listed.entries()].filter(([id, member]) => member.assignmentEligible && id !== staff.s6);

    expect(assignable.map(([id]) => id).sort()).toEqual([staff.s1, staff.s2, staff.s3, staff.s4].sort());
    expect(await customerCapacity()).toBe(assignable.length);
  });

  it('also counts an unassigned request against customer capacity (it will need a staff member of its own)', async () => {
    await officeAppointment({ status: AppointmentStatus.REQUESTED });

    expect(await customerCapacity()).toBe(3);
    // Each staff member is still individually assignable until the request is assigned.
    const listed = await listForTarget();
    expect([staff.s1, staff.s2, staff.s3, staff.s4].every((id) => listed.get(id)?.assignmentEligible)).toBe(true);
  });

  it('keeps the booking agent when the appointment is transferred, and refuses a busy staff member', async () => {
    await appointments.reassignAppointmentSales(targetId, { salesStaffId: staff.s1, reason: 'Retest transfer' }, agentId, [Role.APPOINTMENT_AGENT]);

    const moved = await Appointment.findById(targetId).lean();
    expect(String(moved!.salesStaffId)).toBe(staff.s1);
    expect(moved!.status).toBe(AppointmentStatus.CONFIRMED);
    expect([moved!.bookedBy, moved!.assignedBy, moved!.confirmedBy].map(String)).toEqual([agentId, agentId, agentId]);
    // S6 is free again and S1 is taken: still four free.
    expect(await customerCapacity()).toBe(4);

    await expect(appointments.reassignAppointmentSales(targetId, { salesStaffId: staff.s5 }, agentId, [Role.APPOINTMENT_AGENT]))
      .rejects.toThrow('Already has an appointment at this time');
    expect(String((await Appointment.findById(targetId).lean())!.salesStaffId)).toBe(staff.s1);
  });

  it('records the assigning agent on a customer booking and keeps it through an admin transfer', async () => {
    const request = await officeAppointment({ slotCode: '13:00', status: AppointmentStatus.REQUESTED });
    const requestId = String(request._id);

    await appointments.confirmAppointment(requestId, { salesStaffId: staff.s2 } as never, agentId);
    const assigned = await Appointment.findById(requestId).lean();
    expect(assigned!.status).toBe(AppointmentStatus.CONFIRMED);
    expect(String(assigned!.bookedBy)).toBe(customerId);
    expect([assigned!.assignedBy, assigned!.confirmedBy].map(String)).toEqual([agentId, agentId]);

    await appointments.reassignAppointmentSales(requestId, { salesStaffId: staff.s3 }, adminId, [Role.ADMIN]);
    const transferred = await Appointment.findById(requestId).lean();
    expect(String(transferred!.salesStaffId)).toBe(staff.s3);
    expect(String(transferred!.bookedBy)).toBe(customerId);
    expect([transferred!.assignedBy, transferred!.confirmedBy].map(String)).toEqual([agentId, agentId]);
  });
});
