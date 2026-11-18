import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectFind: vi.fn(),
  projectExists: vi.fn(),
  itemFind: vi.fn(),
  itemDistinct: vi.fn(),
  reportFind: vi.fn(),
  reportCount: vi.fn(),
  reportFindById: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Project: { find: mocks.projectFind, exists: mocks.projectExists },
  ProjectItem: { find: mocks.itemFind, distinct: mocks.itemDistinct },
  VisitReport: { find: mocks.reportFind, countDocuments: mocks.reportCount, findById: mocks.reportFindById },
}));
vi.mock('../appointments/consultation-attendance-automation.js', () => ({
  synchronizeConsultationAttendanceByTime: vi.fn(),
}));

import { getVisitReport, listForFabricationStaff } from './visit-reports.service.js';

const fabricatorId = 'fabricator-1';
const assignedProjects = {
  $or: [
    { fabricationLeadId: fabricatorId },
    { fabricationAssistantIds: fabricatorId },
    { deliveryCrewIds: fabricatorId },
  ],
};

describe('fabricator visit report access', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('lists reports linked to assigned projects and their items', async () => {
    mocks.projectFind.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'project-1', visitReportId: 'primary-report' }] }) });
    mocks.itemFind.mockReturnValue({ select: () => ({ lean: async () => [{ ocularVisitReportId: 'item-report' }] }) });
    mocks.reportFind.mockReturnValue({
      populate: vi.fn().mockReturnThis(), sort: vi.fn().mockReturnThis(), skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ _id: 'item-report' }]),
    });
    mocks.reportCount.mockResolvedValue(1);

    await expect(listForFabricationStaff(fabricatorId, {})).resolves.toEqual({
      items: [{ _id: 'item-report' }], total: 1, hasMore: false,
    });
    expect(mocks.projectFind).toHaveBeenCalledWith(assignedProjects);
    expect(mocks.itemFind).toHaveBeenCalledWith({ projectId: { $in: ['project-1'] } });
    expect(mocks.reportCount).toHaveBeenCalledWith({
      $or: [{ linkedProjectId: { $in: ['project-1'] } }, { _id: { $in: ['primary-report', 'item-report'] } }],
    });
  });

  it('denies an unassigned report opened directly', async () => {
    mocks.reportFindById.mockReturnValue(Object.assign(
      Promise.resolve({ _id: 'report-1', linkedProjectId: 'unassigned-project' }),
      { populate: vi.fn().mockReturnThis() },
    ));
    mocks.itemDistinct.mockResolvedValue([]);
    mocks.projectExists.mockResolvedValue(null);

    await expect(getVisitReport('report-1', fabricatorId)).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.projectExists).toHaveBeenCalledWith({
      ...assignedProjects,
      $and: [{ $or: [{ visitReportId: 'report-1' }, { _id: { $in: ['unassigned-project'] } }] }],
    });
    expect(mocks.projectFind).not.toHaveBeenCalled();
  });
});
