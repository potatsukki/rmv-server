import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectFindById: vi.fn(),
  projectItemFindOne: vi.fn(),
  projectItemFind: vi.fn(),
  projectItemCreate: vi.fn(),
  visitReportFind: vi.fn(),
  userFindById: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Project: { findById: mocks.projectFindById },
  ProjectItem: {
    findOne: mocks.projectItemFindOne,
    find: mocks.projectItemFind,
    create: mocks.projectItemCreate,
  },
  Appointment: {},
  User: { findById: mocks.userFindById },
  AuditLog: { create: mocks.auditCreate },
  VisitReport: { find: mocks.visitReportFind },
}));
vi.mock('../../models/Payment.js', () => ({ PaymentPlan: {} }));
vi.mock('../../models/Blueprint.js', () => ({ Blueprint: {} }));
vi.mock('../notifications/socket.service.js', () => ({
  createAndSendNotification: vi.fn(), notifyRole: vi.fn(),
}));
vi.mock('../../services/contract.service.js', () => ({ generateAndUploadContract: vi.fn() }));
vi.mock('../uploads/upload.service.js', () => ({ generateDownloadUrl: vi.fn(), verifyFileExists: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../config/config.service.js', () => ({ getInstallmentConfig: vi.fn() }));
vi.mock('../../utils/projectNumber.js', () => ({ generateProjectNumber: vi.fn() }));
vi.mock('../fabrication/fabrication.service.js', () => ({ seedFabricationItems: vi.fn() }));

import { reviewInitialDesign } from './projects.service.js';
import { ProjectStatus, Role } from '../../utils/constants.js';

describe('reviewInitialDesign', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('approves a matching primary item when its initial design is stored on the legacy project record', async () => {
    const actorId = 'engineer-1';
    const projectItem = {
      _id: 'item-canopy',
      projectId: 'project-1',
      serviceType: 'canopy',
      title: 'Canopy',
      status: ProjectStatus.SUBMITTED,
      initialDesignKeys: [],
      initialDesignNotes: undefined,
      designReviewStatus: 'not_required',
      save: vi.fn().mockResolvedValue(undefined),
    };
    const project = {
      _id: 'project-1',
      title: 'Canopy & Railings Project',
      serviceType: 'canopy',
      serviceTypes: ['canopy', 'railings'],
      salesStaffId: 'sales-1',
      engineerIds: [{ toString: () => actorId }],
      initialDesignKeys: ['projects/initial-design/canopy.pdf'],
      initialDesignNotes: 'Canopy concept',
      designReviewStatus: 'pending',
      status: ProjectStatus.SUBMITTED,
      save: vi.fn().mockResolvedValue(undefined),
      toObject: vi.fn().mockReturnValue({ _id: 'project-1' }),
    };
    mocks.projectFindById.mockResolvedValue(project);
    mocks.projectItemFindOne.mockResolvedValue(projectItem);
    mocks.userFindById.mockReturnValue({
      select: vi.fn().mockResolvedValue({ roles: [Role.ENGINEER] }),
    });
    mocks.projectItemFind
      .mockReturnValueOnce({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([projectItem]) }) })
      .mockReturnValueOnce({ sort: vi.fn().mockResolvedValue([projectItem]) })
      .mockReturnValueOnce({
        populate: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([projectItem]),
      });
    mocks.visitReportFind.mockReturnValue({ sort: vi.fn().mockResolvedValue([]) });
    mocks.projectItemCreate.mockResolvedValue({ _id: 'item-railings' });
    mocks.auditCreate.mockResolvedValue({});

    await expect(reviewInitialDesign('project-1', {
      projectItemId: 'item-canopy',
      decision: 'approved',
    }, actorId)).resolves.toMatchObject({ _id: 'project-1' });

    expect(projectItem).toMatchObject({
      initialDesignKeys: ['projects/initial-design/canopy.pdf'],
      initialDesignNotes: 'Canopy concept',
      designReviewStatus: 'approved',
    });
    expect(projectItem.save).toHaveBeenCalled();
  });
});
