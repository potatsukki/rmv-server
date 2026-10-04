import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectFind: vi.fn(),
  projectCountDocuments: vi.fn(),
  projectItemFind: vi.fn(),
  projectItemBulkWrite: vi.fn(),
  blueprintAggregate: vi.fn(),
  appointmentFind: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Project: {
    find: mocks.projectFind,
    countDocuments: mocks.projectCountDocuments,
  },
  ProjectItem: {
    find: mocks.projectItemFind,
    bulkWrite: mocks.projectItemBulkWrite,
  },
  Appointment: { find: mocks.appointmentFind },
  User: {},
  AuditLog: {},
  VisitReport: {},
}));
vi.mock('../../models/Payment.js', () => ({ PaymentPlan: {} }));
vi.mock('../../models/Blueprint.js', () => ({ Blueprint: { aggregate: mocks.blueprintAggregate } }));
vi.mock('../notifications/socket.service.js', () => ({
  createAndSendNotification: vi.fn(), notifyRole: vi.fn(),
}));
vi.mock('../../services/contract.service.js', () => ({ generateAndUploadContract: vi.fn() }));
vi.mock('../uploads/upload.service.js', () => ({ generateDownloadUrl: vi.fn(), verifyFileExists: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../config/config.service.js', () => ({ getInstallmentConfig: vi.fn() }));
vi.mock('../../utils/projectNumber.js', () => ({ generateProjectNumber: vi.fn() }));
vi.mock('../fabrication/fabrication.service.js', () => ({ seedFabricationItems: vi.fn() }));

import { listProjects } from './projects.service.js';
import { ProjectStatus, Role } from '../../utils/constants.js';

function queryChain<T>(result: T) {
  const chain: Record<string, unknown> = {};
  for (const method of ['populate', 'sort', 'skip', 'limit', 'select']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.lean = vi.fn().mockResolvedValue(result);
  return chain;
}

describe('listProjects project-item fallback', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('keeps primary project details off a missing sibling item', async () => {
    const project = {
      _id: 'project-1',
      appointmentId: 'appointment-1',
      title: 'Kitchen Counter & Staircase',
      serviceType: 'kitchen_counter',
      serviceTypes: ['kitchen_counter', 'staircase'],
      status: ProjectStatus.SUBMITTED,
      measurements: { length: 240, unit: 'cm' },
      measurementUnit: 'cm',
      lineItems: [{ label: 'Counter', length: 240, quantity: 1 }],
      specifications: { materialsDesign: { steelGrade: '304' } },
      preferredDesign: 'Kitchen layout A',
      customerRequirements: 'Include sink cutout',
      selectedDesignTemplateId: 'kitchen-template',
      selectedDesignTemplateName: 'Kitchen template',
      selectedDesignTemplateImageUrl: '/kitchen-template.jpg',
      materialType: 'Stainless steel 304',
      finishColor: 'Brushed',
      notes: 'Kitchen-only note',
      initialDesignKeys: ['projects/initial-design/kitchen.pdf'],
      initialDesignNotes: 'Kitchen concept',
      mediaKeys: ['visit-photos/kitchen.jpg'],
    };
    mocks.projectFind.mockReturnValue(queryChain([project]));
    mocks.projectCountDocuments.mockResolvedValue(1);
    mocks.blueprintAggregate.mockResolvedValue([]);

    let insertedItems: Array<Record<string, unknown>> = [];
    mocks.projectItemFind
      .mockReturnValueOnce(queryChain([]))
      .mockImplementationOnce(() => queryChain(insertedItems));
    mocks.projectItemBulkWrite.mockImplementation(async (operations) => {
      insertedItems = operations.map((operation: any, index: number) => ({
        _id: `item-${index + 1}`,
        ...operation.updateOne.update.$setOnInsert,
      }));
      return {};
    });

    const result = await listProjects({}, 'admin-1', [Role.ADMIN]);

    expect(mocks.projectItemBulkWrite).toHaveBeenCalledOnce();
    expect(result.items[0]?.items).toHaveLength(2);

    const primaryItem = result.items[0]?.items?.find((item: any) => item.serviceType === 'kitchen_counter');
    const siblingItem = result.items[0]?.items?.find((item: any) => item.serviceType === 'staircase');
    expect(primaryItem).toMatchObject({
      measurements: project.measurements,
      lineItems: project.lineItems,
      customerRequirements: project.customerRequirements,
      notes: project.notes,
    });
    expect(siblingItem).toMatchObject({
      serviceType: 'staircase',
      title: 'Staircase',
      lineItems: [],
      initialDesignKeys: [],
      mediaKeys: [],
      designReviewStatus: 'not_required',
    });
    expect(siblingItem).not.toHaveProperty('measurements');
    expect(siblingItem).not.toHaveProperty('specifications');
    expect(siblingItem).not.toHaveProperty('customerRequirements');
    expect(siblingItem).not.toHaveProperty('notes');
    expect(mocks.appointmentFind).not.toHaveBeenCalled();
  });

  it('includes each ocular visit status with one batch lookup while preserving appointment IDs', async () => {
    const projects = [
      { _id: 'project-1', serviceType: 'railings', status: ProjectStatus.DRAFT, ocularAppointmentId: 'ocular-1' },
      { _id: 'project-2', serviceType: 'gates', status: ProjectStatus.DRAFT, ocularAppointmentId: 'ocular-2' },
      { _id: 'project-3', serviceType: 'doors', status: ProjectStatus.SUBMITTED },
    ];
    mocks.projectFind.mockReturnValue(queryChain(projects));
    mocks.projectCountDocuments.mockResolvedValue(3);
    mocks.projectItemFind.mockReturnValue(queryChain(projects.map((p) => ({ projectId: p._id, serviceType: p.serviceType }))));
    mocks.blueprintAggregate.mockResolvedValue([]);
    mocks.appointmentFind.mockReturnValue(queryChain([
      { _id: 'ocular-1', status: 'completed' },
      { _id: 'ocular-2', status: 'confirmed' },
    ]));

    const result = await listProjects({}, 'sales-1', [Role.SALES_STAFF]);
    expect(result.items[0]).toMatchObject({ ocularAppointmentId: 'ocular-1', ocularVisitStatus: 'completed' });
    expect(result.items[1]).toMatchObject({ ocularAppointmentId: 'ocular-2', ocularVisitStatus: 'confirmed' });
    expect(result.items[2].ocularVisitStatus).toBeUndefined();
    expect(mocks.appointmentFind).toHaveBeenCalledOnce();
    expect(mocks.appointmentFind).toHaveBeenCalledWith({ _id: { $in: ['ocular-1', 'ocular-2'] } });
  });
});
