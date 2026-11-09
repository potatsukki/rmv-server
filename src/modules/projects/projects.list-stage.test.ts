import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectFind: vi.fn(),
  projectCountDocuments: vi.fn(),
  projectItemFind: vi.fn(),
  projectItemBulkWrite: vi.fn(),
  blueprintAggregate: vi.fn(),
  blueprintDistinct: vi.fn(),
  appointmentFind: vi.fn(),
  planFind: vi.fn(),
  paymentDistinct: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Project: { find: mocks.projectFind, countDocuments: mocks.projectCountDocuments },
  ProjectItem: { find: mocks.projectItemFind, bulkWrite: mocks.projectItemBulkWrite },
  Appointment: { find: mocks.appointmentFind },
  PaymentPlan: { find: mocks.planFind },
  Payment: { distinct: mocks.paymentDistinct },
  Blueprint: { distinct: mocks.blueprintDistinct },
  User: {},
  AuditLog: {},
  VisitReport: {},
}));
vi.mock('../../models/Payment.js', () => ({ PaymentPlan: { find: mocks.planFind } }));
vi.mock('../../models/Blueprint.js', () => ({ Blueprint: { aggregate: mocks.blueprintAggregate } }));
vi.mock('../notifications/socket.service.js', () => ({ createAndSendNotification: vi.fn(), notifyRole: vi.fn() }));
vi.mock('../../services/contract.service.js', () => ({ generateAndUploadContract: vi.fn() }));
vi.mock('../uploads/upload.service.js', () => ({ generateDownloadUrl: vi.fn(), verifyFileExists: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../config/config.service.js', () => ({ getInstallmentConfig: vi.fn() }));
vi.mock('../../utils/projectNumber.js', () => ({ generateProjectNumber: vi.fn() }));
vi.mock('../fabrication/fabrication.service.js', () => ({ seedFabricationItems: vi.fn() }));

import { listProjects } from './projects.service.js';
import { Role } from '../../utils/constants.js';

type TestProject = { _id: string; status: string; serviceType?: string; designFee?: { status: string } };

/** The paged list query (populate → sort → skip → limit → lean). */
function pageQuery<T>(result: T) {
  const chain: Record<string, unknown> = {};
  for (const method of ['populate', 'sort', 'skip', 'limit', 'select']) chain[method] = vi.fn(() => chain);
  chain.lean = vi.fn().mockResolvedValue(result);
  return chain;
}

const leanExec = <T>(value: T) => ({ select: () => ({ lean: () => ({ exec: vi.fn().mockResolvedValue(value) }) }) });

function setup(candidates: TestProject[], itemStatuses: Array<{ projectId: string; status: string }>, page: TestProject[]) {
  mocks.projectFind
    // 1) candidate ids for the stage/payment filter, 2) the paged list itself
    .mockReturnValueOnce({ select: () => ({ lean: vi.fn().mockResolvedValue(candidates) }) })
    .mockReturnValueOnce(pageQuery(page));
  mocks.projectCountDocuments.mockResolvedValue(page.length);
  mocks.projectItemFind
    .mockReturnValueOnce(leanExec(itemStatuses))
    .mockReturnValueOnce(pageQuery(page.map((project) => ({ projectId: project._id, serviceType: project.serviceType, status: project.status }))));
  mocks.blueprintAggregate.mockResolvedValue([]);
  mocks.appointmentFind.mockReturnValue(pageQuery([]));
}

const pagedFilter = () => mocks.projectFind.mock.calls[1]![0] as Record<string, unknown>;

describe('listProjects stage and payment filters', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.planFind.mockReturnValue(leanExec([]));
    mocks.blueprintDistinct.mockReturnValue({ exec: vi.fn().mockResolvedValue([]) });
    mocks.paymentDistinct.mockReturnValue({ exec: vi.fn().mockResolvedValue([]) });
  });

  it('pages only the projects in the requested stage, using item statuses like the badge', async () => {
    setup(
      [
        { _id: 'p1', status: 'approved' },
        { _id: 'p2', status: 'blueprint' },
        { _id: 'p3', status: 'blueprint' },
        { _id: 'p4', status: 'fabrication' },
      ],
      [{ projectId: 'p2', status: 'payment_pending' }],
      [],
    );

    await listProjects({ stage: 'billing', limit: '100' }, 'admin-1', [Role.ADMIN]);

    expect(pagedFilter()).toEqual({ $and: [{ _id: { $in: ['p1', 'p2'] } }] });
  });

  it('keeps the customer visibility rule and lists active projects', async () => {
    setup(
      [
        { _id: 'p1', status: 'draft' },
        { _id: 'p2', status: 'completed' },
        { _id: 'p3', status: 'cancelled' },
        { _id: 'p4', status: 'submitted' },
      ],
      [],
      [],
    );

    await listProjects({ stage: 'active' }, 'customer-1', [Role.CUSTOMER]);

    const filter = pagedFilter();
    expect(filter.customerId).toBe('customer-1');
    expect(filter.$and).toEqual([
      expect.objectContaining({ $or: expect.any(Array) }),
      { _id: { $in: ['p1', 'p4'] } },
    ]);
  });

  it('ignores an unknown stage', async () => {
    mocks.projectFind.mockReturnValueOnce(pageQuery([]));
    mocks.projectCountDocuments.mockResolvedValue(0);

    await listProjects({ stage: 'draft' }, 'admin-1', [Role.ADMIN]);

    expect(mocks.projectFind).toHaveBeenCalledOnce();
    expect(mocks.projectFind.mock.calls[0]![0]).toEqual({});
  });

  it('lists payment-relevant projects for the Payments page with their payment due', async () => {
    const p1 = { _id: 'p1', status: 'submitted', serviceType: 'railings', designFee: { status: 'pending' } };
    const p3 = { _id: 'p3', status: 'approved', serviceType: 'gates' };
    setup(
      [
        p1,
        { _id: 'p2', status: 'submitted' },
        p3,
        { _id: 'p4', status: 'fabrication' },
        { _id: 'p5', status: 'completed' },
        { _id: 'p6', status: 'cancelled', designFee: { status: 'pending' } },
      ],
      [],
      [p1, p3],
    );

    const result = await listProjects({ payment: 'relevant', limit: '100' }, 'customer-1', [Role.CUSTOMER]);

    expect(pagedFilter().$and).toContainEqual({ _id: { $in: ['p1', 'p3', 'p4', 'p5'] } });
    expect(result.items[0]).toMatchObject({ _id: 'p1', paymentDue: { designFee: true, needsPayment: true } });
    expect(result.items[1]).toMatchObject({ _id: 'p3', paymentDue: { needsPlan: true, needsPayment: true } });
  });
});
