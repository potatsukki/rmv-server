import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appointmentFindById: vi.fn(),
  appointmentCreate: vi.fn(),
  projectFindOne: vi.fn(),
  projectFindById: vi.fn(),
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
}));

vi.mock('../../models/index.js', () => ({
  Project: { findOne: mocks.projectFindOne, findById: mocks.projectFindById, create: mocks.projectCreate },
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

import { assignFabricationStaff, createProject, updateProject } from './projects.service.js';
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
    mocks.projectCreate.mockImplementation(async (payload) => ({ _id: 'project-1', ...payload }));
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
