import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectFindById: vi.fn(),
  planFindOne: vi.fn(),
  autoAssign: vi.fn(),
  projectFindOneAndUpdate: vi.fn(),
  itemFindById: vi.fn(),
}));

vi.mock('../../models/Payment.js', () => ({ PaymentPlan: { findOne: mocks.planFindOne, find: vi.fn() } }));
vi.mock('../../models/index.js', () => ({
  Project: { findById: mocks.projectFindById, findOneAndUpdate: mocks.projectFindOneAndUpdate, updateOne: vi.fn() },
  ProjectItem: { find: vi.fn(), updateMany: vi.fn(), findById: mocks.itemFindById },
}));
vi.mock('../notifications/socket.service.js', () => ({ createAndSendNotification: vi.fn(), emitUserEvent: vi.fn(), notifyUsers: vi.fn() }));
vi.mock('./fabrication-realtime.js', () => ({ emitFabricationTeamChanged: vi.fn() }));
vi.mock('./target-finish.js', () => ({ applyTargetFinishDate: vi.fn() }));
vi.mock('./fabrication-auto-assign.js', () => ({ autoAssignWaitingFabricationProjects: mocks.autoAssign }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { handleInitialFabricationPaymentVerified, notifyFabricationTeamPaymentVerified } from './fabrication-start.js';
import { createAndSendNotification, notifyUsers } from '../notifications/socket.service.js';
import { DeliveryType, PaymentStageStatus, ProjectStatus } from '../../utils/constants.js';

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

// Notifications per role 2026-11-28: the fabrication team's "paid" notices show under Payments.
describe('fabrication team payment notices', () => {
  const lead = 'lead-1';
  const assistant = 'assistant-1';
  const team = { fabricationLeadId: lead, fabricationAssistantIds: [assistant] };
  const stage = (stageId: string, status: PaymentStageStatus, label = stageId) => ({ stageId, label, status });
  const noticesTitled = (title: string) => vi.mocked(notifyUsers).mock.calls.filter((call) => call[2] === title);

  beforeEach(() => vi.resetAllMocks());

  it.each([
    [2, '1st Payment Verified', 'The required downpayment for "Railings" is verified.'],
    [1, 'Full Payment Verified', 'The full payment for "Railings" is verified.'],
  ])('downpayment (%i stages): customer + engineers get Updates Unlocked, the team gets %s', async (stages, teamTitle, teamText) => {
    const plan = { stages: [stage('s1', PaymentStageStatus.VERIFIED), stage('s2', PaymentStageStatus.PENDING)].slice(0, stages) };
    mocks.planFindOne.mockResolvedValue(plan);
    mocks.projectFindById.mockResolvedValue(waitingProject(team));
    mocks.projectFindOneAndUpdate.mockResolvedValue(waitingProject({ ...team, status: ProjectStatus.FABRICATION }));

    await handleInitialFabricationPaymentVerified('project-1' as never, plan);

    expect(noticesTitled('Fabrication Updates Unlocked').map((call) => call[0])).toEqual([['customer-1', 'engineer-1']]);
    const teamNotice = noticesTitled(teamTitle);
    expect(teamNotice).toHaveLength(1);
    expect(teamNotice[0]!.slice(0, 2)).toEqual([[lead, assistant], 'payment']);
    expect(teamNotice[0]![3]).toContain(teamText);
    expect(teamNotice[0]![4]).toBe('/projects/project-1/fabrication');
  });

  const projectQuery = (value: unknown) => ({ select: vi.fn().mockResolvedValue(value) });

  it.each([
    [DeliveryType.ON_SITE_INSTALLATION, 'Installation'],
    [DeliveryType.SHOP_FABRICATED, 'Ready for Delivery'],
  ])('2nd of 3 payments verified (%s): the team may continue to %s', async (deliveryType, nextStage) => {
    mocks.projectFindById.mockReturnValue(projectQuery({ _id: 'project-1', title: 'Railings', deliveryType, ...team }));
    const plan = { stages: [stage('s1', PaymentStageStatus.VERIFIED), stage('s2', PaymentStageStatus.VERIFIED, 'Progress Billing'), stage('s3', PaymentStageStatus.PENDING)] };

    await notifyFabricationTeamPaymentVerified('project-1', plan, 's2');

    expect(vi.mocked(notifyUsers).mock.calls).toEqual([[
      [lead, assistant], 'payment', '2nd Payment Verified',
      `The 2nd payment (Progress Billing) for "Railings" is verified. You can continue to ${nextStage}.`,
      '/projects/project-1/fabrication',
    ]]);
  });

  it('the last payment: All Payments Verified, with the item named for a per-item plan', async () => {
    mocks.projectFindById.mockReturnValue(projectQuery({ _id: 'project-1', title: 'Railings', ...team }));
    mocks.itemFindById.mockReturnValue(projectQuery({ title: 'Balcony' }));
    const plan = { projectItemId: 'item-1', stages: [stage('s1', PaymentStageStatus.VERIFIED), stage('s2', PaymentStageStatus.VERIFIED)] };

    await notifyFabricationTeamPaymentVerified('project-1', plan, 's2');

    const [recipients, category, title, message, link] = vi.mocked(notifyUsers).mock.calls[0]!;
    expect([recipients, category, title, link]).toEqual([[lead, assistant], 'payment', 'All Payments Verified', '/projects/project-1/fabrication?projectItemId=item-1']);
    expect(message).toBe('All payments for "Railings" (Balcony) are verified. No stage waits for payment any more, so you can continue up to Done.');
  });

  it('sends nothing for the downpayment, a stage not verified yet, or a project without a lead', async () => {
    const plan = { stages: [stage('s1', PaymentStageStatus.VERIFIED), stage('s2', PaymentStageStatus.PROOF_SUBMITTED), stage('s3', PaymentStageStatus.PENDING)] };
    await notifyFabricationTeamPaymentVerified('project-1', plan, 's1');
    await notifyFabricationTeamPaymentVerified('project-1', plan, 's2');
    await notifyFabricationTeamPaymentVerified('project-1', plan, 'unknown');
    expect(mocks.projectFindById).not.toHaveBeenCalled();

    mocks.projectFindById.mockReturnValue(projectQuery({ _id: 'project-1', title: 'Railings', fabricationLeadId: null, fabricationAssistantIds: [] }));
    await notifyFabricationTeamPaymentVerified('project-1', { stages: [stage('s1', PaymentStageStatus.VERIFIED), stage('s2', PaymentStageStatus.VERIFIED)] }, 's2');
    expect(notifyUsers).not.toHaveBeenCalled();
  });
});