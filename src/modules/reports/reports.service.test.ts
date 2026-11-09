import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dashboardMocks = vi.hoisted(() => ({
  projectCount: vi.fn(),
  projectFind: vi.fn(),
  paymentCount: vi.fn(),
  paymentAggregate: vi.fn(),
  paymentDistinct: vi.fn(),
  planFind: vi.fn(),
  appointmentCount: vi.fn(),
  userCount: vi.fn(),
  blueprintCount: vi.fn(),
  blueprintDistinct: vi.fn(),
  projectItemFind: vi.fn(),
  fabricationCount: vi.fn(),
  fabricationAggregate: vi.fn(),
}));

const { mockAuditAggregate, mockAuditCountDocuments } = vi.hoisted(() => ({
  mockAuditAggregate: vi.fn(),
  mockAuditCountDocuments: vi.fn(),
}));

const { mockConfigFindOne, mockConfigFindOneAndUpdate, mockAuditCreate } = vi.hoisted(() => ({
  mockConfigFindOne: vi.fn(),
  mockConfigFindOneAndUpdate: vi.fn(),
  mockAuditCreate: vi.fn(),
}));

const { mockCountPendingReportGroupsForSalesStaff } = vi.hoisted(() => ({
  mockCountPendingReportGroupsForSalesStaff: vi.fn(),
}));

vi.mock('../visit-reports/visit-reports.service.js', () => ({
  countPendingReportGroupsForSalesStaff: mockCountPendingReportGroupsForSalesStaff,
}));

vi.mock('../../models/index.js', () => ({
  Project: { countDocuments: dashboardMocks.projectCount, find: dashboardMocks.projectFind },
  Payment: { countDocuments: dashboardMocks.paymentCount, aggregate: dashboardMocks.paymentAggregate, distinct: dashboardMocks.paymentDistinct },
  PaymentPlan: { find: dashboardMocks.planFind },
  Appointment: { countDocuments: dashboardMocks.appointmentCount },
  FabricationUpdate: { countDocuments: dashboardMocks.fabricationCount, aggregate: dashboardMocks.fabricationAggregate },
  User: { countDocuments: dashboardMocks.userCount },
  CashCollection: {},
  VisitReport: {},
  Blueprint: { countDocuments: dashboardMocks.blueprintCount, distinct: dashboardMocks.blueprintDistinct },
  ProjectItem: { find: dashboardMocks.projectItemFind },
  AuditLog: {
    aggregate: mockAuditAggregate,
    countDocuments: mockAuditCountDocuments,
    create: mockAuditCreate,
  },
  Config: {
    findOne: mockConfigFindOne,
    findOneAndUpdate: mockConfigFindOneAndUpdate,
  },
}));

import {
  acknowledgeLifecycleMismatchHotspot,
  getLifecycleMismatchHotspots,
  getDashboardSummary,
} from './reports.service.js';
import { buildAppointmentStatusGroupFilter } from '../appointments/appointment-status-groups.js';

function mockExecValue<T>(value: T) {
  return { exec: vi.fn().mockResolvedValue(value) };
}

function mockLeanExecValue<T>(value: T) {
  return {
    lean: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(value) }),
  };
}

describe('dashboard pending payment projects', () => {
  function plan(projectId: string, stages: object[], status = 'payment_pending', deletedAt: Date | null = null) {
    return { projectId: { _id: projectId, status, deletedAt }, stages };
  }

  const pending = { status: 'pending', amount: 3000, amountPaid: 0 };

  function plansQuery(plans: object[]) {
    const query = {
      select: vi.fn().mockReturnThis(),
      populate: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(plans),
    };
    dashboardMocks.planFind.mockReturnValue(query);
    return query;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    for (const count of [dashboardMocks.projectCount, dashboardMocks.paymentCount,
      dashboardMocks.appointmentCount, dashboardMocks.userCount, dashboardMocks.blueprintCount,
      dashboardMocks.fabricationCount]) {
      count.mockReturnValue(mockExecValue(0));
    }
    dashboardMocks.paymentAggregate.mockReturnValue(mockExecValue([]));
    dashboardMocks.fabricationAggregate.mockReturnValue(mockExecValue([]));
    plansQuery([]);
  });

  it('counts an unpaid project even when no payment has been submitted for verification', async () => {
    plansQuery([plan('railings', [pending])]);
    const summary = await getDashboardSummary('cashier-1', ['cashier']);
    expect(summary).toMatchObject({ unpaidProjects: 1, pendingPayments: 0 });
  });

  it('counts each project once across items and stages and keeps the verification queue separate', async () => {
    plansQuery([
      plan('railings', [pending, pending]),
      plan('railings', [pending]),
      plan('canopy', [{ status: 'proof_submitted', amount: 1000, amountPaid: 0 }]),
      plan('grills', [{ status: 'declined', amount: 1000, amountPaid: 250 }]),
    ]);
    dashboardMocks.paymentCount.mockReturnValue(mockExecValue(1));
    expect(await getDashboardSummary('cashier-1', ['cashier']))
      .toMatchObject({ unpaidProjects: 3, pendingPayments: 1 });
  });

  it('excludes settled, empty, cancelled, deleted and orphaned plans', async () => {
    plansQuery([
      plan('verified', [{ status: 'verified', amount: 3000, amountPaid: 3000 }]),
      plan('settled', [{ ...pending, amountPaid: 3000 }]),
      plan('empty', []),
      plan('cancelled', [pending], 'cancelled'),
      plan('deleted', [pending], 'payment_pending', new Date()),
      { projectId: null, stages: [pending] },
      plan('partial', [{ ...pending, amountPaid: 1500 }]),
    ]);
    expect(await getDashboardSummary('cashier-1', ['cashier']))
      .toMatchObject({ unpaidProjects: 1 });
  });

  it('does not count floating point residue as an unpaid cent', async () => {
    plansQuery([
      plan('rounded', [{ ...pending, amount: 0.1 + 0.2, amountPaid: 0.3 }]),
      plan('cent-due', [{ ...pending, amount: 0.3, amountPaid: 0.29 }]),
    ]);
    expect(await getDashboardSummary('cashier-1', ['cashier']))
      .toMatchObject({ unpaidProjects: 1 });
  });

  describe('customer dashboard counts (same rules as the lists the cards open)', () => {
    const activatedAt = new Date('2026-11-01');

    type TestProject = { _id: string; status: string; designFee?: { status: string } };

    function customerProjects(projects: TestProject[], items: Array<{ projectId: string; status: string }> = []) {
      dashboardMocks.projectFind.mockImplementation(() => ({ select: () => mockLeanExecValue(projects) }));
      dashboardMocks.projectItemFind.mockReturnValue({ select: () => mockLeanExecValue(items) });
    }

    // Payment plans as both plan queries read them: populated for the unpaid-balance count,
    // and stringifying to the project id for the payment-due rules.
    function customerPlan(projectId: string, stages: object[], status = 'payment_pending') {
      return { projectId: { _id: projectId, status, deletedAt: null, toString: () => projectId }, stages };
    }

    function appointmentCounts({ unpaidOcularFees = 0, pendingVisits = 0 } = {}) {
      dashboardMocks.appointmentCount.mockImplementation((filter: Record<string, unknown>) => mockExecValue(
        filter.ocularFeeStatus === 'pending' ? unpaidOcularFees : filter.$or ? pendingVisits : 0,
      ));
    }

    beforeEach(() => {
      dashboardMocks.blueprintDistinct.mockReturnValue(mockExecValue([]));
      dashboardMocks.paymentDistinct.mockReturnValue(mockExecValue([]));
      appointmentCounts();
    });

    it('counts only projects the customer can see, by the Projects page listing stage', async () => {
      customerProjects(
        [
          { _id: 'p1', status: 'draft' },
          { _id: 'p2', status: 'submitted' },
          { _id: 'p3', status: 'fabrication' },
          { _id: 'p4', status: 'blueprint' },
          { _id: 'p5', status: 'completed' },
          { _id: 'p6', status: 'cancelled' },
          { _id: 'p7', status: 'payment_pending' },
        ],
        [
          { projectId: 'p4', status: 'fabrication' },
          { projectId: 'p4', status: 'blueprint' },
          { projectId: 'p7', status: 'completed' },
        ],
      );

      const summary = await getDashboardSummary('customer-1', ['customer']);

      expect(summary).toMatchObject({
        totalProjects: 7,
        activeProjects: 4,
        fabricationInProgress: 2,
        completedProjects: 2,
      });
      expect(dashboardMocks.projectFind).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'customer-1',
        $and: expect.any(Array),
      }));
      expect(dashboardMocks.projectCount).not.toHaveBeenCalled();
    });

    it('counts each project needing payment once, plus unpaid ocular fees', async () => {
      customerProjects([
        { _id: 'p1', status: 'payment_pending' },
        { _id: 'p2', status: 'approved' },
        { _id: 'p3', status: 'approved' },
        { _id: 'p4', status: 'submitted', designFee: { status: 'pending' } },
        { _id: 'p5', status: 'blueprint', designFee: { status: 'pending' } },
        { _id: 'p6', status: 'blueprint' },
        { _id: 'p7', status: 'cancelled' },
        { _id: 'p8', status: 'fabrication' },
      ]);
      plansQuery([
        customerPlan('p1', [
          { status: 'pending', amount: 3000, amountPaid: 0, activatedAt },
          { status: 'declined', amount: 1000, amountPaid: 0, activatedAt },
          { status: 'pending', amount: 4000, amountPaid: 0, activatedAt: null },
        ]),
        customerPlan('p3', [{ status: 'pending', amount: 3000, amountPaid: 0, activatedAt: null }], 'approved'),
        customerPlan('p8', [
          { status: 'proof_submitted', amount: 1000, amountPaid: 0, activatedAt },
          { status: 'pending', amount: 1000, amountPaid: 1000, activatedAt },
          { status: 'pending', amount: 1000, amountPaid: 0, creditApplied: 1000, activatedAt },
        ], 'fabrication'),
      ]);
      dashboardMocks.paymentDistinct.mockReturnValue(mockExecValue(['design-fee-p5']));
      dashboardMocks.blueprintDistinct.mockReturnValue(mockExecValue(['p6']));
      appointmentCounts({ unpaidOcularFees: 2 });

      const summary = await getDashboardSummary('customer-1', ['customer']);

      // p1 (due stages), p2 (needs a payment plan), p4 (design fee), p6 (revision fee) + 2 ocular fees
      expect(summary.pendingPayments).toBe(6);
      expect(dashboardMocks.paymentDistinct).toHaveBeenCalledWith('stageId', {
        stageId: { $in: ['design-fee-p4', 'design-fee-p5'] },
        paymentStatus: 'pending_verification',
      });
      expect(dashboardMocks.appointmentCount).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'customer-1',
        type: 'ocular',
        ocularFeeStatus: 'pending',
        ocularFee: { $gt: 0 },
        status: { $nin: ['cancelled', 'completed', 'no_show'] },
      }));
      expect(dashboardMocks.paymentCount).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'proof_submitted' }));
      expect(dashboardMocks.planFind).toHaveBeenCalledWith(expect.objectContaining({
        projectId: { $in: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p8'] },
      }));
    });

    it('counts pending visits as the Requested and Assigned appointment groups', async () => {
      customerProjects([]);
      appointmentCounts({ pendingVisits: 3 });

      const summary = await getDashboardSummary('customer-1', ['customer']);

      expect(summary.pendingAppointments).toBe(3);
      expect(dashboardMocks.appointmentCount).toHaveBeenCalledWith({
        customerId: 'customer-1',
        $or: [buildAppointmentStatusGroupFilter('requested'), buildAppointmentStatusGroupFilter('assigned')],
      });
    });

    it('keeps the cashier count as proofs awaiting verification', async () => {
      dashboardMocks.paymentCount.mockReturnValue(mockExecValue(4));
      const summary = await getDashboardSummary('cashier-1', ['cashier']);
      expect(summary.pendingPayments).toBe(4);
      expect(dashboardMocks.paymentCount).toHaveBeenCalledWith({ status: 'proof_submitted' });
    });
  });
});

describe('getLifecycleMismatchHotspots', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns hotspot summary and trend when a date range is provided', async () => {
    mockAuditAggregate
      .mockReturnValueOnce(
        mockExecValue([
          {
            targetType: 'payments',
            currentStatus: 'pending',
            attemptedStatus: 'verified',
            refreshRequired: true,
            count: 9,
            lastSeenAt: new Date('2026-03-16T09:30:00.000Z'),
          },
        ]),
      )
      .mockReturnValueOnce(
        mockExecValue([
          { targetType: 'payments', count: 12 },
          { targetType: 'projects', count: 5 },
        ]),
      );

    mockConfigFindOne.mockReturnValueOnce(
      mockLeanExecValue({
        key: 'lifecycle_hotspot_acknowledgements',
        value: {
          'payments|pending|verified|1': {
            acknowledgedAt: '2026-03-16T12:00:00.000Z',
            acknowledgedBy: 'admin-1',
          },
        },
      }),
    );

    mockAuditCountDocuments
      .mockReturnValueOnce(mockExecValue(17))
      .mockReturnValueOnce(mockExecValue(10))
      .mockReturnValueOnce(mockExecValue(11));

    const result = await getLifecycleMismatchHotspots({
      dateFrom: '2026-03-10',
      dateTo: '2026-03-17',
      limit: 10,
    });

    expect(result.total).toBe(17);
    expect(result.refreshRequiredTotal).toBe(10);
    expect(result.byTargetType).toEqual([
      { targetType: 'payments', count: 12 },
      { targetType: 'projects', count: 5 },
    ]);
    expect(result.escalationSummary).toMatchObject({
      topTargetType: 'payments',
      ownerTeam: 'Cash Operations',
      ownerRole: 'Cashier Supervisor',
      slaHours: 2,
    });
    expect(result.trend.previousWindowTotal).toBe(11);
    expect(result.trend.trendDelta).toBe(6);
    expect(result.trend.trendPercent).toBeCloseTo(54.5, 1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      targetType: 'payments',
      isAcknowledged: true,
      acknowledgedBy: 'admin-1',
      escalation: {
        ownerTeam: 'Cash Operations',
        ownerRole: 'Cashier Supervisor',
        slaHours: 2,
      },
    });
    expect(result.acknowledgedCount).toBe(1);
    expect(result.unacknowledgedCount).toBe(0);

    expect(mockAuditAggregate).toHaveBeenCalledTimes(2);
    expect(mockAuditCountDocuments).toHaveBeenCalledTimes(3);
  });

  it('returns null trend fields when no date range is provided', async () => {
    mockAuditAggregate
      .mockReturnValueOnce(mockExecValue([]))
      .mockReturnValueOnce(mockExecValue([]));

    mockConfigFindOne.mockReturnValueOnce(mockLeanExecValue(null));

    mockAuditCountDocuments
      .mockReturnValueOnce(mockExecValue(0))
      .mockReturnValueOnce(mockExecValue(0));

    const result = await getLifecycleMismatchHotspots({ limit: 5 });

    expect(result.total).toBe(0);
    expect(result.refreshRequiredTotal).toBe(0);
    expect(result.byTargetType).toEqual([]);
    expect(result.escalationSummary).toMatchObject({
      topTargetType: 'unknown',
      ownerTeam: 'Platform Operations',
      ownerRole: 'Admin',
      slaHours: 8,
    });
    expect(result.trend).toEqual({
      previousWindowTotal: null,
      trendDelta: null,
      trendPercent: null,
    });
    expect(result.acknowledgedCount).toBe(0);
    expect(result.unacknowledgedCount).toBe(0);
    expect(result.items).toEqual([]);

    expect(mockAuditAggregate).toHaveBeenCalledTimes(2);
    expect(mockAuditCountDocuments).toHaveBeenCalledTimes(2);
  });

  it('stores acknowledgement entries and can clear them', async () => {
    mockConfigFindOne.mockReturnValueOnce(mockLeanExecValue(null));
    mockConfigFindOneAndUpdate.mockReturnValueOnce(mockExecValue({}));
    mockAuditCreate.mockResolvedValueOnce({});

    const acknowledged = await acknowledgeLifecycleMismatchHotspot(
      {
        targetType: 'payments',
        currentStatus: 'pending',
        attemptedStatus: 'verified',
        refreshRequired: true,
        acknowledged: true,
        note: 'Investigating with cashier lead',
      },
      'admin-2',
    );

    expect(acknowledged.acknowledged).toBe(true);
    expect(acknowledged.hotspotKey).toBe('payments|pending|verified|1');
    expect(mockConfigFindOneAndUpdate).toHaveBeenCalled();
    expect(mockAuditCreate).toHaveBeenCalled();

    mockConfigFindOne.mockReturnValueOnce(
      mockLeanExecValue({
        value: {
          'payments|pending|verified|1': {
            acknowledgedAt: '2026-03-18T01:00:00.000Z',
            acknowledgedBy: 'admin-2',
          },
        },
      }),
    );
    mockConfigFindOneAndUpdate.mockReturnValueOnce(mockExecValue({}));
    mockAuditCreate.mockResolvedValueOnce({});

    const cleared = await acknowledgeLifecycleMismatchHotspot(
      {
        targetType: 'payments',
        currentStatus: 'pending',
        attemptedStatus: 'verified',
        refreshRequired: true,
        acknowledged: false,
      },
      'admin-2',
    );

    expect(cleared.acknowledged).toBe(false);
    expect(cleared.acknowledgedAt).toBeNull();
  });
});
