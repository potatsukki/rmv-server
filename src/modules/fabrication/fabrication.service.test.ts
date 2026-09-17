import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../utils/appError.js';
import {
  FabricationStatus,
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
  mockItemCount, mockItemInsert, mockReportFindOne,
} = vi.hoisted(() => ({
  mockProjectFindById: vi.fn(),
  mockFabricationUpdateFindOne: vi.fn(),
  mockFabricationUpdateCreate: vi.fn(),
  mockPaymentPlanFindOne: vi.fn(),
  mockAuditLogCreate: vi.fn(),
  mockUserFindById: vi.fn(),
  mockItemCount: vi.fn(), mockItemInsert: vi.fn(), mockReportFindOne: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  FabricationItem: { countDocuments: mockItemCount, insertMany: mockItemInsert },
  VisitReport: { findOne: mockReportFindOne },
  Project: {
    findById: mockProjectFindById,
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

import { createFabricationUpdate, seedFabricationItems } from './fabrication.service.js';

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
