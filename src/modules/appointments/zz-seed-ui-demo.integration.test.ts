/**
 * TEMPORARY (deleted after the browser check): seeds a throwaway local database with the live
 * scenario so the forms can be driven in a real browser. Uses the real services and the real clock.
 */
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

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
    fee: { label: 'Within NCR', baseFee: 0, baseCoveredKm: 0, perKmRate: 0, additionalDistanceKm: 0, additionalFee: 0, total: 0, isWithinNCR: true },
  })),
}));

import { Appointment, Project, User } from '../../models/index.js';
import { AppointmentStatus, AppointmentType, Role } from '../../utils/constants.js';
import * as appointments from './appointments.service.js';
import * as visitReports from '../visit-reports/visit-reports.service.js';
import * as projects from '../projects/projects.service.js';

const MONGO_URI = process.env.RMV_UI_DEMO_URI;
const SITE = { customerLocation: { lat: 14.55, lng: 121.02 }, formattedAddress: 'Makati City, Metro Manila' };
const manilaDay = (offsetDays: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' })
  .format(new Date(Date.now() + offsetDays * 86_400_000));

describe.runIf(Boolean(MONGO_URI))('seed the UI demo database', () => {
  it('creates the accounts and the early-completed appointments', async () => {
    await mongoose.connect(MONGO_URI!);
    if (!mongoose.connection.name.includes('repro')) throw new Error('Refusing to use this database.');
    await mongoose.connection.dropDatabase();

    const password = await bcrypt.hash('Demo@12345', 10);
    const user = async (email: string, firstName: string, lastName: string, roles: Role[]) => String((await User.create({
      email, firstName, lastName, roles, password, isEmailVerified: true, isActive: true, mustChangePassword: false, provider: 'local',
    }))._id);
    const customerId = await user('kiryu@example.test', 'Kiryu', 'Kazuma', [Role.CUSTOMER]);
    const charlieId = await user('charlie@example.test', 'Charlie', 'Cortez', [Role.SALES_STAFF]);
    const bugoyId = await user('bugoy@example.test', 'Bugoy', 'Sorrento', [Role.SALES_STAFF]);
    await user('agent@example.test', 'Appointment', 'Agent', [Role.APPOINTMENT_AGENT]);

    const today = manilaDay(0);
    const day = manilaDay(3); // earliest bookable day

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
    async function projectFrom(slotCode: string, staffId: string, title: string) {
      const consultation = await Appointment.create({
        customerId, type: AppointmentType.OFFICE, date: today, slotCode,
        status: AppointmentStatus.CONFIRMED, salesStaffId: staffId, bookedBy: customerId, serviceTypes: ['railings'],
      });
      const reportId = await finishConsultation(String(consultation._id), staffId);
      const project = await projects.createProject({
        customerId, appointmentId: String(consultation._id), title, serviceType: 'railings', serviceTypes: ['railings'],
        visitReportId: reportId, additionalItems: [],
        contractFileKey: 'contracts/signed-contract.png', contractFileName: 'signed-contract.png', contractContentType: 'image/png',
      } as never, staffId, undefined, undefined, [Role.SALES_STAFF]);
      return String(project._id);
    }

    // Project 1 (Bugoy): ocular on the earliest day at 9:00, marked Completed today (early).
    const project1 = await projectFrom('09:00', bugoyId, 'Railings Project');
    await projects.scheduleProjectOcular(project1, { date: day, slotCode: '09:00', ...SITE, salesStaffId: bugoyId } as never, bugoyId, [Role.SALES_STAFF]);
    const ocularId = String((await Project.findById(project1).lean())!.ocularAppointmentId);
    for (const status of [AppointmentStatus.ON_THE_WAY, AppointmentStatus.ARRIVED_AT_SITE] as const) {
      await appointments.updateVisitStatus(ocularId, status, bugoyId);
    }
    for (const report of await visitReports.getByAppointment(ocularId)) {
      await visitReports.updateReport(String(report._id), {
        visitType: 'ocular', measurements: { length: 430, height: 110 }, materials: 'SS316', finishes: 'Brushed',
        notes: 'Measured on site.', actualVisitDateTime: new Date().toISOString(),
        lineItems: [{ label: 'Railing', quantity: 1, length: 430, width: 5, height: 110, thickness: 0.15, area: 4.73, notes: 'One run' }],
        siteConditions: { environment: 'outdoor', floorType: 'Concrete', wallMaterial: 'Concrete', accessNotes: 'Stairs', obstaclesOrConstraints: 'None' },
        photoKeys: ['visit-reports/site-photo-1.jpg'],
      } as never, bugoyId);
      await visitReports.submitReport(String(report._id), bugoyId);
    }

    // Project 2 (Charlie): still waiting for its ocular visit.
    const project2 = await projectFrom('13:00', charlieId, 'Gate Project');
    // A consultation on the earliest day at 1:00 PM with Charlie, marked Completed today (early).
    const consultation = await Appointment.create({
      customerId, type: AppointmentType.OFFICE, date: day, slotCode: '13:00',
      status: AppointmentStatus.CONFIRMED, salesStaffId: charlieId, bookedBy: customerId, serviceTypes: ['gates'],
    });
    await finishConsultation(String(consultation._id), charlieId);

    const rows = await Appointment.find({ customerId, date: day }).sort({ slotCode: 1 }).lean();
    console.log(`SEEDED day=${day} project2=${project2} customer=${customerId}\n${rows.map((row) => `  ${row.appointmentNumber} ${row.type} ${row.date} ${row.slotCode} ${row.status}`).join('\n')}`);
    expect(rows.map((row) => row.status)).toEqual([AppointmentStatus.COMPLETED, AppointmentStatus.COMPLETED]);
    await mongoose.disconnect();
  }, 120_000);
});
