/**
 * One customer can never hold a consultation and an ocular visit that overlap, even with different
 * sales staff. Runs the real booking, project ocular and reschedule services against a REAL,
 * throwaway MongoDB database (the live case: APT-20261118-0004 and PRJ-2026-00101, both Nov 18, 9 AM).
 *
 * Skipped unless RMV_MONGO_TEST_URI points at a local database, e.g.
 *   RMV_MONGO_TEST_URI=mongodb://127.0.0.1:27017/rmv_repro_customer_overlap npx vitest run customer-schedule-conflict
 * The database named in the URI is dropped before and after the run. Never point it at real data.
 * With other real-DB test files, run them one at a time (--no-file-parallelism): they share the database.
 * Only outside services (notifications, email, maps, file storage, payments) are stubbed.
 */
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const stubAll = vi.hoisted(() => (module: Record<string, unknown>) => Object.fromEntries(
  Object.entries(module).map(([key, value]) => [key, typeof value === 'function' ? vi.fn() : value]),
));

vi.mock('../notifications/socket.service.js', async (importOriginal) => stubAll(await importOriginal()));
vi.mock('../notifications/email.service.js', async (importOriginal) => stubAll(await importOriginal()));
vi.mock('../../services/contract.service.js', async (importOriginal) => stubAll(await importOriginal()));
vi.mock('../../services/paymongo.service.js', async (importOriginal) => stubAll(await importOriginal()));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../uploads/upload.service.js', async (importOriginal) => ({
  ...stubAll(await importOriginal()),
  verifyFileExists: vi.fn(async () => true),
  generateDownloadUrl: vi.fn(async () => 'https://files.test/download'),
}));
vi.mock('../maps/maps.service.js', async (importOriginal) => ({
  ...stubAll(await importOriginal()),
  assertOcularLocationAccepted: vi.fn(async () => undefined),
  reverseGeocode: vi.fn(async () => ({ formattedAddress: 'Makati City, Metro Manila' })),
  computeOcularFee: vi.fn(async () => ({
    route: { distanceKm: 5, durationMinutes: 18 },
    fee: {
      label: 'Within NCR', baseFee: 0, baseCoveredKm: 0, perKmRate: 0,
      additionalDistanceKm: 0, additionalFee: 0, total: 0, isWithinNCR: true,
    },
  })),
}));

import { Appointment, Project, ProjectItem, SlotLock, User, VisitReport } from '../../models/index.js';
import { AppointmentAttendanceStatus, AppointmentStatus, AppointmentType, Role } from '../../utils/constants.js';
import * as appointments from './appointments.service.js';
import { getCustomerBookedSlots } from './customer-schedule-conflict.js';
import * as visitReports from '../visit-reports/visit-reports.service.js';
import * as projects from '../projects/projects.service.js';
import { acquireCustomerScheduleLock, acquireSalesDayLock, withSalesDayLocks } from './sales-day-lock.js';

const MONGO_URI = process.env.RMV_MONGO_TEST_URI;
const SITE = { customerLocation: { lat: 14.55, lng: 121.02 }, formattedAddress: 'Makati City, Metro Manila' };
/** The earliest bookable day on Nov 15 (3 days' notice): where the live records collided. */
const DAY = '2026-11-18';
const CONFLICT = { statusCode: 409, code: 'CUSTOMER_SCHEDULE_CONFLICT' };

describe.runIf(Boolean(MONGO_URI))('same customer, different sales staff: consultation and ocular visit never overlap (real database)', () => {
  let customerId: string;
  let otherCustomerId: string;
  let charlieId: string;
  let bugoyId: string;
  let agentId: string;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Nov 15, 2026, 8:00 PM Manila: the evening the live records were created.
    vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
    await mongoose.connect(MONGO_URI!);
    if (!mongoose.connection.name.includes('repro') && !mongoose.connection.name.includes('test')) {
      throw new Error(`Refusing to use database "${mongoose.connection.name}": its name must contain "repro" or "test".`);
    }
    await mongoose.connection.dropDatabase();
    for (const model of [User, Appointment, VisitReport, Project, ProjectItem, SlotLock]) await model.syncIndexes();
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
    customerId = await createUser('customer01@example.test', [Role.CUSTOMER]);
    otherCustomerId = await createUser('customer02@example.test', [Role.CUSTOMER]);
    // Two sales staff, as in the live case: one takes the consultation, the other the ocular visit.
    charlieId = await createUser('salesstaff01@example.test', [Role.SALES_STAFF]);
    bugoyId = await createUser('salesstaff02@example.test', [Role.SALES_STAFF]);
    agentId = await createUser('appointmentagent01@example.test', [Role.APPOINTMENT_AGENT]);
  });

  /** Sales staff fills and submits the consultation report, which marks the consultation Completed. */
  async function finishConsultation(consultationId: string, staffId: string) {
    const report = (await visitReports.getByAppointment(consultationId))[0]!;
    await visitReports.updateReport(String(report._id), {
      visitType: 'consultation', materials: 'SS304', finishes: 'Brushed', notes: 'One run.',
      lineItems: [{ label: 'Railing', quantity: 1 }],
      consultationOutcome: 'no_ocular', noOcularReason: 'Ocular visit decision moved to project creation.',
    } as never, staffId);
    await visitReports.submitReport(String(report._id), staffId);
    return String(report._id);
  }

  /** An earlier consultation (Nov 15) already finished; its project waits for an ocular visit. */
  async function projectWaitingForOcular() {
    const consultation = await Appointment.create({
      customerId, type: AppointmentType.OFFICE, date: '2026-11-15', slotCode: '09:00',
      status: AppointmentStatus.CONFIRMED, salesStaffId: bugoyId, bookedBy: customerId, serviceTypes: ['railings'],
    });
    const reportId = await finishConsultation(String(consultation._id), bugoyId);
    const project = await projects.createProject({
      customerId, appointmentId: String(consultation._id), title: 'Railings Project', serviceType: 'railings',
      serviceTypes: ['railings'], visitReportId: reportId, additionalItems: [],
      contractFileKey: 'contracts/signed-contract.png', contractFileName: 'signed-contract.png', contractContentType: 'image/png',
    } as never, bugoyId, undefined, undefined, [Role.SALES_STAFF]);
    return String(project._id);
  }

  /** The ocular staff travels, fills the ocular report and submits it: the visit is marked Completed. */
  async function finishOcular(projectId: string) {
    const ocularId = String((await Project.findById(projectId).lean())!.ocularAppointmentId);
    for (const status of [AppointmentStatus.ON_THE_WAY, AppointmentStatus.ARRIVED_AT_SITE] as const) {
      await appointments.updateVisitStatus(ocularId, status, bugoyId);
    }
    for (const report of await visitReports.getByAppointment(ocularId)) {
      await visitReports.updateReport(String(report._id), {
        visitType: 'ocular', measurements: { length: 430, height: 110 }, materials: 'SS316', finishes: 'Brushed',
        notes: 'Measured on site.', actualVisitDateTime: '2026-11-15T11:30:00.000Z',
        lineItems: [{ label: 'Railing', quantity: 1, length: 430, width: 5, height: 110, thickness: 0.15, area: 4.73, notes: 'One run' }],
        siteConditions: { environment: 'outdoor', floorType: 'Concrete', wallMaterial: 'Concrete', accessNotes: 'Stairs', obstaclesOrConstraints: 'None' },
        photoKeys: ['visit-reports/site-photo-1.jpg'],
      } as never, bugoyId);
      await visitReports.submitReport(String(report._id), bugoyId);
    }
    expect((await Appointment.findById(ocularId).lean())?.status).toBe(AppointmentStatus.COMPLETED);
    return ocularId;
  }

  /** The customer books a consultation; the agent assigns it to Charlie (Confirmed). */
  async function bookConsultation(slotCode = '09:00', date = DAY) {
    const consultation = await appointments.requestAppointment(
      { type: AppointmentType.OFFICE, date, slotCode, serviceTypes: ['railings'] } as never, customerId, [Role.CUSTOMER],
    );
    await appointments.confirmAppointment(String(consultation._id), { salesStaffId: charlieId } as never, agentId);
    return String(consultation._id);
  }

  /** Sales schedules the project's ocular visit with Bugoy as the ocular staff. */
  const scheduleOcular = (projectId: string, slotCode = '09:00', date = DAY) => projects.scheduleProjectOcular(
    projectId, { date, slotCode, ...SITE, salesStaffId: bugoyId } as never, bugoyId, [Role.SALES_STAFF],
  );

  /** The customer's appointments on the day that still hold their time (not cancelled / no-show). */
  const heldOn = (slotCode: string, date = DAY) => Appointment.countDocuments({
    customerId, date, slotCode, status: { $nin: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] },
  });

  // Legacy consultations can create their missing ocular when the customer supplies the site.
  async function legacyConsultationWaitingForLocation() {
    const consultation = await Appointment.create({
      customerId, type: AppointmentType.OFFICE, date: '2026-11-15', slotCode: '09:00',
      status: AppointmentStatus.COMPLETED, consultationReportSubmitted: true,
      salesStaffId: bugoyId, bookedBy: customerId,
    });
    await VisitReport.create({
      appointmentId: consultation._id, customerId, salesStaffId: bugoyId,
      visitType: 'consultation', serviceType: 'railings', status: 'submitted',
      consultationOutcome: 'schedule_ocular',
      recommendedOcularDate: new Date(`${DAY}T00:00:00Z`), recommendedOcularSlot: '09:00',
    });
    return String(consultation._id);
  }

  it('location submission cannot create a legacy ocular while another request holds the customer schedule', async () => {
    const consultationId = await legacyConsultationWaitingForLocation();
    await withSalesDayLocks(async (locks) => {
      await acquireCustomerScheduleLock(locks, customerId, agentId);
      await expect(appointments.customerSubmitOcularLocation(consultationId, SITE, customerId))
        .rejects.toMatchObject({ statusCode: 409, code: 'SLOT_LOCKED' });
    });
    expect(await Appointment.countDocuments({ customerId, type: AppointmentType.OCULAR })).toBe(0);
    expect(await SlotLock.countDocuments({ slotCode: 'customer-schedule' })).toBe(0);
  });

  it('location submission cannot create a legacy ocular while another request holds the sales staff day', async () => {
    const consultationId = await legacyConsultationWaitingForLocation();
    await withSalesDayLocks(async (locks) => {
      await acquireSalesDayLock(locks, bugoyId, DAY, bugoyId);
      await expect(appointments.customerSubmitOcularLocation(consultationId, SITE, customerId))
        .rejects.toMatchObject({ statusCode: 409, code: 'SLOT_LOCKED' });
    });
    expect(await Appointment.countDocuments({ customerId, type: AppointmentType.OCULAR })).toBe(0);
    expect(await SlotLock.countDocuments({ slotCode: 'customer-schedule' })).toBe(0);
  });

  it('location submission still creates the legacy ocular when both schedules are free', async () => {
    const consultationId = await legacyConsultationWaitingForLocation();
    const ocular = await appointments.customerSubmitOcularLocation(consultationId, SITE, customerId);
    expect(ocular).toMatchObject({ type: AppointmentType.OCULAR, date: DAY, slotCode: '09:00' });
    expect(await heldOn('09:00')).toBe(1);
    expect(await SlotLock.countDocuments({ slotCode: { $in: ['customer-schedule', 'sales-day'] } })).toBe(0);
  });

  it('consultation first: refuses another project\'s ocular visit at the same start time with a different staff member', async () => {
    const projectId = await projectWaitingForOcular();
    await bookConsultation('09:00');

    await expect(scheduleOcular(projectId, '09:00')).rejects.toMatchObject({
      ...CONFLICT,
      message: expect.stringMatching(/^This customer already has a consultation on Nov 18, 2026, 9:00 AM to 10:00 AM \(APT-20261118-\d+ · Confirmed\)\. An ocular visit on Nov 18, 2026 at 9:00 AM would overlap it\./),
    });
    expect(await heldOn('09:00')).toBe(1);
    expect(await Appointment.countDocuments({ customerId, type: AppointmentType.OCULAR })).toBe(0);

    // The pending consultation (another project) does not block the ocular visit at a free time.
    await scheduleOcular(projectId, '11:00');
    expect(await Appointment.countDocuments({ customerId, type: AppointmentType.OCULAR, date: DAY, slotCode: '11:00' })).toBe(1);
  });

  it('ocular visit first: refuses a consultation booking at the same start time, by the customer or by an agent', async () => {
    const projectId = await projectWaitingForOcular();
    await scheduleOcular(projectId, '09:00');

    await expect(appointments.requestAppointment(
      { type: AppointmentType.OFFICE, date: DAY, slotCode: '09:00', serviceTypes: ['railings'] } as never, customerId, [Role.CUSTOMER],
    )).rejects.toMatchObject({
      ...CONFLICT,
      message: expect.stringMatching(/^You already have an ocular visit on Nov 18, 2026, 9:00 AM to 10:00 AM \(APT-20261118-\d+ · Confirmed · PRJ-2026-\d+\)\. A consultation on Nov 18, 2026 at 9:00 AM would overlap it\./),
    });
    await expect(appointments.agentCreateAppointment(
      { customerId, type: AppointmentType.OFFICE, date: DAY, slotCode: '09:00' } as never, agentId,
    )).rejects.toMatchObject({ ...CONFLICT, message: expect.stringContaining('This customer already has an ocular visit on Nov 18, 2026, 9:00 AM to 10:00 AM') });
    expect(await heldOn('09:00')).toBe(1);
    expect(await Appointment.countDocuments({ customerId, type: AppointmentType.OFFICE, date: DAY })).toBe(0);
  });

  it('multiple bookings: a new consultation at its own time is accepted while others are active, up to 3 active', async () => {
    const projectId = await projectWaitingForOcular();
    await scheduleOcular(projectId, '09:00');
    // Same day, another hour: accepted although the ocular visit is still active.
    await bookConsultation('11:00');
    // Another day: accepted.
    await bookConsultation('09:00', '2026-11-19');

    // 3 active now (ocular + 2 consultations): a 4th booking is refused, by the customer or an agent.
    await expect(appointments.requestAppointment(
      { type: AppointmentType.OFFICE, date: '2026-11-20', slotCode: '09:00', serviceTypes: ['railings'] } as never, customerId, [Role.CUSTOMER],
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'ACTIVE_APPOINTMENT_LIMIT',
      message: expect.stringMatching(/^You already have 3 active appointments \(.+\)\. Please complete or cancel one before booking another\.$/),
    });
    await expect(appointments.agentCreateAppointment(
      { customerId, type: AppointmentType.OFFICE, date: '2026-11-20', slotCode: '09:00' } as never, agentId,
    )).rejects.toMatchObject({ code: 'ACTIVE_APPOINTMENT_LIMIT', message: expect.stringContaining('This customer already has 3 active appointments') });
    expect(await Appointment.countDocuments({ customerId, date: '2026-11-20' })).toBe(0);
  });

  /**
   * A future appointment marked Completed early (the live case). Lifecycle rule: a visit is completed
   * on its own day (assertAppointmentDayReached), and a booking needs 3 days' notice, so a Completed
   * appointment is normally always in the past and can never clash with a new booking. While
   * APPOINTMENT_DAY_CHECK_BYPASSED is on, staff can mark a visit Completed days early. Its record
   * still says "Nov 18, 9:00 AM", so that hour stays taken for the CUSTOMER: nothing else of theirs
   * can be put on it (only Cancelled / No-show give it back). Since the Travel Time fix (user decision
   * 2026-11-26) the STAFF rule matches: a completed appointment holds the staff member's time until
   * that time has passed (holdsStaffTime), so finishing early never reopens it.
   */
  describe('a future appointment marked Completed before its date', () => {
    it('ocular visit completed early (the live order): the customer cannot book a consultation on its time', async () => {
      // PRJ ocular Nov 18 9:00 with Bugoy, marked Completed on Nov 15.
      const projectId = await projectWaitingForOcular();
      await scheduleOcular(projectId, '09:00');
      const ocularId = await finishOcular(projectId);
      const ocular = await Appointment.findById(ocularId).lean();
      const projectNumber = (await Project.findById(projectId).lean())!.projectNumber;

      await expect(appointments.requestAppointment(
        { type: AppointmentType.OFFICE, date: DAY, slotCode: '09:00', serviceTypes: ['railings'] } as never, customerId, [Role.CUSTOMER],
      )).rejects.toMatchObject({
        ...CONFLICT,
        message: `You already have an ocular visit on Nov 18, 2026, 9:00 AM to 10:00 AM (${ocular!.appointmentNumber} · Completed · ${projectNumber}). `
          + 'A consultation on Nov 18, 2026 at 9:00 AM would overlap it. Please choose a different date or time.',
        details: expect.objectContaining({
          conflictAppointmentId: ocularId, conflictDate: DAY, conflictSlotCode: '09:00', requestedDate: DAY, requestedSlotCode: '09:00',
        }),
      });
      await expect(appointments.agentCreateAppointment(
        { customerId, type: AppointmentType.OFFICE, date: DAY, slotCode: '09:00' } as never, agentId,
      )).rejects.toMatchObject({ ...CONFLICT, message: expect.stringContaining('This customer already has an ocular visit on Nov 18, 2026, 9:00 AM to 10:00 AM') });
      expect(await heldOn('09:00')).toBe(1);

      // Staff rule: Bugoy's ocular was completed early (it is Nov 15), so its time is still ahead and
      // still holds HIS day too: another customer's 9:00 consultation that day can't be assigned to him.
      const other = await Appointment.create({
        customerId: otherCustomerId, type: AppointmentType.OFFICE, date: DAY, slotCode: '09:00',
        status: AppointmentStatus.REQUESTED, bookedBy: otherCustomerId,
      });
      await expect(appointments.confirmAppointment(String(other._id), { salesStaffId: bugoyId } as never, agentId))
        .rejects.toThrow('Already has an appointment at this time');
      expect((await Appointment.findById(other._id).lean())!.salesStaffId).toBeFalsy();
    });

    it('consultation completed early: another project\'s ocular visit cannot be scheduled on its time', async () => {
      const projectId = await projectWaitingForOcular();
      const consultationId = await bookConsultation('09:00');
      await finishConsultation(consultationId, charlieId);
      expect((await Appointment.findById(consultationId).lean())?.status).toBe(AppointmentStatus.COMPLETED);

      await expect(scheduleOcular(projectId, '09:00')).rejects.toMatchObject({
        ...CONFLICT,
        message: expect.stringMatching(/^This customer already has a consultation on Nov 18, 2026, 9:00 AM to 10:00 AM \(APT-20261118-\d+ · Completed\)\. An ocular visit on Nov 18, 2026 at 9:00 AM would overlap it\. Choose a different date or time\.$/),
      });
      expect(await heldOn('09:00')).toBe(1);
      expect(await Appointment.countDocuments({ customerId, type: AppointmentType.OCULAR })).toBe(0);

      // The next hour is free for the customer, and Bugoy has nothing else that day.
      await scheduleOcular(projectId, '10:00');
      expect(await Appointment.countDocuments({ customerId, type: AppointmentType.OCULAR, date: DAY, slotCode: '10:00' })).toBe(1);
    });
  });

  it('blocks a partial overlap and accepts the next free slot the same day', async () => {
    // An ocular visit recorded at 9:30 (runs to 10:30), already marked Completed.
    await Appointment.create({
      customerId, type: AppointmentType.OCULAR, date: DAY, slotCode: '09:30',
      status: AppointmentStatus.COMPLETED, salesStaffId: bugoyId, bookedBy: bugoyId,
    });
    const book = (slotCode: string) => appointments.requestAppointment(
      { type: AppointmentType.OFFICE, date: DAY, slotCode, serviceTypes: ['railings'] } as never, customerId, [Role.CUSTOMER],
    );

    await expect(book('09:00')).rejects.toMatchObject({ ...CONFLICT, message: expect.stringContaining('9:30 AM to 10:30 AM') });
    await expect(book('10:00')).rejects.toMatchObject({ ...CONFLICT, message: expect.stringContaining('A consultation on Nov 18, 2026 at 10:00 AM would overlap it.') });

    // 11:00 is clear. The customer only needs the visit's own hour: the ocular visit takes the
    // STAFF member's whole day, not the customer's.
    const booked = await book('11:00');
    expect(booked.status).toBe(AppointmentStatus.REQUESTED);
    expect(await heldOn('11:00')).toBe(1);
  });

  it('accepts the slot right after the customer\'s other appointment (back-to-back hours do not overlap)', async () => {
    const projectId = await projectWaitingForOcular();
    await scheduleOcular(projectId, '09:00');
    await finishOcular(projectId);

    const consultationId = await bookConsultation('10:00');

    const consultation = await Appointment.findById(consultationId).lean();
    expect(consultation).toMatchObject({ date: DAY, slotCode: '10:00', status: AppointmentStatus.CONFIRMED });
    expect(String(consultation!.salesStaffId)).toBe(charlieId);
  });

  it('a cancelled appointment does not block its time', async () => {
    const projectId = await projectWaitingForOcular();
    await scheduleOcular(projectId, '09:00');
    const ocularId = String((await Project.findById(projectId).lean())!.ocularAppointmentId);
    await appointments.cancelAppointment(ocularId, 'Customer is out of town', agentId, Role.APPOINTMENT_AGENT);
    expect((await Appointment.findById(ocularId).lean())?.status).toBe(AppointmentStatus.CANCELLED);

    const consultationId = await bookConsultation('09:00');

    expect((await Appointment.findById(consultationId).lean())).toMatchObject({ date: DAY, slotCode: '09:00', status: AppointmentStatus.CONFIRMED });
  });

  it('a consultation closed as No Show gives its time back; one the customer attended keeps it (user decision 2026-11-27)', async () => {
    // An office No Show is stored as completed + attendanceStatus no_show (an ocular No Show as status no_show).
    await Appointment.create({
      customerId, type: AppointmentType.OFFICE, date: DAY, slotCode: '09:00',
      status: AppointmentStatus.COMPLETED, attendanceStatus: AppointmentAttendanceStatus.NO_SHOW,
      salesStaffId: bugoyId, bookedBy: customerId,
    });
    await Appointment.create({
      customerId, type: AppointmentType.OFFICE, date: DAY, slotCode: '10:00',
      status: AppointmentStatus.COMPLETED, attendanceStatus: AppointmentAttendanceStatus.CUSTOMER_DECLINED,
      salesStaffId: bugoyId, bookedBy: customerId,
    });

    // The booking page's "Already booked" marks and the submission check use the same rule.
    expect([...(await getCustomerBookedSlots(customerId, DAY, ['09:00', '10:00', '11:00']))]).toEqual(['10:00']);
    const consultationId = await bookConsultation('09:00');
    expect((await Appointment.findById(consultationId).lean())).toMatchObject({ date: DAY, slotCode: '09:00', status: AppointmentStatus.CONFIRMED });
    await expect(bookConsultation('10:00')).rejects.toMatchObject(CONFLICT);
  });

  it('reschedule: refuses a move onto the customer\'s other appointment, and never compares an appointment with itself', async () => {
    const projectId = await projectWaitingForOcular();
    await scheduleOcular(projectId, '09:00');
    await finishOcular(projectId);
    const consultationId = await bookConsultation('10:00', '2026-11-19');
    const reschedule = (newDate: string, newSlotCode: string) => appointments.requestReschedule(
      consultationId, { newDate, newSlotCode, reason: 'Customer asked to move it' } as never, agentId, [Role.APPOINTMENT_AGENT],
    );

    // Onto the ocular visit's time: refused, and the consultation stays where it was.
    await expect(reschedule(DAY, '09:00')).rejects.toMatchObject({
      ...CONFLICT,
      message: expect.stringContaining('This customer already has an ocular visit on Nov 18, 2026, 9:00 AM to 10:00 AM'),
    });
    expect(await Appointment.findById(consultationId).lean()).toMatchObject({ date: '2026-11-19', slotCode: '10:00', rescheduleCount: 0 });

    // Onto its own date and time: it is the only appointment there, so it must not block itself.
    await reschedule('2026-11-19', '10:00');
    // To the free hour after the ocular visit: accepted.
    await reschedule(DAY, '10:00');
    expect(await Appointment.findById(consultationId).lean()).toMatchObject({ date: DAY, slotCode: '10:00', rescheduleCount: 2 });

    // The agent's "accept reschedule" step applies the same rule.
    await Appointment.updateOne({ _id: consultationId }, { $set: { status: AppointmentStatus.RESCHEDULE_REQUESTED } });
    await expect(appointments.completeReschedule(consultationId, { date: DAY, slotCode: '09:00' } as never, agentId))
      .rejects.toMatchObject(CONFLICT);
    expect(await Appointment.findById(consultationId).lean()).toMatchObject({ date: DAY, slotCode: '10:00' });
  });

  it('reschedule: refuses moving an ocular visit onto the customer\'s consultation time', async () => {
    // The consultation was completed early, so the customer can hold an active ocular visit too.
    const projectId = await projectWaitingForOcular();
    const consultationId = await bookConsultation('09:00');
    await finishConsultation(consultationId, charlieId);
    await scheduleOcular(projectId, '09:00', '2026-11-19');
    const ocularId = String((await Project.findById(projectId).lean())!.ocularAppointmentId);

    await expect(appointments.requestReschedule(
      ocularId, { newDate: DAY, newSlotCode: '09:00', reason: 'Site not ready' } as never, agentId, [Role.APPOINTMENT_AGENT],
    )).rejects.toMatchObject({
      ...CONFLICT,
      message: expect.stringContaining('This customer already has a consultation on Nov 18, 2026, 9:00 AM to 10:00 AM'),
    });
    expect(await Appointment.findById(ocularId).lean()).toMatchObject({ date: '2026-11-19', slotCode: '09:00' });
  });

  it('two requests at the same moment: only one of a consultation booking and an ocular visit is saved', async () => {
    const projectId = await projectWaitingForOcular();

    const results = await Promise.allSettled([
      appointments.requestAppointment(
        { type: AppointmentType.OFFICE, date: DAY, slotCode: '09:00', serviceTypes: ['railings'] } as never, customerId, [Role.CUSTOMER],
      ),
      scheduleOcular(projectId, '09:00'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.statusCode).toBe(409);
    expect(await heldOn('09:00')).toBe(1);
    // Nothing is left locked for the next request.
    expect(await SlotLock.countDocuments({ slotCode: { $in: ['customer-schedule', 'sales-day'] } })).toBe(0);
  });

  it('two requests at the same moment: only one of two consultation bookings is saved', async () => {
    const results = await Promise.allSettled([
      appointments.requestAppointment(
        { type: AppointmentType.OFFICE, date: DAY, slotCode: '09:00', serviceTypes: ['railings'] } as never, customerId, [Role.CUSTOMER],
      ),
      appointments.agentCreateAppointment(
        { customerId, type: AppointmentType.OFFICE, date: DAY, slotCode: '09:00' } as never, agentId,
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason.statusCode).toBe(409);
    expect(await Appointment.countDocuments({ customerId })).toBe(1);
  });
});
