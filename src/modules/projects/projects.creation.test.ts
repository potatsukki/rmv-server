import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appointmentFindById: vi.fn(),
  projectFindOne: vi.fn(),
  projectCreate: vi.fn(),
  userFindOne: vi.fn(),
  auditCreate: vi.fn(),
  reportFindOne: vi.fn(),
  reportFind: vi.fn(),
  projectItemCreate: vi.fn(),
  generateProjectNumber: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Project: { findOne: mocks.projectFindOne, create: mocks.projectCreate },
  ProjectItem: { create: mocks.projectItemCreate },
  Appointment: { findById: mocks.appointmentFindById },
  User: { findOne: mocks.userFindOne },
  AuditLog: { create: mocks.auditCreate },
  VisitReport: { findOne: mocks.reportFindOne, find: mocks.reportFind },
}));
vi.mock('../../models/Payment.js', () => ({ PaymentPlan: {} }));
vi.mock('../../models/Blueprint.js', () => ({ Blueprint: {} }));
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

import { createProject } from './projects.service.js';
import { verifyFileExists } from '../uploads/upload.service.js';
import { AppointmentStatus, AuditAction, ContractStatus, ProjectStatus, Role } from '../../utils/constants.js';

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

  it('links a completed appointment without importing its information or visit-report specifications', async () => {
    const project = await createProject({ ...input, appointmentId }, actorId, undefined, undefined, [Role.SALES_STAFF]);

    expect(project).toMatchObject({ ...input, appointmentId, salesStaffId: actorId });
    expect(project.consultationVisitReportId).toBeUndefined();
    expect(project.ocularVisitReportId).toBeUndefined();
    expect(mocks.reportFindOne).not.toHaveBeenCalled();
    expect(mocks.reportFind).not.toHaveBeenCalled();
    expect(mocks.projectItemCreate).not.toHaveBeenCalled();
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
