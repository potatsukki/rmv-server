import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectFindById: vi.fn(),
  projectFindOne: vi.fn(),
  projectItemFind: vi.fn(),
  projectItemCreate: vi.fn(),
  projectItemUpdateMany: vi.fn(),
  visitReportFind: vi.fn(),
  visitReportFindById: vi.fn(),
  appointmentFindById: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Project: { findById: mocks.projectFindById, findOne: mocks.projectFindOne },
  ProjectItem: {
    find: mocks.projectItemFind,
    create: mocks.projectItemCreate,
    updateMany: mocks.projectItemUpdateMany,
  },
  Appointment: { findById: mocks.appointmentFindById },
  User: {},
  AuditLog: {},
  VisitReport: { find: mocks.visitReportFind, findById: mocks.visitReportFindById, findOne: vi.fn() },
}));
vi.mock('../../models/Payment.js', () => ({ PaymentPlan: {} }));
vi.mock('../../models/Blueprint.js', () => ({ Blueprint: {} }));
vi.mock('../notifications/socket.service.js', () => ({
  createAndSendNotification: vi.fn(), notifyRole: vi.fn(),
}));
vi.mock('../../services/contract.service.js', () => ({ generateAndUploadContract: vi.fn() }));
vi.mock('../uploads/upload.service.js', () => ({ generateDownloadUrl: vi.fn(), verifyFileExists: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../config/config.service.js', () => ({ getInstallmentConfig: vi.fn() }));
vi.mock('../../utils/projectNumber.js', () => ({ generateProjectNumber: vi.fn() }));
vi.mock('../fabrication/fabrication.service.js', () => ({ seedFabricationItems: vi.fn() }));

import { getContractDownloadUrl, getProjectById, getProjectByVisitReportId, getProjectHistory } from './projects.service.js';
import { ProjectStatus, Role } from '../../utils/constants.js';

function thenablePopulate<T>(result: T) {
  const chain: any = {
    populate: vi.fn(() => chain),
    then: (resolve: (value: T) => unknown, reject: (error: unknown) => unknown) => (
      Promise.resolve(result).then(resolve, reject)
    ),
  };
  return chain;
}

function populatedItems<T>(result: T) {
  const chain: any = {
    populate: vi.fn(() => chain),
    sort: vi.fn(() => chain),
    lean: vi.fn().mockResolvedValue(result),
  };
  return chain;
}

describe('fabrication project access', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('denies an unassigned fabricator before reading or repairing related project records', async () => {
    const project = { _id: 'project-1', fabricationAssistantIds: [{ _id: 'another-user' }] };
    mocks.projectFindById.mockReturnValue(thenablePopulate(project));

    await expect(getProjectById('project-1', 'fabricator-1', [Role.FABRICATION_STAFF]))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.visitReportFind).not.toHaveBeenCalled();
    expect(mocks.projectItemFind).not.toHaveBeenCalled();
  });

  it.each([
    { fabricationLeadId: { _id: 'fabricator-1' } },
    { fabricationAssistantIds: [{ _id: 'fabricator-1' }] },
    { deliveryCrewIds: ['fabricator-1'] },
  ])('lets a fabricator open an assigned project awaiting payment (%o)', async (assignment) => {
    const data = { _id: 'project-1', status: ProjectStatus.PAYMENT_PENDING, ...assignment };
    const project = { ...data, visitReportId: 'report-1', toObject: () => data };
    const item = { _id: 'item-1', projectId: 'project-1', ocularVisitReportId: 'report-1' };
    mocks.projectFindById.mockReturnValue(thenablePopulate(project));
    mocks.visitReportFind.mockReturnValue({ sort: vi.fn().mockResolvedValue([]) });
    mocks.projectItemFind
      .mockReturnValueOnce({ sort: vi.fn().mockResolvedValue([item]) })
      .mockReturnValueOnce(populatedItems([item]));

    await expect(getProjectById('project-1', 'fabricator-1', [Role.FABRICATION_STAFF])).resolves.toMatchObject(data);
  });

  it('denies project history and signed contracts to an unassigned fabricator', async () => {
    const project = { _id: 'project-1', fabricationLeadId: 'another-user' };
    mocks.projectFindById
      .mockReturnValueOnce({ select: () => ({ lean: async () => project }) })
      .mockResolvedValueOnce(project);

    await expect(getProjectHistory('project-1', 'fabricator-1', [Role.FABRICATION_STAFF]))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(getContractDownloadUrl('project-1', 'original', 'fabricator-1', [Role.FABRICATION_STAFF]))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.visitReportFind).not.toHaveBeenCalled();
  });

  it('keeps the assignment scope for both visit-report project lookups', async () => {
    mocks.projectFindOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
    mocks.visitReportFindById.mockReturnValue({ select: () => ({ lean: async () => ({ linkedProjectId: 'unassigned-project' }) }) });

    await expect(getProjectByVisitReportId('report-1', 'fabricator-1', [Role.FABRICATION_STAFF])).resolves.toBeNull();
    const scope = {
      $or: [
        { fabricationLeadId: 'fabricator-1' },
        { fabricationAssistantIds: 'fabricator-1' },
        { deliveryCrewIds: 'fabricator-1' },
      ],
    };
    expect(mocks.projectFindOne.mock.calls).toEqual([
      [{ visitReportId: 'report-1', ...scope }],
      [{ _id: 'unassigned-project', ...scope }],
    ]);
  });
});

describe('getProjectById project-item repair', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('clears copied project details from a sibling that has no matching visit report', async () => {
    const project = {
      _id: 'project-1',
      customerId: { _id: 'customer-1' },
      serviceType: 'kitchen_counter',
      serviceTypes: ['kitchen_counter', 'staircase'],
      status: ProjectStatus.SUBMITTED,
      visitReportId: { _id: 'report-kitchen' },
      toObject: vi.fn().mockReturnValue({
        _id: 'project-1',
        customerId: { _id: 'customer-1' },
        serviceType: 'kitchen_counter',
        serviceTypes: ['kitchen_counter', 'staircase'],
        status: ProjectStatus.SUBMITTED,
      }),
    };
    const primaryItem = {
      _id: 'item-kitchen',
      projectId: 'project-1',
      serviceType: 'kitchen_counter',
      ocularVisitReportId: 'report-kitchen',
      lineItems: [{ label: 'Counter', quantity: 1 }],
    };
    const contaminatedSibling = {
      _id: 'item-staircase',
      projectId: 'project-1',
      serviceType: 'staircase',
      lineItems: [{ label: 'Counter', quantity: 1 }],
      materials: 'Stainless steel 304',
      customerRequirements: 'Include sink cutout',
      notes: 'Kitchen-only note',
    };
    const repairedSibling = {
      _id: 'item-staircase',
      projectId: 'project-1',
      serviceType: 'staircase',
      lineItems: [],
    };

    mocks.projectFindById.mockReturnValue(thenablePopulate(project));
    mocks.visitReportFind.mockReturnValue({ sort: vi.fn().mockResolvedValue([]) });
    mocks.projectItemFind
      .mockReturnValueOnce({ sort: vi.fn().mockResolvedValue([primaryItem, contaminatedSibling]) })
      .mockReturnValueOnce(populatedItems([primaryItem, repairedSibling]));
    mocks.projectItemUpdateMany.mockResolvedValue({ modifiedCount: 1 });

    const result = await getProjectById('project-1', 'admin-1', [Role.ADMIN]);

    expect(mocks.projectItemUpdateMany).toHaveBeenCalledWith(
      { _id: { $in: ['item-staircase'] }, projectId: 'project-1' },
      { $unset: expect.objectContaining({
        measurements: 1,
        lineItems: 1,
        materials: 1,
        customerRequirements: 1,
        notes: 1,
      }) },
    );
    expect(result.items).toEqual([primaryItem, repairedSibling]);
    expect(mocks.projectItemCreate).not.toHaveBeenCalled();
  });

  it('preserves sibling details that are linked to an authoritative visit report', async () => {
    const project = {
      _id: 'project-1',
      customerId: { _id: 'customer-1' },
      serviceType: 'kitchen_counter',
      serviceTypes: ['kitchen_counter', 'staircase'],
      status: ProjectStatus.SUBMITTED,
      visitReportId: { _id: 'report-kitchen' },
      toObject: vi.fn().mockReturnValue({
        _id: 'project-1',
        customerId: { _id: 'customer-1' },
        serviceType: 'kitchen_counter',
        serviceTypes: ['kitchen_counter', 'staircase'],
        status: ProjectStatus.SUBMITTED,
      }),
    };
    const items = [
      {
        _id: 'item-kitchen',
        projectId: 'project-1',
        serviceType: 'kitchen_counter',
        ocularVisitReportId: 'report-kitchen',
      },
      {
        _id: 'item-staircase',
        projectId: 'project-1',
        serviceType: 'staircase',
        ocularVisitReportId: 'report-staircase',
        materials: 'Stainless steel 316',
        customerRequirements: 'Match stair angle',
      },
    ];

    mocks.projectFindById.mockReturnValue(thenablePopulate(project));
    mocks.visitReportFind.mockReturnValue({ sort: vi.fn().mockResolvedValue([]) });
    mocks.projectItemFind
      .mockReturnValueOnce({ sort: vi.fn().mockResolvedValue(items) })
      .mockReturnValueOnce(populatedItems(items));

    const result = await getProjectById('project-1', 'admin-1', [Role.ADMIN]);

    expect(mocks.projectItemUpdateMany).not.toHaveBeenCalled();
    expect(result.items).toEqual(items);
  });

  it('shows the ocular visit pin as the project site address', async () => {
    const project = {
      _id: 'project-1',
      customerId: { _id: 'customer-1' },
      serviceType: 'railings',
      serviceTypes: ['railings', 'gates'],
      status: ProjectStatus.FABRICATION,
      visitReportId: { _id: 'report-railings' },
      ocularAppointmentId: 'ocular-1',
      siteAddress: undefined as string | undefined,
      save: vi.fn().mockResolvedValue(undefined),
      toObject: vi.fn().mockReturnValue({
        _id: 'project-1',
        customerId: { _id: 'customer-1' },
        serviceType: 'railings',
        serviceTypes: ['railings', 'gates'],
        status: ProjectStatus.FABRICATION,
      }),
    };
    const items = [
      { _id: 'item-railings', projectId: 'project-1', serviceType: 'railings', ocularVisitReportId: 'report-railings' },
      { _id: 'item-gates', projectId: 'project-1', serviceType: 'gates', ocularVisitReportId: 'report-gates' },
    ];

    mocks.projectFindById.mockReturnValue(thenablePopulate(project));
    mocks.appointmentFindById.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ formattedAddress: 'Paco-Santa Mesa Road, Manila' }) }),
    });
    mocks.visitReportFind.mockReturnValue({ sort: vi.fn().mockResolvedValue([]) });
    mocks.projectItemFind
      .mockReturnValueOnce({ sort: vi.fn().mockResolvedValue(items) })
      .mockReturnValueOnce(populatedItems(items));

    await getProjectById('project-1', 'admin-1', [Role.ADMIN]);

    expect(mocks.appointmentFindById).toHaveBeenCalledWith('ocular-1');
    expect(project.siteAddress).toBe('Paco-Santa Mesa Road, Manila');
    expect(project.save).toHaveBeenCalledOnce();
  });
});
