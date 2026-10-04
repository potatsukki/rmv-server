import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appointmentFindById: vi.fn(),
  appointmentCreate: vi.fn(),
  projectFindOne: vi.fn(),
  projectFindById: vi.fn(),
  projectFindOneAndUpdate: vi.fn(),
  projectCreate: vi.fn(),
  userFindOne: vi.fn(),
  auditCreate: vi.fn(),
  reportFindOne: vi.fn(),
  reportFind: vi.fn(),
  projectItemCreate: vi.fn(),
  projectItemFindOneAndUpdate: vi.fn(),
  projectItemFind: vi.fn(),
  projectItemUpdateMany: vi.fn(),
  blueprintFindOne: vi.fn(),
  paymentPlanFindOne: vi.fn(),
  generateProjectNumber: vi.fn(),
  prepareOcularSchedule: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Project: { findOne: mocks.projectFindOne, findById: mocks.projectFindById, findOneAndUpdate: mocks.projectFindOneAndUpdate, create: mocks.projectCreate },
  ProjectItem: {
    create: mocks.projectItemCreate,
    findOneAndUpdate: mocks.projectItemFindOneAndUpdate,
    find: mocks.projectItemFind,
    updateMany: mocks.projectItemUpdateMany,
  },
  Appointment: { findById: mocks.appointmentFindById, create: mocks.appointmentCreate },
  User: { findOne: mocks.userFindOne },
  AuditLog: { create: mocks.auditCreate },
  VisitReport: { findOne: mocks.reportFindOne, find: mocks.reportFind },
}));
vi.mock('../../models/Payment.js', () => ({ PaymentPlan: { findOne: mocks.paymentPlanFindOne } }));
vi.mock('../../models/Blueprint.js', () => ({ Blueprint: { findOne: mocks.blueprintFindOne } }));
vi.mock('../notifications/socket.service.js', () => ({
  createAndSendNotification: vi.fn(), notifyRole: vi.fn(),
}));
vi.mock('../../services/contract.service.js', () => ({ generateAndUploadContract: vi.fn() }));
vi.mock('../uploads/upload.service.js', () => ({
  generateDownloadUrl: vi.fn(), verifyFileExists: vi.fn(),
}));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../config/config.service.js', () => ({ getInstallmentConfig: vi.fn() }));
vi.mock('../../utils/projectNumber.js', () => ({ generateProjectNumber: mocks.generateProjectNumber }));
vi.mock('../fabrication/fabrication.service.js', () => ({ seedFabricationItems: vi.fn() }));
vi.mock('../appointments/appointments.service.js', () => ({ prepareProjectOcularSchedule: mocks.prepareOcularSchedule }));

import { assignEngineers, assignFabricationStaff, createProject, finalizeOcularProject, transitionProject, uploadSignedContract, updateProject, updateProjectSiteAddress } from './projects.service.js';
import { verifyFileExists } from '../uploads/upload.service.js';
import { AppointmentStatus, AuditAction, ContractStatus, DeliveryType, ProjectStatus, Role } from '../../utils/constants.js';

const customerId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const appointmentId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const actorId = 'cccccccccccccccccccccccc';
const input = {
  customerId,
  title: 'Kitchen counter',
  serviceType: 'countertops',
  description: 'Counter with two shelves',
  siteAddress: '123 Project Street',
  quantity: 2,
  measurements: { length: 120, width: 60, unit: 'cm' },
  materialType: 'Stainless steel 304',
  finishColor: 'Brushed',
  notes: 'Use project measurements',
  contractFileKey: 'contracts/signed-contract.pdf',
};

describe('finalizeOcularProject', () => {
  let draft: Record<string, any>;
  let reports: Record<string, any>[];

  beforeEach(() => {
    vi.resetAllMocks();
    draft = {
      _id: 'project-1', customerId, salesStaffId: actorId,
      projectNumber: 'RMV-2026-0001', ocularAppointmentId: 'ocular-1',
      status: ProjectStatus.DRAFT, contractStatus: ContractStatus.MISSING,
      serviceType: 'gates', serviceTypes: ['gates'], initialDesignKeys: [],
      engineerIds: [], save: vi.fn(),
    };
    reports = [{
      _id: 'report-1', serviceType: 'gates', visitType: 'ocular', status: 'submitted',
      materials: 'Original ocular material', lineItems: [{ label: 'Gate', quantity: 1 }],
      linkedProjectId: 'project-1', save: vi.fn(),
    }];
    mocks.projectFindById.mockResolvedValue(draft);
    mocks.projectFindOneAndUpdate.mockImplementation(async (_filter, update) => Object.assign(draft, update.$set));
    mocks.appointmentFindById.mockResolvedValue({ _id: 'ocular-1', status: AppointmentStatus.COMPLETED });
    mocks.reportFind.mockReturnValue({ sort: vi.fn().mockResolvedValue(reports) });
    mocks.projectItemFindOneAndUpdate.mockImplementation(async (_filter, update) => ({ _id: 'item-1', ...update.$set, save: vi.fn() }));
    vi.mocked(verifyFileExists).mockResolvedValue(true);
  });

  it('creates the final project on the same record and keeps sales edits in the primary item', async () => {
    const project = await finalizeOcularProject('project-1', { ...input, serviceType: 'gates' }, actorId, [Role.SALES_STAFF]);
    expect(project).toMatchObject({
      _id: 'project-1', projectNumber: 'RMV-2026-0001',
      status: ProjectStatus.SUBMITTED, contractStatus: ContractStatus.UPLOADED,
      contractFileKey: input.contractFileKey, materialType: input.materialType,
    });
    expect(mocks.projectCreate).not.toHaveBeenCalled();
    expect(mocks.appointmentCreate).not.toHaveBeenCalled();
    expect(mocks.projectItemFindOneAndUpdate).toHaveBeenLastCalledWith(
      { projectId: 'project-1', serviceType: 'gates' },
      expect.objectContaining({ $set: expect.objectContaining({ materials: input.materialType }) }),
      { upsert: true, new: true },
    );
    expect(reports[0].materials).toBe('Original ocular material');
  });

  it.each([AppointmentStatus.REQUESTED, AppointmentStatus.CONFIRMED, AppointmentStatus.CANCELLED])('rejects finalization while the ocular is %s', async (status) => {
    mocks.appointmentFindById.mockResolvedValue({ _id: 'ocular-1', status });
    await expect(finalizeOcularProject('project-1', input, actorId, [Role.SALES_STAFF])).rejects.toThrow('Complete the ocular visit');
    expect(draft.save).not.toHaveBeenCalled();
  });

  it('requires every ocular report to be submitted', async () => {
    reports.push({ _id: 'report-2', serviceType: 'railings', status: 'draft' });
    await expect(finalizeOcularProject('project-1', input, actorId, [Role.SALES_STAFF])).rejects.toThrow('Submit all ocular reports');
    expect(draft.save).not.toHaveBeenCalled();
  });

  it('requires a signed contract', async () => {
    await expect(finalizeOcularProject('project-1', { ...input, contractFileKey: undefined }, actorId, [Role.SALES_STAFF])).rejects.toThrow('upload the signed contract');
    expect(draft.save).not.toHaveBeenCalled();
  });

  it('rejects an unverified contract before changing the pending record', async () => {
    vi.mocked(verifyFileExists).mockResolvedValue(false);
    await expect(finalizeOcularProject('project-1', input, actorId, [Role.SALES_STAFF])).rejects.toThrow('could not be verified');
    expect(draft.status).toBe(ProjectStatus.DRAFT);
    expect(draft.save).not.toHaveBeenCalled();
  });

  it('rejects another sales staff and a customer change', async () => {
    await expect(finalizeOcularProject('project-1', input, 'another-sales', [Role.SALES_STAFF])).rejects.toThrow('Only the assigned sales staff');
    await expect(finalizeOcularProject('project-1', { ...input, customerId: appointmentId }, actorId, [Role.SALES_STAFF])).rejects.toThrow('customer cannot be changed');
    expect(draft.save).not.toHaveBeenCalled();
  });

  it('rejects a repeat finalization', async () => {
    draft.status = ProjectStatus.SUBMITTED;
    await expect(finalizeOcularProject('project-1', input, actorId, [Role.SALES_STAFF])).rejects.toThrow('no longer pending');
    expect(draft.save).not.toHaveBeenCalled();
  });

  it('rejects a competing finalization without updating items twice', async () => {
    mocks.projectFindOneAndUpdate.mockResolvedValue(null);
    await expect(finalizeOcularProject('project-1', input, actorId, [Role.SALES_STAFF])).rejects.toThrow('no longer pending');
    expect(mocks.projectItemFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('keeps Pending Ocular out of engineering even if a contract was uploaded early', async () => {
    draft.contractStatus = ContractStatus.UPLOADED;
    await expect(assignEngineers('project-1', { engineerIds: ['engineer-1'] }, actorId)).rejects.toThrow('Complete the pending ocular project');
    await expect(transitionProject('project-1', { status: ProjectStatus.SUBMITTED }, actorId)).rejects.toThrow('Complete the pending ocular project');
    await expect(uploadSignedContract('project-1', { contractFileKey: input.contractFileKey }, actorId, [Role.SALES_STAFF])).rejects.toThrow('Use Complete Project');
    expect(draft.save).not.toHaveBeenCalled();
  });
});

function appointment(overrides: Record<string, unknown> = {}) {
  return {
    _id: appointmentId,
    customerId,
    salesStaffId: actorId,
    status: AppointmentStatus.COMPLETED,
    siteAddress: 'Different appointment address',
    serviceTypes: ['gates'],
    customerSiteDetails: { customerRequirements: 'Old appointment requirements' },
    ...overrides,
  };
}

describe('createProject', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.appointmentFindById.mockResolvedValue(appointment());
    mocks.projectFindOne.mockResolvedValue(null);
    mocks.userFindOne.mockResolvedValue({ _id: customerId, roles: [Role.CUSTOMER], isActive: true });
    mocks.generateProjectNumber.mockResolvedValue('RMV-2026-0001');
    mocks.projectCreate.mockImplementation(async (payload) => ({ _id: 'project-1', ...payload, save: vi.fn() }));
    mocks.prepareOcularSchedule.mockResolvedValue(actorId);
    mocks.appointmentCreate.mockImplementation(async (payload) => ({ _id: 'ocular-appointment-1', ...payload }));
    mocks.reportFind.mockReturnValue({ sort: vi.fn().mockResolvedValue([]) });
    mocks.projectItemFindOneAndUpdate.mockImplementation(async (_filter, update) => ({
      _id: `item-${update.$set.serviceType}`,
      ...update.$setOnInsert,
      ...update.$set,
      save: vi.fn().mockResolvedValue(undefined),
    }));
    mocks.auditCreate.mockResolvedValue({});
    vi.mocked(verifyFileExists).mockResolvedValue(true);
  });

  it.each([undefined, appointmentId])('saves an ocular draft without a signed contract (appointment: %s)', async (sourceAppointmentId) => {
    mocks.reportFind.mockReturnValue({ sort: vi.fn().mockResolvedValue([{ _id: 'report-1', serviceType: 'gates', save: vi.fn() }]) });
    const project = await createProject({
      customerId,
      appointmentId: sourceAppointmentId,
      quantity: 1,
      ocularVisit: { date: '2026-10-08', slotCode: '09:00' },
    }, actorId, undefined, undefined, [Role.SALES_STAFF]);
    expect(project).toMatchObject({ status: ProjectStatus.DRAFT, contractStatus: ContractStatus.MISSING, ocularAppointmentId: 'ocular-appointment-1' });
    expect(verifyFileExists).not.toHaveBeenCalled();
    expect(mocks.appointmentCreate).toHaveBeenCalledOnce();
    expect(mocks.prepareOcularSchedule).toHaveBeenCalledWith(expect.objectContaining({ customerId, date: '2026-10-08', slotCode: '09:00' }));
  });

  it('does not persist a draft or appointment when the ocular schedule is unavailable', async () => {
    mocks.prepareOcularSchedule.mockRejectedValue(new Error('Slot unavailable'));
    await expect(createProject({ ...input, ocularVisit: { date: '2026-10-08', slotCode: '09:00' } }, actorId, undefined, undefined, [Role.SALES_STAFF])).rejects.toThrow('Slot unavailable');
    expect(mocks.projectCreate).not.toHaveBeenCalled();
    expect(mocks.appointmentCreate).not.toHaveBeenCalled();
  });

  it('creates a standalone draft using the project form and the acting sales staff', async () => {
    const project = await createProject(input, actorId, '127.0.0.1', 'vitest', [Role.SALES_STAFF]);

    expect(project).toMatchObject({
      ...input,
      projectNumber: 'RMV-2026-0001',
      salesStaffId: actorId,
      status: ProjectStatus.SUBMITTED,
      deliveryType: DeliveryType.SHOP_FABRICATED,
      contractStatus: ContractStatus.UPLOADED,
      contractFileKey: input.contractFileKey,
    });
    expect(project.appointmentId).toBeUndefined();
    expect(mocks.appointmentFindById).not.toHaveBeenCalled();
    expect(mocks.userFindOne).toHaveBeenCalledWith({ _id: customerId, roles: Role.CUSTOMER, isActive: true });
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.PROJECT_CREATED,
      actorId,
      targetId: 'project-1',
      ipAddress: '127.0.0.1',
      userAgent: 'vitest',
    }));
  });

  it.each([false, true])('creates a project without a site address with ocular selected: %s', async (withOcular) => {
    const { siteAddress: _siteAddress, ...withoutAddress } = input;
    const report = { _id: 'report-1', serviceType: 'gates', save: vi.fn() };
    mocks.reportFind.mockReturnValue({ sort: vi.fn().mockResolvedValue([report]) });
    const project = await createProject({
      ...withoutAddress,
      appointmentId,
      ocularVisit: withOcular ? { date: '2026-10-08', slotCode: '09:00' } : undefined,
    }, actorId, undefined, undefined, [Role.SALES_STAFF]);
    expect(project.siteAddress).toBeUndefined();
    expect(project.status).toBe(withOcular ? ProjectStatus.DRAFT : ProjectStatus.SUBMITTED);
  });

  it('imports every appointment service as a separate project item with its own visit details', async () => {
    const canopyReport = {
      _id: 'report-canopy',
      appointmentId,
      visitType: 'ocular',
      serviceType: 'canopy',
      measurementUnit: 'mm',
      lineItems: [{ label: 'Main roof', length: 3200, width: 1800, quantity: 1 }],
      specifications: { measurements: { projectionLength: 1800, totalWidth: 3200 } },
      customerRequirements: 'Include a gutter',
      discussionNotes: 'Consultation note for canopy',
      notes: 'Ocular note for canopy',
      photoKeys: ['visit-photos/canopy.jpg'],
      videoKeys: [],
      sketchKeys: [],
      referenceImageKeys: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
    const railingsReport = {
      _id: 'report-railings',
      appointmentId,
      visitType: 'ocular',
      serviceType: 'railings',
      measurementUnit: 'mm',
      lineItems: [{ label: 'Stair rail', length: 4100, height: 950, quantity: 2 }],
      specifications: { measurements: { totalRunLength: 4100, railHeight: 950 } },
      customerRequirements: 'Child-safe spacing',
      discussionNotes: 'Consultation note for railings',
      notes: 'Ocular note for railings',
      photoKeys: [],
      videoKeys: ['visit-videos/railings.mp4'],
      sketchKeys: [],
      referenceImageKeys: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
    mocks.appointmentFindById.mockResolvedValue(appointment({ serviceTypes: ['canopy', 'railings'] }));
    mocks.reportFind.mockReturnValue({ sort: vi.fn().mockResolvedValue([canopyReport, railingsReport]) });

    const project = await createProject({ ...input, appointmentId }, actorId, undefined, undefined, [Role.SALES_STAFF]);

    expect(project).toMatchObject({
      ...input,
      appointmentId,
      salesStaffId: actorId,
      serviceTypes: ['canopy', 'railings'],
      visitReportId: 'report-canopy',
      lineItems: canopyReport.lineItems,
      specifications: canopyReport.specifications,
    });
    expect(mocks.reportFindOne).not.toHaveBeenCalled();
    expect(mocks.reportFind).toHaveBeenCalledWith({ appointmentId });
    expect(mocks.projectItemFindOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.projectItemFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'project-1', serviceType: 'canopy' },
      expect.objectContaining({
        $set: expect.objectContaining({
          serviceType: 'canopy',
          lineItems: canopyReport.lineItems,
          specifications: canopyReport.specifications,
          customerRequirements: 'Include a gutter',
          notes: 'Consultation note for canopy\n\nOcular note for canopy',
          mediaKeys: ['visit-photos/canopy.jpg'],
          ocularVisitReportId: 'report-canopy',
        }),
      }),
      { upsert: true, new: true },
    );
    expect(mocks.projectItemFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'project-1', serviceType: 'railings' },
      expect.objectContaining({
        $set: expect.objectContaining({
          serviceType: 'railings',
          lineItems: railingsReport.lineItems,
          specifications: railingsReport.specifications,
          customerRequirements: 'Child-safe spacing',
          notes: 'Consultation note for railings\n\nOcular note for railings',
          mediaKeys: ['visit-videos/railings.mp4'],
          ocularVisitReportId: 'report-railings',
        }),
      }),
      { upsert: true, new: true },
    );
    expect(canopyReport).toMatchObject({ linkedProjectId: 'project-1', projectItemId: 'item-canopy' });
    expect(railingsReport).toMatchObject({ linkedProjectId: 'project-1', projectItemId: 'item-railings' });
    expect(canopyReport.save).toHaveBeenCalled();
    expect(railingsReport.save).toHaveBeenCalled();
    expect(mocks.projectItemCreate).not.toHaveBeenCalled();
  });

  it('creates the project first and schedules the ocular visit from project creation', async () => {
    const consultationReport = {
      _id: 'report-gates',
      appointmentId,
      visitType: 'consultation',
      status: 'submitted',
      serviceType: 'gates',
      measurementUnit: 'cm',
      lineItems: [],
      photoKeys: [],
      videoKeys: [],
      sketchKeys: [],
      referenceImageKeys: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
    mocks.reportFind.mockReturnValue({ sort: vi.fn().mockResolvedValue([consultationReport]) });

    const project = await createProject({
      ...input,
      appointmentId,
      serviceType: 'gates',
      ocularVisit: { date: '2026-10-08', slotCode: '09:00' },
    }, actorId, undefined, undefined, [Role.SALES_STAFF]);

    expect(project.status).toBe(ProjectStatus.DRAFT);
    expect(mocks.appointmentCreate).toHaveBeenCalledWith(expect.objectContaining({
      customerId,
      type: 'ocular',
      date: '2026-10-08',
      slotCode: '09:00',
      sourceConsultationAppointmentId: appointmentId,
      sourceConsultationReportId: 'report-gates',
    }));
    expect(consultationReport).toMatchObject({
      appointmentId: 'ocular-appointment-1',
      visitType: 'ocular',
      status: 'draft',
      linkedProjectId: 'project-1',
    });
    expect(consultationReport.save).toHaveBeenCalled();
    expect(mocks.projectItemFindOneAndUpdate).toHaveBeenLastCalledWith(
      { projectId: 'project-1', serviceType: 'gates' },
      expect.objectContaining({
        $set: expect.objectContaining({ ocularVisitReportId: 'report-gates' }),
      }),
      { upsert: true, new: true },
    );
  });

  it('creates a blank separate item instead of copying the primary item when a service has no report', async () => {
    const canopyReport = {
      _id: 'report-canopy',
      appointmentId,
      visitType: 'ocular',
      serviceType: 'canopy',
      measurementUnit: 'mm',
      lineItems: [{ label: 'Main roof', length: 3200, width: 1800, quantity: 1 }],
      specifications: { measurements: { projectionLength: 1800, totalWidth: 3200 } },
      photoKeys: [],
      videoKeys: [],
      sketchKeys: [],
      referenceImageKeys: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
    mocks.appointmentFindById.mockResolvedValue(appointment({ serviceTypes: ['canopy', 'railings'] }));
    mocks.reportFind.mockReturnValue({ sort: vi.fn().mockResolvedValue([canopyReport]) });

    await createProject({ ...input, appointmentId, serviceType: 'canopy' }, actorId, undefined, undefined, [Role.SALES_STAFF]);

    expect(mocks.projectItemCreate).toHaveBeenCalledTimes(1);
    const fallbackItem = mocks.projectItemCreate.mock.calls[0]![0];
    expect(fallbackItem).toMatchObject({
      projectId: 'project-1',
      appointmentId,
      serviceType: 'railings',
      title: 'Railings',
      lineItems: [],
      initialDesignKeys: [],
      mediaKeys: [],
      designReviewStatus: 'not_required',
    });
    expect(fallbackItem).not.toHaveProperty('measurements');
    expect(fallbackItem).not.toHaveProperty('specifications');
    expect(fallbackItem).not.toHaveProperty('customerRequirements');
    expect(fallbackItem).not.toHaveProperty('notes');
  });

  it('attaches a form-uploaded initial design only to the matching primary item', async () => {
    const canopyReport = {
      _id: 'report-canopy',
      appointmentId,
      visitType: 'ocular',
      serviceType: 'canopy',
      photoKeys: [],
      videoKeys: [],
      sketchKeys: [],
      referenceImageKeys: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
    const railingsReport = {
      _id: 'report-railings',
      appointmentId,
      visitType: 'ocular',
      serviceType: 'railings',
      photoKeys: [],
      videoKeys: [],
      sketchKeys: [],
      referenceImageKeys: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
    mocks.appointmentFindById.mockResolvedValue(appointment({ serviceTypes: ['canopy', 'railings'] }));
    mocks.reportFind.mockReturnValue({ sort: vi.fn().mockResolvedValue([canopyReport, railingsReport]) });

    await createProject({
      ...input,
      appointmentId,
      serviceType: 'canopy',
      initialDesignKeys: ['projects/initial-design/canopy.pdf'],
      initialDesignNotes: 'Canopy concept',
    }, actorId, undefined, undefined, [Role.SALES_STAFF]);

    const canopyUpdate = mocks.projectItemFindOneAndUpdate.mock.calls.find(
      ([filter]) => filter.serviceType === 'canopy',
    )?.[1];
    const railingsUpdate = mocks.projectItemFindOneAndUpdate.mock.calls.find(
      ([filter]) => filter.serviceType === 'railings',
    )?.[1];
    expect(canopyUpdate?.$setOnInsert).toMatchObject({
      initialDesignKeys: ['projects/initial-design/canopy.pdf'],
      initialDesignNotes: 'Canopy concept',
      designReviewStatus: 'pending',
    });
    expect(railingsUpdate?.$setOnInsert).toMatchObject({
      initialDesignKeys: [],
      designReviewStatus: 'not_required',
    });
  });

  it('repairs an older primary item that is missing its project-level initial design', async () => {
    const existingItem = {
      _id: 'item-canopy',
      initialDesignKeys: [],
      initialDesignNotes: undefined,
      designReviewStatus: 'not_required',
      save: vi.fn().mockResolvedValue(undefined),
    };
    const canopyReport = {
      _id: 'report-canopy',
      appointmentId,
      visitType: 'ocular',
      serviceType: 'canopy',
      photoKeys: [],
      videoKeys: [],
      sketchKeys: [],
      referenceImageKeys: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
    mocks.appointmentFindById.mockResolvedValue(appointment({ serviceTypes: ['canopy'] }));
    mocks.reportFind.mockReturnValue({ sort: vi.fn().mockResolvedValue([canopyReport]) });
    mocks.projectItemFindOneAndUpdate.mockResolvedValue(existingItem);

    await createProject({
      ...input,
      appointmentId,
      serviceType: 'canopy',
      initialDesignKeys: ['projects/initial-design/canopy.pdf'],
      initialDesignNotes: 'Canopy concept',
    }, actorId, undefined, undefined, [Role.SALES_STAFF]);

    expect(existingItem).toMatchObject({
      initialDesignKeys: ['projects/initial-design/canopy.pdf'],
      initialDesignNotes: 'Canopy concept',
      designReviewStatus: 'pending',
    });
    expect(existingItem.save).toHaveBeenCalled();
  });

  it('saves moved specifications, design and attachment data on an independent project', async () => {
    const movedFields = {
      preferredDesign: 'Minimalist', customerRequirements: 'Child safe edges',
      specifications: { materialsDesign: { material: 'Stainless 304' } },
      lineItems: [{ label: 'Left panel', width: 40, quantity: 2 }],
      initialDesignKeys: ['projects/initial-design/sketch.pdf'], initialDesignNotes: 'Rounded corners',
      selectedDesignTemplateId: 'template-1', selectedDesignTemplateName: 'Steel gate',
      photoKeys: ['visit-photos/site.jpg'], videoKeys: ['visit-videos/site.mp4'],
      sketchKeys: ['visit-sketches/sketch.pdf'], referenceImageKeys: ['visit-references/reference.jpg'],
    };
    const project = await createProject({ ...input, ...movedFields }, actorId);
    expect(project).toMatchObject({ ...movedFields, designReviewStatus: 'pending' });
    expect(project.mediaKeys).toEqual([
      'visit-photos/site.jpg', 'visit-videos/site.mp4', 'visit-sketches/sketch.pdf', 'visit-references/reference.jpg',
    ]);
    expect(mocks.appointmentFindById).not.toHaveBeenCalled();
    expect(mocks.reportFindOne).not.toHaveBeenCalled();
  });

  it('supports the legacy linked input by resolving the customer from the appointment', async () => {
    const { customerId: _customerId, ...legacyInput } = input;
    const project = await createProject({ ...legacyInput, appointmentId }, actorId);
    expect(project.customerId).toBe(customerId);
  });

  it('allows an admin to link another sales staff appointment while retaining the assigned staff', async () => {
    const project = await createProject({ ...input, appointmentId }, 'admin-1', undefined, undefined, [Role.ADMIN]);
    expect(project.salesStaffId).toBe(actorId);
  });

  it.each([undefined, 'other-sales-staff'])('rejects appointments not assigned to the actor (%s)', async (salesStaffId) => {
    mocks.appointmentFindById.mockResolvedValue(appointment({ salesStaffId }));
    await expect(createProject({ ...input, appointmentId }, actorId, undefined, undefined, [Role.SALES_STAFF]))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.projectCreate).not.toHaveBeenCalled();
  });

  it.each(Object.values(AppointmentStatus).filter((status) => status !== AppointmentStatus.COMPLETED))(
    'rejects linking an appointment in %s status', async (status) => {
      mocks.appointmentFindById.mockResolvedValue(appointment({ status }));
      await expect(createProject({ ...input, appointmentId }, actorId))
        .rejects.toThrow('Only completed appointments can be linked');
      expect(mocks.projectCreate).not.toHaveBeenCalled();
    },
  );

  it('rejects a link to another customer appointment', async () => {
    mocks.appointmentFindById.mockResolvedValue(appointment({ customerId: 'other-customer' }));
    await expect(createProject({ ...input, appointmentId }, actorId))
      .rejects.toThrow('The appointment must belong to the selected customer');
    expect(mocks.projectCreate).not.toHaveBeenCalled();
  });

  it('rejects a missing appointment', async () => {
    mocks.appointmentFindById.mockResolvedValue(null);
    await expect(createProject({ ...input, appointmentId }, actorId)).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.projectCreate).not.toHaveBeenCalled();
  });

  it('rejects a duplicate appointment link', async () => {
    mocks.projectFindOne.mockResolvedValue({ _id: 'existing-project' });
    await expect(createProject({ ...input, appointmentId }, actorId))
      .rejects.toMatchObject({ statusCode: 409, code: 'DUPLICATE_ENTRY' });
    expect(mocks.projectCreate).not.toHaveBeenCalled();
  });

  it('rejects a customer who is missing, inactive, or is not a customer', async () => {
    mocks.userFindOne.mockResolvedValue(null);
    await expect(createProject(input, actorId)).rejects.toThrow('Select an active customer');
    expect(mocks.userFindOne).toHaveBeenCalledWith({ _id: customerId, roles: Role.CUSTOMER, isActive: true });
    expect(mocks.projectCreate).not.toHaveBeenCalled();
  });

  it('rejects an input without either a customer or an appointment', async () => {
    const { customerId: _customerId, ...missingCustomerInput } = input;
    await expect(createProject(missingCustomerInput, actorId)).rejects.toThrow('Select a customer');
    expect(mocks.projectCreate).not.toHaveBeenCalled();
  });

  it('rejects creation when the uploaded contract cannot be verified', async () => {
    vi.mocked(verifyFileExists).mockResolvedValue(false);
    await expect(createProject(input, actorId)).rejects.toThrow('Uploaded contract file could not be verified');
    expect(mocks.projectCreate).not.toHaveBeenCalled();
  });
});

describe('assignFabricationStaff', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.projectItemFind.mockReturnValue({ select: vi.fn().mockResolvedValue([]) });
    mocks.paymentPlanFindOne.mockResolvedValue(null);
    mocks.blueprintFindOne.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({ status: 'approved' }),
      }),
    });
    mocks.userFindOne.mockResolvedValue({ _id: 'fabricator-1' });
    mocks.auditCreate.mockResolvedValue({});
  });

  it('assigns the fabrication team before payment while keeping updates locked', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const project = {
      _id: { toString: () => 'project-1' },
      customerId: { toString: () => 'customer-1' },
      title: 'Kitchen Counter',
      status: ProjectStatus.PAYMENT_PENDING,
      fabricationAssistantIds: [],
      save,
    };
    mocks.projectFindById.mockResolvedValue(project);

    const result = await assignFabricationStaff(
      'project-1',
      { fabricationLeadId: 'fabricator-1', fabricationAssistantIds: [] },
      actorId,
    );

    expect(result).toBe(project);
    expect(project).toMatchObject({
      status: ProjectStatus.PAYMENT_PENDING,
      fabricationLeadId: 'fabricator-1',
      fabricationAssistantIds: [],
    });
    expect(save).toHaveBeenCalledOnce();
    expect(mocks.projectItemUpdateMany).not.toHaveBeenCalled();
  });
});

describe('updateProject delivery type authorization', () => {
  it('allows only admins to change delivery type', async () => {
    const project = {
      _id: 'project-1',
      status: ProjectStatus.SUBMITTED,
      deliveryType: DeliveryType.SHOP_FABRICATED,
      save: vi.fn(),
    };
    mocks.projectFindById.mockResolvedValue(project);

    await expect(updateProject(
      'project-1',
      { deliveryType: DeliveryType.ON_SITE_INSTALLATION },
      actorId,
      undefined,
      undefined,
      [Role.SALES_STAFF],
    )).rejects.toThrow('Only an admin can change the delivery type');

    await updateProject(
      'project-1',
      { deliveryType: DeliveryType.ON_SITE_INSTALLATION },
      'admin-1',
      undefined,
      undefined,
      [Role.ADMIN],
    );
    expect(project.deliveryType).toBe(DeliveryType.ON_SITE_INSTALLATION);
    expect(project.save).toHaveBeenCalled();
  });
});

describe('updateProjectSiteAddress', () => {
  const address = { siteAddress: '456 Installation Street' };
  let project: { _id: string; status: ProjectStatus; siteAddress?: string; fabricationLeadId: string; fabricationAssistantIds: string[]; save: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.resetAllMocks();
    project = {
      _id: 'project-1', status: ProjectStatus.FABRICATION,
      fabricationLeadId: 'fabricator-1', fabricationAssistantIds: ['assistant-1'],
      save: vi.fn().mockResolvedValue(undefined),
    };
    mocks.projectFindById.mockResolvedValue(project);
  });

  it.each(['fabricator-1', 'assistant-1'])('persists the address entered by assigned member %s', async (memberId) => {
    const result = await updateProjectSiteAddress('project-1', address, memberId, '127.0.0.1', 'vitest', [Role.FABRICATION_STAFF]);
    expect(result.siteAddress).toBe(address.siteAddress);
    expect(project.save).toHaveBeenCalledOnce();
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      actorId: memberId, action: AuditAction.PROJECT_UPDATED, targetId: 'project-1', details: address,
    }));
  });

  it.each([
    ['unassigned-fabricator', Role.FABRICATION_STAFF],
    ['fabricator-1', Role.SALES_STAFF],
    ['fabricator-1', Role.ENGINEER],
    ['fabricator-1', Role.CUSTOMER],
  ])('denies %s with role %s', async (memberId, role) => {
    await expect(updateProjectSiteAddress('project-1', address, memberId, undefined, undefined, [role as Role])).rejects.toThrow('Only the assigned fabrication team');
    expect(project.save).not.toHaveBeenCalled();
    expect(project.siteAddress).toBeUndefined();
  });

  it('allows the admin to save an address', async () => {
    await updateProjectSiteAddress('project-1', address, 'admin-1', undefined, undefined, [Role.ADMIN]);
    expect(project.siteAddress).toBe(address.siteAddress);
  });

  it.each([ProjectStatus.COMPLETED, ProjectStatus.CANCELLED])('rejects changes to a %s project', async (status) => {
    project.status = status;
    await expect(updateProjectSiteAddress('project-1', address, 'fabricator-1', undefined, undefined, [Role.FABRICATION_STAFF])).rejects.toThrow('completed or cancelled');
    expect(project.save).not.toHaveBeenCalled();
  });

  it('returns not found for a missing project', async () => {
    mocks.projectFindById.mockResolvedValue(null);
    await expect(updateProjectSiteAddress('missing', address, 'fabricator-1', undefined, undefined, [Role.FABRICATION_STAFF])).rejects.toThrow('Project not found');
  });
});
