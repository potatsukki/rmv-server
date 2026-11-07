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
const DESIGN_FEE_LABEL = 'Design Fee (Layout & Blueprint)';

const roundMoney = (value: number) => Math.round(value * 100) / 100;

export function isDesignFeePaymentStage(stageId?: string | null) {
  return Boolean(stageId?.startsWith(DESIGN_FEE_STAGE_PREFIX));
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
    `A design fee of ${formatCurrency(designFeeAmount)} for "${project.title}" is due before the blueprint starts. It will be deducted from your total project cost once.`,
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

// ── Cashier records the design fee payment ──

export interface RecordDesignFeeInput {
  method: PaymentMethod.CASH | PaymentMethod.GCASH | PaymentMethod.BANK_TRANSFER;
  referenceNumber?: string;
}

export async function recordDesignFeePayment(
  projectId: string,
  input: RecordDesignFeeInput,
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
  const referenceNumber = input.referenceNumber?.trim() || undefined;
  if (input.method !== PaymentMethod.CASH && !referenceNumber) {
    throw AppError.badRequest('Enter the GCash or bank reference number', ErrorCode.VALIDATION_ERROR);
  }

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
      },
    },
    { new: true },
  );
  if (!project) throw AppError.conflict('The design fee for this project is already paid', ErrorCode.DUPLICATE_ENTRY);

  const amount = project.designFee!.amount;
  const receiptNumber = await generateNextReceiptNumber();
  const [customer, cashier] = await Promise.all([User.findById(project.customerId), User.findById(actorId)]);
  const receipt = await generateAndUploadReceipt({
    receiptNumber,
    customerName: customer ? `${customer.firstName} ${customer.lastName}` : 'Customer',
    customerEmail: customer?.email || '',
    customerAddress: '',
    projectTitle: project.title,
    stageName: DESIGN_FEE_LABEL,
    amountPaid: amount,
    paymentMethod: input.method,
    referenceNumber,
    creditApplied: 0,
    excessCredit: 0,
    verifiedByName: cashier ? `${cashier.firstName} ${cashier.lastName}` : 'Cashier',
    verifiedAt: now,
    totalProjectCost: amount,
    totalPaid: amount,
    totalOutstanding: 0,
  });

  const payment = await Payment.create({
    _id: paymentId,
    projectId: project._id,
    customerId: project.customerId,
    stageId: `${DESIGN_FEE_STAGE_PREFIX}${project._id}`,
    method: input.method,
    amountPaid: amount,
    amountRequired: amount,
    referenceNumber,
    status: PaymentStageStatus.VERIFIED,
    paymentStatus: 'paid',
    paymentDate: now,
    verifiedBy: actorId,
    verifiedAt: now,
    receiptNumber,
    receiptKey: receipt.key || undefined,
    evidenceTrail: [{
      version: 1,
      source: 'cashier_design_fee',
      status: PaymentStageStatus.VERIFIED,
      method: input.method,
      amountPaid: amount,
      referenceNumber,
      receiptKey: receipt.key || undefined,
      receiptNumber,
      note: 'Design fee recorded and receipt issued',
      actorId,
      capturedAt: now,
    }],
  });
  await Project.updateOne({ _id: project._id }, { $set: { 'designFee.receiptNumber': receiptNumber } });

  await AuditLog.create({
    action: AuditAction.PAYMENT_VERIFIED,
    actorId,
    targetType: 'payment',
    targetId: payment._id,
    details: { type: 'design_fee', projectId: project._id.toString(), amountPaid: amount, method: input.method, receiptNumber },
    ipAddress: ip,
    userAgent: ua,
  });

  await createAndSendNotification(
    project.customerId,
    NotificationCategory.PAYMENT,
    'Design Fee Received',
    `Your design fee of ${formatCurrency(amount)} for "${project.title}" is verified. Receipt: ${receiptNumber}. It will be deducted from your total project cost.`,
    `/projects/${project._id}/payments`,
  );
  if (customer?.email) {
    await sendPaymentVerifiedEmail(customer.email, {
      amount: formatCurrency(amount),
      stageLabel: DESIGN_FEE_LABEL,
      receiptNumber,
      projectId: project._id.toString(),
    }, receipt.buffer.length > 0 ? receipt.buffer : undefined);
  }
  await notifyRole(
    Role.ENGINEER,
    NotificationCategory.PROJECT,
    'Design Fee Paid',
    `The design fee for "${project.title}" is paid. The blueprint can start.`,
    `/projects/${project._id}`,
  );
  emitRoleEvent(Role.CASHIER, 'payments:queue-updated', {
    type: 'design_fee_recorded',
    paymentId: payment._id.toString(),
    projectId: project._id.toString(),
  });

  return { project, payment, receiptNumber };
}

export async function listPendingDesignFees() {
  return Project.find({ 'designFee.status': 'pending', deletedAt: null })
    .select('projectNumber title status designFee customerId createdAt')
    .populate('customerId', 'firstName lastName customerNumber email phone')
    .sort({ 'designFee.dueAt': 1 })
    .lean();
}

// ── Credits: the paid design fee (and, by policy, the ocular fee) is deducted from one plan once ──

type PlanLike = {
  _id?: unknown;
  totalAmount: number;
  grossAmount?: number;
  designFeeCredit?: number;
  ocularFeeCredit?: number;
  stages: Array<{ amount: number; remainingBalance: number; status: string; amountPaid: number }>;
};

/** Deducts a credit from a plan total and re-spreads it over the stages proportionally. */
export function deductCreditFromPlan(plan: PlanLike, credit: number) {
  const gross = roundMoney(plan.totalAmount);
  const applied = roundMoney(Math.min(Math.max(credit, 0), gross));
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
  first.grossAmount = roundMoney(first.totalAmount);

  const { ocularFeeOnProceed } = await getFeePolicyConfig();

  const designClaim = await Project.findOneAndUpdate(
    { _id: projectId, 'designFee.status': 'verified', 'designFee.creditedPlanId': { $exists: false } },
    { $set: { 'designFee.creditedPlanId': first._id } },
    { new: true },
  );
  if (designClaim?.designFee?.amount) {
    first.designFeeCredit = deductCreditFromPlan(first, designClaim.designFee.amount);
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
      if (ocularClaim) first.ocularFeeCredit = deductCreditFromPlan(first, ocular.ocularFee || 0);
    }
  }

  return plans;
}

// ── Fee summary: single source of truth for the customer / cashier breakdown ──

export async function getProjectFeeSummary(projectId: string) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  const [{ ocularFeeOnProceed, designFeeAmount }, plans, ocular] = await Promise.all([
    getFeePolicyConfig(),
    PaymentPlan.find({ projectId: project._id }).lean(),
    getProjectOcularAppointment(project),
  ]);

  // Project cost before credits: gross plan totals, or the latest approved quotation before a plan exists.
  let projectCost: number | null = null;
  if (plans.length) {
    projectCost = roundMoney(plans.reduce((sum, plan) => (
      sum + (plan.grossAmount ?? roundMoney(plan.totalAmount + (plan.designFeeCredit || 0) + (plan.ocularFeeCredit || 0)))
    ), 0));
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

  const planPaymentsReceived = roundMoney(plans.reduce((sum, plan) => (
    sum + plan.stages.reduce((stageSum, stage) => stageSum + (stage.amountPaid || 0), 0)
  ), 0));

  const totalCharges = roundMoney((projectCost || 0) + designAmount + (ocularApplies ? ocularAmount : 0));
  const totalCredits = roundMoney(designFeeCredit + ocularFeeCredit);
  const totalAmountDue = roundMoney(Math.max(0, totalCharges - totalCredits));
  const paymentsReceived = roundMoney(designPaid + ocularPaid + planPaymentsReceived);
  const remainingBalance = roundMoney(Math.max(0, totalAmountDue - paymentsReceived));

  return {
    projectId: project._id.toString(),
    projectCost,
    designFee: {
      amount: designStatus === 'not_required' ? 0 : roundMoney(project.designFee?.amount || designFeeAmount),
      status: designStatus,
      paidAt: project.designFee?.paidAt || null,
      method: project.designFee?.method || null,
      referenceNumber: project.designFee?.referenceNumber || null,
      receiptNumber: project.designFee?.receiptNumber || null,
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
    totalCharges,
    totalCredits,
    totalAmountDue,
    paymentsReceived,
    planPaymentsReceived,
    remainingBalance,
    hasPaymentPlan: plans.length > 0,
  };
}
