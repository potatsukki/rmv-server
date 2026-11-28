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

import { AuditLog, Blueprint, FabricationUpdate, Payment, PaymentPlan, Project, ProjectItem, SlotLock, User } from '../../models/index.js';
import {
  AuditAction, DeliveryType, FabricationStatus, PaymentMethod, PaymentStageStatus, ProjectStatus, Role, StaffAvailabilityStatus,
} from '../../utils/constants.js';
import { AppError } from '../../utils/appError.js';
import { createFabricationUpdate, deleteFabricationUpdate, getLatestFabricationStatus } from '../fabrication/fabrication.service.js';
import { createAndSendNotification } from '../notifications/socket.service.js';
import { recordCashPayment } from '../payments/payments.service.js';
import { autoAssignWaitingFabricationProjects, listProjectsWaitingForFabricator, pickAutoAssignLead } from './fabrication-auto-assign.js';
import { findFabricationTeamProblems } from './fabrication-team-audit.js';
import { assignFabricationStaff, listFabricationStaffWorkload, transitionProject, updateFabricationAssistants } from './projects.service.js';

const uri = process.env.RMV_MONGO_TEST_URI;

// QA 2026-11-28 (user): "dapat make sure na walang overlap" + "walang double assign". A fabricator
// leads / assists at most ONE project still in the workshop (an old one at Quality Check or later
// may stay on top), a project is never assigned twice, and nobody is twice on one team, whatever
// runs at the same moment.
describe.runIf(Boolean(uri))('fabrication teams: no overlap, no double assign (real database)', () => {
  let customerId: string;
  let salesStaffId: string;
  let engineerId: string;
  let adminId: string;
  let cashierId: string;

  beforeAll(async () => {
    const target = new URL(uri!);
    if (target.hostname !== '127.0.0.1' || !/^\/rmv_(?:test|repro)/.test(target.pathname)) {
      throw new Error('Fabrication overlap tests require a throwaway local RMV MongoDB database');
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

  async function resetData() {
    vi.clearAllMocks();
    await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
    customerId = await addUser('customer', Role.CUSTOMER);
    salesStaffId = await addUser('sales', Role.SALES_STAFF);
    engineerId = await addUser('engineer', Role.ENGINEER);
    adminId = await addUser('admin', Role.ADMIN);
    cashierId = await addUser('cashier', Role.CASHIER);
  }
  beforeEach(resetData);

  /**
   * A shop project whose every stage can be posted: fully paid (one verified Full Payment stage
   * unless `unpaid`), delivery date set, receipt already confirmed.
   */
  async function project(projectNumber: string, status: ProjectStatus, extra: Record<string, unknown> = {}, unpaid = false) {
    const created = await Project.create({
      title: `Railings ${projectNumber}`, projectNumber, serviceType: 'railings',
      customerId, salesStaffId, engineerIds: [engineerId],
      status, deliveryType: DeliveryType.SHOP_FABRICATED,
      deliverySchedule: { date: '2026-12-15' },
      installationConfirmedAt: new Date('2026-11-20T02:00:00Z'),
      ...extra,
    });
    await Blueprint.create({
      projectId: created._id, uploadedBy: engineerId, status: 'approved', quotationReviewStatus: 'sent_to_customer',
      version: 1, blueprintKey: `blueprints/${projectNumber}.pdf`, quotation: { total: 1000, workingDays: 5 },
    });
    const stageId = `${projectNumber}-full`;
    await PaymentPlan.create({
      projectId: created._id, totalAmount: 1000, isPayInFull: true, createdBy: cashierId,
      stages: [unpaid
        ? { stageId, label: 'Full Payment', percentage: 100, amount: 1000, remainingBalance: 1000, activatedAt: new Date() }
        : { stageId, label: 'Full Payment', percentage: 100, amount: 1000, status: PaymentStageStatus.VERIFIED, amountPaid: 1000, remainingBalance: 0, activatedAt: new Date() }],
    });
    if (!unpaid) {
      await Payment.create({
        projectId: created._id, stageId, method: PaymentMethod.CASH, amountPaid: 1000,
        status: PaymentStageStatus.VERIFIED, verifiedBy: cashierId, verifiedAt: new Date('2026-11-20T02:00:00Z'),
      });
    }
    return { id: String(created._id), stageId };
  }

  async function inFabrication(projectNumber: string, leadId: string, stage: FabricationStatus, assistants: string[] = []) {
    const { id } = await project(projectNumber, ProjectStatus.FABRICATION, { fabricationLeadId: leadId, fabricationAssistantIds: assistants });
    await FabricationUpdate.create({ projectId: id, status: stage, notes: `At ${stage}`, updatedBy: leadId });
    return id;
  }

  const waiting = (projectNumber: string, paid: boolean) => project(projectNumber, ProjectStatus.PAYMENT_PENDING, {}, !paid);

  const leadOf = async (projectId: string) => {
    const lead = (await Project.findById(projectId))?.fabricationLeadId;
    return lead ? String(lead) : null;
  };

  /** The rules, read from the database (the same check the VPS diagnose script prints). */
  async function expectNoOverlap(label: string) {
    const problems = await findFabricationTeamProblems();
    expect({ label, ...problems }).toEqual({ label, overlaps: [], doubleOnTeam: [], repeatedAutoAssign: [] });
    // One "Auto-assigned as Lead" notice per project at most: the system never assigns twice.
    const autoNotices = vi.mocked(createAndSendNotification).mock.calls
      .filter(([, , title]) => title === 'Auto-assigned as Lead')
      .map(([, , , , link]) => link);
    expect({ label, repeatedNotices: autoNotices.filter((link, index) => autoNotices.indexOf(link) !== index) })
      .toEqual({ label, repeatedNotices: [] });
  }

  /** Every refusal under concurrency must be a business rule (AppError), never a crash. */
  function expectOnlyRuleRefusals(results: PromiseSettledResult<unknown>[]) {
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(AppError);
        expect([400, 403, 404, 409]).toContain((result.reason as AppError).statusCode);
      }
    }
  }

  const latestUpdateId = async (projectId: string) => String((await FabricationUpdate.findOne({ projectId }).sort({ createdAt: -1 }))?._id);

  it('gives one free fabricator to only one of two projects paid at the same moment', async () => {
    const ana = await fabricator('ana');
    const p1 = await waiting('PRJ-2026-00001', false);
    const p2 = await waiting('PRJ-2026-00002', false);

    const results = await Promise.allSettled([
      recordCashPayment(p1.stageId, 1000, cashierId),
      recordCashPayment(p2.stageId, 1000, cashierId),
    ]);
    expectOnlyRuleRefusals(results);
    await autoAssignWaitingFabricationProjects('sweep');

    const leads = [await leadOf(p1.id), await leadOf(p2.id)];
    expect(leads.filter((lead) => lead === ana)).toHaveLength(1);
    expect(leads.filter((lead) => lead === null)).toHaveLength(1);
    await expectNoOverlap('two payments, one fabricator');
  });

  it('assigns once when a payment, a Quality Check update and the minute sweep run together', async () => {
    const ana = await fabricator('ana');
    const p1 = await inFabrication('PRJ-2026-00001', ana, FabricationStatus.FINISHING);
    const p2 = await waiting('PRJ-2026-00002', false);
    const p3 = await waiting('PRJ-2026-00003', true);

    const results = await Promise.allSettled([
      recordCashPayment(p2.stageId, 1000, cashierId),
      createFabricationUpdate({ projectId: p1, status: FabricationStatus.QUALITY_CHECK, notes: 'Checked' }, ana, [Role.FABRICATION_STAFF]),
      autoAssignWaitingFabricationProjects('sweep'),
      autoAssignWaitingFabricationProjects('sweep'),
    ]);
    expectOnlyRuleRefusals(results);
    await autoAssignWaitingFabricationProjects('sweep');

    // Ana took exactly one of the two waiting projects; the other keeps waiting.
    const leads = [await leadOf(p2.id), await leadOf(p3.id)];
    expect(leads.filter((lead) => lead === ana)).toHaveLength(1);
    await expectNoOverlap('payment + QC + sweep');
  });

  it('keeps only one of two team saves made at the same moment on a waiting project', async () => {
    const ana = await fabricator('ana');
    const ben = await fabricator('ben');
    const p1 = await waiting('PRJ-2026-00001', true);

    const results = await Promise.allSettled([
      assignFabricationStaff(p1.id, { fabricationLeadId: ana, fabricationAssistantIds: [], expectedLeadId: null }, engineerId),
      assignFabricationStaff(p1.id, { fabricationLeadId: ben, fabricationAssistantIds: [], expectedLeadId: null }, adminId),
    ]);
    expectOnlyRuleRefusals(results);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect([ana, ben]).toContain(await leadOf(p1.id));
    await expectNoOverlap('two team saves');
  });

  it("never loses the engineer's or the lead's change when both edit the team at the same moment", async () => {
    const lead = await fabricator('lead');
    const ana = await fabricator('ana');
    const ben = await fabricator('ben');
    const p1 = await inFabrication('PRJ-2026-00001', lead, FabricationStatus.CUTTING);

    const results = await Promise.allSettled([
      updateFabricationAssistants(p1, { fabricationAssistantIds: [ana], expectedAssistantIds: [] }, lead),
      assignFabricationStaff(p1, { fabricationLeadId: lead, fabricationAssistantIds: [ben], expectedLeadId: lead, expectedAssistantIds: [] }, engineerId),
    ]);
    expectOnlyRuleRefusals(results);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const assistants = (await Project.findById(p1))?.fabricationAssistantIds.map(String);
    expect([[ana], [ben]]).toContainEqual(assistants);
    await expectNoOverlap('lead + engineer');
  });

  it('puts one free assistant on only one of two projects whose leads add him at the same moment', async () => {
    const lead1 = await fabricator('lead1');
    const lead2 = await fabricator('lead2');
    const cy = await fabricator('cy');
    const p1 = await inFabrication('PRJ-2026-00001', lead1, FabricationStatus.CUTTING);
    const p2 = await inFabrication('PRJ-2026-00002', lead2, FabricationStatus.WELDING);

    const results = await Promise.allSettled([
      updateFabricationAssistants(p1, { fabricationAssistantIds: [cy], expectedAssistantIds: [] }, lead1),
      updateFabricationAssistants(p2, { fabricationAssistantIds: [cy], expectedAssistantIds: [] }, lead2),
    ]);
    expectOnlyRuleRefusals(results);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expectNoOverlap('two leads, one assistant');
  });

  it('never lets a Quality Check delete and an auto-assign of its lead both win (8 runs)', async () => {
    for (let run = 0; run < 8; run += 1) {
      if (run) await resetData();
      const ana = await fabricator('ana');
      const p1 = await inFabrication('PRJ-2026-00001', ana, FabricationStatus.QUALITY_CHECK);
      const p2 = await waiting('PRJ-2026-00002', true);
      const qc = await latestUpdateId(p1);

      const results = await Promise.allSettled([
        deleteFabricationUpdate(qc, adminId, [Role.ADMIN]),
        autoAssignWaitingFabricationProjects('sweep'),
      ]);
      expectOnlyRuleRefusals(results);
      const qcDeleted = !(await FabricationUpdate.exists({ _id: qc }));
      const p2TookAna = (await leadOf(p2.id)) === ana;
      // Either the delete went first (Ana stays on PRJ-1) or the assignment did (the delete is refused).
      expect({ run, qcDeleted, p2TookAna, oneWinner: qcDeleted !== p2TookAna }).toMatchObject({ run, oneWinner: true });
      await expectNoOverlap(`delete + auto, run ${run}`);
    }
  });

  it('frees the team of a cancelled, completed or re-teamed project for the next paid project, once', async () => {
    const ana = await fabricator('ana');
    const ben = await fabricator('ben');
    const cy = await fabricator('cy', { availabilityStatus: StaffAvailabilityStatus.ON_LEAVE });
    const p1 = await inFabrication('PRJ-2026-00001', ana, FabricationStatus.WELDING);
    const p2 = await inFabrication('PRJ-2026-00002', ben, FabricationStatus.READY_FOR_DELIVERY);
    const p3 = await waiting('PRJ-2026-00003', true);
    const p4 = await waiting('PRJ-2026-00004', true);
    const p5 = await waiting('PRJ-2026-00005', true);

    // Ben's project is at Ready for Delivery (past Quality Check): he takes the earliest waiting one.
    await expect(autoAssignWaitingFabricationProjects('sweep')).resolves.toBe(1);
    expect(await leadOf(p3.id)).toBe(ben);
    await expectNoOverlap('nearest completion');

    // Cancelled: Ana is free again and the next waiting project gets her on the next sweep.
    await transitionProject(p1, { status: ProjectStatus.CANCELLED, cancelReason: 'Customer backed out' }, adminId);
    await autoAssignWaitingFabricationProjects('sweep');
    expect(await leadOf(p4.id)).toBe(ana);

    // Done: Ben's old project completes, but he is busy with PRJ-3 and Cy is on leave: PRJ-5 waits.
    await createFabricationUpdate({ projectId: p2, status: FabricationStatus.DONE, notes: 'Delivered' }, ben, [Role.FABRICATION_STAFF]);
    expect((await Project.findById(p2))?.status).toBe(ProjectStatus.COMPLETED);
    expect(await leadOf(p5.id)).toBeNull();

    // Re-teamed: the engineer gives PRJ-3 to Cy (on leave is allowed by hand); Ben takes PRJ-5.
    await assignFabricationStaff(p3.id, { fabricationLeadId: cy, fabricationAssistantIds: [], expectedLeadId: ben, expectedAssistantIds: [] }, engineerId);
    await autoAssignWaitingFabricationProjects('sweep');
    expect(await leadOf(p5.id)).toBe(ben);

    // Nothing runs twice.
    await expect(autoAssignWaitingFabricationProjects('sweep')).resolves.toBe(0);
    await expectNoOverlap('cancel / done / re-team');
  });

  // ── Seeded random stress: many operations at the same moment, rules checked after each round ──

  /** Small deterministic PRNG (mulberry32), so a failing seed can be replayed. */
  const prng = (seed: number) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it.each([11, 2026, 1128, 7, 42])('keeps every rule through 30 rounds of concurrent operations (seed %i)', async (seed) => {
    await resetData();
    const random = prng(seed);
    const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!;
    const staff = [
      await fabricator('ana'), await fabricator('ben'), await fabricator('cy'), await fabricator('dee'),
      await fabricator('eve', { availabilityStatus: StaffAvailabilityStatus.ON_LEAVE }),
    ];
    await inFabrication('PRJ-2026-00001', staff[0]!, FabricationStatus.CUTTING);
    await inFabrication('PRJ-2026-00002', staff[1]!, FabricationStatus.FINISHING);
    await inFabrication('PRJ-2026-00003', staff[2]!, FabricationStatus.QUALITY_CHECK);
    const unpaid = [];
    for (let index = 4; index <= 9; index += 1) unpaid.push(await waiting(`PRJ-2026-0000${index}`, index > 7));

    const outcomes: Record<string, number> = {};
    const count = (key: string) => { outcomes[key] = (outcomes[key] ?? 0) + 1; };
    const activeProjects = () => Project.find({ status: { $in: [ProjectStatus.PAYMENT_PENDING, ProjectStatus.FABRICATION] } }).lean();
    // A project gets its FIRST lead once: by the system or by a person, never both. Here only the
    // admin's "assign a waiting project" op saves a team as admin, so automatic + admin
    // assignments of one project must be at most one (a no-op save writes no audit).
    const assignedTwice = async () => (await AuditLog.aggregate<{ _id: unknown }>([
      { $match: { action: AuditAction.FABRICATION_ASSIGNED, $or: [{ 'details.automatic': true }, { actorId: new mongoose.Types.ObjectId(adminId) }] } },
      { $group: { _id: '$targetId', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ])).map((row) => String(row._id));

    const operations: Record<string, () => Promise<unknown>> = {
      pay: async () => {
        const plans = await PaymentPlan.find({ 'stages.status': PaymentStageStatus.PENDING }).lean();
        if (!plans.length) return null;
        const stage = pick(plans).stages[0]!;
        return recordCashPayment(stage.stageId, stage.amount, cashierId);
      },
      postStage: async () => {
        const started = (await activeProjects()).filter((item) => item.status === ProjectStatus.FABRICATION);
        if (!started.length) return null;
        const target = pick(started);
        const status = await getLatestFabricationStatus(String(target._id), adminId, [Role.ADMIN]);
        const next = status.allowedTransitions[0];
        return next ? createFabricationUpdate({ projectId: String(target._id), status: next, notes: 'Next stage' }, adminId, [Role.ADMIN]) : null;
      },
      deleteLatest: async () => {
        const started = (await activeProjects()).filter((item) => item.status === ProjectStatus.FABRICATION);
        if (!started.length) return null;
        // Half of the time aim at a project past Quality Check: the delete that could send it back.
        const atQc = [];
        for (const item of started) {
          const latest = await FabricationUpdate.findOne({ projectId: item._id }).sort({ createdAt: -1 }).lean();
          if (latest && [FabricationStatus.QUALITY_CHECK, FabricationStatus.READY_FOR_DELIVERY].includes(latest.status)) atQc.push(item);
        }
        const target = atQc.length && random() < 0.5 ? pick(atQc) : pick(started);
        const latest = await FabricationUpdate.findOne({ projectId: target._id }).sort({ createdAt: -1 });
        return latest ? deleteFabricationUpdate(String(latest._id), adminId, [Role.ADMIN]) : null;
      },
      assignWaiting: async () => {
        // A person assigns a waiting project by hand while the system may be assigning it too.
        const open = (await activeProjects()).filter((item) => !item.fabricationLeadId);
        if (!open.length) return null;
        return assignFabricationStaff(String(pick(open)._id), {
          fabricationLeadId: pick(staff), fabricationAssistantIds: [], expectedLeadId: null, expectedAssistantIds: [],
        }, adminId);
      },
      changeTeam: async () => {
        const teamed = (await activeProjects()).filter((item) => item.fabricationLeadId);
        if (!teamed.length) return null;
        const target = pick(teamed);
        const lead = pick(staff);
        const assistants = [...new Set([pick(staff), pick(staff)])].filter((id) => id !== lead).slice(0, Math.floor(random() * 3));
        return assignFabricationStaff(String(target._id), {
          fabricationLeadId: lead,
          fabricationAssistantIds: assistants,
          expectedLeadId: String(target.fabricationLeadId),
          expectedAssistantIds: (target.fabricationAssistantIds || []).map(String),
        }, engineerId);
      },
      editAssistants: async () => {
        const teamed = (await activeProjects()).filter((item) => item.fabricationLeadId);
        if (!teamed.length) return null;
        const target = pick(teamed);
        const lead = String(target.fabricationLeadId);
        const assistants = [...new Set([pick(staff), pick(staff)])].filter((id) => id !== lead).slice(0, Math.floor(random() * 3));
        return updateFabricationAssistants(String(target._id), {
          fabricationAssistantIds: assistants,
          expectedAssistantIds: (target.fabricationAssistantIds || []).map(String),
        }, lead);
      },
      cancel: async () => {
        if (random() > 0.25) return null; // rare
        const active = await activeProjects();
        return active.length ? transitionProject(String(pick(active)._id), { status: ProjectStatus.CANCELLED, cancelReason: 'Stress test' }, adminId) : null;
      },
      sweep: () => autoAssignWaitingFabricationProjects('stress'),
    };
    const names = Object.keys(operations);

    for (let round = 0; round < 30; round += 1) {
      // At most one cash payment per round: two cashiers paying one stage at once is a payments
      // question, not a team one.
      const batch = Array.from({ length: 2 + Math.floor(random() * 3) }, () => pick(names))
        .filter((name, index, all) => name !== 'pay' || all.indexOf('pay') === index);
      const results = await Promise.allSettled(batch.map((name) => operations[name]!()));
      results.forEach((result, index) => count(`${batch[index]}:${result.status === 'fulfilled'
        ? (result.value === null ? 'skip' : 'ok')
        : result.reason instanceof AppError ? (result.reason.code ?? result.reason.statusCode) : 'CRASH'}`));
      expectOnlyRuleRefusals(results);
      await expectNoOverlap(`seed ${seed}, round ${round}: ${batch.join(' + ')}`);
      expect({ round, assignedTwice: await assignedTwice() }).toEqual({ round, assignedTwice: [] });
    }

    // No project is left waiting while someone could take it.
    await autoAssignWaitingFabricationProjects('final sweep');
    const stillWaiting = await listProjectsWaitingForFabricator();
    const canTake = pickAutoAssignLead(await listFabricationStaffWorkload());
    expect({ waiting: stillWaiting.length > 0, canTake: Boolean(canTake) }).not.toEqual({ waiting: true, canTake: true });
    await expectNoOverlap(`seed ${seed}, end`);
    console.info(`[overlap stress] seed ${seed}:`, JSON.stringify(outcomes));
  }, 120_000);
});
