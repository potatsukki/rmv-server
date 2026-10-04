import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockPaymentFindById,
  mockPaymentFind,
  mockProjectFindById,
  mockProjectItemUpdateMany,
  mockPaymentPlanFindOne,
  mockPaymentCreate,
  mockUserFindById,
  mockReceiptCounterUpdate,
  mockAuditCreate,
} = vi.hoisted(() => ({
  mockPaymentFindById: vi.fn(),
  mockPaymentFind: vi.fn(),
  mockProjectFindById: vi.fn(),
  mockProjectItemUpdateMany: vi.fn(),
  mockPaymentPlanFindOne: vi.fn(),
  mockPaymentCreate: vi.fn(),
  mockUserFindById: vi.fn(),
  mockReceiptCounterUpdate: vi.fn(),
  mockAuditCreate: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  PaymentPlan: { findOne: mockPaymentPlanFindOne },
  Payment: {
    findById: mockPaymentFindById,
    find: mockPaymentFind,
    create: mockPaymentCreate,
  },
  Project: {
    findById: mockProjectFindById,
  },
  ProjectItem: {
    updateMany: mockProjectItemUpdateMany,
  },
  User: { findById: mockUserFindById },
  AuditLog: { create: mockAuditCreate },
  ReceiptCounter: { findOneAndUpdate: mockReceiptCounterUpdate },
  Appointment: {},
}));

vi.mock('../notifications/socket.service.js', () => ({
  createAndSendNotification: vi.fn(),
  notifyRole: vi.fn(),
  emitRoleEvent: vi.fn(),
}));

vi.mock('../notifications/email.service.js', () => ({
  sendPaymentVerifiedEmail: vi.fn(),
  sendPaymentDeclinedEmail: vi.fn(),
}));

vi.mock('../../services/paymongo.service.js', () => ({
  createStageCheckoutSession: vi.fn(),
}));

vi.mock('../../services/receipt.service.js', () => ({
  generateReceiptPdf: vi.fn(),
}));

vi.mock('../../config/r2.js', () => ({
  r2Client: {
    send: vi.fn(),
  },
}));

vi.mock('../../modules/uploads/upload.service.js', () => ({
  generateDownloadUrl: vi.fn(),
}));

vi.mock('../../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    R2_BUCKET_NAME: 'test-bucket',
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  activateAssignedFabricationAfterInitialPayment,
  getPaymentEvidenceTrail,
  recordCashPayment,
  listPendingPayments,
} from './payments.service.js';
import { PaymentMethod, PaymentStageStatus, ProjectStatus, Role } from '../../utils/constants.js';

describe('flagged GCash history', () => {
  it('returns rejected duplicates separately from the pending queue with cashier audit details', async () => {
    const history = [{ _id: 'attempt-1', method: 'gcash', duplicateReference: true, paymentStatus: 'rejected',
      rejectionReason: 'Duplicate reference number', rejectedAt: new Date(), rejectionSource: 'system',
      bookingId: { appointmentNumber: 'RMV-APPT-101', serviceTypes: ['Kitchen Counter'] },
      customerId: { firstName: 'Test', lastName: 'Customer' } }];
    const cursor = { populate: vi.fn(), sort: vi.fn(), skip: vi.fn(), limit: vi.fn(), lean: vi.fn().mockResolvedValue(history) };
    cursor.populate.mockReturnValue(cursor); cursor.sort.mockReturnValue(cursor); cursor.skip.mockReturnValue(cursor); cursor.limit.mockReturnValue(cursor);
    mockPaymentFind.mockReturnValue(cursor);
    const flagged = await listPendingPayments({ limit: '100' }, true);
    expect(mockPaymentFind).toHaveBeenCalledWith({ method: 'gcash', duplicateReference: true, paymentStatus: 'rejected' });
    expect(flagged[0]).toMatchObject({ customerName: 'Test Customer', bookingReference: 'RMV-APPT-101', duplicateReference: true, rejectionReason: 'Duplicate reference number' });
    expect(cursor.populate).toHaveBeenCalledWith('rejectedBy', 'firstName lastName');
  });
});

function mockPopulateValue<T>(value: T) {
  return {
    populate: vi.fn().mockResolvedValue(value),
  };
}

describe('payments.service evidence trail access', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns evidence trail for authorized customer', async () => {
    mockPaymentFindById.mockReturnValueOnce(
      mockPopulateValue({
        _id: 'pay-1',
        projectId: 'project-1',
        status: PaymentStageStatus.VERIFIED,
        method: PaymentMethod.QRPH,
        amountPaid: 1234,
        evidenceTrail: [
          {
            version: 1,
            source: 'paymongo_checkout_webhook',
          },
        ],
      }),
    );

    mockProjectFindById.mockReturnValueOnce({
      select: vi.fn().mockResolvedValue({
        customerId: {
          toString: () => 'customer-1',
        },
        salesStaffId: null,
        engineerIds: [],
        fabricationLeadId: null,
        fabricationAssistantIds: [],
        status: 'payment_pending',
      }),
    });

    const result = await getPaymentEvidenceTrail('pay-1', 'customer-1', [Role.CUSTOMER]);

    expect(result).toMatchObject({
      paymentId: 'pay-1',
      status: PaymentStageStatus.VERIFIED,
      method: PaymentMethod.QRPH,
      amountPaid: 1234,
    });
    expect(result.evidenceTrail).toHaveLength(1);
  });
});

describe('fabrication activation after initial payment', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('unlocks fabrication updates when payment is ready and a team is already assigned', async () => {
    const project = {
      _id: 'project-1',
      status: ProjectStatus.PAYMENT_PENDING,
      fabricationLeadId: 'fabricator-1',
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockProjectItemUpdateMany.mockResolvedValue({ modifiedCount: 2 });

    const result = await activateAssignedFabricationAfterInitialPayment(project);

    expect(result).toEqual({ parentReady: true, activated: true });
    expect(project.status).toBe(ProjectStatus.FABRICATION);
    expect(project.save).toHaveBeenCalledOnce();
    expect(mockProjectItemUpdateMany).toHaveBeenCalledWith(
      { projectId: 'project-1', status: ProjectStatus.PAYMENT_PENDING },
      { $set: { status: ProjectStatus.FABRICATION } },
    );
  });

  it('keeps updates locked when payment is ready but no team is assigned', async () => {
    const project = {
      _id: 'project-1',
      status: ProjectStatus.PAYMENT_PENDING,
      fabricationLeadId: null,
      save: vi.fn(),
    };

    const result = await activateAssignedFabricationAfterInitialPayment(project);

    expect(result).toEqual({ parentReady: true, activated: false });
    expect(project.status).toBe(ProjectStatus.PAYMENT_PENDING);
    expect(project.save).not.toHaveBeenCalled();
    expect(mockProjectItemUpdateMany).not.toHaveBeenCalled();
  });
});

describe('recordCashPayment amount limits', () => {
  const stage = {
    stageId: 'stage-1', label: 'Full Payment', amount: 3000,
    amountPaid: 0, remainingBalance: 3000, status: PaymentStageStatus.PENDING,
  };
  const plan = {
    projectId: 'project-1', totalAmount: 3000, stages: [stage], isImmutable: false,
    save: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(stage, { amount: 3000, amountPaid: 0, remainingBalance: 3000, status: PaymentStageStatus.PENDING });
    plan.isImmutable = false;
    mockPaymentPlanFindOne.mockResolvedValue(plan);
    mockProjectFindById.mockResolvedValue({
      _id: 'project-1', title: 'Railings', customerId: 'customer-1', status: ProjectStatus.PAYMENT_PENDING,
    });
    mockReceiptCounterUpdate.mockResolvedValue({ lastSeq: 1 });
    mockPaymentCreate.mockImplementation(async (input) => ({
      ...input, _id: 'payment-1', evidenceTrail: [], save: vi.fn(),
    }));
    mockUserFindById.mockResolvedValue(null);
  });

  it.each([3500, 3000.01, 999_999_999])('rejects an amount of %s above the outstanding balance before writing', async (amount) => {
    await expect(recordCashPayment('stage-1', amount, 'cashier-1')).rejects.toThrow(/cannot exceed.*amount due/i);
    expect(mockPaymentCreate).not.toHaveBeenCalled();
    expect(mockReceiptCounterUpdate).not.toHaveBeenCalled();
    expect(plan.save).not.toHaveBeenCalled();
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it('uses the unpaid balance after a partial payment', async () => {
    stage.amountPaid = 1000;
    stage.remainingBalance = 2000;
    await expect(recordCashPayment('stage-1', 2500, 'cashier-1')).rejects.toThrow(/cannot exceed.*amount due/i);
    expect(mockPaymentCreate).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity, 1e100, 1.005, 0.0000001, 3000.0000001])('rejects invalid or unsupported cash amounts: %s', async (amount) => {
    await expect(recordCashPayment('stage-1', amount, 'cashier-1')).rejects.toThrow(/valid amount|decimal places|too large/i);
    expect(mockPaymentCreate).not.toHaveBeenCalled();
    expect(plan.save).not.toHaveBeenCalled();
  });

  it('accepts the exact amount due and verifies the stage without excess credit', async () => {
    const result = await recordCashPayment('stage-1', 3000, 'cashier-1');
    expect(result.payment).toMatchObject({ amountPaid: 3000, excessCredit: 0 });
    expect(stage).toMatchObject({ status: PaymentStageStatus.VERIFIED, amountPaid: 3000, remainingBalance: 0 });
    expect(plan.save).toHaveBeenCalledOnce();
  });

  it('preserves partial payments without marking the whole stage paid', async () => {
    await recordCashPayment('stage-1', 1000.25, 'cashier-1');
    expect(stage).toMatchObject({ status: PaymentStageStatus.PENDING, amountPaid: 1000.25, remainingBalance: 1999.75 });
    expect(plan.save).toHaveBeenCalledOnce();
  });

  it('settles a fractional balance without leaving a floating-point remainder', async () => {
    stage.amount = 0.3;
    stage.amountPaid = 0.1;
    stage.remainingBalance = 0.2;
    await recordCashPayment('stage-1', 0.2, 'cashier-1');
    expect(stage).toMatchObject({ status: PaymentStageStatus.VERIFIED, amountPaid: 0.3, remainingBalance: 0 });
  });
});
