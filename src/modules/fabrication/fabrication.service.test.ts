import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, ErrorCode } from '../../utils/appError.js';
import {
  DeliveryType,
  FabricationStatus,
  PaymentStageStatus,
  ProjectStatus,
  Role,
} from '../../utils/constants.js';

const {
  mockProjectFindById,
  mockFabricationUpdateFindOne,
  mockFabricationUpdateCreate,
  mockPaymentPlanFindOne,
  mockAuditLogCreate,
  mockUserFindById,
  mockProjectItemFindOne,
  mockProjectItemUpdate,
  mockProjectItemCount,
  mockItemCount, mockItemInsert, mockReportFindOne,
} = vi.hoisted(() => ({
  mockProjectFindById: vi.fn(),
  mockFabricationUpdateFindOne: vi.fn(),
  mockFabricationUpdateCreate: vi.fn(),
  mockPaymentPlanFindOne: vi.fn(),
  mockAuditLogCreate: vi.fn(),
  mockUserFindById: vi.fn(),
  mockProjectItemFindOne: vi.fn(),
  mockProjectItemUpdate: vi.fn(),
  mockProjectItemCount: vi.fn(),
  mockItemCount: vi.fn(), mockItemInsert: vi.fn(), mockReportFindOne: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  FabricationItem: { countDocuments: mockItemCount, insertMany: mockItemInsert },
  VisitReport: { findOne: mockReportFindOne },
  Project: {
    findById: mockProjectFindById,
  },
  ProjectItem: {
    findOne: mockProjectItemFindOne,
    findByIdAndUpdate: mockProjectItemUpdate,
    countDocuments: mockProjectItemCount,
  },
  FabricationUpdate: {
    findOne: mockFabricationUpdateFindOne,
    create: mockFabricationUpdateCreate,
  },
  User: {
    findById: mockUserFindById,
  },
  AuditLog: {
    create: mockAuditLogCreate,
  },
}));

vi.mock('../../models/Payment.js', () => ({
  PaymentPlan: {
    findOne: mockPaymentPlanFindOne,
  },
}));

vi.mock('../notifications/socket.service.js', () => ({
  createAndSendNotification: vi.fn(),
  getIO: vi.fn(() => ({
    to: vi.fn(() => ({ emit: vi.fn() })),
  })),
}));

vi.mock('../notifications/email.service.js', () => ({
  sendFabricationUpdateEmail: vi.fn(),
  sendPaymentHeadsUpEmail: vi.fn(),
  sendPaymentDueEmail: vi.fn(),
  sendReadyForDeliveryEmail: vi.fn(),
  sendProjectCompletedEmail: vi.fn(),
}));

vi.mock('../config/config.service.js', () => ({
  getPaymentActivationConfig: vi.fn(),
}));

vi.mock('../../utils/helpers.js', () => ({
  formatCurrency: vi.fn((amount: number) => `$${amount}`),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { createFabricationUpdate, getLatestFabricationStatus, seedFabricationItems } from './fabrication.service.js';

describe('createFabricationUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockProjectFindById.mockResolvedValue({
      _id: 'project-1',
      customerId: 'customer-1',
      title: 'QA Flow Project',
      status: ProjectStatus.FABRICATION,
      fabricationLeadId: { toString: () => 'lead-1' },
      fabricationAssistantIds: [],
      engineerIds: [],
      installationConfirmedAt: null,
    });

    mockFabricationUpdateFindOne.mockReturnValue({
      sort: vi.fn().mockResolvedValue({
        status: FabricationStatus.READY_FOR_DELIVERY,
      }),
    });
    mockPaymentPlanFindOne.mockResolvedValue(null);
    mockFabricationUpdateCreate.mockResolvedValue({ _id: 'update-1' });
    mockAuditLogCreate.mockResolvedValue({});
    mockUserFindById.mockResolvedValue(null);
    mockProjectItemCount.mockResolvedValue(0);
  });

  it('rejects done before installation confirmation without persisting an update', async () => {
    try {
      await createFabricationUpdate(
        {
          projectId: 'project-1',
          status: FabricationStatus.DONE,
          notes: 'Final installation completed.',
        },
        'lead-1',
        [Role.FABRICATION_STAFF],
      );
      throw new Error('Expected creation to fail without installation confirmation');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.statusCode).toBe(400);
      expect(appError.message).toBe(
        'Customer must confirm the installation schedule before marking the project as Done',
      );
    }

    expect(mockFabricationUpdateCreate).not.toHaveBeenCalled();
    expect(mockAuditLogCreate).not.toHaveBeenCalled();
  });

  it('keeps assigned fabricators from posting before the required payment is verified', async () => {
    mockProjectFindById.mockResolvedValue({
      _id: 'project-1',
      customerId: 'customer-1',
      title: 'Awaiting Payment Project',
      status: ProjectStatus.PAYMENT_PENDING,
      fabricationLeadId: { toString: () => 'lead-1' },
      fabricationAssistantIds: [],
      engineerIds: [],
    });

    await expect(createFabricationUpdate(
      {
        projectId: 'project-1',
        status: FabricationStatus.MATERIAL_PREP,
        notes: 'Trying to start early.',
      },
      'lead-1',
      [Role.FABRICATION_STAFF],
    )).rejects.toThrow('Project is not in fabrication phase');

    expect(mockFabricationUpdateCreate).not.toHaveBeenCalled();
  });

  it('allows an explicit shop-fabricated project to finish without installation confirmation', async () => {
    const save = vi.fn();
    mockProjectFindById.mockResolvedValue({
      _id: 'project-1',
      customerId: 'customer-1',
      title: 'Deliverable Project',
      status: ProjectStatus.FABRICATION,
      deliveryType: DeliveryType.SHOP_FABRICATED,
      fabricationLeadId: { toString: () => 'lead-1' },
      fabricationAssistantIds: [],
      engineerIds: [],
      installationConfirmedAt: null,
      save,
    });

    await createFabricationUpdate(
      { projectId: 'project-1', status: FabricationStatus.DONE, notes: 'Delivered.' },
      'lead-1',
      [Role.FABRICATION_STAFF],
    );

    expect(mockFabricationUpdateCreate).toHaveBeenCalled();
    expect(save).toHaveBeenCalled();
  });

  function setUpOnSiteProject(currentStatus: FabricationStatus | null = null, confirmed = false) {
    mockProjectFindById.mockResolvedValue({
      _id: 'project-1',
      customerId: 'customer-1',
      title: 'Installation Project',
      status: ProjectStatus.FABRICATION,
      deliveryType: DeliveryType.ON_SITE_INSTALLATION,
      fabricationLeadId: { toString: () => 'lead-1' },
      fabricationAssistantIds: [],
      engineerIds: [],
      installationConfirmedAt: confirmed ? new Date() : null,
      save: vi.fn(),
    });
    mockFabricationUpdateFindOne.mockReturnValue({
      sort: vi.fn().mockResolvedValue(currentStatus ? { status: currentStatus } : null),
    });
    mockPaymentPlanFindOne.mockResolvedValue({
      stages: [{ label: 'Full Payment', status: PaymentStageStatus.VERIFIED }],
    });
  }

  it.each([
    [null, FabricationStatus.SITE_PREPARATION],
    [FabricationStatus.SITE_PREPARATION, FabricationStatus.MEASUREMENT_LAYOUT],
    [FabricationStatus.MEASUREMENT_LAYOUT, FabricationStatus.MATERIAL_PREP],
    [FabricationStatus.MATERIAL_PREP, FabricationStatus.FABRICATION_INSTALLATION],
    [FabricationStatus.FABRICATION_INSTALLATION, FabricationStatus.WELDING_ASSEMBLY],
    [FabricationStatus.WELDING_ASSEMBLY, FabricationStatus.FINISHING],
    [FabricationStatus.FINISHING, FabricationStatus.QUALITY_CHECK],
  ])('lets a fully paid on-site project advance from %s to %s before confirmation', async (currentStatus, targetStatus) => {
    setUpOnSiteProject(currentStatus);

    await createFabricationUpdate(
      { projectId: 'project-1', status: targetStatus!, notes: 'Work progressing.' },
      'lead-1',
      [Role.FABRICATION_STAFF],
    );

    expect(mockFabricationUpdateCreate).toHaveBeenCalledWith(expect.objectContaining({
      status: targetStatus,
      updatedBy: 'lead-1',
    }));
  });

  it('lets the fabricator start a fully paid item without schedule confirmation', async () => {
    setUpOnSiteProject();
    mockProjectItemFindOne.mockResolvedValue({
      _id: 'item-1', status: ProjectStatus.FABRICATION, installationConfirmedAt: null,
    });

    await createFabricationUpdate(
      { projectId: 'project-1', projectItemId: 'item-1', status: FabricationStatus.SITE_PREPARATION, notes: 'Mobilizing.' },
      'lead-1',
      [Role.FABRICATION_STAFF],
    );

    expect(mockPaymentPlanFindOne).toHaveBeenCalledWith({ projectId: 'project-1', projectItemId: 'item-1' });
    expect(mockFabricationUpdateCreate).toHaveBeenCalledWith(expect.objectContaining({
      projectItemId: 'item-1', status: FabricationStatus.SITE_PREPARATION,
    }));
  });

  it('requires the selected item to be confirmed at Done even if its parent is confirmed', async () => {
    setUpOnSiteProject(FabricationStatus.QUALITY_CHECK, true);
    mockProjectItemFindOne.mockResolvedValue({
      _id: 'item-1', status: ProjectStatus.FABRICATION, installationConfirmedAt: null,
    });

    await expect(createFabricationUpdate(
      { projectId: 'project-1', projectItemId: 'item-1', status: FabricationStatus.TURNOVER, notes: 'Installation complete.' },
      'lead-1',
      [Role.FABRICATION_STAFF],
    )).rejects.toMatchObject({ code: ErrorCode.FABRICATION_INSTALLATION_NOT_CONFIRMED });

    expect(mockFabricationUpdateCreate).not.toHaveBeenCalled();
    expect(mockProjectItemUpdate).not.toHaveBeenCalled();
  });

  it('still blocks site preparation when full payment is not cashier-verified', async () => {
    setUpOnSiteProject();
    mockPaymentPlanFindOne.mockResolvedValue({
      stages: [{ label: 'Full Payment', status: PaymentStageStatus.PROOF_SUBMITTED }],
    });

    await expect(createFabricationUpdate(
      { projectId: 'project-1', status: FabricationStatus.SITE_PREPARATION, notes: 'Mobilizing.' },
      'lead-1',
      [Role.FABRICATION_STAFF],
    )).rejects.toMatchObject({ code: ErrorCode.FABRICATION_PAYMENT_GATE });

    expect(mockFabricationUpdateCreate).not.toHaveBeenCalled();
  });

  it('requires installation confirmation at Done even when the on-site project is fully paid', async () => {
    setUpOnSiteProject(FabricationStatus.QUALITY_CHECK);

    await expect(createFabricationUpdate(
      { projectId: 'project-1', status: FabricationStatus.TURNOVER, notes: 'Installation complete.' },
      'lead-1',
      [Role.FABRICATION_STAFF],
    )).rejects.toMatchObject({ code: ErrorCode.FABRICATION_INSTALLATION_NOT_CONFIRMED });

    expect(mockFabricationUpdateCreate).not.toHaveBeenCalled();
    expect(mockAuditLogCreate).not.toHaveBeenCalled();
  });

  it('lets a fully paid on-site project finish once installation is confirmed', async () => {
    setUpOnSiteProject(FabricationStatus.QUALITY_CHECK, true);

    await createFabricationUpdate(
      { projectId: 'project-1', status: FabricationStatus.TURNOVER, notes: 'Installation complete.' },
      'lead-1',
      [Role.FABRICATION_STAFF],
    );

    expect(mockFabricationUpdateCreate).toHaveBeenCalledWith(expect.objectContaining({
      status: FabricationStatus.TURNOVER,
    }));
    const project = await mockProjectFindById.mock.results[0].value;
    expect(project.status).toBe(ProjectStatus.COMPLETED);
    expect(project.save).toHaveBeenCalled();
  });

  it('advertises Done as the confirmation gate while leaving the paid first stage available', async () => {
    mockProjectFindById.mockReturnValue({
      select: vi.fn().mockResolvedValue({ deliveryType: DeliveryType.ON_SITE_INSTALLATION }),
    });
    mockFabricationUpdateFindOne.mockReturnValue({
      sort: vi.fn().mockReturnValue({ populate: vi.fn().mockResolvedValue(null) }),
    });
    mockPaymentPlanFindOne.mockResolvedValue({
      stages: [{ label: 'Full Payment', status: PaymentStageStatus.VERIFIED }],
    });

    const result = await getLatestFabricationStatus('project-1', 'admin-1', [Role.ADMIN]);

    expect(result.confirmationGateStatus).toBe(FabricationStatus.TURNOVER);
    expect(result.currentStatus).toBe(FabricationStatus.QUEUED);
    expect(result.allowedTransitions).toEqual([FabricationStatus.SITE_PREPARATION]);
    expect(result.paymentGate.allPaid).toBe(true);
    expect(result.paymentGate.stageGates[FabricationStatus.SITE_PREPARATION].blocked).toBe(false);
  });
});

describe('project component measurements', () => {
  it('uses the components entered in Create Project without a visit report', async () => {
    vi.clearAllMocks();
    mockProjectFindById.mockResolvedValue({
      _id: 'project-independent',
      lineItems: [{ label: 'Left panel', quantity: 2, notes: 'Rounded edges' }],
    });
    mockItemCount.mockResolvedValue(0);
    mockReportFindOne.mockReturnValue({ sort: vi.fn().mockResolvedValue(null) });
    await seedFabricationItems('project-independent');
    expect(mockItemInsert).toHaveBeenCalledWith([{
      projectId: 'project-independent', title: 'Left panel', description: 'Rounded edges', quantity: 2, isCompleted: false,
    }]);
  });
});
