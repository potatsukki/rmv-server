import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  deleteOne: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  SlotLock: { create: mocks.create, deleteOne: mocks.deleteOne },
}));

import { acquireSalesDayLock, withSalesDayLocks } from './sales-day-lock.js';

describe('sales day lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteOne.mockResolvedValue(undefined);
  });

  it('lets only one of two simultaneous bookings for the same staff and day through', async () => {
    const taken = new Set<string>();
    mocks.create.mockImplementation(async (doc: { date: string; slotCode: string; salesId: string }) => {
      const key = `${doc.date}|${doc.slotCode}|${doc.salesId}`;
      if (taken.has(key)) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      taken.add(key);
      return doc;
    });

    const book = () => withSalesDayLocks(async (locks) => {
      await acquireSalesDayLock(locks, 'sales-1', '2026-11-13', 'sales-1');
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'saved';
    });

    const results = await Promise.allSettled([book(), book()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.message).toContain('Another booking for this sales staff on this date is being saved');
    expect(rejected.reason.statusCode).toBe(409);
  });

  it('releases the lock even when the booking fails', async () => {
    mocks.create.mockResolvedValue({});
    await expect(withSalesDayLocks(async (locks) => {
      await acquireSalesDayLock(locks, 'sales-1', '2026-11-13', 'sales-1');
      throw new Error('site outside mainland Luzon');
    })).rejects.toThrow('site outside mainland Luzon');

    expect(mocks.deleteOne).toHaveBeenLastCalledWith({ date: '2026-11-13', slotCode: 'sales-day', salesId: 'sales-1' });
  });

  it('does nothing when the caller does not hold locks', async () => {
    await acquireSalesDayLock(undefined, 'sales-1', '2026-11-13', 'sales-1');
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
