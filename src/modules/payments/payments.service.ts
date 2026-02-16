import { v4 as uuidv4 } from 'uuid';
import {
  PaymentPlan, Payment, Project, User, AuditLog, ReceiptCounter,
} from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import {
  PaymentStageStatus, ProjectStatus, AuditAction, NotificationCategory, Role,
} from '../../utils/constants.js';
import { paymentStateMachine, projectStateMachine } from '../../utils/stateMachine.js';
import { createAndSendNotification } from '../notifications/socket.service.js';
import { sendPaymentVerifiedEmail, sendPaymentDeclinedEmail } from '../notifications/email.service.js';
import { formatCurrency, generateReceiptNumber } from '../../utils/helpers.js';
import type {
  CreatePaymentPlanInput,
  UpdatePaymentPlanInput,
  SubmitPaymentProofInput,
  DeclinePaymentInput,
} from './payments.validation.js';
import type { Types } from 'mongoose';

// ── Cashier: Create Payment Plan ──

export async function createPaymentPlan(
  input: CreatePaymentPlanInput,
  createdBy: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(input.projectId);
  if (!project) throw AppError.notFound('Project not found');

  // Project must be approved
  if (project.status !== ProjectStatus.APPROVED) {
    throw AppError.badRequest('Payment plan can only be created for approved projects');
  }

  // Check no existing plan
  const existing = await PaymentPlan.findOne({ projectId: input.projectId });
  if (existing) throw AppError.conflict('Payment plan already exists for this project', ErrorCode.DUPLICATE_ENTRY);

  const isPayInFull = input.stages.length === 1;
  const stages = input.stages.map((s, idx) => ({
    stageId: uuidv4(),
    label: isPayInFull ? 'Full Payment' : `Stage ${idx + 1}`,
    percentage: s.percentage,
    amount: Math.round((input.totalAmount * s.percentage / 100) * 100) / 100,
    status: PaymentStageStatus.PENDING,
    qrCodeKey: s.qrCodeKey,
    amountPaid: 0,
    creditApplied: 0,
    remainingBalance: Math.round((input.totalAmount * s.percentage / 100) * 100) / 100,
  }));

  const plan = await PaymentPlan.create({
    projectId: input.projectId,
    totalAmount: input.totalAmount,
    isPayInFull,
    stages,
    createdBy,
  });

  // Transition project to payment_pending
  projectStateMachine.assertTransition(project.status, ProjectStatus.PAYMENT_PENDING);
  project.status = ProjectStatus.PAYMENT_PENDING;
  await project.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_PLAN_CREATED,
    actorId: createdBy,
    targetType: 'payment_plan',
    targetId: plan._id,
    details: { projectId: input.projectId, totalAmount: input.totalAmount, stageCount: stages.length },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    project.customerId,
    NotificationCategory.PAYMENT,
    'Payment Plan Created',
    `A payment plan of ${formatCurrency(input.totalAmount)} has been set up for "${project.title}".`,
    `/projects/${project._id}/payments`,
  );

  return plan;
}

// ── Cashier: Update Payment Plan (before any verified payment) ──

export async function updatePaymentPlan(
  planId: string,
  input: UpdatePaymentPlanInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const plan = await PaymentPlan.findById(planId);
  if (!plan) throw AppError.notFound('Payment plan not found');

  if (plan.isImmutable) {
    throw AppError.badRequest('Payment plan cannot be modified after a payment has been verified');
  }

  if (input.totalAmount !== undefined) {
    plan.totalAmount = input.totalAmount;
  }

  if (input.stages) {
    const isPayInFull = input.stages.length === 1;
    plan.isPayInFull = isPayInFull;
    plan.stages = input.stages.map((s, idx) => ({
      stageId: uuidv4(),
      label: isPayInFull ? 'Full Payment' : `Stage ${idx + 1}`,
      percentage: s.percentage,
      amount: Math.round((plan.totalAmount * s.percentage / 100) * 100) / 100,
      status: PaymentStageStatus.PENDING,
      qrCodeKey: s.qrCodeKey,
      amountPaid: 0,
      creditApplied: 0,
      remainingBalance: Math.round((plan.totalAmount * s.percentage / 100) * 100) / 100,
    }));
  }

  await plan.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_PLAN_UPDATED,
    actorId,
    targetType: 'payment_plan',
    targetId: plan._id,
    details: { totalAmount: plan.totalAmount, stageCount: plan.stages.length },
    ipAddress: ip,
    userAgent: ua,
  });

  return plan;
}

// ── Customer: Submit Payment Proof ──

export async function submitPaymentProof(
  input: SubmitPaymentProofInput,
  customerId: string,
  idempotencyKey?: string,
  ip?: string,
  ua?: string,
) {
  // Find the plan containing this stage
  const plan = await PaymentPlan.findOne({ 'stages.stageId': input.stageId });
  if (!plan) throw AppError.notFound('Payment stage not found');

  const project = await Project.findById(plan.projectId);
  if (!project) throw AppError.notFound('Project not found');
  if (project.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only submit payments for your own projects');
  }

  const stage = plan.stages.find(s => s.stageId === input.stageId);
  if (!stage) throw AppError.notFound('Stage not found');

  // Stage must be pending or declined (re-submit allowed)
  if (![PaymentStageStatus.PENDING, PaymentStageStatus.DECLINED].includes(stage.status)) {
    throw AppError.badRequest('This stage is not accepting payments');
  }

  const payment = await Payment.create({
    projectId: plan.projectId,
    stageId: input.stageId,
    method: input.method,
    amountPaid: input.amountPaid,
    referenceNumber: input.referenceNumber,
    proofKey: input.proofKey,
    status: PaymentStageStatus.PROOF_SUBMITTED,
    idempotencyKey,
    creditFromPrevious: 0,
    excessCredit: 0,
  });

  // Update stage status
  stage.status = PaymentStageStatus.PROOF_SUBMITTED;
  await plan.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_PROOF_SUBMITTED,
    actorId: customerId,
    targetType: 'payment',
    targetId: payment._id,
    details: { stageId: input.stageId, method: input.method, amountPaid: input.amountPaid },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify cashier
  await createAndSendNotification(
    plan.createdBy,
    NotificationCategory.PAYMENT,
    'Payment Proof Submitted',
    `New payment proof submitted for "${project.title}" - ${stage.label} (${formatCurrency(input.amountPaid)})`,
    `/projects/${project._id}/payments`,
  );

  return payment;
}

// ── Cashier: Verify Payment ──

export async function verifyPayment(
  paymentId: string,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw AppError.notFound('Payment not found');

  paymentStateMachine.assertTransition(payment.status, PaymentStageStatus.VERIFIED);

  const plan = await PaymentPlan.findOne({ projectId: payment.projectId });
  if (!plan) throw AppError.notFound('Payment plan not found');

  const stage = plan.stages.find(s => s.stageId === payment.stageId);
  if (!stage) throw AppError.notFound('Stage not found');

  const project = await Project.findById(payment.projectId);
  if (!project) throw AppError.notFound('Project not found');

  // Credit system: calculate overpay/underpay
  const totalPaidForStage = stage.amountPaid + payment.amountPaid;
  const remaining = stage.amount - totalPaidForStage;

  if (remaining <= 0) {
    // Fully paid or overpaid
    stage.status = PaymentStageStatus.VERIFIED;
    stage.amountPaid = totalPaidForStage;
    stage.remainingBalance = 0;

    const excess = Math.abs(remaining);
    if (excess > 0) {
      payment.excessCredit = excess;
      // Apply excess credit to next pending stage
      await applyExcessCredit(plan, excess);
    }
  } else {
    // Partial payment — stage remains proof_submitted but records the partial
    stage.amountPaid = totalPaidForStage;
    stage.remainingBalance = remaining;
    // Mark as pending to allow more proofs
    stage.status = PaymentStageStatus.PENDING;
  }

  // Lock the plan after first verified payment
  if (!plan.isImmutable) {
    plan.isImmutable = true;
  }

  await plan.save();

  // Generate receipt
  const receiptNumber = await generateNextReceiptNumber();
  payment.status = PaymentStageStatus.VERIFIED;
  payment.verifiedBy = actorId as unknown as Types.ObjectId;
  payment.verifiedAt = new Date();
  payment.receiptNumber = receiptNumber;
  await payment.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_VERIFIED,
    actorId,
    targetType: 'payment',
    targetId: payment._id,
    details: {
      stageId: payment.stageId,
      amountPaid: payment.amountPaid,
      receiptNumber,
      excessCredit: payment.excessCredit,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  const customer = await User.findById(project.customerId);
  if (customer) {
    await createAndSendNotification(
      project.customerId,
      NotificationCategory.PAYMENT,
      'Payment Verified',
      `Your payment of ${formatCurrency(payment.amountPaid)} for "${project.title}" - ${stage.label} has been verified. Receipt: ${receiptNumber}`,
      `/projects/${project._id}/payments`,
    );

    await sendPaymentVerifiedEmail(customer.email, {
      amount: formatCurrency(payment.amountPaid),
      stageLabel: stage.label,
      receiptNumber,
    });
  }

  // Check if all stages are verified — transition project to fabrication
  const allVerified = plan.stages.every(s => s.status === PaymentStageStatus.VERIFIED);
  if (allVerified && project.status === ProjectStatus.PAYMENT_PENDING) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.FABRICATION);
    project.status = ProjectStatus.FABRICATION;
    await project.save();

    await createAndSendNotification(
      project.customerId,
      NotificationCategory.SYSTEM,
      'All Payments Verified',
      `All payments for "${project.title}" are verified! Your project is now moving to fabrication.`,
      `/projects/${project._id}`,
    );
  }

  return { payment, receiptNumber };
}

// ── Cashier: Decline Payment ──

export async function declinePayment(
  paymentId: string,
  input: DeclinePaymentInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw AppError.notFound('Payment not found');

  paymentStateMachine.assertTransition(payment.status, PaymentStageStatus.DECLINED);

  const plan = await PaymentPlan.findOne({ projectId: payment.projectId });
  if (!plan) throw AppError.notFound('Payment plan not found');

  const stage = plan.stages.find(s => s.stageId === payment.stageId);
  if (!stage) throw AppError.notFound('Stage not found');

  const project = await Project.findById(payment.projectId);
  if (!project) throw AppError.notFound('Project not found');

  payment.status = PaymentStageStatus.DECLINED;
  payment.declineReason = input.reason;
  await payment.save();

  // Revert stage status to declined
  stage.status = PaymentStageStatus.DECLINED;
  await plan.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_DECLINED,
    actorId,
    targetType: 'payment',
    targetId: payment._id,
    details: { stageId: payment.stageId, reason: input.reason },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  const customer = await User.findById(project.customerId);
  if (customer) {
    await createAndSendNotification(
      project.customerId,
      NotificationCategory.PAYMENT,
      'Payment Declined',
      `Your payment for "${project.title}" - ${stage.label} has been declined. Reason: ${input.reason}`,
      `/projects/${project._id}/payments`,
    );

    await sendPaymentDeclinedEmail(customer.email, {
      stageLabel: stage.label,
      reason: input.reason,
    });
  }

  return payment;
}

// ── Get Payment Plan by Project ──

async function assertPaymentProjectAccess(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
): Promise<void> {
  const project = await Project.findById(projectId)
    .select('customerId salesStaffId engineerIds');
  if (!project) throw AppError.notFound('Project not found');

  if (actorRoles.some((role) => [Role.ADMIN, Role.CASHIER].includes(role))) {
    return;
  }

  if (
    actorRoles.includes(Role.CUSTOMER) &&
    project.customerId.toString() === actorId
  ) {
    return;
  }

  if (
    actorRoles.includes(Role.SALES_STAFF) &&
    project.salesStaffId?.toString() === actorId
  ) {
    return;
  }

  if (
    actorRoles.includes(Role.ENGINEER) &&
    project.engineerIds.some((id) => id.toString() === actorId)
  ) {
    return;
  }

  throw AppError.forbidden('Access denied');
}

export async function getPaymentPlanByProject(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
) {
  await assertPaymentProjectAccess(projectId, actorId, actorRoles);
  const plan = await PaymentPlan.findOne({ projectId })
    .populate('createdBy', 'firstName lastName');
  return plan;
}

// ── List Payments for a Project ──

export async function listPaymentsByProject(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
) {
  await assertPaymentProjectAccess(projectId, actorId, actorRoles);
  const payments = await Payment.find({ projectId })
    .populate('verifiedBy', 'firstName lastName')
    .sort({ createdAt: -1 });
  return payments;
}

// ── List Payments for Cashier (pending verification) ──

export async function listPendingPayments(query: {
  page?: string;
  limit?: string;
}) {
  const page = parseInt(query.page || '1');
  const limit = Math.min(parseInt(query.limit || '20'), 100);

  const [payments, total] = await Promise.all([
    Payment.find({ status: PaymentStageStatus.PROOF_SUBMITTED })
      .populate('projectId', 'title customerId')
      .sort({ createdAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Payment.countDocuments({ status: PaymentStageStatus.PROOF_SUBMITTED }),
  ]);

  return payments;
}

// ── Get Payment by ID ──

export async function getPaymentById(
  paymentId: string,
  actorId: string,
  actorRoles: Role[],
) {
  const payment = await Payment.findById(paymentId)
    .populate('verifiedBy', 'firstName lastName');
  if (!payment) throw AppError.notFound('Payment not found');
  await assertPaymentProjectAccess(payment.projectId.toString(), actorId, actorRoles);
  return payment;
}

// ── Helpers ──

async function applyExcessCredit(plan: any, excessAmount: number): Promise<void> {
  // Find next pending stages and apply credit
  for (const stage of plan.stages) {
    if (excessAmount <= 0) break;
    if (stage.status === PaymentStageStatus.PENDING && stage.remainingBalance > 0) {
      const creditToApply = Math.min(excessAmount, stage.remainingBalance);
      stage.creditApplied += creditToApply;
      stage.amountPaid += creditToApply;
      stage.remainingBalance -= creditToApply;
      excessAmount -= creditToApply;

      if (stage.remainingBalance <= 0) {
        stage.status = PaymentStageStatus.VERIFIED;
        stage.remainingBalance = 0;
      }
    }
  }
}

async function generateNextReceiptNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const counter = await ReceiptCounter.findOneAndUpdate(
    { year },
    { $inc: { lastSeq: 1 } },
    { upsert: true, new: true },
  );
  return generateReceiptNumber(year, counter.lastSeq);
}
