import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectFind: vi.fn(),
  planFind: vi.fn(),
  paymentFind: vi.fn(),
  paid: vi.fn(),
  workload: vi.fn(),
  assignLead: vi.fn(),
}));
const lean = (rows: unknown) => ({ select: () => ({ lean: async () => rows }) });

vi.mock('../../models/index.js', () => ({
  Project: { find: (filter: unknown) => lean(mocks.projectFind(filter)) },
  PaymentPlan: { find: (filter: unknown) => lean(mocks.planFind(filter)) },
  Payment: { find: (filter: unknown) => lean(mocks.paymentFind(filter)) },
}));
vi.mock('./fabrication-start.js', () => ({ hasRequiredInitialFabricationPayment: mocks.paid }));
vi.mock('./projects.service.js', () => ({
  listFabricationStaffWorkload: mocks.workload,
  autoAssignFabricationLead: mocks.assignLead,
}));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  autoAssignWaitingFabricationProjects, listProjectsWaitingForFabricator, pickAutoAssignLead,
} from './fabrication-auto-assign.js';
import { FabricationStatus, PaymentStageStatus, ProjectStatus } from '../../utils/constants.js';

type Member = Parameters<typeof pickAutoAssignLead>[0][number];

function member(overrides: Partial<Member>): Member {
  return {
    _id: 'staff', firstName: 'Ana', lastName: 'Reyes', availabilityNote: undefined,
    workloadStatus: 'available', activeProjectCount: 0, activeProjects: [], deliveryDates: [],
    freeAt: null, lowestProgressPercent: 100, hasTeamProject: false, teamStatus: 'free',
    ...overrides,
  } as Member;
}

const qcProject = {
  _id: 'p-qc', projectNumber: 'PRJ-2026-00051', title: 'Gate', status: ProjectStatus.FABRICATION,
  roles: ['lead' as const], currentStage: FabricationStatus.QUALITY_CHECK, stageIndex: 6, stageCount: 8, progressPercent: 75,
  nearCompletion: true, estimatedCompletionDate: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.projectFind.mockReturnValue([]);
  mocks.planFind.mockReturnValue([]);
  mocks.paymentFind.mockReturnValue([]);
  mocks.paid.mockResolvedValue(true);
  mocks.workload.mockResolvedValue([]);
  mocks.assignLead.mockResolvedValue({ _id: 'assigned' });
});

describe('pickAutoAssignLead', () => {
  it('takes the first free fabricator from the sorted workload list', () => {
    const free = member({ _id: 'free' });
    const finishing = member({ _id: 'finishing', workloadStatus: 'busy', teamStatus: 'finishing', activeProjects: [qcProject] });
    expect(pickAutoAssignLead([free, finishing])).toEqual({ member: free, reason: { kind: 'free' } });
  });

  it('otherwise takes the one nearest completion, naming the project that reached Quality Check', () => {
    const away = member({ _id: 'away', workloadStatus: 'on_leave' });
    const finishing = member({ _id: 'finishing', workloadStatus: 'busy', teamStatus: 'finishing', activeProjects: [qcProject] });
    expect(pickAutoAssignLead([away, finishing])).toEqual({
      member: finishing,
      reason: { kind: 'nearest_completion', fromProject: { _id: 'p-qc', projectNumber: 'PRJ-2026-00051', title: 'Gate', stage: 'quality_check' } },
    });
  });

  it('never picks someone still in the workshop, on leave or unavailable', () => {
    expect(pickAutoAssignLead([
      member({ _id: 'busy', workloadStatus: 'busy', teamStatus: 'busy' }),
      member({ _id: 'leave', workloadStatus: 'on_leave' }),
      member({ _id: 'off', workloadStatus: 'unavailable', teamStatus: 'finishing' }),
    ])).toBeNull();
  });
});

describe('listProjectsWaitingForFabricator', () => {
  it('lists only paid projects without a lead, the earliest verified downpayment first', async () => {
    mocks.projectFind.mockReturnValue([
      { _id: 'late', projectNumber: 'PRJ-3', createdAt: new Date('2026-11-01') },
      { _id: 'unpaid', projectNumber: 'PRJ-2', createdAt: new Date('2026-10-01') },
      { _id: 'early', projectNumber: 'PRJ-1', createdAt: new Date('2026-11-20') },
    ]);
    mocks.paid.mockImplementation(async (id: string) => id !== 'unpaid');
    mocks.planFind.mockReturnValue([
      { projectId: 'late', stages: [{ stageId: 'late-1' }, { stageId: 'late-2' }], createdAt: new Date('2026-11-02') },
      { projectId: 'early', stages: [{ stageId: 'early-1' }], createdAt: new Date('2026-11-21') },
    ]);
    mocks.paymentFind.mockReturnValue([
      { stageId: 'late-1', verifiedAt: new Date('2026-11-26T09:00:00Z') },
      { stageId: 'early-1', verifiedAt: new Date('2026-11-25T09:00:00Z') },
    ]);

    const waiting = await listProjectsWaitingForFabricator();

    expect(waiting.map((project) => project._id)).toEqual(['early', 'late']);
    expect(mocks.projectFind.mock.calls[0]![0]).toEqual({ status: ProjectStatus.PAYMENT_PENDING, fabricationLeadId: null });
    // Only the first stage of each plan (the downpayment / full payment) counts.
    expect(mocks.paymentFind.mock.calls[0]![0]).toEqual({ stageId: { $in: ['late-1', 'early-1'] }, status: PaymentStageStatus.VERIFIED });
  });
});

describe('autoAssignWaitingFabricationProjects', () => {
  it('gives each waiting project the next lead, refreshing the workload after every pick', async () => {
    mocks.projectFind.mockReturnValue([{ _id: 'p-1', projectNumber: 'PRJ-1' }]);
    const finishing = member({ _id: 'lance', workloadStatus: 'busy', teamStatus: 'finishing', activeProjects: [qcProject] });
    mocks.workload.mockResolvedValue([member({ _id: 'busy', workloadStatus: 'busy', teamStatus: 'busy' }), finishing]);

    await expect(autoAssignWaitingFabricationProjects('fabrication_update')).resolves.toBe(1);
    expect(mocks.assignLead).toHaveBeenCalledWith('p-1', 'lance', expect.objectContaining({ kind: 'nearest_completion' }));
  });

  it('stops when nobody is free or finishing, so the rest keep waiting', async () => {
    mocks.projectFind.mockReturnValue([{ _id: 'p-1' }, { _id: 'p-2' }]);
    mocks.planFind.mockReturnValue([]);
    mocks.workload
      .mockResolvedValueOnce([member({ _id: 'free' })])
      .mockResolvedValueOnce([member({ _id: 'free', workloadStatus: 'busy', teamStatus: 'busy' })]);

    await expect(autoAssignWaitingFabricationProjects('payment_verified')).resolves.toBe(1);
    expect(mocks.assignLead).toHaveBeenCalledTimes(1);
    expect(mocks.assignLead).toHaveBeenCalledWith('p-1', 'free', { kind: 'free' });
  });

  it('skips a project whose assignment fails or was taken meanwhile, and never throws', async () => {
    mocks.projectFind.mockReturnValue([{ _id: 'p-1' }, { _id: 'p-2' }, { _id: 'p-3' }]);
    mocks.workload.mockResolvedValue([member({ _id: 'free' })]);
    mocks.assignLead
      .mockRejectedValueOnce(new Error('Another team assignment for this fabricator is being saved right now.'))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 'p-3' });

    await expect(autoAssignWaitingFabricationProjects('sweep')).resolves.toBe(1);
    expect(mocks.assignLead.mock.calls.map(([projectId]) => projectId)).toEqual(['p-1', 'p-2', 'p-3']);

    mocks.projectFind.mockImplementation(() => { throw new Error('database down'); });
    await expect(autoAssignWaitingFabricationProjects('sweep')).resolves.toBe(0);
  });

  it('does nothing when no paid project is waiting', async () => {
    mocks.projectFind.mockReturnValue([{ _id: 'unpaid' }]);
    mocks.paid.mockResolvedValue(false);
    await expect(autoAssignWaitingFabricationProjects('sweep')).resolves.toBe(0);
    expect(mocks.workload).not.toHaveBeenCalled();
  });
});
