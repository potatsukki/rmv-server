import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectFind: vi.fn(), userFind: vi.fn(), holidayFindOne: vi.fn(), updateAggregate: vi.fn(), itemFind: vi.fn(),
}));
const lean = (rows: unknown) => ({ select: () => ({ lean: async () => rows }) });

vi.mock('../../models/index.js', () => ({
  Project: { find: (filter: unknown) => lean(mocks.projectFind(filter)) },
  ProjectItem: { find: (filter: unknown) => lean(mocks.itemFind(filter)) },
  FabricationUpdate: { aggregate: async (pipeline: unknown) => mocks.updateAggregate(pipeline) },
  User: { find: () => lean(mocks.userFind()) },
  Holiday: { findOne: () => lean(mocks.holidayFindOne()) },
}));

import {
  assertDeliveryCrewFree, assertDeliveryDateAllowed, assertFabricatorsFree, fabricationTrackProgress, manilaToday,
  stageIsNearCompletion,
} from './fabrication-scheduling.js';
import { ErrorCode } from '../../utils/appError.js';
import { DeliveryType, FabricationStatus, ProjectStatus } from '../../utils/constants.js';

const NOW = new Date('2026-11-18T10:00:00+08:00'); // Wednesday
const SHOP = DeliveryType.SHOP_FABRICATED;
const ON_SITE = DeliveryType.ON_SITE_INSTALLATION;
const latest = (projectId: string, status: string, projectItemId: string | null = null) => ({ _id: { projectId, projectItemId }, status });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.projectFind.mockReturnValue([]);
  mocks.userFind.mockReturnValue([{ _id: 'lance', firstName: 'Lance', lastName: 'Zelot' }, { _id: 'mark', firstName: 'Mark', lastName: 'Perkz' }]);
  mocks.holidayFindOne.mockReturnValue(null);
  mocks.updateAggregate.mockReturnValue([]);
  mocks.itemFind.mockReturnValue([]);
});

describe('one project in the workshop per fabricator', () => {
  it('rejects a lead or assistant still on another project before Quality Check, naming the project', async () => {
    mocks.projectFind.mockReturnValue([
      { _id: 'p-51', projectNumber: 'PRJ-2026-00051', status: ProjectStatus.FABRICATION, deliveryType: SHOP, fabricationLeadId: 'lance', fabricationAssistantIds: [] },
      { _id: 'p-73', projectNumber: 'PRJ-2026-00073', status: ProjectStatus.PAYMENT_PENDING, fabricationLeadId: 'other', fabricationAssistantIds: ['mark'] },
    ]);
    mocks.updateAggregate.mockReturnValue([latest('p-51', FabricationStatus.FINISHING)]);
    await expect(assertFabricatorsFree('project-1', ['lance', 'mark'])).rejects.toMatchObject({
      code: ErrorCode.FABRICATOR_ALREADY_ASSIGNED,
      message: 'Lance Zelot is still on PRJ-2026-00051 (Lead); Mark Perkz is still on PRJ-2026-00073 (Assistant). A fabricator can take a new project once their current one reaches Quality Check.',
    });
    // Only other active projects, and only lead / assistant roles.
    const filter = mocks.projectFind.mock.calls[0]![0];
    expect(filter._id).toEqual({ $ne: 'project-1' });
    expect(filter.$or).toEqual([{ fabricationLeadId: { $in: ['lance', 'mark'] } }, { fabricationAssistantIds: { $in: ['lance', 'mark'] } }]);
  });

  it('allows fabricators with no other active project', async () => {
    await expect(assertFabricatorsFree('project-1', ['lance'])).resolves.toBeUndefined();
  });

  it('allows a fabricator whose other project reached Quality Check (panel: nearest completion takes the next project)', async () => {
    mocks.projectFind.mockReturnValue([
      { _id: 'p-51', projectNumber: 'PRJ-2026-00051', status: ProjectStatus.FABRICATION, deliveryType: ON_SITE, fabricationLeadId: 'lance', fabricationAssistantIds: ['mark'] },
    ]);
    mocks.updateAggregate.mockReturnValue([latest('p-51', FabricationStatus.QUALITY_CHECK)]);
    await expect(assertFabricatorsFree('project-1', ['lance', 'mark'])).resolves.toBeUndefined();

    mocks.updateAggregate.mockReturnValue([latest('p-51', FabricationStatus.INSTALLATION)]);
    await expect(assertFabricatorsFree('project-1', ['lance'])).resolves.toBeUndefined();
  });
});

describe('near completion (Quality Check or later)', () => {
  it('counts Quality Check and every later stage for both lifecycles', () => {
    expect([
      FabricationStatus.FABRICATION, FabricationStatus.WELDING_ASSEMBLY, FabricationStatus.FINISHING,
      FabricationStatus.QUALITY_CHECK, FabricationStatus.INSTALLATION, FabricationStatus.DONE,
    ].map((status) => stageIsNearCompletion(status, ON_SITE))).toEqual([false, false, false, true, true, true]);
    expect([
      FabricationStatus.ASSEMBLY, FabricationStatus.FINISHING, FabricationStatus.QUALITY_CHECK,
      FabricationStatus.READY_FOR_DELIVERY, FabricationStatus.DONE,
    ].map((status) => stageIsNearCompletion(status, SHOP))).toEqual([false, false, true, true, true]);
    // Legacy on-site history: Ready for Delivery counts as Quality Check, Assembly as Welding / Assembly.
    expect(stageIsNearCompletion(FabricationStatus.READY_FOR_DELIVERY, ON_SITE)).toBe(true);
    expect(stageIsNearCompletion(FabricationStatus.ASSEMBLY, ON_SITE)).toBe(false);
    expect(stageIsNearCompletion(undefined, SHOP)).toBe(false);
    expect(stageIsNearCompletion(FabricationStatus.QUEUED, SHOP)).toBe(false);
  });

  it('uses the slowest item of a multi-item project, and falls back to the project-level update', async () => {
    mocks.itemFind.mockReturnValue([
      { _id: 'item-a', projectId: 'p-1' }, { _id: 'item-b', projectId: 'p-1' },
      { _id: 'item-c', projectId: 'p-2' },
    ]);
    mocks.updateAggregate.mockReturnValue([
      latest('p-1', FabricationStatus.READY_FOR_DELIVERY, 'item-a'),
      latest('p-1', FabricationStatus.WELDING, 'item-b'),
      latest('p-2', FabricationStatus.QUALITY_CHECK), // older project-wide update covers item-c
      latest('p-3', FabricationStatus.QUALITY_CHECK),
    ]);
    const progress = await fabricationTrackProgress([
      { _id: 'p-1', status: ProjectStatus.FABRICATION, deliveryType: SHOP },
      { _id: 'p-2', status: ProjectStatus.FABRICATION, deliveryType: SHOP },
      { _id: 'p-3', status: ProjectStatus.FABRICATION, deliveryType: SHOP },
      { _id: 'p-4', status: ProjectStatus.PAYMENT_PENDING, deliveryType: SHOP },
    ]);

    expect(progress.get('p-1')).toMatchObject({ nearCompletion: false, currentStage: FabricationStatus.WELDING, stageIndex: 3, stageCount: 8 });
    expect(progress.get('p-2')).toMatchObject({ nearCompletion: true, currentStage: FabricationStatus.QUALITY_CHECK, stageIndex: 6 });
    expect(progress.get('p-3')).toMatchObject({ nearCompletion: true, progressPercent: 75 });
    expect(progress.get('p-4')).toMatchObject({ nearCompletion: false, stageIndex: 0 });
    // Only started projects are looked up, cancelled items are skipped.
    expect(mocks.itemFind.mock.calls[0]![0]).toEqual({ projectId: { $in: ['p-1', 'p-2', 'p-3'] }, status: { $ne: ProjectStatus.CANCELLED } });
  });

  it('is not near completion while an item has no update yet', async () => {
    mocks.itemFind.mockReturnValue([{ _id: 'item-a', projectId: 'p-1' }, { _id: 'item-b', projectId: 'p-1' }]);
    mocks.updateAggregate.mockReturnValue([latest('p-1', FabricationStatus.DONE, 'item-a')]);
    const progress = await fabricationTrackProgress([{ _id: 'p-1', status: ProjectStatus.FABRICATION, deliveryType: ON_SITE }]);
    expect(progress.get('p-1')).toMatchObject({ nearCompletion: false, stageIndex: 0 });
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
