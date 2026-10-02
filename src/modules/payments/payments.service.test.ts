import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockPaymentFindById,
  mockProjectFindById,
  mockProjectItemUpdateMany,
} = vi.hoisted(() => ({
  mockPaymentFindById: vi.fn(),
  mockProjectFindById: vi.fn(),
  mockProjectItemUpdateMany: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  PaymentPlan: {},
  Payment: {
    findById: mockPaymentFindById,
  },
  Project: {
    findById: mockProjectFindById,
  },
  ProjectItem: {
    updateMany: mockProjectItemUpdateMany,
  },
  User: {},
  AuditLog: {},
  ReceiptCounter: {},
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
} from './payments.service.js';
import { PaymentMethod, PaymentStageStatus, ProjectStatus, Role } from '../../utils/constants.js';

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
