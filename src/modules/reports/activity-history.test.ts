import { describe, expect, it, vi } from 'vitest';

const { mockAuditFind } = vi.hoisted(() => ({ mockAuditFind: vi.fn() }));

vi.mock('../../models/index.js', () => ({
  AuditLog: { find: mockAuditFind },
}));

import { getActivityHistory } from './activity-history.js';

function chainResolving(rows: unknown[]) {
  const chain = {
    sort: vi.fn(),
    limit: vi.fn(),
    populate: vi.fn(),
    lean: vi.fn().mockResolvedValue(rows),
  };
  chain.sort.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.populate.mockReturnValue(chain);
  return chain;
}

describe('getActivityHistory', () => {
  it('lists each step oldest first with the person who did it', async () => {
    const at = new Date('2026-11-09T02:00:00Z');
    const chain = chainResolving([
      {
        _id: 'log-1',
        action: 'appointment_on_the_way',
        targetType: 'appointment',
        targetId: 'appt-1',
        createdAt: at,
        actorId: { _id: 'sales-1', firstName: 'Kendl', lastName: 'Johnson', roles: ['sales_staff'] },
        details: { fromStatus: 'confirmed', toStatus: 'on_the_way', nested: { hidden: true } },
      },
    ]);
    mockAuditFind.mockReturnValue(chain);

    const items = await getActivityHistory([
      { targetType: 'appointment', ids: ['appt-1'] },
      { targetType: 'visit_report', ids: [] },
    ]);

    expect(mockAuditFind).toHaveBeenCalledWith({
      $or: [{ targetType: 'appointment', targetId: { $in: ['appt-1'] } }],
    });
    expect(chain.sort).toHaveBeenCalledWith({ createdAt: 1 });
    expect(items).toEqual([{
      _id: 'log-1',
      action: 'appointment_on_the_way',
      targetType: 'appointment',
      targetId: 'appt-1',
      at,
      actor: { _id: 'sales-1', name: 'Kendl Johnson', roles: ['sales_staff'] },
      automatic: false,
      // Nested objects stay out; only simple values are shown.
      details: { fromStatus: 'confirmed', toStatus: 'on_the_way' },
    }]);
  });

  it('marks steps without a person as automatic (System)', async () => {
    mockAuditFind.mockReturnValue(chainResolving([
      { _id: 'log-2', action: 'appointment_attendance_updated', createdAt: new Date(), details: { automatic: true } },
    ]));

    const [item] = await getActivityHistory([{ targetType: 'appointment', ids: ['appt-1'] }]);

    expect(item?.actor).toBeNull();
    expect(item?.automatic).toBe(true);
  });

  it('does not query when there is nothing to look up', async () => {
    mockAuditFind.mockClear();
    await expect(getActivityHistory([{ targetType: 'appointment', ids: [] }])).resolves.toEqual([]);
    expect(mockAuditFind).not.toHaveBeenCalled();
  });
});
