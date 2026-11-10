/**
 * End-to-end service flow against a REAL, throwaway MongoDB database:
 * consultation → consultation report → project → signed contract → schedule ocular →
 * ocular report → project detail (sales staff + engineer) → assign engineer.
 *
 * Skipped unless RMV_MONGO_TEST_URI points at a local database, e.g.
 *   RMV_MONGO_TEST_URI=mongodb://127.0.0.1:27017/rmv_repro npx vitest run project-ocular-flow
 * The database named in the URI is dropped before and after the run. Never point it at real data.
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
    route: { distanceKm: 5 },
    fee: {
      label: 'Within NCR', baseFee: 0, baseCoveredKm: 0, perKmRate: 0,
      additionalDistanceKm: 0, additionalFee: 0, total: 0, isWithinNCR: true,
    },
  })),
}));

import { Appointment, Project, ProjectItem, SlotLock, User, VisitReport } from '../../models/index.js';
import { AppointmentStatus, AppointmentType, ProjectStatus, Role } from '../../utils/constants.js';
import * as appointments from '../appointments/appointments.service.js';
import * as visitReports from '../visit-reports/visit-reports.service.js';
import * as projects from './projects.service.js';

const MONGO_URI = process.env.RMV_MONGO_TEST_URI;
const DESIGN = {
  id: 'railings-balcony-horizontal',
  name: 'Balcony horizontal stainless railing',
  imageUrl: '/landing/services/railings/07-balcony-horizontal-stainless-railing.png',
  serviceId: 'railings',
  serviceLabel: 'Railings',
  serviceType: 'railings',
};
const SITE = { customerLocation: { lat: 14.55, lng: 121.02 }, formattedAddress: 'Makati City, Metro Manila' };

async function createUser(email: string, roles: Role[]) {
  return User.create({ email, firstName: email.split('@')[0], lastName: 'Test', roles, isActive: true });
}

describe.runIf(Boolean(MONGO_URI))('project ocular flow on a real database (PRJ-2026-00094 repro)', () => {
  let customerId: string;
  let salesId: string;
  let engineerId: string;
  let adminId: string;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Nov 10, 2026, 10:00 AM Manila — the day the QA run completed the Nov 13 consultation early.
    vi.setSystemTime(new Date('2026-11-10T02:00:00Z'));
    await mongoose.connect(MONGO_URI!);
    if (!mongoose.connection.name.includes('repro') && !mongoose.connection.name.includes('test')) {
      throw new Error(`Refusing to use database "${mongoose.connection.name}": its name must contain "repro" or "test".`);
    }
    await mongoose.connection.dropDatabase();
    // The indexes this flow relies on (unique keys included), built exactly as in production.
    for (const model of [User, Appointment, VisitReport, Project, ProjectItem, SlotLock]) await model.syncIndexes();
  }, 60_000);

  afterAll(async () => {
    vi.useRealTimers();
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
    customerId = String((await createUser('customer01@example.test', [Role.CUSTOMER]))._id);
    salesId = String((await createUser('salesstaff01@example.test', [Role.SALES_STAFF]))._id);
    engineerId = String((await createUser('engineer01@example.test', [Role.ENGINEER]))._id);
    adminId = String((await createUser('admin01@example.test', [Role.ADMIN]))._id);
  });

  async function completeConsultation(booking: Record<string, unknown> = {}) {
    const consultation = await Appointment.create({
      customerId,
      type: AppointmentType.OFFICE,
      date: '2026-11-13',
      slotCode: '09:00',
      status: AppointmentStatus.CONFIRMED,
      salesStaffId: salesId,
      bookedBy: customerId,
      serviceTypes: ['railings'],
      selectedDesignTemplates: [DESIGN],
      selectedDesignTemplateId: DESIGN.id,
      selectedDesignTemplateName: DESIGN.name,
      selectedDesignTemplateImageUrl: DESIGN.imageUrl,
      customerSiteDetails: { serviceTypes: ['railings'] },
      ...booking,
    });
    const consultationId = String(consultation._id);

    // Sales staff opens the consultation report (drafts are created on read), fills it, and submits it.
    const drafts = await visitReports.getByAppointment(consultationId);
    expect(drafts.length).toBeGreaterThanOrEqual(1);
    const report = drafts[0]!;
    await visitReports.updateReport(String(report._id), {
      visitType: 'consultation',
      measurements: { length: 420, height: 105 },
      materials: 'SS304',
      finishes: 'Brushed',
      notes: 'Balcony railing, one run.',
      lineItems: [{ label: 'Balcony railing', quantity: 1 }],
      consultationOutcome: 'no_ocular',
      noOcularReason: 'Ocular visit decision moved to project creation.',
      selectedDesignTemplateId: report.selectedDesignTemplateId || undefined,
      selectedDesignTemplateName: report.selectedDesignTemplateName || undefined,
      selectedDesignTemplateImageUrl: report.selectedDesignTemplateImageUrl || undefined,
    } as never, salesId);
    await visitReports.submitReport(String(report._id), salesId);

    const completed = await Appointment.findById(consultationId).lean();
    expect(completed?.status).toBe(AppointmentStatus.COMPLETED);
    return { consultationId, reportId: String(report._id) };
  }

  async function createProjectWithContract(consultationId: string, reportId: string, overrides: Record<string, unknown> = {}) {
    const report = await VisitReport.findById(reportId).lean();
    // Same payload shape the Create Project page sends for a one-item consultation.
    const project = await projects.createProject({
      customerId,
      appointmentId: consultationId,
      title: 'Railings Project',
      serviceType: 'railings',
      serviceTypes: ['railings'],
      visitReportId: reportId,
      additionalItems: [],
      deliveryType: undefined,
      lineItems: report?.lineItems,
      measurementUnit: 'cm',
      selectedDesignTemplateId: report?.selectedDesignTemplateId || DESIGN.id,
      selectedDesignTemplateName: report?.selectedDesignTemplateName || DESIGN.name,
      selectedDesignTemplateImageUrl: report?.selectedDesignTemplateImageUrl || DESIGN.imageUrl,
      materialType: 'SS304',
      finishColor: 'Brushed',
      ...overrides,
    } as never, salesId, undefined, undefined, [Role.SALES_STAFF]);
    const projectId = String(project._id);
    await projects.uploadSignedContract(projectId, {
      contractFileKey: 'contracts/signed-contract.png',
      contractFileName: 'signed-contract.png',
      contractContentType: 'image/png',
    } as never, salesId, [Role.SALES_STAFF]);
    return projectId;
  }

  it('rejects an ocular on the completed consultation\'s own date, then accepts a valid one', async () => {
    const { consultationId, reportId } = await completeConsultation();
    const projectId = await createProjectWithContract(consultationId, reportId);

    // QA: ocular Nov 13 9 AM, same customer + sales staff as the completed Nov 13 consultation.
    await expect(projects.scheduleProjectOcular(projectId, { date: '2026-11-13', slotCode: '09:00', ...SITE } as never, salesId, [Role.SALES_STAFF]))
      .rejects.toThrow('Choose Nov 16, 2026 or later.');
    expect(await Appointment.countDocuments({ type: AppointmentType.OCULAR })).toBe(0);

    await projects.scheduleProjectOcular(projectId, { date: '2026-11-16', slotCode: '09:00', ...SITE } as never, salesId, [Role.SALES_STAFF]);
    expect(await Appointment.countDocuments({ type: AppointmentType.OCULAR })).toBe(1);
  });

  it('blocks a second appointment for the sales staff on a day that already has a completed one', async () => {
    const { consultationId, reportId } = await completeConsultation();
    const projectId = await createProjectWithContract(consultationId, reportId);
    // Another completed appointment of the same sales staff on Nov 16.
    const otherCustomer = await createUser('customer02@example.test', [Role.CUSTOMER]);
    await Appointment.create({
      customerId: otherCustomer._id, type: AppointmentType.OFFICE, date: '2026-11-16', slotCode: '13:00',
      status: AppointmentStatus.COMPLETED, salesStaffId: salesId, bookedBy: otherCustomer._id,
    });

    await expect(projects.scheduleProjectOcular(projectId, { date: '2026-11-16', slotCode: '09:00', ...SITE } as never, salesId, [Role.SALES_STAFF]))
      .rejects.toThrow(/No sales staff is available|Already has an appointment on Nov 16, 2026/);
  });

  /** Schedules the ocular, travels, fills and submits the ocular report. */
  async function runOcularVisit(projectId: string, options: { qaSameDay?: boolean } = {}) {
    await projects.scheduleProjectOcular(projectId, { date: '2026-11-16', slotCode: '09:00', ...SITE } as never, salesId, [Role.SALES_STAFF]);
    const ocularId = String((await Project.findById(projectId).lean())!.ocularAppointmentId);
    // What the old rules allowed in QA: the ocular on Nov 13, 9 AM, the consultation's own date and time.
    if (options.qaSameDay) await Appointment.updateOne({ _id: ocularId }, { $set: { date: '2026-11-13', slotCode: '09:00' } });

    // Sales staff travels to the site (day check is bypassed while APPOINTMENT_DAY_CHECK_BYPASSED is on).
    for (const status of [AppointmentStatus.ON_THE_WAY, AppointmentStatus.ARRIVED_AT_SITE] as const) {
      await appointments.updateVisitStatus(ocularId, status, salesId);
    }

    // Sales staff opens the ocular report(s), fills each one, and submits.
    const ocularReports = await visitReports.getByAppointment(ocularId);
    for (const ocularReport of ocularReports) {
      await visitReports.updateReport(String(ocularReport._id), {
        visitType: 'ocular',
        measurements: { length: 430, height: 110 },
        materials: 'SS316',
        finishes: 'Brushed',
        notes: 'Measured on site.',
        actualVisitDateTime: '2026-11-16T01:30:00.000Z',
        lineItems: [{ label: 'Balcony railing', quantity: 1, length: 430, width: 5, height: 110, thickness: 0.15, area: 4.73, notes: 'One run' }],
        siteConditions: {
          environment: 'outdoor', floorType: 'Concrete', wallMaterial: 'Concrete',
          accessNotes: 'Stairs only', obstaclesOrConstraints: 'None',
        },
        photoKeys: ['visit-reports/site-photo-1.jpg'],
        selectedDesignTemplateId: ocularReport.selectedDesignTemplateId || undefined,
        selectedDesignTemplateName: ocularReport.selectedDesignTemplateName || undefined,
        selectedDesignTemplateImageUrl: ocularReport.selectedDesignTemplateImageUrl || undefined,
      } as never, salesId);
    }
    for (const ocularReport of ocularReports) {
      const current = await VisitReport.findById(ocularReport._id).lean();
      if (current?.status === 'draft') await visitReports.submitReport(String(ocularReport._id), salesId);
    }
    return ocularReports.length;
  }

  it('keeps one item when sales re-classifies the report item on Create Project (Railings → Custom name)', async () => {
    // QA data: no booked design; on Create Project the item was changed to Custom "Stainless Steel Balcony Railings".
    const { consultationId, reportId } = await completeConsultation({
      selectedDesignTemplates: [], selectedDesignTemplateId: undefined, selectedDesignTemplateName: undefined, selectedDesignTemplateImageUrl: undefined,
    });
    const projectId = await createProjectWithContract(consultationId, reportId, {
      serviceType: 'custom', serviceTypeCustom: 'Stainless Steel Balcony Railings', serviceTypes: ['custom'],
      selectedDesignTemplateId: undefined, selectedDesignTemplateName: undefined, selectedDesignTemplateImageUrl: undefined,
    });
    // Same ocular date and time as the consultation, as the old rules allowed in QA.
    const reportCount = await runOcularVisit(projectId, { qaSameDay: true });

    expect(reportCount).toBe(1);
    expect((await Project.findById(projectId).lean())?.status).toBe(ProjectStatus.SUBMITTED);
    const project = await projects.getProjectById(projectId, salesId, [Role.SALES_STAFF]);
    expect(project.items.map((item: { title: string }) => item.title)).toEqual(['Stainless Steel Balcony Railings']);
    await expect(projects.getProjectById(projectId, engineerId, [Role.ENGINEER])).resolves.toMatchObject({ status: ProjectStatus.SUBMITTED });

    const report = await VisitReport.findById(reportId).lean();
    expect(report?.serviceType).toBe('custom');
    expect(report?.consultationSnapshot).toMatchObject({ serviceType: 'railings', consultationOutcome: 'no_ocular' });
  });

  it('loads the project For Review for sales staff and engineer after the ocular report, with one railing item', async () => {
    const { consultationId, reportId } = await completeConsultation();
    const projectId = await createProjectWithContract(consultationId, reportId);
    await runOcularVisit(projectId);

    expect((await Project.findById(projectId).lean())?.status).toBe(ProjectStatus.SUBMITTED);

    const asSales = await projects.getProjectById(projectId, salesId, [Role.SALES_STAFF]);
    const asEngineer = await projects.getProjectById(projectId, engineerId, [Role.ENGINEER]);
    expect(asSales.status).toBe(ProjectStatus.SUBMITTED);
    expect(asEngineer.status).toBe(ProjectStatus.SUBMITTED);

    const items = await ProjectItem.find({ projectId }).lean();
    expect(items.map((item) => item.title)).toHaveLength(1);

    // Same report id moved on to the ocular visit, but the consultation answers are kept.
    const promoted = await VisitReport.findById(reportId).lean();
    expect(promoted?.visitType).toBe('ocular');
    expect(promoted?.consultationSnapshot).toMatchObject({
      consultationOutcome: 'no_ocular',
      noOcularReason: 'Ocular visit decision moved to project creation.',
      status: 'submitted',
    });
    expect(String(promoted?.consultationSnapshot?.appointmentId)).toBe(consultationId);

    // The engineering step can start.
    await projects.assignEngineers(projectId, { engineerIds: [engineerId] } as never, adminId);
    expect((await projects.getProjectById(projectId, engineerId, [Role.ENGINEER])).engineerIds).toHaveLength(1);
  });
});
