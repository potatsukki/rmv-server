import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectFindById: vi.fn(),
  projectItemFind: vi.fn(),
  projectItemCreate: vi.fn(),
  projectItemUpdateMany: vi.fn(),
  visitReportFind: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Project: { findById: mocks.projectFindById },
  ProjectItem: {
    find: mocks.projectItemFind,
    create: mocks.projectItemCreate,
    updateMany: mocks.projectItemUpdateMany,
  },
  Appointment: {},
  User: {},
  AuditLog: {},
  VisitReport: { find: mocks.visitReportFind, findOne: vi.fn() },
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

import { getProjectById } from './projects.service.js';
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
});
