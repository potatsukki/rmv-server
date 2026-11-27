import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectFindById: vi.fn(),
  planFindOne: vi.fn(),
  autoAssign: vi.fn(),
}));

vi.mock('../../models/Payment.js', () => ({ PaymentPlan: { findOne: mocks.planFindOne, find: vi.fn() } }));
vi.mock('../../models/index.js', () => ({
  Project: { findById: mocks.projectFindById, findOneAndUpdate: vi.fn(), updateOne: vi.fn() },
  ProjectItem: { find: vi.fn(), updateMany: vi.fn() },
}));
vi.mock('../notifications/socket.service.js', () => ({ createAndSendNotification: vi.fn(), emitUserEvent: vi.fn(), notifyUsers: vi.fn() }));
vi.mock('./target-finish.js', () => ({ applyTargetFinishDate: vi.fn() }));
vi.mock('./fabrication-auto-assign.js', () => ({ autoAssignWaitingFabricationProjects: mocks.autoAssign }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { handleInitialFabricationPaymentVerified } from './fabrication-start.js';
import { createAndSendNotification, notifyUsers } from '../notifications/socket.service.js';
import { PaymentStageStatus, ProjectStatus } from '../../utils/constants.js';

const verifiedPlan = { stages: [{ status: PaymentStageStatus.VERIFIED }] };
const waitingProject = (overrides: Record<string, unknown> = {}) => ({
  _id: 'project-1',
  title: 'Railings',
  status: ProjectStatus.PAYMENT_PENDING,
  customerId: 'customer-1',
  engineerIds: ['engineer-1'],
  fabricationLeadId: null,
  fabricationAssistantIds: [],
  ...overrides,
});

describe('verified downpayment on a project without a team (panel note 2026-11-27)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // A project-level plan whose first stage is verified: the project is ready to start.
    mocks.planFindOne.mockResolvedValue(verifiedPlan);
  });

  it('runs the auto-assign and returns the project with its new lead; the assignment sends its own notices', async () => {
    mocks.projectFindById
      .mockResolvedValueOnce(waitingProject())
      .mockResolvedValueOnce(waitingProject({ status: ProjectStatus.FABRICATION, fabricationLeadId: 'lead-1' }));
    mocks.autoAssign.mockResolvedValue(1);

    const result = await handleInitialFabricationPaymentVerified('project-1' as never, verifiedPlan);

    expect(mocks.autoAssign).toHaveBeenCalledWith('payment_verified');
    expect(result).toMatchObject({ status: ProjectStatus.FABRICATION, fabricationLeadId: 'lead-1' });
    expect(createAndSendNotification).not.toHaveBeenCalled();
    expect(notifyUsers).not.toHaveBeenCalled();
  });

  it('tells the customer and the engineers that the project waits in line when nobody is free', async () => {
    mocks.projectFindById.mockResolvedValue(waitingProject());
    mocks.autoAssign.mockResolvedValue(0);

    await handleInitialFabricationPaymentVerified('project-1' as never, verifiedPlan);

    const [customerId, , customerTitle, customerMessage] = vi.mocked(createAndSendNotification).mock.calls[0]!;
    expect([customerId, customerTitle]).toEqual(['customer-1', 'Fabrication Team Assignment Pending']);
    expect(customerMessage).toContain('next in line for a fabricator');
    const [recipients, , title, message] = vi.mocked(notifyUsers).mock.calls[0]!;
    expect(recipients).toEqual(['engineer-1']);
    expect(title).toBe('Waiting for a Fabricator');
    expect(message).toContain('when a fabricator is free or their project reaches Quality Check');
  });

  it('still sends the waiting notices when the auto-assign itself fails', async () => {
    mocks.projectFindById.mockResolvedValue(waitingProject());
    mocks.autoAssign.mockRejectedValue(new Error('database down'));

    await expect(handleInitialFabricationPaymentVerified('project-1' as never, verifiedPlan)).resolves.toMatchObject({ _id: 'project-1' });
    expect(vi.mocked(notifyUsers).mock.calls[0]![2]).toBe('Waiting for a Fabricator');
  });

  it('does not run before the required payment is verified', async () => {
    mocks.planFindOne.mockResolvedValue({ stages: [{ status: PaymentStageStatus.PROOF_SUBMITTED }] });
    mocks.projectFindById.mockResolvedValue(waitingProject());

    await handleInitialFabricationPaymentVerified('project-1' as never, { stages: [{ status: PaymentStageStatus.PROOF_SUBMITTED }] });

    expect(mocks.autoAssign).not.toHaveBeenCalled();
  });
});
