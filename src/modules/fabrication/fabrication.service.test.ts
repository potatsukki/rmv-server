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
  mockFabricationUpdateFind,
  mockFabricationUpdateFindById,
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
  mockFabricationUpdateFind: vi.fn(),
  mockFabricationUpdateFindById: vi.fn(),
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
    find: mockFabricationUpdateFind,
    findById: mockFabricationUpdateFindById,
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
    error: vi.fn(),
  },
}));

import { createFabricationUpdate, updateFabricationUpdate, getLatestFabricationStatus, listFabricationUpdates, getFabricationUpdateById, seedFabricationItems } from './fabrication.service.js';
import { getPaymentActivationConfig } from '../config/config.service.js';
import { createAndSendNotification } from '../notifications/socket.service.js';
import { sendFabricationUpdateEmail, sendProjectCompletedEmail, sendReadyForDeliveryEmail } from '../notifications/email.service.js';

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
    [null, FabricationStatus.FABRICATION],
    [FabricationStatus.FABRICATION, FabricationStatus.WELDING_ASSEMBLY],
    [FabricationStatus.WELDING_ASSEMBLY, FabricationStatus.INSTALLATION],
    [FabricationStatus.INSTALLATION, FabricationStatus.FINISHING],
    [FabricationStatus.FINISHING, FabricationStatus.QUALITY_CHECK],
  ])('lets a fully paid on-site project advance from %s to %s before confirmation', async (currentStatus, targetStatus) => {
    setUpOnSiteProject(currentStatus);
    mockUserFindById.mockResolvedValue({ email: 'customer@example.com' });

    await createFabricationUpdate(
      { projectId: 'project-1', status: targetStatus!, notes: 'Work progressing.' },
      'lead-1',
      [Role.FABRICATION_STAFF],
    );

    expect(mockFabricationUpdateCreate).toHaveBeenCalledWith(expect.objectContaining({
      status: targetStatus,
      updatedBy: 'lead-1',
    }));
    expect(sendReadyForDeliveryEmail).not.toHaveBeenCalled();
    expect(sendFabricationUpdateEmail).toHaveBeenCalledWith('customer@example.com', expect.objectContaining({
      projectTitle: 'Installation Project',
    }));
    const notification = vi.mocked(createAndSendNotification).mock.calls[0];
    expect(notification[2]).toBe('Fabrication Update');
    expect(notification[3]).not.toMatch(/deliver/i);
  });

  it('lets the fabricator start a fully paid item without schedule confirmation', async () => {
    setUpOnSiteProject();
    mockProjectItemFindOne.mockResolvedValue({
      _id: 'item-1', status: ProjectStatus.FABRICATION, installationConfirmedAt: null,
    });

    await createFabricationUpdate(
      { projectId: 'project-1', projectItemId: 'item-1', status: FabricationStatus.FABRICATION, notes: 'Fabricating.' },
      'lead-1',
      [Role.FABRICATION_STAFF],
    );

    expect(mockPaymentPlanFindOne).toHaveBeenCalledWith({ projectId: 'project-1', projectItemId: 'item-1' });
    expect(mockFabricationUpdateCreate).toHaveBeenCalledWith(expect.objectContaining({
      projectItemId: 'item-1', status: FabricationStatus.FABRICATION,
    }));
  });

  it('requires the selected item to be confirmed at Done even if its parent is confirmed', async () => {
    setUpOnSiteProject(FabricationStatus.QUALITY_CHECK, true);
    mockProjectItemFindOne.mockResolvedValue({
      _id: 'item-1', status: ProjectStatus.FABRICATION, installationConfirmedAt: null,
    });

    await expect(createFabricationUpdate(
      { projectId: 'project-1', projectItemId: 'item-1', status: FabricationStatus.DONE, notes: 'Installation complete.' },
      'lead-1',
      [Role.FABRICATION_STAFF],
    )).rejects.toMatchObject({ code: ErrorCode.FABRICATION_INSTALLATION_NOT_CONFIRMED });

    expect(mockFabricationUpdateCreate).not.toHaveBeenCalled();
    expect(mockProjectItemUpdate).not.toHaveBeenCalled();
  });

  it('still blocks fabrication when full payment is not cashier-verified', async () => {
    setUpOnSiteProject();
    mockPaymentPlanFindOne.mockResolvedValue({
      stages: [{ label: 'Full Payment', status: PaymentStageStatus.PROOF_SUBMITTED }],
    });

    await expect(createFabricationUpdate(
      { projectId: 'project-1', status: FabricationStatus.FABRICATION, notes: 'Fabricating.' },
      'lead-1',
      [Role.FABRICATION_STAFF],
    )).rejects.toMatchObject({ code: ErrorCode.FABRICATION_PAYMENT_GATE });

    expect(mockFabricationUpdateCreate).not.toHaveBeenCalled();
  });

  it('requires installation confirmation at Done even when the on-site project is fully paid', async () => {
    setUpOnSiteProject(FabricationStatus.QUALITY_CHECK);

    await expect(createFabricationUpdate(
      { projectId: 'project-1', status: FabricationStatus.DONE, notes: 'Installation complete.' },
      'lead-1',
      [Role.FABRICATION_STAFF],
    )).rejects.toMatchObject({ code: ErrorCode.FABRICATION_INSTALLATION_NOT_CONFIRMED });

    expect(mockFabricationUpdateCreate).not.toHaveBeenCalled();
    expect(mockAuditLogCreate).not.toHaveBeenCalled();
  });

  it('lets a fully paid on-site project finish once installation is confirmed', async () => {
    setUpOnSiteProject(FabricationStatus.QUALITY_CHECK, true);
    mockUserFindById.mockResolvedValue({ email: 'customer@example.com' });

    await createFabricationUpdate(
      { projectId: 'project-1', status: FabricationStatus.DONE, notes: 'Installation complete.' },
      'lead-1',
      [Role.FABRICATION_STAFF],
    );

    expect(mockFabricationUpdateCreate).toHaveBeenCalledWith(expect.objectContaining({
      status: FabricationStatus.DONE,
    }));
    const project = await mockProjectFindById.mock.results[0].value;
    expect(project.status).toBe(ProjectStatus.COMPLETED);
    expect(project.save).toHaveBeenCalled();
    expect(sendReadyForDeliveryEmail).not.toHaveBeenCalled();
    expect(sendProjectCompletedEmail).toHaveBeenCalledWith('customer@example.com', expect.objectContaining({
      projectTitle: 'Installation Project',
    }));
    const notification = vi.mocked(createAndSendNotification).mock.calls[0];
    expect(notification[2]).toBe('Project Complete!');
    expect(notification[3]).toContain('installed and turned over');
    expect(notification[3]).not.toMatch(/deliver/i);
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

    expect(result.confirmationGateStatus).toBe(FabricationStatus.DONE);
    expect(result.currentStatus).toBe(FabricationStatus.QUEUED);
    expect(result.lifecycleStatuses).toEqual(['fabrication', 'welding_assembly', 'installation', 'finishing', 'quality_check', 'done']);
    expect(result.allowedTransitions).toEqual([FabricationStatus.FABRICATION]);
    expect(result.paymentGate.allPaid).toBe(true);
    expect(result.paymentGate.stageGates[FabricationStatus.FABRICATION].blocked).toBe(false);
  });

  it.each([
    FabricationStatus.SITE_PREPARATION, FabricationStatus.MEASUREMENT_LAYOUT,
    FabricationStatus.MATERIAL_PREP, FabricationStatus.FABRICATION_INSTALLATION,
  ])('allows existing on-site work at %s to continue from Fabrication', async (legacyStatus) => {
    setUpOnSiteProject(legacyStatus);
    await createFabricationUpdate(
      { projectId: 'project-1', status: FabricationStatus.WELDING_ASSEMBLY, notes: 'Assembly underway.' },
      'lead-1', [Role.FABRICATION_STAFF],
    );
    expect(mockFabricationUpdateCreate).toHaveBeenCalledWith(expect.objectContaining({ status: 'welding_assembly' }));
  });

  it.each([
    FabricationStatus.SITE_PREPARATION, FabricationStatus.MEASUREMENT_LAYOUT,
    FabricationStatus.MATERIAL_PREP, FabricationStatus.FABRICATION_INSTALLATION,
    FabricationStatus.TURNOVER, FabricationStatus.INSTALLATION, FabricationStatus.DONE,
  ])('rejects the invalid first on-site update %s without persisting it', async (status) => {
    setUpOnSiteProject();
    await expect(createFabricationUpdate(
      { projectId: 'project-1', status, notes: 'Invalid transition.' }, 'lead-1', [Role.FABRICATION_STAFF],
    )).rejects.toMatchObject({ code: ErrorCode.INVALID_TRANSITION });
    expect(mockFabricationUpdateCreate).not.toHaveBeenCalled();
  });

  it.each([FabricationStatus.FABRICATION, FabricationStatus.INSTALLATION])('rejects on-site stage %s for shop-fabricated work', async (status) => {
    mockProjectFindById.mockResolvedValue({ _id: 'project-1', status: ProjectStatus.FABRICATION, deliveryType: DeliveryType.SHOP_FABRICATED, fabricationAssistantIds: [] });
    mockFabricationUpdateFindOne.mockReturnValue({ sort: vi.fn().mockResolvedValue(null) });
    await expect(createFabricationUpdate(
      { projectId: 'project-1', status, notes: 'Wrong lifecycle.' }, 'admin-1', [Role.ADMIN],
    )).rejects.toMatchObject({ code: ErrorCode.INVALID_TRANSITION });
    expect(mockFabricationUpdateCreate).not.toHaveBeenCalled();
  });

  it.each([0, 1])('completes an on-site item with %s other unfinished items', async (remainingItems) => {
    setUpOnSiteProject(FabricationStatus.QUALITY_CHECK, true);
    mockProjectItemFindOne.mockResolvedValue({ _id: 'item-1', status: ProjectStatus.FABRICATION, installationConfirmedAt: new Date() });
    mockProjectItemCount.mockResolvedValue(remainingItems);
    await createFabricationUpdate(
      { projectId: 'project-1', projectItemId: 'item-1', status: FabricationStatus.DONE, notes: 'Item completed.' }, 'lead-1', [Role.FABRICATION_STAFF],
    );
    expect(mockProjectItemUpdate).toHaveBeenCalledWith('item-1', { $set: { status: ProjectStatus.COMPLETED } });
    const project = await mockProjectFindById.mock.results[0].value;
    expect(project.status).toBe(remainingItems ? ProjectStatus.FABRICATION : ProjectStatus.COMPLETED);
    expect(project.save).toHaveBeenCalledTimes(remainingItems ? 0 : 1);
  });

  it.each([
    [FabricationStatus.FABRICATION, FabricationStatus.WELDING_ASSEMBLY, 1, false, 1],
    [FabricationStatus.WELDING_ASSEMBLY, FabricationStatus.INSTALLATION, 1, true, 2],
    [FabricationStatus.FINISHING, FabricationStatus.QUALITY_CHECK, 2, true, 3],
  ])('applies payment gates for the six-stage on-site pipeline at %s', async (current, next, paidCount, blocked, requiredPaid) => {
    const stored = { status: current };
    mockProjectFindById.mockReturnValue({ select: vi.fn().mockResolvedValue({ deliveryType: DeliveryType.ON_SITE_INSTALLATION }) });
    mockFabricationUpdateFindOne.mockReturnValue({ sort: vi.fn().mockReturnValue({ populate: vi.fn().mockResolvedValue(stored) }) });
    mockPaymentPlanFindOne.mockResolvedValue({ stages: Array.from({ length: 3 }, (_, index) => ({ label: `Stage ${index + 1}`, status: index < paidCount ? PaymentStageStatus.VERIFIED : PaymentStageStatus.PENDING })) });
    const result = await getLatestFabricationStatus('project-1', 'admin-1', [Role.ADMIN]);
    expect(result.allowedTransitions).toEqual([next]);
    expect(result.paymentGate.stageGates[next]).toMatchObject({ requiredPaid, currentPaid: paidCount, blocked });
  });

  it('maps legacy payment reminder triggers only for on-site work', async () => {
    setUpOnSiteProject(FabricationStatus.FABRICATION);
    const stage = { label: 'Second payment', amount: 100, status: PaymentStageStatus.PENDING, activatedAt: undefined, headsUpSentAt: undefined };
    const save = vi.fn();
    mockPaymentPlanFindOne.mockResolvedValue({ stages: [{ status: PaymentStageStatus.VERIFIED }, stage], save });
    vi.mocked(getPaymentActivationConfig).mockResolvedValue({ activationMap: [null, 'welding'], headsUpMap: [null, 'assembly'], reminderGraceDays: 3, reminderIntervalDays: 2, escalationAfterReminders: 3 });
    await createFabricationUpdate(
      { projectId: 'project-1', status: FabricationStatus.WELDING_ASSEMBLY, notes: 'Assembling.' }, 'lead-1', [Role.FABRICATION_STAFF],
    );
    expect(stage.activatedAt).toBeInstanceOf(Date);
    expect(stage.headsUpSentAt).toBeInstanceOf(Date);
    expect(save).toHaveBeenCalled();
  });
});

describe('existing on-site fabrication tracking', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [FabricationStatus.SITE_PREPARATION, 'fabrication', ['welding_assembly']],
    [FabricationStatus.MEASUREMENT_LAYOUT, 'fabrication', ['welding_assembly']],
    [FabricationStatus.MATERIAL_PREP, 'fabrication', ['welding_assembly']],
    [FabricationStatus.FABRICATION_INSTALLATION, 'fabrication', ['welding_assembly']],
    [FabricationStatus.WELDING_ASSEMBLY, 'welding_assembly', ['installation']],
    [FabricationStatus.FINISHING, 'finishing', ['quality_check']],
    [FabricationStatus.TURNOVER, 'done', []],
  ])('maps stored %s in status, history, and detail without rewriting it', async (oldStatus, expectedStatus, next) => {
    const record = { _id: 'update-1', projectId: 'project-1', status: oldStatus, notes: 'Original notes', photoKeys: ['proof.png'], createdAt: new Date('2026-01-01'), updatedBy: 'lead-1' };
    const document = { ...record, toObject: () => ({ ...record }) };
    mockProjectFindById.mockReturnValue({ select: vi.fn().mockResolvedValue({ deliveryType: DeliveryType.ON_SITE_INSTALLATION }) });
    mockFabricationUpdateFindOne.mockReturnValue({ sort: vi.fn().mockReturnValue({ populate: vi.fn().mockResolvedValue(document) }) });
    mockFabricationUpdateFind.mockReturnValue({ populate: vi.fn().mockReturnValue({ sort: vi.fn().mockResolvedValue([document]) }) });
    mockFabricationUpdateFindById.mockReturnValue({ populate: vi.fn().mockResolvedValue(document) });
    mockPaymentPlanFindOne.mockResolvedValue(null);
    const result = await getLatestFabricationStatus('project-1', 'admin-1', [Role.ADMIN]);
    expect(result.currentStatus).toBe(expectedStatus);
    expect(result.latestUpdate).toMatchObject({ status: expectedStatus, notes: record.notes, photoKeys: record.photoKeys, createdAt: record.createdAt });
    expect(result.allowedTransitions).toEqual(next);
    expect(await listFabricationUpdates('project-1', 'admin-1', [Role.ADMIN])).toEqual([expect.objectContaining({ status: expectedStatus, notes: record.notes })]);
    expect(await getFabricationUpdateById('update-1', 'admin-1', [Role.ADMIN])).toMatchObject({ status: expectedStatus });
    expect(document.status).toBe(oldStatus);
  });

  it.each([Role.CUSTOMER, Role.SALES_STAFF, Role.FABRICATION_STAFF])('exposes the same lifecycle to the assigned %s', async (role) => {
    mockProjectFindById.mockReturnValue({ select: vi.fn().mockResolvedValue({ customerId: 'actor-1', salesStaffId: 'actor-1', fabricationLeadId: 'actor-1', fabricationAssistantIds: [], deliveryType: DeliveryType.ON_SITE_INSTALLATION }) });
    mockFabricationUpdateFindOne.mockReturnValue({ sort: vi.fn().mockReturnValue({ populate: vi.fn().mockResolvedValue({ status: FabricationStatus.INSTALLATION }) }) });
    mockPaymentPlanFindOne.mockResolvedValue(null);
    const result = await getLatestFabricationStatus('project-1', 'actor-1', [role]);
    expect(result.lifecycleStatuses).toEqual(['fabrication', 'welding_assembly', 'installation', 'finishing', 'quality_check', 'done']);
    expect(result.allowedTransitions).toEqual(['finishing']);
  });

  it('maps an edited historical update in the response while preserving its stored status', async () => {
    const document = {
      projectId: 'project-1', updatedBy: 'lead-1', status: FabricationStatus.FABRICATION_INSTALLATION,
      notes: 'Original notes', save: vi.fn(),
      toObject() { return { projectId: this.projectId, status: this.status, notes: this.notes }; },
    };
    mockFabricationUpdateFindById.mockResolvedValue(document);
    mockProjectFindById.mockReturnValue({ select: vi.fn().mockResolvedValue({ deliveryType: DeliveryType.ON_SITE_INSTALLATION, customerId: 'customer-1', fabricationAssistantIds: [], engineerIds: [] }) });
    const result = await updateFabricationUpdate('update-1', { notes: 'Corrected notes' }, 'lead-1', [Role.FABRICATION_STAFF]);
    expect(result).toMatchObject({ status: 'fabrication', notes: 'Corrected notes' });
    expect(document.status).toBe(FabricationStatus.FABRICATION_INSTALLATION);
    expect(document.save).toHaveBeenCalled();
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
