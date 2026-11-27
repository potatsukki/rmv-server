import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const stubAll = vi.hoisted(() => (module: Record<string, unknown>) => Object.fromEntries(
  Object.entries(module).map(([key, value]) => [key, typeof value === 'function' ? vi.fn() : value]),
));

vi.mock('../notifications/socket.service.js', async (importOriginal) => stubAll(await importOriginal()));
vi.mock('../notifications/email.service.js', async (importOriginal) => stubAll(await importOriginal()));
vi.mock('../../config/r2.js', () => ({ r2Client: { send: vi.fn(async () => ({})) } }));
vi.mock('../../services/receipt.service.js', () => ({ generateReceiptPdf: vi.fn(async () => Buffer.from('test receipt')) }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { Blueprint, Payment, PaymentPlan, Project, ProjectItem, SlotLock, User } from '../../models/index.js';
import { DeliveryType, FabricationStatus, PaymentStageStatus, ProjectStatus, Role, StaffAvailabilityStatus } from '../../utils/constants.js';
import { createFabricationUpdate, getLatestFabricationStatus } from '../fabrication/fabrication.service.js';
import { emitUserEvent, notifyUsers } from '../notifications/socket.service.js';
import { recordCashPayment } from '../payments/payments.service.js';
import { handleInitialFabricationPaymentVerified, reconcileFabricationStart } from './fabrication-start.js';
import { assignFabricationStaff, selectPaymentPlan } from './projects.service.js';

const uri = process.env.RMV_MONGO_TEST_URI;

describe.runIf(Boolean(uri))('fabrication start after verified project payment', () => {
  let customerId: string;
  let engineerId: string;
  let leadId: string;
  let cashierId: string;
  let salesStaffId: string;

  beforeAll(async () => {
    const target = new URL(uri!);
    if (target.hostname !== '127.0.0.1' || !/^\/rmv_(?:test|repro)/.test(target.pathname)) {
      throw new Error('Fabrication payment tests require a throwaway local RMV MongoDB database');
    }
    await mongoose.connect(uri!);
    await mongoose.connection.dropDatabase();
    for (const model of [Project, ProjectItem, PaymentPlan, SlotLock]) await model.syncIndexes();
  }, 60_000);

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  async function addUser(name: string, role: Role) {
    const user = await User.create({ email: `${name}@example.test`, firstName: name, lastName: 'Test', roles: [role], isActive: true });
    return String(user._id);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
    customerId = await addUser('customer', Role.CUSTOMER);
    engineerId = await addUser('engineer', Role.ENGINEER);
    leadId = await addUser('lead', Role.FABRICATION_STAFF);
    cashierId = await addUser('cashier', Role.CASHIER);
    salesStaffId = await addUser('sales', Role.SALES_STAFF);
  });

  async function approvedProject(quotationTotals: number[], withDesignCredit = true) {
    const project = await Project.create({
      title: 'Staircase project', projectNumber: 'PRJ-2026-00001', serviceType: 'staircase',
      customerId, salesStaffId, engineerIds: [engineerId],
      status: ProjectStatus.APPROVED, deliveryType: DeliveryType.SHOP_FABRICATED,
      ...(withDesignCredit ? { designFee: { status: 'verified', amount: 1000 } } : {}),
    });
    const items = [];
    for (const [index, total] of quotationTotals.entries()) {
      const item = await ProjectItem.create({
        projectId: project._id, title: `Staircase ${index + 1}`, serviceType: index === 0 ? 'staircase' : 'railings',
        status: ProjectStatus.APPROVED,
      });
      await Blueprint.create({
        projectId: project._id, projectItemId: item._id, uploadedBy: engineerId,
        status: 'approved', quotationReviewStatus: 'sent_to_customer', version: 1,
        blueprintKey: `blueprints/test-${index}.pdf`, quotation: { total, workingDays: 3 },
      });
      items.push(item);
    }
    return { projectId: String(project._id), itemIds: items.map((item) => String(item._id)) };
  }

  function assign(projectId: string) {
    return assignFabricationStaff(projectId, { fabricationLeadId: leadId, fabricationAssistantIds: [] }, engineerId);
  }

  function post(projectId: string, projectItemId: string, status: FabricationStatus, actorId: string, role: Role) {
    return createFabricationUpdate({ projectId, projectItemId, status, notes: 'Workshop progress' }, actorId, [role]);
  }

  it('starts the assigned one-peso project as soon as its design credit settles the plan', async () => {
    const { projectId, itemIds: [itemId] } = await approvedProject([1]);
    expect((await assign(projectId)).status).toBe(ProjectStatus.PAYMENT_PENDING);

    const result = await selectPaymentPlan(projectId, { paymentType: 'full', projectItemId: itemId }, customerId);
    expect(result.paymentPlan).toMatchObject({
      totalAmount: 0, designFeeCredit: 1, stages: [{ status: PaymentStageStatus.VERIFIED, amount: 0, remainingBalance: 0 }],
    });
    expect(result.project.status).toBe(ProjectStatus.FABRICATION);
    expect((await Project.findById(projectId))?.estimatedCompletionDate).toBeInstanceOf(Date);
    expect((await ProjectItem.findById(itemId))?.status).toBe(ProjectStatus.FABRICATION);
    expect(await Payment.countDocuments({ projectId })).toBe(0);

    for (const [id, role] of [[customerId, Role.CUSTOMER], [engineerId, Role.ENGINEER], [leadId, Role.FABRICATION_STAFF]] as const) {
      const state = await getLatestFabricationStatus(projectId, id, [role], itemId);
      expect(state.paymentGate).toMatchObject({ allPaid: true, unpaidCount: 0, readyToStart: false });
    }
    const plan = await PaymentPlan.findOne({ projectId });
    await handleInitialFabricationPaymentVerified(plan!.projectId, plan!);
    expect(vi.mocked(notifyUsers).mock.calls.filter(([, , title]) => title === 'Fabrication Updates Unlocked')).toHaveLength(1);
    await expect(post(projectId, itemId!, FabricationStatus.MATERIAL_PREP, engineerId, Role.ENGINEER)).resolves.toBeDefined();
    await expect(post(projectId, itemId!, FabricationStatus.CUTTING, leadId, Role.FABRICATION_STAFF)).resolves.toBeDefined();
  });

  // A free fabricator would now be assigned automatically once the plan is settled (see
  // fabrication-auto-assign.integration.test.ts); on leave, the engineer's own assignment is tested.
  const keepLeadOffAutoAssign = () => User.updateOne({ _id: leadId }, { $set: { availabilityStatus: StaffAvailabilityStatus.ON_LEAVE } });

  it('starts every item on team assignment when a combined plan is already settled', async () => {
    const { projectId } = await approvedProject([1, 2]);
    await keepLeadOffAutoAssign();
    const result = await selectPaymentPlan(projectId, { paymentType: 'full' }, customerId);
    expect(result.paymentPlan?.totalAmount).toBe(0);
    expect(result.project.status).toBe(ProjectStatus.PAYMENT_PENDING);
    expect((await assign(projectId)).status).toBe(ProjectStatus.FABRICATION);
    expect(await ProjectItem.countDocuments({ projectId, status: ProjectStatus.FABRICATION })).toBe(2);
  });

  it('resumes an existing stuck paid project when the assigned lead posts a normal update', async () => {
    const { projectId, itemIds: [itemId] } = await approvedProject([1]);
    await assign(projectId);
    await selectPaymentPlan(projectId, { paymentType: 'full' }, customerId);
    await Project.updateOne({ _id: projectId }, { $set: { status: ProjectStatus.PAYMENT_PENDING } });
    await ProjectItem.updateOne({ _id: itemId }, { $set: { status: ProjectStatus.PAYMENT_PENDING } });

    const ready = await getLatestFabricationStatus(projectId, leadId, [Role.FABRICATION_STAFF], itemId);
    expect(ready.paymentGate).toMatchObject({ readyToStart: true, allPaid: true });
    expect((await Project.findById(projectId))?.status).toBe(ProjectStatus.PAYMENT_PENDING);
    await post(projectId, itemId!, FabricationStatus.MATERIAL_PREP, leadId, Role.FABRICATION_STAFF);
    expect((await Project.findById(projectId))?.status).toBe(ProjectStatus.FABRICATION);
    expect((await reconcileFabricationStart(projectId)).activated).toBe(false);
    expect((await ProjectItem.findById(itemId))?.status).toBe(ProjectStatus.FABRICATION);
  });

  it('activates once across simultaneous attempts and brings pending items forward on retry', async () => {
    const { projectId, itemIds: [itemId] } = await approvedProject([1]);
    await keepLeadOffAutoAssign();
    await selectPaymentPlan(projectId, { paymentType: 'full' }, customerId);
    await Project.updateOne({ _id: projectId }, { $set: { fabricationLeadId: leadId } });

    const results = await Promise.all([reconcileFabricationStart(projectId), reconcileFabricationStart(projectId)]);
    expect(results.filter((result) => result.activated)).toHaveLength(1);
    expect(vi.mocked(emitUserEvent).mock.calls.filter(([, event]) => event === 'fabrication:update').map(([id]) => id).sort())
      .toEqual([customerId, engineerId, leadId].sort());

    await ProjectItem.updateOne({ _id: itemId }, { $set: { status: ProjectStatus.PAYMENT_PENDING } });
    expect((await reconcileFabricationStart(projectId)).activated).toBe(false);
    expect((await ProjectItem.findById(itemId))?.status).toBe(ProjectStatus.FABRICATION);
  });

  it('keeps an unverified proof locked and starts only after the required first payments on all item plans', async () => {
    const { projectId, itemIds } = await approvedProject([60, 60], false);
    await assign(projectId);
    await ProjectItem.updateMany({ projectId }, { $set: { status: ProjectStatus.PAYMENT_PENDING } });
    for (const [index, itemId] of itemIds.entries()) {
      await PaymentPlan.create({
        projectId, projectItemId: itemId, totalAmount: 60, createdBy: cashierId,
        stages: [
          { stageId: `initial-${index}`, label: 'Initial payment', percentage: 50, amount: 30, remainingBalance: 30, activatedAt: new Date() },
          { stageId: `final-${index}`, label: 'Final payment', percentage: 50, amount: 30, remainingBalance: 30 },
        ],
      });
    }
    await recordCashPayment('initial-0', 30, cashierId);
    await PaymentPlan.updateOne({ projectId, 'stages.stageId': 'initial-1' }, { $set: { 'stages.$.status': PaymentStageStatus.PROOF_SUBMITTED } });
    const pending = await getLatestFabricationStatus(projectId, leadId, [Role.FABRICATION_STAFF], itemIds[0]);
    expect(pending.paymentGate.readyToStart).toBe(false);
    await expect(post(projectId, itemIds[0]!, FabricationStatus.MATERIAL_PREP, leadId, Role.FABRICATION_STAFF)).rejects.toMatchObject({ code: 'FABRICATION_NOT_IN_PHASE' });

    await PaymentPlan.updateOne({ projectId, 'stages.stageId': 'initial-1' }, { $set: { 'stages.$.status': PaymentStageStatus.PENDING } });
    await recordCashPayment('initial-1', 30, cashierId);
    expect((await Project.findById(projectId))?.status).toBe(ProjectStatus.FABRICATION);
    const started = await getLatestFabricationStatus(projectId, leadId, [Role.FABRICATION_STAFF], itemIds[0]);
    expect(started.paymentGate).toMatchObject({ allPaid: false, paidCount: 1, unpaidCount: 1 });
  });
});
