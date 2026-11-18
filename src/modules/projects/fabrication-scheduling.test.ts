import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ projectFind: vi.fn(), userFind: vi.fn(), holidayFindOne: vi.fn() }));
const lean = (rows: unknown) => ({ select: () => ({ lean: async () => rows }) });

vi.mock('../../models/index.js', () => ({
  Project: { find: (filter: unknown) => lean(mocks.projectFind(filter)) },
  User: { find: () => lean(mocks.userFind()) },
  Holiday: { findOne: () => lean(mocks.holidayFindOne()) },
}));

import {
  assertDeliveryCrewFree, assertDeliveryDateAllowed, assertFabricatorsFree, manilaToday,
} from './fabrication-scheduling.js';
import { ErrorCode } from '../../utils/appError.js';

const NOW = new Date('2026-11-18T10:00:00+08:00'); // Wednesday

beforeEach(() => {
  vi.resetAllMocks();
  mocks.projectFind.mockReturnValue([]);
  mocks.userFind.mockReturnValue([{ _id: 'lance', firstName: 'Lance', lastName: 'Zelot' }, { _id: 'mark', firstName: 'Mark', lastName: 'Perkz' }]);
  mocks.holidayFindOne.mockReturnValue(null);
});

describe('one active project per fabricator', () => {
  it('rejects a lead or assistant already on another active project, naming the project', async () => {
    mocks.projectFind.mockReturnValue([
      { projectNumber: 'PRJ-2026-00051', fabricationLeadId: 'lance', fabricationAssistantIds: [] },
      { projectNumber: 'PRJ-2026-00073', fabricationLeadId: 'other', fabricationAssistantIds: ['mark'] },
    ]);
    await expect(assertFabricatorsFree('project-1', ['lance', 'mark'])).rejects.toMatchObject({
      code: ErrorCode.FABRICATOR_ALREADY_ASSIGNED,
      message: 'Lance Zelot is already on PRJ-2026-00051 (Lead); Mark Perkz is already on PRJ-2026-00073 (Assistant). A fabricator can work on one active project at a time.',
    });
    // Only other active projects, and only lead / assistant roles.
    const filter = mocks.projectFind.mock.calls[0]![0];
    expect(filter._id).toEqual({ $ne: 'project-1' });
    expect(filter.$or).toEqual([{ fabricationLeadId: { $in: ['lance', 'mark'] } }, { fabricationAssistantIds: { $in: ['lance', 'mark'] } }]);
  });

  it('allows fabricators with no other active project', async () => {
    await expect(assertFabricatorsFree('project-1', ['lance'])).resolves.toBeUndefined();
  });
});

describe('delivery / installation date', () => {
  it('accepts today or a later Monday-Saturday that is not a holiday', async () => {
    expect(manilaToday(NOW)).toBe('2026-11-18');
    await expect(assertDeliveryDateAllowed('2026-11-18', NOW)).resolves.toBeUndefined();
    await expect(assertDeliveryDateAllowed('2026-11-21', NOW)).resolves.toBeUndefined(); // Saturday
  });

  it('rejects a past date, a Sunday, a holiday, and an invalid date', async () => {
    await expect(assertDeliveryDateAllowed('2026-11-17', NOW)).rejects.toThrow('cannot be in the past');
    await expect(assertDeliveryDateAllowed('2026-11-22', NOW)).rejects.toThrow('Monday to Saturday');
    mocks.holidayFindOne.mockReturnValue({ name: 'Bonifacio Day' });
    await expect(assertDeliveryDateAllowed('2026-11-30', NOW)).rejects.toThrow('Nov 30, 2026 is a holiday (Bonifacio Day)');
    await expect(assertDeliveryDateAllowed('2026-02-30', NOW)).rejects.toThrow('valid delivery');
  });
});

describe('delivery crew overlap', () => {
  it('rejects a crew member with another delivery on the same day', async () => {
    mocks.projectFind.mockReturnValue([{ projectNumber: 'PRJ-2026-00062', deliveryCrewIds: ['mark'] }]);
    await expect(assertDeliveryCrewFree('project-1', ['lance', 'mark'], '2026-11-25')).rejects.toMatchObject({
      code: ErrorCode.DELIVERY_CREW_CONFLICT,
      message: expect.stringContaining('Mark Perkz already has a delivery on Nov 25, 2026 (PRJ-2026-00062)'),
    });
    expect(mocks.projectFind.mock.calls[0]![0]).toMatchObject({ _id: { $ne: 'project-1' }, 'deliverySchedule.date': '2026-11-25' });
  });

  it('allows the crew when nobody has a delivery that day', async () => {
    await expect(assertDeliveryCrewFree('project-1', ['lance'], '2026-11-26')).resolves.toBeUndefined();
  });
});
