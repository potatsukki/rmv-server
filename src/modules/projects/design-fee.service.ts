import { Types } from 'mongoose';
import { Project, Appointment, User, AuditLog } from '../../models/index.js';
import { Payment, PaymentPlan } from '../../models/Payment.js';
import { Blueprint } from '../../models/Blueprint.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import {
  AuditAction, NotificationCategory, PaymentMethod, PaymentStageStatus, Role,
} from '../../utils/constants.js';
import { formatCurrency } from '../../utils/helpers.js';
import { createAndSendNotification, notifyRole, emitRoleEvent } from '../notifications/socket.service.js';
import { sendPaymentVerifiedEmail } from '../notifications/email.service.js';
import { getFeePolicyConfig, type OcularFeeOnProceed } from '../config/config.service.js';
import { generateAndUploadReceipt, generateNextReceiptNumber } from '../payments/payments.service.js';
import { OCULAR_TOLL_NOTE } from '../maps/maps.service.js';

export const DESIGN_FEE_STAGE_PREFIX = 'design-fee-';
export const REVISION_FEE_STAGE_PREFIX = 'revision-fee-';
const DESIGN_FEE_LABEL = 'Design Fee (Layout & Blueprint)';

const roundMoney = (value: number) => Math.round(value * 100) / 100;

export function isDesignFeePaymentStage(stageId?: string | null) {
  return Boolean(stageId?.startsWith(DESIGN_FEE_STAGE_PREFIX));
}

export function isRevisionFeePaymentStage(stageId?: string | null) {
  return Boolean(stageId?.startsWith(REVISION_FEE_STAGE_PREFIX));
}

export interface RecordFeeInput {
  method: PaymentMethod.CASH | PaymentMethod.GCASH | PaymentMethod.BANK_TRANSFER;
  referenceNumber?: string;
  /** Cashier confirms the customer acknowledged in person that the fee is non-refundable. */
  customerAcknowledgedInPerson?: boolean;
}

function cleanReference(input: RecordFeeInput) {
  const referenceNumber = input.referenceNumber?.trim() || undefined;
  if (input.method !== PaymentMethod.CASH && !referenceNumber) {
    throw AppError.badRequest('Enter the GCash or bank reference number', ErrorCode.VALIDATION_ERROR);
  }
  return referenceNumber;
}

/**
 * Shared cashier flow for a one-off fee (design fee, revision fee): receipt PDF, verified Payment,
 * audit log, customer notification + receipt email. The caller has already claimed the fee atomically.
 */
async function issueVerifiedFeePayment(args: {
  paymentId: Types.ObjectId;
  project: { _id: Types.ObjectId; customerId: Types.ObjectId; title: string };
  stageId: string;
  label: string;
  amount: number;
  input: RecordFeeInput;
  referenceNumber?: string;
  actorId: string;
  source: string;
  auditType: string;
  paidAt: Date;
  ip?: string;
  ua?: string;
}) {
  const { project, amount, label, input, referenceNumber, actorId, paidAt } = args;
  const receiptNumber = await generateNextReceiptNumber();
  const [customer, cashier] = await Promise.all([User.findById(project.customerId), User.findById(actorId)]);
  const receipt = await generateAndUploadReceipt({
    receiptNumber,
    customerName: customer ? `${customer.firstName} ${customer.lastName}` : 'Customer',
    customerEmail: customer?.email || '',
    customerAddress: '',
    projectTitle: project.title,
    stageName: label,
    amountPaid: amount,
    paymentMethod: input.method,
    referenceNumber,
    creditApplied: 0,
    excessCredit: 0,
    verifiedByName: cashier ? `${cashier.firstName} ${cashier.lastName}` : 'Cashier',
    verifiedAt: paidAt,
    totalProjectCost: amount,
    totalPaid: amount,
    totalOutstanding: 0,
  });

  const payment = await Payment.create({
    _id: args.paymentId,
    projectId: project._id,
    customerId: project.customerId,
    stageId: args.stageId,
    method: input.method,
    amountPaid: amount,
    amountRequired: amount,
    referenceNumber,
    status: PaymentStageStatus.VERIFIED,
    paymentStatus: 'paid',
    paymentDate: paidAt,
    verifiedBy: actorId,
    verifiedAt: paidAt,
    receiptNumber,
    receiptKey: receipt.key || undefined,
    evidenceTrail: [{
      version: 1,
      source: args.source,
      status: PaymentStageStatus.VERIFIED,
      method: input.method,
      amountPaid: amount,
      referenceNumber,
      receiptKey: receipt.key || undefined,
      receiptNumber,
      note: `${label} recorded and receipt issued`,
      actorId,
      capturedAt: paidAt,
    }],
  });

  await AuditLog.create({
    action: AuditAction.PAYMENT_VERIFIED,
    actorId,
    targetType: 'payment',
    targetId: payment._id,
    details: { type: args.auditType, projectId: project._id.toString(), amountPaid: amount, method: input.method, receiptNumber },
    ipAddress: args.ip,
    userAgent: args.ua,
  });

  if (customer?.email) {
    await sendPaymentVerifiedEmail(customer.email, {
      amount: formatCurrency(amount),
      stageLabel: label,
      receiptNumber,
      projectId: project._id.toString(),
    }, receipt.buffer.length > 0 ? receipt.buffer : undefined);
  }
  emitRoleEvent(Role.CASHIER, 'payments:queue-updated', {
    type: `${args.auditType}_recorded`,
    paymentId: payment._id.toString(),
    projectId: project._id.toString(),
  });

  return { payment, receiptNumber };
}

// ── Design fee becomes due once the customer proceeds (project submitted after the ocular) ──

export async function openDesignFee(projectId: string | Types.ObjectId) {
  const { designFeeAmount } = await getFeePolicyConfig();
  if (designFeeAmount <= 0) return null;

  // Atomic: only projects that never had a design fee get one, so it is opened exactly once.
  const project = await Project.findOneAndUpdate(
    {
      _id: projectId,
      $or: [{ 'designFee.status': { $exists: false } }, { 'designFee.status': 'not_required' }],
    },
    { $set: { designFee: { amount: designFeeAmount, status: 'pending', dueAt: new Date() } } },
    { new: true },
  );
  if (!project) return null;

  await createAndSendNotification(
    project.customerId,
    NotificationCategory.PAYMENT,
    'Design Fee Due',
    `A non-refundable design fee of ${formatCurrency(designFeeAmount)} for "${project.title}" is due before the blueprint starts. It will be deducted once from your total project cost.`,
    `/projects/${project._id}/payments`,
  );
  await notifyRole(
    Role.CASHIER,
    NotificationCategory.PAYMENT,
    'Design Fee Pending',
    `Project "${project.title}" has a ${formatCurrency(designFeeAmount)} design fee waiting for payment.`,
    `/projects/${project._id}/payments`,
  );
  return project;
}

/** A project that stops before the design fee is paid is never charged for it. */
export async function markDesignFeeNotCharged(projectId: string | Types.ObjectId) {
  return Project.updateOne(
    { _id: projectId, 'designFee.status': 'pending' },
    { $set: { 'designFee.status': 'not_charged' } },
  );
}

export function assertDesignFeeAllowsBlueprint(project: { designFee?: { status?: string } | null }) {
  if (project.designFee?.status === 'pending') {
    throw AppError.badRequest(
      'The design fee must be paid and verified by the cashier before the blueprint starts',
      ErrorCode.VALIDATION_ERROR,
    );
  }
}

const peso = (value: number) => `₱${value.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A quotation below the design fee would be fully covered by the credit, leaving nothing to pay. */
export function assertQuotationCoversDesignFee(
  quotationTotal: number,
  project: { designFee?: { status?: string; amount?: number } | null },
) {
  const fee = project.designFee;
  if (!fee || ['not_required', 'not_charged'].includes(String(fee.status)) || !(Number(fee.amount) > 0)) return;
  if (quotationTotal < Number(fee.amount)) {
    throw AppError.badRequest(
      `The quotation (${peso(quotationTotal)}) is lower than the ${peso(Number(fee.amount))} design fee. Update the costing to at least the design fee before sending it to the customer.`,
      ErrorCode.VALIDATION_ERROR,
    );
  }
}

/** Customer confirms in the app that the design fee is non-refundable. */
export async function acknowledgeDesignFee(projectId: string, customerId: string) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');
  if (project.customerId.toString() !== customerId) throw AppError.forbidden('Only the project customer can acknowledge this fee');
  if (project.designFee?.status !== 'pending') throw AppError.badRequest('This project has no design fee waiting for payment');
  if (project.designFee.acknowledgedAt) return project;

  const updated = await Project.findOneAndUpdate(
    { _id: projectId, 'designFee.status': 'pending', 'designFee.acknowledgedAt': { $exists: false } },
    { $set: { 'designFee.acknowledgedAt': new Date(), 'designFee.acknowledgedVia': 'customer' } },
    { new: true },
  );
  return updated || Project.findById(projectId);
}

export async function recordDesignFeePayment(
  projectId: string,
  input: RecordFeeInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const existing = await Project.findById(projectId);
  if (!existing) throw AppError.notFound('Project not found');
  if (existing.designFee?.status !== 'pending') {
    throw AppError.conflict(
      existing.designFee?.status === 'verified'
        ? 'The design fee for this project is already paid'
        : 'This project has no design fee waiting for payment',
      ErrorCode.DUPLICATE_ENTRY,
    );
  }
  const alreadyAcknowledged = Boolean(existing.designFee.acknowledgedAt);
  if (!alreadyAcknowledged && !input.customerAcknowledgedInPerson) {
    throw AppError.badRequest(
      'The customer must acknowledge that the design fee is non-refundable before it is recorded',
      ErrorCode.VALIDATION_ERROR,
    );
  }
  const referenceNumber = cleanReference(input);

  const now = new Date();
  const paymentId = new Types.ObjectId();
  // Claim the pending fee atomically so two cashiers cannot record it twice.
  const project = await Project.findOneAndUpdate(
    { _id: projectId, 'designFee.status': 'pending' },
    {
      $set: {
        'designFee.status': 'verified',
        'designFee.paidAt': now,
        'designFee.method': input.method,
        'designFee.referenceNumber': referenceNumber,
        'designFee.paymentId': paymentId,
        'designFee.recordedBy': actorId,
        ...(alreadyAcknowledged ? {} : { 'designFee.acknowledgedAt': now, 'designFee.acknowledgedVia': 'in_person' }),
      },
    },
    { new: true },
  );
  if (!project) throw AppError.conflict('The design fee for this project is already paid', ErrorCode.DUPLICATE_ENTRY);

  const amount = project.designFee!.amount;
  const { payment, receiptNumber } = await issueVerifiedFeePayment({
    paymentId,
    project,
    stageId: `${DESIGN_FEE_STAGE_PREFIX}${project._id}`,
    label: DESIGN_FEE_LABEL,
    amount,
    input,
    referenceNumber,
    actorId,
    source: 'cashier_design_fee',
    auditType: 'design_fee',
    paidAt: now,
    ip,
    ua,
  });
  await Project.updateOne({ _id: project._id }, { $set: { 'designFee.receiptNumber': receiptNumber } });

  await createAndSendNotification(
    project.customerId,
    NotificationCategory.PAYMENT,
    'Design Fee Received',
    `Your design fee of ${formatCurrency(amount)} for "${project.title}" is verified. Receipt: ${receiptNumber}. It will be deducted from your total project cost.`,
    `/projects/${project._id}/payments`,
  );
  await notifyRole(
    Role.ENGINEER,
    NotificationCategory.PROJECT,
    'Design Fee Paid',
    `The design fee for "${project.title}" is paid. The blueprint can start.`,
    `/projects/${project._id}`,
  );

  return { project, payment, receiptNumber };
}

// ── Revision fee: requests beyond the free revisions cost a fee, paid before the engineer revises ──

/**
 * Called when the customer requests a revision on `blueprintVersion`. Returns the fee to store on
 * that blueprint, or null when the revision is still free. Paid revisions need the customer's
 * non-refundable acknowledgment.
 */
export async function prepareRevisionFee(blueprintVersion: number, acknowledged: boolean | undefined) {
  const { revisionFeeAmount, freeRevisionLimit } = await getFeePolicyConfig();
  const revisionNumber = blueprintVersion;
  if (revisionNumber <= freeRevisionLimit || revisionFeeAmount <= 0) return null;
  if (!acknowledged) {
    throw AppError.badRequest(
      `This revision has a ${formatCurrency(revisionFeeAmount)} non-refundable fee. Please confirm to continue.`,
      ErrorCode.VALIDATION_ERROR,
    );
  }
  return { amount: revisionFeeAmount, status: 'pending' as const, revisionNumber, acknowledgedAt: new Date() };
}

export async function notifyRevisionFeeDue(project: { _id: unknown; customerId: unknown; title: string }, amount: number, revisionNumber: number) {
  await createAndSendNotification(
    project.customerId as Types.ObjectId,
    NotificationCategory.PAYMENT,
    'Revision Fee Due',
    `Revision ${revisionNumber} for "${project.title}" has a non-refundable fee of ${formatCurrency(amount)}. Pay it at the RMV cashier so the engineer can start the revision.`,
    `/projects/${project._id}/payments`,
  );
  await notifyRole(
    Role.CASHIER,
    NotificationCategory.PAYMENT,
    'Revision Fee Pending',
    `Project "${project.title}" has a ${formatCurrency(amount)} revision fee waiting for payment.`,
    `/projects/${project._id}/payments`,
  );
}

export function assertRevisionFeeAllowsWork(blueprint: { revisionFee?: { status?: string } | null }) {
  if (blueprint.revisionFee?.status === 'pending') {
    throw AppError.badRequest(
      'The revision fee must be paid and verified by the cashier before the revision starts',
      ErrorCode.VALIDATION_ERROR,
    );
  }
}

export async function recordRevisionFeePayment(
  blueprintId: string,
  input: RecordFeeInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const existing = await Blueprint.findById(blueprintId);
  if (!existing) throw AppError.notFound('Blueprint not found');
  if (existing.revisionFee?.status !== 'pending') {
    throw AppError.conflict(
      existing.revisionFee?.status === 'verified'
        ? 'The revision fee for this request is already paid'
        : 'This revision has no fee waiting for payment',
      ErrorCode.DUPLICATE_ENTRY,
    );
  }
  const referenceNumber = cleanReference(input);
  const project = await Project.findById(existing.projectId);
  if (!project) throw AppError.notFound('Project not found');

  const now = new Date();
  const paymentId = new Types.ObjectId();
  const blueprint = await Blueprint.findOneAndUpdate(
    { _id: blueprintId, 'revisionFee.status': 'pending' },
    {
      $set: {
        'revisionFee.status': 'verified',
        'revisionFee.paidAt': now,
        'revisionFee.method': input.method,
        'revisionFee.referenceNumber': referenceNumber,
        'revisionFee.paymentId': paymentId,
        'revisionFee.recordedBy': actorId,
      },
    },
    { new: true },
  );
  if (!blueprint) throw AppError.conflict('The revision fee for this request is already paid', ErrorCode.DUPLICATE_ENTRY);

  const amount = blueprint.revisionFee!.amount;
  const label = `Revision Fee (Revision ${blueprint.revisionFee!.revisionNumber})`;
  const { payment, receiptNumber } = await issueVerifiedFeePayment({
    paymentId,
    project,
    stageId: `${REVISION_FEE_STAGE_PREFIX}${blueprint._id}`,
    label,
    amount,
    input,
    referenceNumber,
    actorId,
    source: 'cashier_revision_fee',
    auditType: 'revision_fee',
    paidAt: now,
    ip,
    ua,
  });
  await Blueprint.updateOne({ _id: blueprint._id }, { $set: { 'revisionFee.receiptNumber': receiptNumber } });

  await createAndSendNotification(
    project.customerId,
    NotificationCategory.PAYMENT,
    'Revision Fee Received',
    `Your revision fee of ${formatCurrency(amount)} for "${project.title}" is verified. Receipt: ${receiptNumber}. The engineer can now start your revision.`,
    `/projects/${project._id}/payments`,
  );
  if (blueprint.uploadedBy) {
    await createAndSendNotification(
      blueprint.uploadedBy,
      NotificationCategory.PROJECT,
      'Revision Fee Paid',
      `The revision fee for "${project.title}" is paid. You can start the requested revision.`,
      `/projects/${project._id}`,
    );
  }

  return { blueprint, payment, receiptNumber };
}

export async function listPendingFees() {
  const [designFees, pendingRevisions] = await Promise.all([
    Project.find({ 'designFee.status': 'pending', deletedAt: null })
      .select('projectNumber title status designFee customerId createdAt')
      .populate('customerId', 'firstName lastName customerNumber email phone')
      .sort({ 'designFee.dueAt': 1 })
      .lean(),
    Blueprint.find({ 'revisionFee.status': 'pending' })
      .select('projectId projectItemId version revisionFee updatedAt')
      .sort({ updatedAt: 1 })
      .lean(),
  ]);

  const projectIds = [...new Set(pendingRevisions.map((blueprint) => blueprint.projectId.toString()))];
  const projects = projectIds.length
    ? await Project.find({ _id: { $in: projectIds }, deletedAt: null })
      .select('projectNumber title status customerId')
      .populate('customerId', 'firstName lastName customerNumber email phone')
      .lean()
    : [];
  const projectById = new Map(projects.map((project) => [project._id.toString(), project]));

  const revisionFees = pendingRevisions.flatMap((blueprint) => {
    const project = projectById.get(blueprint.projectId.toString());
    return project ? [{
      blueprintId: blueprint._id.toString(),
      version: blueprint.version,
      revisionFee: blueprint.revisionFee,
      project,
    }] : [];
  });

  return { designFees, revisionFees };
}

// ── Credits: the paid design fee (and, by policy, the ocular fee) is deducted from one plan once ──

type PlanLike = {
  _id?: unknown;
  totalAmount: number;
  baseAmount?: number;
  surchargePercent?: number;
  designFeeCredit?: number;
  ocularFeeCredit?: number;
  stages: Array<{ amount: number; remainingBalance: number; status: string; amountPaid: number }>;
};

/** Deducts an amount from a plan total and re-spreads it over the stages proportionally. */
export function deductCreditFromPlan(plan: PlanLike, deduction: number) {
  const gross = roundMoney(plan.totalAmount);
  const applied = roundMoney(Math.min(Math.max(deduction, 0), gross));
  if (applied <= 0) return 0;

  const net = roundMoney(gross - applied);
  let allocated = 0;
  plan.stages.forEach((stage, index) => {
    const isLast = index === plan.stages.length - 1;
    const amount = isLast
      ? roundMoney(net - allocated)
      : roundMoney(gross > 0 ? (net * stage.amount) / gross : 0);
    allocated = roundMoney(allocated + amount);
    stage.amount = amount;
    stage.remainingBalance = amount;
    if (amount <= 0) stage.status = PaymentStageStatus.VERIFIED;
  });
  plan.totalAmount = net;
  return applied;
}

/**
 * Credits are taken off the quotation total BEFORE the installment surcharge, so the plan total
 * becomes (base − credit) × (1 + surcharge). Returns the credit actually applied (pre-surcharge).
 */
function applyCreditBeforeSurcharge(plan: PlanLike, credit: number) {
  const multiplier = 1 + (plan.surchargePercent || 0) / 100;
  const deducted = deductCreditFromPlan(plan, roundMoney(credit * multiplier));
  return roundMoney(deducted / multiplier);
}

async function getProjectOcularAppointment(project: { ocularAppointmentId?: unknown; appointmentId?: unknown }) {
  if (project.ocularAppointmentId) return Appointment.findById(project.ocularAppointmentId);
  if (!project.appointmentId) return null;
  const source = await Appointment.findById(project.appointmentId);
  return source?.type === 'ocular' ? source : null;
}

function ocularFeeIsPaid(appointment: { ocularFeePaid?: boolean; ocularFeeStatus?: string } | null | undefined) {
  return Boolean(appointment?.ocularFeePaid || appointment?.ocularFeeStatus === 'verified');
}

/**
 * Applies the design fee credit (and the ocular fee credit when ocular_fee_on_proceed = 'credit')
 * to the first plan built for a project. Each credit is claimed atomically on the project so it
 * can never be applied to a second plan.
 */
export async function applyFeeCreditsToNewPlans<T extends PlanLike>(projectId: string | Types.ObjectId, plans: T[]) {
  const first = plans[0];
  if (!first) return plans;
  first._id ||= new Types.ObjectId();
  const multiplier = 1 + (first.surchargePercent || 0) / 100;
  first.baseAmount ??= roundMoney(first.totalAmount / multiplier);

  const { ocularFeeOnProceed } = await getFeePolicyConfig();

  const designClaim = await Project.findOneAndUpdate(
    { _id: projectId, 'designFee.status': 'verified', 'designFee.creditedPlanId': { $exists: false } },
    { $set: { 'designFee.creditedPlanId': first._id } },
    { new: true },
  );
  if (designClaim?.designFee?.amount) {
    first.designFeeCredit = applyCreditBeforeSurcharge(first, designClaim.designFee.amount);
  }

  if (ocularFeeOnProceed === 'credit') {
    const project = await Project.findById(projectId).select('ocularAppointmentId appointmentId ocularFeeCreditedPlanId');
    const ocular = project && !project.ocularFeeCreditedPlanId ? await getProjectOcularAppointment(project) : null;
    if (ocular && ocularFeeIsPaid(ocular) && (ocular.ocularFee || 0) > 0) {
      const ocularClaim = await Project.findOneAndUpdate(
        { _id: projectId, ocularFeeCreditedPlanId: { $exists: false } },
        { $set: { ocularFeeCreditedPlanId: first._id } },
        { new: true },
      );
      if (ocularClaim) first.ocularFeeCredit = applyCreditBeforeSurcharge(first, ocular.ocularFee || 0);
    }
  }

  return plans;
}

// ── Fee summary: single source of truth for the customer / cashier breakdown ──

export async function getProjectFeeSummary(projectId: string) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  const [{ ocularFeeOnProceed, designFeeAmount, revisionFeeAmount, freeRevisionLimit }, plans, ocular, revisedBlueprints] = await Promise.all([
    getFeePolicyConfig(),
    PaymentPlan.find({ projectId: project._id }).lean(),
    getProjectOcularAppointment(project),
    Blueprint.find({ projectId: project._id, 'revisionFee.status': { $in: ['pending', 'verified'] } })
      .select('version revisionFee')
      .lean(),
  ]);

  // Project cost = quotation total before credits and before the installment surcharge.
  let projectCost: number | null = null;
  let installmentSurcharge = 0;
  if (plans.length) {
    projectCost = 0;
    for (const plan of plans) {
      const credits = (plan.designFeeCredit || 0) + (plan.ocularFeeCredit || 0);
      // Plans created before this field existed: their total already is the full amount.
      const base = plan.baseAmount ?? roundMoney(plan.totalAmount + credits);
      projectCost = roundMoney(projectCost + base);
      installmentSurcharge = roundMoney(installmentSurcharge + Math.max(0, plan.totalAmount - (base - credits)));
    }
  } else if (project.totalCost && project.totalCost > 0) {
    projectCost = roundMoney(project.totalCost);
  } else {
    const approved = await Blueprint.findOne({ projectId: project._id, status: 'approved' }).sort({ version: -1 }).lean();
    const total = Number(approved?.quotation?.total);
    projectCost = Number.isFinite(total) && total > 0 ? roundMoney(total) : null;
  }

  const designStatus = project.designFee?.status || 'not_required';
  const designCharged = designStatus === 'pending' || designStatus === 'verified';
  const designAmount = designCharged ? roundMoney(project.designFee?.amount || 0) : 0;
  const designPaid = designStatus === 'verified' ? designAmount : 0;
  const planDesignCredit = roundMoney(plans.reduce((sum, plan) => sum + (plan.designFeeCredit || 0), 0));
  // Before a plan exists the paid fee is shown as the credit the customer will receive.
  const designFeeCredit = plans.length ? planDesignCredit : designPaid;

  const ocularAmount = roundMoney(ocular?.ocularFee || 0);
  const ocularApplies = ocularAmount > 0;
  const ocularPaid = ocularApplies && ocularFeeIsPaid(ocular) ? ocularAmount : 0;
  const planOcularCredit = roundMoney(plans.reduce((sum, plan) => sum + (plan.ocularFeeCredit || 0), 0));
  const ocularFeeCredit = ocularFeeOnProceed === 'credit'
    ? (plans.length ? planOcularCredit : ocularPaid)
    : 0;

  const revisionAmount = roundMoney(revisedBlueprints.reduce((sum, item) => sum + (item.revisionFee?.amount || 0), 0));
  const revisionPaid = roundMoney(revisedBlueprints
    .filter((item) => item.revisionFee?.status === 'verified')
    .reduce((sum, item) => sum + (item.revisionFee?.amount || 0), 0));

  const planPaymentsReceived = roundMoney(plans.reduce((sum, plan) => (
    sum + plan.stages.reduce((stageSum, stage) => stageSum + (stage.amountPaid || 0), 0)
  ), 0));

  const totalCharges = roundMoney(
    (projectCost || 0) + installmentSurcharge + designAmount + (ocularApplies ? ocularAmount : 0) + revisionAmount,
  );
  const totalCredits = roundMoney(designFeeCredit + ocularFeeCredit);
  const totalAmountDue = roundMoney(Math.max(0, totalCharges - totalCredits));
  const paymentsReceived = roundMoney(designPaid + ocularPaid + revisionPaid + planPaymentsReceived);
  const remainingBalance = roundMoney(Math.max(0, totalAmountDue - paymentsReceived));

  return {
    projectId: project._id.toString(),
    projectCost,
    installmentSurcharge,
    designFee: {
      amount: designStatus === 'not_required' ? 0 : roundMoney(project.designFee?.amount || designFeeAmount),
      status: designStatus,
      paidAt: project.designFee?.paidAt || null,
      method: project.designFee?.method || null,
      referenceNumber: project.designFee?.referenceNumber || null,
      receiptNumber: project.designFee?.receiptNumber || null,
      acknowledgedAt: project.designFee?.acknowledgedAt || null,
    },
    designFeeCredit,
    ocularFee: {
      applies: ocularApplies,
      amount: ocularAmount,
      status: !ocularApplies ? 'not_applicable' : ocularPaid ? 'verified' : (ocular?.ocularFeeStatus || 'pending'),
      treatment: ocularFeeOnProceed as OcularFeeOnProceed,
      isWithinNCR: Boolean(ocular?.ocularFeeBreakdown?.isWithinNCR),
      tollNote: OCULAR_TOLL_NOTE,
    },
    ocularFeeCredit,
    revisionFees: {
      count: revisedBlueprints.length,
      amount: revisionAmount,
      paid: revisionPaid,
      pending: roundMoney(revisionAmount - revisionPaid),
      items: revisedBlueprints.map((item) => ({
        blueprintId: item._id.toString(),
        revisionNumber: item.revisionFee?.revisionNumber || item.version,
        amount: item.revisionFee?.amount || 0,
        status: item.revisionFee?.status || 'pending',
        receiptNumber: item.revisionFee?.receiptNumber || null,
      })),
    },
    totalCharges,
    totalCredits,
    totalAmountDue,
    paymentsReceived,
    planPaymentsReceived,
    remainingBalance,
    hasPaymentPlan: plans.length > 0,
    revisionPolicy: { freeRevisionLimit, revisionFeeAmount },
  };
}
