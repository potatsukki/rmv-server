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

import {
  AuditLog, Blueprint, FabricationUpdate, Payment, PaymentPlan, Project, ProjectItem, SlotLock, User,
} from '../../models/index.js';
import {
  AuditAction, DeliveryType, FabricationStatus, PaymentMethod, PaymentStageStatus, ProjectStatus, Role, StaffAvailabilityStatus,
} from '../../utils/constants.js';
import { ErrorCode } from '../../utils/appError.js';
import { createFabricationUpdate } from '../fabrication/fabrication.service.js';
import { createAndSendNotification, notifyUsers } from '../notifications/socket.service.js';
import { recordCashPayment } from '../payments/payments.service.js';
import { autoAssignWaitingFabricationProjects } from './fabrication-auto-assign.js';
import { assignFabricationStaff, updateFabricationAssistants } from './projects.service.js';

const uri = process.env.RMV_MONGO_TEST_URI;

// Panel note 2026-11-27: "Project assigned to fabricator nearest the completion", automatically.
describe.runIf(Boolean(uri))('fabrication auto-assign on a real database', () => {
  let customerId: string;
  let salesStaffId: string;
  let engineerId: string;
  let cashierId: string;

  beforeAll(async () => {
    const target = new URL(uri!);
    if (target.hostname !== '127.0.0.1' || !/^\/rmv_(?:test|repro)/.test(target.pathname)) {
      throw new Error('Fabrication auto-assign tests require a throwaway local RMV MongoDB database');
    }
    await mongoose.connect(uri!);
    await mongoose.connection.dropDatabase();
    for (const model of [Project, ProjectItem, PaymentPlan, Payment, SlotLock]) await model.syncIndexes();
  }, 60_000);

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  async function addUser(name: string, role: Role, extra: Record<string, unknown> = {}) {
    const user = await User.create({ email: `${name}@example.test`, firstName: name, lastName: 'Test', roles: [role], isActive: true, ...extra });
    return String(user._id);
  }
  const fabricator = (name: string, extra: Record<string, unknown> = {}) => addUser(name, Role.FABRICATION_STAFF, extra);

  beforeEach(async () => {
    vi.clearAllMocks();
    await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
    customerId = await addUser('customer', Role.CUSTOMER);
    salesStaffId = await addUser('sales', Role.SALES_STAFF);
    engineerId = await addUser('engineer', Role.ENGINEER);
    cashierId = await addUser('cashier', Role.CASHIER);
  });

  async function project(projectNumber: string, status: ProjectStatus, extra: Record<string, unknown> = {}) {
    const created = await Project.create({
      title: `Railings ${projectNumber}`, projectNumber, serviceType: 'railings',
      customerId, salesStaffId, engineerIds: [engineerId],
      status, deliveryType: DeliveryType.SHOP_FABRICATED, ...extra,
    });
    await Blueprint.create({
      projectId: created._id, uploadedBy: engineerId, status: 'approved', quotationReviewStatus: 'sent_to_customer',
      version: 1, blueprintKey: `blueprints/${projectNumber}.pdf`, quotation: { total: 1000, workingDays: 5 },
    });
    return String(created._id);
  }

  /** In fabrication with `leadId` as lead, its latest stage already posted. */
  async function inFabrication(projectNumber: string, leadId: string, stage: FabricationStatus, assistants: string[] = []) {
    const id = await project(projectNumber, ProjectStatus.FABRICATION, { fabricationLeadId: leadId, fabricationAssistantIds: assistants });
    await FabricationUpdate.create({ projectId: id, status: stage, notes: `At ${stage}`, updatedBy: leadId });
    return id;
  }

  /** Payment pending with no lead; the downpayment is either verified at `paidAt` or still due. */
  async function waitingForTeam(projectNumber: string, paidAt?: Date) {
    const id = await project(projectNumber, ProjectStatus.PAYMENT_PENDING);
    const stageId = `${projectNumber}-down`;
    await PaymentPlan.create({
      projectId: id, totalAmount: 1000, createdBy: cashierId,
      stages: [
        paidAt
          ? { stageId, label: 'Stage 1', percentage: 50, amount: 500, status: PaymentStageStatus.VERIFIED, amountPaid: 500, remainingBalance: 0, activatedAt: paidAt }
          : { stageId, label: 'Stage 1', percentage: 50, amount: 500, remainingBalance: 500, activatedAt: new Date() },
        { stageId: `${projectNumber}-final`, label: 'Stage 2', percentage: 50, amount: 500, remainingBalance: 500 },
      ],
    });
    if (paidAt) {
      await Payment.create({
        projectId: id, stageId, method: PaymentMethod.CASH, amountPaid: 500,
        status: PaymentStageStatus.VERIFIED, verifiedBy: cashierId, verifiedAt: paidAt,
      });
    }
    return { id, stageId };
  }

  const leadOf = async (projectId: string) => {
    const lead = (await Project.findById(projectId))?.fabricationLeadId;
    return lead ? String(lead) : null;
  };

  it('keeps a paid project waiting while everyone is in the workshop or on leave, then gives it the lead whose project reaches Quality Check', async () => {
    const ana = await fabricator('ana');
    await fabricator('ben', { availabilityStatus: StaffAvailabilityStatus.ON_LEAVE });
    const p1 = await inFabrication('PRJ-2026-00001', ana, FabricationStatus.FINISHING);
    const { id: p2 } = await waitingForTeam('PRJ-2026-00002', new Date('2026-11-25T02:00:00Z'));

    await expect(autoAssignWaitingFabricationProjects('test')).resolves.toBe(0);
    expect(await leadOf(p2)).toBeNull();

    await createFabricationUpdate({ projectId: p1, status: FabricationStatus.QUALITY_CHECK, notes: 'Checked' }, ana, [Role.FABRICATION_STAFF]);

    const assigned = await Project.findById(p2);
    expect(String(assigned?.fabricationLeadId)).toBe(ana);
    expect(assigned?.fabricationAssistantIds).toHaveLength(0);
    expect(assigned?.status).toBe(ProjectStatus.FABRICATION);
    expect(assigned?.fabricationAutoAssignedAt).toBeInstanceOf(Date);
    expect(assigned?.estimatedCompletionDate).toBeInstanceOf(Date);
    const audit = await AuditLog.findOne({ action: AuditAction.FABRICATION_ASSIGNED, targetId: p2 }).lean();
    expect(audit?.actorId).toBeUndefined();
    expect(audit?.details).toMatchObject({ automatic: true, reason: 'nearest_completion', fromProjectNumber: 'PRJ-2026-00001', fromStage: 'quality_check' });
    expect(vi.mocked(createAndSendNotification).mock.calls.some(([userId, , title]) => String(userId) === ana && title === 'Auto-assigned as Lead')).toBe(true);
    expect(vi.mocked(notifyUsers).mock.calls.some(([, , title]) => title === 'Fabrication Team Assigned Automatically')).toBe(true);

    // Ana stays the lead of PRJ-1 and can start the new project right away.
    expect(await leadOf(p1)).toBe(ana);
    await expect(createFabricationUpdate({ projectId: p2, status: FabricationStatus.MATERIAL_PREP, notes: 'Started' }, ana, [Role.FABRICATION_STAFF]))
      .resolves.toBeDefined();
  });

  it('prefers a free fabricator, then the one nearest completion, and the earliest paid project goes first', async () => {
    const ana = await fabricator('ana');
    const cy = await fabricator('cy');
    await inFabrication('PRJ-2026-00001', ana, FabricationStatus.QUALITY_CHECK);
    const { id: late } = await waitingForTeam('PRJ-2026-00003', new Date('2026-11-26T02:00:00Z'));
    const { id: early } = await waitingForTeam('PRJ-2026-00002', new Date('2026-11-25T02:00:00Z'));
    const { id: unpaid } = await waitingForTeam('PRJ-2026-00004');

    await expect(autoAssignWaitingFabricationProjects('test')).resolves.toBe(2);

    expect(await leadOf(early)).toBe(cy);
    expect(await leadOf(late)).toBe(ana);
    expect(await leadOf(unpaid)).toBeNull();
    // Running again changes nothing: both are busy in the workshop now.
    await expect(autoAssignWaitingFabricationProjects('test')).resolves.toBe(0);
  });

  it('starts a paid project with the free fabricator as soon as the cashier records its downpayment', async () => {
    const ana = await fabricator('ana');
    const { id, stageId } = await waitingForTeam('PRJ-2026-00005');

    await recordCashPayment(stageId, 500, cashierId);

    const started = await Project.findById(id);
    expect(String(started?.fabricationLeadId)).toBe(ana);
    expect(started?.status).toBe(ProjectStatus.FABRICATION);
    const titles = vi.mocked(notifyUsers).mock.calls.map(([, , title]) => title);
    expect(titles).toContain('Fabrication Team Assigned Automatically');
    expect(titles).not.toContain('Waiting for a Fabricator');
  });

  it('tells the engineer the project waits in line when nobody can take it yet', async () => {
    const ana = await fabricator('ana');
    await inFabrication('PRJ-2026-00001', ana, FabricationStatus.WELDING);
    const { id, stageId } = await waitingForTeam('PRJ-2026-00006');

    await recordCashPayment(stageId, 500, cashierId);

    expect(await leadOf(id)).toBeNull();
    expect((await Project.findById(id))?.status).toBe(ProjectStatus.PAYMENT_PENDING);
    expect(vi.mocked(notifyUsers).mock.calls.some(([recipients, , title]) => title === 'Waiting for a Fabricator'
      && recipients.map(String).includes(engineerId))).toBe(true);
  });

  it('lets a lead add an assistant whose own project reached Quality Check, but not one still in the workshop', async () => {
    const lead = await fabricator('lead');
    const ana = await fabricator('ana');
    const ben = await fabricator('ben');
    await inFabrication('PRJ-2026-00001', ana, FabricationStatus.QUALITY_CHECK);
    await inFabrication('PRJ-2026-00002', ben, FabricationStatus.WELDING);
    const p3 = await inFabrication('PRJ-2026-00003', lead, FabricationStatus.MATERIAL_PREP);

    await updateFabricationAssistants(p3, { fabricationAssistantIds: [ana] }, lead);
    expect((await Project.findById(p3))?.fabricationAssistantIds.map(String)).toEqual([ana]);

    await expect(updateFabricationAssistants(p3, { fabricationAssistantIds: [ana, ben] }, lead))
      .rejects.toMatchObject({ code: ErrorCode.FABRICATOR_ALREADY_ASSIGNED });
    await expect(updateFabricationAssistants(p3, { fabricationAssistantIds: [] }, ana)).rejects.toMatchObject({ statusCode: 403 });
    expect((await Project.findById(p3))?.fabricationAssistantIds.map(String)).toEqual([ana]);

    // The engineer's own pick follows the same rule: Ben is still at Welding, and Ana now assists
    // PRJ-3, which is still in the workshop.
    const dee = await fabricator('dee');
    const { id: p4 } = await waitingForTeam('PRJ-2026-00004', new Date('2026-11-25T02:00:00Z'));
    await expect(assignFabricationStaff(p4, { fabricationLeadId: ben, fabricationAssistantIds: [] }, engineerId))
      .rejects.toThrow('still on PRJ-2026-00002 (Lead)');
    await expect(assignFabricationStaff(p4, { fabricationLeadId: ana, fabricationAssistantIds: [] }, engineerId))
      .rejects.toThrow('still on PRJ-2026-00003 (Assistant)');
    const manual = await assignFabricationStaff(p4, { fabricationLeadId: dee, fabricationAssistantIds: [] }, engineerId);
    expect(manual.fabricationAutoAssignedAt).toBeNull();
  });
});
