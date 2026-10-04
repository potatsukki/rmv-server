import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Payment } from '../../models/index.js';
import { getRevenueReport } from './reports.service.js';
import { PaymentStageStatus } from '../../utils/constants.js';

// Only the database query is replaced. Report grouping and totals use the real service.
describe('revenue reports', () => {
  const rows = [
    { verifiedAt: new Date('2026-04-01T12:00:00Z'), amountPaid: 100, method: 'gcash' },
    { verifiedAt: new Date('2026-04-01T13:00:00Z'), amountPaid: 50, method: 'cash' },
    { verifiedAt: new Date('2026-04-05T12:00:00Z'), amountPaid: 200, method: 'gcash' },
    { verifiedAt: new Date('2026-05-01T12:00:00Z'), amountPaid: 300, method: 'cash' },
  ];
  let find: ReturnType<typeof vi.spyOn>;
  let sort: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sort = vi.fn().mockResolvedValue(rows);
    find = vi.spyOn(Payment, 'find').mockReturnValue({ sort } as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps payment totals and method totals when period grouping is added', async () => {
    const report = await getRevenueReport({ groupBy: 'day' });
    expect(report.totalRevenue).toBe(650);
    expect(report.totalPayments).toBe(4);
    expect(report.byPaymentMethod).toEqual([
      { method: 'gcash', amount: 300 }, { method: 'cash', amount: 350 },
    ]);
    expect(sort).toHaveBeenCalledWith({ verifiedAt: 1 });
  });

  it.each([
    ['day', [
      { period: '2026-04-01', revenue: 150, count: 2 },
      { period: '2026-04-05', revenue: 200, count: 1 },
      { period: '2026-05-01', revenue: 300, count: 1 },
    ]],
    ['week', [
      { period: 'Week of 2026-03-29', revenue: 150, count: 2 },
      { period: 'Week of 2026-04-05', revenue: 200, count: 1 },
      { period: 'Week of 2026-04-26', revenue: 300, count: 1 },
    ]],
    ['month', [
      { period: '2026-04', revenue: 350, count: 3 },
      { period: '2026-05', revenue: 300, count: 1 },
    ]],
  ])('groups by %s without changing the total revenue', async (groupBy, expected) => {
    const report = await getRevenueReport({ groupBy });
    expect(report.byPeriod).toEqual(expected);
    expect(report.byPeriod.reduce((total, group) => total + group.revenue, 0)).toBe(650);
  });

  it('requests verified payments within the inclusive date range', async () => {
    await getRevenueReport({ dateFrom: '2026-04-01', dateTo: '2026-04-30' });
    expect(find).toHaveBeenCalledWith(expect.objectContaining({
      status: PaymentStageStatus.VERIFIED,
      amountPaid: { $lte: expect.any(Number) },
      verifiedAt: {
        $gte: new Date('2026-04-01T00:00:00Z'),
        $lte: new Date('2026-04-30T23:59:59.999Z'),
      },
    }));
  });

  it('returns zero totals for an empty report', async () => {
    sort.mockResolvedValue([]);
    expect(await getRevenueReport({})).toEqual({
      totalRevenue: 0, totalPayments: 0, byPeriod: [], byPaymentMethod: [],
    });
  });
});
