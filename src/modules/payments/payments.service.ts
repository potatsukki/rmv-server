import { v4 as uuidv4 } from 'uuid';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  PaymentPlan, Payment, Project, ProjectItem, User, AuditLog, ReceiptCounter, Appointment,
} from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import {
  PaymentStageStatus, PaymentMethod, ProjectStatus, AuditAction, NotificationCategory, Role,
} from '../../utils/constants.js';
import { paymentStateMachine, projectStateMachine } from '../../utils/stateMachine.js';
import { createAndSendNotification, notifyRole, emitRoleEvent } from '../notifications/socket.service.js';
import { sendPaymentVerifiedEmail, sendPaymentDeclinedEmail } from '../notifications/email.service.js';
import { formatCurrency, generateReceiptNumber } from '../../utils/helpers.js';
import { createStageCheckoutSession } from '../../services/paymongo.service.js';
import { generateReceiptPdf, type ReceiptData } from '../../services/receipt.service.js';
import { r2Client } from '../../config/r2.js';
import { generateDownloadUrl } from '../uploads/upload.service.js';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type {
  CreatePaymentPlanInput,
  UpdatePaymentPlanInput,
  SubmitPaymentProofInput,
  VerifyPaymentInput,
  DeclinePaymentInput,
} from './payments.validation.js';
import type { Types } from 'mongoose';

// ── Receipt PDF helper — generate, upload to R2, return key ──

async function generateAndUploadReceipt(data: ReceiptData): Promise<{ key: string; buffer: Buffer }> {
  try {
    const buf = await generateReceiptPdf(data);
    const key = `receipts/${uuidv4()}-${data.receiptNumber}.pdf`;
    await r2Client.send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET_NAME,
        Key: key,
        Body: buf,
        ContentType: 'application/pdf',
      }),
    );
    logger.info(`Receipt PDF uploaded: ${key}`);
    return { key, buffer: buf };
  } catch (err) {
    logger.error('Receipt PDF generation/upload failed', err);
    return { key: '', buffer: Buffer.alloc(0) }; // non-fatal — payment still succeeds
  }
}

function appendPaymentEvidenceVersion(
  payment: any,
  input: { source: string; note?: string; actorId?: string },
) {
  const nextVersion = (payment.evidenceTrail?.length || 0) + 1;
  payment.evidenceTrail = payment.evidenceTrail || [];
  payment.evidenceTrail.push({
    version: nextVersion,
    source: input.source,
    status: payment.status,
    method: payment.method,
    amountPaid: payment.amountPaid,
    proofKey: payment.proofKey,
    referenceNumber: payment.referenceNumber,
    receiptKey: payment.receiptKey,
    receiptNumber: payment.receiptNumber,
    note: input.note,
    actorId: input.actorId,
    capturedAt: new Date(),
  });
}

function itemScopedQuery(projectId: string, projectItemId?: string) {
  return projectItemId
    ? { projectId, projectItemId }
    : { projectId, projectItemId: { $exists: false } };
}

function buildProjectPaymentsLink(projectId: string, projectItemId?: string | null) {
  return projectItemId
    ? `/projects/${projectId}/payments?projectItemId=${projectItemId}`
    : `/projects/${projectId}/payments`;
}

async function allProjectItemsHaveFirstPaymentVerified(projectId: string) {
  const items = await ProjectItem.find({ projectId }).select('_id');
  if (!items.length) return true;

  const plans = await PaymentPlan.find({
    projectId,
    projectItemId: { $in: items.map((item) => item._id) },
  });
  if (plans.length < items.length) return false;

  return plans.every((plan) => plan.stages[0]?.status === PaymentStageStatus.VERIFIED);
}

async function isPaidScopeReadyForFabricationAssignment(project: any, projectItemId?: string) {
  return projectItemId
    ? await allProjectItemsHaveFirstPaymentVerified(project._id.toString())
    : true;
}

export async function activateAssignedFabricationAfterInitialPayment(project: any, projectItemId?: string) {
  const parentReady = await isPaidScopeReadyForFabricationAssignment(project, projectItemId);
  const hasAssignedTeam = Boolean(project.fabricationLeadId);

  if (!parentReady || !hasAssignedTeam || project.status !== ProjectStatus.PAYMENT_PENDING) {
    return { parentReady, activated: false };
  }

  projectStateMachine.assertTransition(project.status, ProjectStatus.FABRICATION);
  project.status = ProjectStatus.FABRICATION;
  await project.save();
  await ProjectItem.updateMany(
    { projectId: project._id, status: ProjectStatus.PAYMENT_PENDING },
    { $set: { status: ProjectStatus.FABRICATION } },
  );

  return { parentReady, activated: true };
}

async function handleInitialFabricationPaymentVerified(project: any, plan: any, projectItemId?: string) {
  if (
    plan.stages[0]?.status !== PaymentStageStatus.VERIFIED
    || project.status !== ProjectStatus.PAYMENT_PENDING
  ) return;

  const { parentReady, activated } = await activateAssignedFabricationAfterInitialPayment(
    project,
    projectItemId,
  );
  const allVerified = plan.stages.every((stage: any) => stage.status === PaymentStageStatus.VERIFIED);

  await createAndSendNotification(
    project.customerId,
    NotificationCategory.SYSTEM,
    parentReady
      ? (activated ? 'Fabrication Updates Unlocked' : (allVerified ? 'All Payments Verified' : 'Fabrication Team Assignment Pending'))
      : 'Item Payment Verified',
    parentReady
      ? (activated
        ? `The required payment for "${project.title}" is verified. The assigned fabrication team can now post work updates.`
        : (allVerified
          ? `All payments for "${project.title}" are verified. The engineer will now assign the fabrication team.`
          : `The required first payments for "${project.title}" are verified. The engineer will now assign the fabrication team before fabrication starts.`))
      : `Payment for one item in "${project.title}" has been verified. Other items still need their required first payment before the full project enters fabrication.`,
    `/projects/${project._id}`,
  );

  if (!parentReady) return;

  if (activated) {
    const fabricationTeamIds = [
      project.fabricationLeadId,
      ...(project.fabricationAssistantIds || []),
    ].filter(Boolean);
    await Promise.all(fabricationTeamIds.map((staffId: any) => createAndSendNotification(
      staffId,
      NotificationCategory.FABRICATION,
      'Fabrication Updates Unlocked',
      `The required customer payment for "${project.title}" has been verified. You can now post fabrication updates.`,
      `/projects/${project._id}`,
    )));
    return;
  }

  await Promise.all((project.engineerIds || []).map((engineerId: any) => createAndSendNotification(
    engineerId,
    NotificationCategory.FABRICATION,
    'Assign Fabrication Team',
    `The required first payment for "${project.title}" has been verified. Assign the fabrication team to start fabrication.`,
    `/projects/${project._id}`,
  )));
}

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
    throw AppError.badRequest(
      'Payment plan can only be created for approved projects',
      ErrorCode.PAYMENT_PLAN_NOT_ALLOWED,
      { helpPath: '/help/payments/payment-stage-status-reference#overview' },
    );
  }

  // Check no existing plan
  const existing = await PaymentPlan.findOne(itemScopedQuery(input.projectId, input.projectItemId));
  if (existing) {
    throw AppError.conflict(
      'Payment plan already exists for this project',
      ErrorCode.PAYMENT_PLAN_ALREADY_EXISTS,
      { helpPath: '/help/payments/payment-stage-status-reference#overview' },
    );
  }

  const isPayInFull = input.stages.length === 1;
  const stages = input.stages.map((s, idx) => {
    const amount = Math.round((input.totalAmount * s.percentage / 100) * 100) / 100;
    // Auto-verify ₱0 stages so customers don't need to checkout for nothing
    const isZero = amount <= 0;
    return {
      stageId: uuidv4(),
      label: isPayInFull ? 'Full Payment' : `Stage ${idx + 1}`,
      percentage: s.percentage,
      amount,
      status: isZero ? PaymentStageStatus.VERIFIED : PaymentStageStatus.PENDING,
      qrCodeKey: s.qrCodeKey,
      amountPaid: isZero ? amount : 0,
      creditApplied: 0,
      remainingBalance: isZero ? 0 : amount,
      activatedAt: (idx === 0 || isZero) ? new Date() : null, // Stage 1 immediately due; others wait for fabrication
    };
  });

  const plan = await PaymentPlan.create({
    projectId: input.projectId,
    projectItemId: input.projectItemId,
    totalAmount: input.totalAmount,
    isPayInFull,
    stages,
    createdBy,
  });

  // Transition project to payment_pending
  projectStateMachine.assertTransition(project.status, ProjectStatus.PAYMENT_PENDING);
  project.status = ProjectStatus.PAYMENT_PENDING;
  await project.save();
  if (input.projectItemId) {
    await ProjectItem.findByIdAndUpdate(input.projectItemId, { $set: { status: ProjectStatus.PAYMENT_PENDING } });
  }

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
    buildProjectPaymentsLink(project._id.toString(), input.projectItemId),
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
    plan.stages = input.stages.map((s, idx) => {
      const amount = Math.round((plan.totalAmount * s.percentage / 100) * 100) / 100;
      const isZero = amount <= 0;
      return {
        stageId: uuidv4(),
        label: isPayInFull ? 'Full Payment' : `Stage ${idx + 1}`,
        percentage: s.percentage,
        amount,
        status: isZero ? PaymentStageStatus.VERIFIED : PaymentStageStatus.PENDING,
        qrCodeKey: s.qrCodeKey,
        amountPaid: isZero ? amount : 0,
        creditApplied: 0,
        remainingBalance: isZero ? 0 : amount,
        activatedAt: idx === 0 ? new Date() : null,
        headsUpSentAt: null,
        remindersSent: 0,
        lastReminderAt: null,
        escalatedToCashier: false,
      };
    });
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
  throw AppError.badRequest('Manual proof upload is no longer supported. Please pay via QR.');
}

// ── Cashier: Verify Payment ──

export async function verifyPayment(
  paymentId: string,
  input: VerifyPaymentInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw AppError.notFound('Payment not found');

  paymentStateMachine.assertTransition(payment.status, PaymentStageStatus.VERIFIED);

  const plan = await PaymentPlan.findOne(itemScopedQuery(payment.projectId.toString(), payment.projectItemId?.toString()));
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
  payment.cashierSignatureKey = input.signatureKey;
  payment.receiptNumber = receiptNumber;

  // Generate receipt PDF
  const customer = await User.findById(project.customerId);
  const verifier = await User.findById(actorId);
  const totalPaid = plan.stages.reduce((sum, s) => sum + s.amountPaid, 0);
  const customerAddr = customer?.addressData
    ? [customer.addressData.street, customer.addressData.barangay, customer.addressData.city, customer.addressData.province, customer.addressData.zip].filter(Boolean).join(', ')
    : (customer as any)?.address || '';
  
  const cashierSignatureUrl = input.signatureKey 
    ? await generateDownloadUrl(input.signatureKey)
    : undefined;

  const receipt = await generateAndUploadReceipt({
    receiptNumber,
    customerName: customer ? `${customer.firstName} ${customer.lastName}` : 'Customer',
    customerEmail: customer?.email || '',
    customerAddress: customerAddr,
    projectTitle: project.title,
    stageName: stage.label,
    amountPaid: payment.amountPaid,
    paymentMethod: payment.method,
    referenceNumber: payment.referenceNumber,
    creditApplied: payment.creditFromPrevious,
    excessCredit: payment.excessCredit,
    verifiedByName: verifier ? `${verifier.firstName} ${verifier.lastName}` : 'System',
    verifiedAt: payment.verifiedAt!,
    totalProjectCost: plan.totalAmount,
    totalPaid,
    totalOutstanding: Math.max(0, plan.totalAmount - totalPaid),
    cashierSignatureUrl,
  });
  if (receipt.key) payment.receiptKey = receipt.key;

  appendPaymentEvidenceVersion(payment, {
    source: 'cashier_verification',
    note: 'Payment verified and receipt issued',
    actorId,
  });

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
      receiptKey: receipt.key,
      excessCredit: payment.excessCredit,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  if (customer) {
    await createAndSendNotification(
      project.customerId,
      NotificationCategory.PAYMENT,
      'Payment Verified',
      `Your payment of ${formatCurrency(payment.amountPaid)} for "${project.title}" - ${stage.label} has been verified. Receipt: ${receiptNumber}`,
      buildProjectPaymentsLink(project._id.toString(), payment.projectItemId?.toString()),
    );

    await sendPaymentVerifiedEmail(customer.email, {
      amount: formatCurrency(payment.amountPaid),
      stageLabel: stage.label,
      receiptNumber,
      projectId: project._id.toString(),
      paymentStageId: stage.stageId,
    }, receipt.buffer.length > 0 ? receipt.buffer : undefined);
  }

  await handleInitialFabricationPaymentVerified(
    project,
    plan,
    payment.projectItemId?.toString(),
  );

  emitRoleEvent(Role.CASHIER, 'payments:queue-updated', {
    type: 'payment_verified',
    paymentId: payment._id.toString(),
    projectId: project._id.toString(),
    stageId: payment.stageId,
    amountPaid: payment.amountPaid,
  });

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

  const plan = await PaymentPlan.findOne(itemScopedQuery(payment.projectId.toString(), payment.projectItemId?.toString()));
  if (!plan) throw AppError.notFound('Payment plan not found');

  const stage = plan.stages.find(s => s.stageId === payment.stageId);
  if (!stage) throw AppError.notFound('Stage not found');

  const project = await Project.findById(payment.projectId);
  if (!project) throw AppError.notFound('Project not found');

  payment.status = PaymentStageStatus.DECLINED;
  payment.declineReason = input.reason;
  appendPaymentEvidenceVersion(payment, {
    source: 'cashier_decline',
    note: input.reason,
    actorId,
  });
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
      buildProjectPaymentsLink(project._id.toString(), payment.projectItemId?.toString()),
    );

    await sendPaymentDeclinedEmail(customer.email, {
      stageLabel: stage.label,
      reason: input.reason,
      projectId: project._id.toString(),
      paymentStageId: stage.stageId,
    });
  }

  emitRoleEvent(Role.CASHIER, 'payments:queue-updated', {
    type: 'payment_declined',
    paymentId: payment._id.toString(),
    projectId: project._id.toString(),
    stageId: payment.stageId,
  });

  return payment;
}

// ── Get Payment Plan by Project ──

async function assertPaymentProjectAccess(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
): Promise<void> {
  const project = await Project.findById(projectId)
    .select('customerId salesStaffId engineerIds fabricationLeadId fabricationAssistantIds status');
  if (!project) throw AppError.notFound('Project not found');

  if (actorRoles.some((role) => [Role.ADMIN, Role.CASHIER].includes(role))) return;

  if (actorRoles.includes(Role.CUSTOMER) && project.customerId.toString() === actorId) return;
  if (actorRoles.includes(Role.SALES_STAFF) && project.salesStaffId?.toString() === actorId) return;

  if (actorRoles.includes(Role.ENGINEER)) {
    if (project.engineerIds.some((id) => id.toString() === actorId)) return;
    if (project.status === ProjectStatus.SUBMITTED && project.engineerIds.length === 0) return;
  }


  if (actorRoles.includes(Role.FABRICATION_STAFF)) {
    if (project.fabricationLeadId?.toString() === actorId) return;
    if (project.fabricationAssistantIds?.some((id) => id.toString() === actorId)) return;
  }
  throw AppError.forbidden('Access denied');
}

export async function getPaymentPlanByProject(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
  projectItemId?: string,
) {
  await assertPaymentProjectAccess(projectId, actorId, actorRoles);
  const plan = await PaymentPlan.findOne(itemScopedQuery(projectId, projectItemId))
    .populate('createdBy', 'firstName lastName');
  return plan;
}

// ── List Payments for a Project ──

export async function listPaymentsByProject(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
  projectItemId?: string,
) {
  await assertPaymentProjectAccess(projectId, actorId, actorRoles);
  const payments = await Payment.find(itemScopedQuery(projectId, projectItemId))
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

  const [payments] = await Promise.all([
    Payment.find({ status: PaymentStageStatus.PROOF_SUBMITTED })
      .populate({
        path: 'projectId',
        select: 'title customerId',
        populate: { path: 'customerId', select: 'firstName lastName' },
      })
      .sort({ createdAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
  ]);

  const missingProjectIds = Array.from(
    new Set(
      payments
        .filter((payment: any) => !payment?.projectId || typeof payment.projectId !== 'object')
        .map((payment: any) => String(payment.projectId || ''))
        .filter(Boolean),
    ),
  );

  const fallbackProjects = missingProjectIds.length
    ? await Project.find({ _id: { $in: missingProjectIds } })
        .select('title customerId')
        .populate('customerId', 'firstName lastName')
        .lean()
    : [];
  const fallbackProjectMap = new Map(fallbackProjects.map((project: any) => [String(project._id), project]));

  return payments.map((payment: any) => {
    const populatedProject =
      payment?.projectId && typeof payment.projectId === 'object'
        ? payment.projectId
        : fallbackProjectMap.get(String(payment.projectId || ''));
    const customer =
      populatedProject?.customerId && typeof populatedProject.customerId === 'object'
        ? populatedProject.customerId
        : null;

    const customerName = customer
      ? `${String(customer.firstName || '').trim()} ${String(customer.lastName || '').trim()}`.trim()
      : 'Unknown Customer';
    const projectTitle = populatedProject?.title || 'Unknown Project';

    return {
      ...payment,
      customerName,
      projectTitle,
    };
  });
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

export async function getPaymentEvidenceTrail(
  paymentId: string,
  actorId: string,
  actorRoles: Role[],
) {
  const payment = await getPaymentById(paymentId, actorId, actorRoles);
  return {
    paymentId: payment._id,
    status: payment.status,
    method: payment.method,
    amountPaid: payment.amountPaid,
    evidenceTrail: payment.evidenceTrail || [],
  };
}

// ── Customer: Payment History (all payments) ──

export async function getMyPaymentHistory(customerId: string) {
  // Get all projects belonging to this customer
  const projects = await Project.find({ customerId }).select('_id title');
  const projectIds = projects.map(p => p._id);
  const projectMap = new Map(projects.map(p => [p._id.toString(), p.title]));

  // Get all project payments
  const projectPayments = await Payment.find({ projectId: { $in: projectIds } })
    .sort({ createdAt: -1 })
    .lean();

  // Get all ocular fee appointments (paid or pending)
  const ocularAppointments = await Appointment.find({
    customerId,
    type: 'ocular',
    ocularFee: { $gt: 0 },
    ocularFeeStatus: { $in: ['verified', 'pending', 'proof_submitted', 'declined'] },
  })
    .select('date ocularFee ocularFeePaid ocularFeeStatus ocularFeePaymentMethod formattedAddress createdAt')
    .sort({ createdAt: -1 })
    .lean();

  // Build unified timeline
  const history: Array<{
    _id: string;
    type: 'project_payment' | 'ocular_fee';
    amount: number;
    status: string;
    method?: string;
    referenceNumber?: string;
    receiptNumber?: string;
    description: string;
    date: string;
    declineReason?: string;
  }> = [];

  for (const p of projectPayments) {
    history.push({
      _id: p._id.toString(),
      type: 'project_payment',
      amount: p.amountPaid,
      status: p.status,
      method: p.method,
      referenceNumber: p.referenceNumber,
      receiptNumber: p.receiptNumber,
      description: projectMap.get(p.projectId.toString()) || 'Project Payment',
      date: (p.createdAt as Date).toISOString(),
      declineReason: p.declineReason,
    });
  }

  for (const a of ocularAppointments) {
    history.push({
      _id: a._id.toString(),
      type: 'ocular_fee',
      amount: a.ocularFee!,
      status: a.ocularFeePaid ? 'verified' : (a.ocularFeeStatus || 'pending'),
      method: a.ocularFeePaymentMethod,
      description: `Ocular Fee — ${a.formattedAddress || a.date}`,
      date: (a.createdAt as Date).toISOString(),
    });
  }

  // Sort by date descending
  history.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return history;
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

// ── Customer: Create PayMongo QRPH Checkout for a Stage ──

export async function createStageCheckout(
  stageId: string,
  customerId: string,
  origin: string,
) {
  const plan = await PaymentPlan.findOne({ 'stages.stageId': stageId });
  if (!plan) throw AppError.notFound('Payment stage not found');

  const project = await Project.findById(plan.projectId);
  if (!project) throw AppError.notFound('Project not found');
  if (project.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only pay for your own projects');
  }

  const stage = plan.stages.find(s => s.stageId === stageId);
  if (!stage) throw AppError.notFound('Stage not found');

  if (![PaymentStageStatus.PENDING, PaymentStageStatus.DECLINED].includes(stage.status)) {
    throw AppError.badRequest(
      'This stage is not accepting payments',
      ErrorCode.PAYMENT_STAGE_NOT_ACCEPTING,
      { helpPath: '/help/payments/payment-stage-status-reference#overview' },
    );
  }

  // Allow advance payments — badges stay informational, no hard block

  const remaining = stage.remainingBalance > 0 ? stage.remainingBalance : stage.amount;

  // Dev override: ₱1 flat for testing (same pattern as ocular fee)
  const checkoutAmount = env.NODE_ENV === 'production' ? remaining : 1;

  const description = `${project.title} — ${stage.label}`;
  const session = await createStageCheckoutSession({
    amount: checkoutAmount,
    description,
    stageId,
    projectId: plan.projectId.toString(),
    customerId,
    successUrl: `${origin}/payments?paid=1`,
    cancelUrl: `${origin}/payments?cancelled=1`,
  });

  // Store checkout session ID on the stage for webhook lookup
  stage.checkoutSessionId = session.id;
  await plan.save();

  logger.info(`Stage checkout session created: ${session.id} for stage ${stageId}`);

  return {
    checkoutUrl: session.attributes.checkout_url,
    sessionId: session.id,
    amount: checkoutAmount,
  };
}

// ── Customer: Request Cash Payment for a Stage ──

export async function requestStageCashPayment(
  stageId: string,
  customerId: string,
  ip?: string,
  ua?: string,
) {
  const plan = await PaymentPlan.findOne({ 'stages.stageId': stageId });
  if (!plan) throw AppError.notFound('Payment stage not found');

  const project = await Project.findById(plan.projectId);
  if (!project) throw AppError.notFound('Project not found');
  if (project.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only pay for your own projects');
  }

  const stage = plan.stages.find(s => s.stageId === stageId);
  if (!stage) throw AppError.notFound('Stage not found');

  if (stage.status === PaymentStageStatus.PROOF_SUBMITTED) {
    throw AppError.badRequest(
      'This stage already has a payment awaiting verification',
      ErrorCode.PAYMENT_ALREADY_AWAITING_VERIFICATION,
      { helpPath: '/help/payments/payment-stage-status-reference#overview' },
    );
  }

  if (![PaymentStageStatus.PENDING, PaymentStageStatus.DECLINED].includes(stage.status)) {
    throw AppError.badRequest(
      'This stage is not accepting payments',
      ErrorCode.PAYMENT_STAGE_NOT_ACCEPTING,
      { helpPath: '/help/payments/payment-stage-status-reference#overview' },
    );
  }

  const remaining = stage.remainingBalance > 0 ? stage.remainingBalance : stage.amount;

  const payment = await Payment.create({
    projectId: plan.projectId,
    projectItemId: plan.projectItemId,
    stageId: stage.stageId,
    method: PaymentMethod.CASH,
    amountPaid: remaining,
    status: PaymentStageStatus.PROOF_SUBMITTED,
    referenceNumber: `CASH-REQ-${Date.now()}`,
    creditFromPrevious: 0,
    excessCredit: 0,
  });
  appendPaymentEvidenceVersion(payment, {
    source: 'customer_cash_request',
    note: 'Customer requested cashier-side cash verification',
    actorId: customerId,
  });
  await payment.save();

  stage.status = PaymentStageStatus.PROOF_SUBMITTED;
  if (!plan.isImmutable) plan.isImmutable = true;
  await plan.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_PROOF_SUBMITTED,
    actorId: customerId,
    targetType: 'payment',
    targetId: payment._id,
    details: { stageId: stage.stageId, amountPaid: remaining, method: PaymentMethod.CASH, intentType: 'customer_cash_request' },
    ipAddress: ip,
    userAgent: ua,
  });

  await createAndSendNotification(
    project.customerId,
    NotificationCategory.PAYMENT,
    'Cash Payment Request Submitted',
    `Your cash payment request for ${formatCurrency(remaining)} on "${project.title}" — ${stage.label} is awaiting cashier verification.`,
    buildProjectPaymentsLink(project._id.toString(), plan.projectItemId?.toString()),
  );

  await notifyRole(
    Role.CASHIER,
    NotificationCategory.PAYMENT,
    'Cash Payment Awaiting Verification',
    `Cash payment request of ${formatCurrency(remaining)} for "${project.title}" — ${stage.label} needs verification.`,
    '/cashier-queue',
  );

  emitRoleEvent(Role.CASHIER, 'payments:queue-updated', {
    type: 'payment_submitted',
    paymentId: payment._id.toString(),
    projectId: project._id.toString(),
    stageId: stage.stageId,
    amountPaid: remaining,
    method: PaymentMethod.CASH,
  });

  return {
    paymentId: payment._id.toString(),
    stageId: stage.stageId,
    amountPaid: remaining,
    method: payment.method,
    status: payment.status,
  };
}

// ── Handle PayMongo Webhook for Stage Payments ──

export async function handleStagePaymongoPayment(checkoutSessionId: string) {
  const plan = await PaymentPlan.findOne({
    'stages.checkoutSessionId': checkoutSessionId,
  });

  if (!plan) return null; // Not a stage payment

  const stage = plan.stages.find(s => s.checkoutSessionId === checkoutSessionId);
  if (!stage) return null;

  // Already verified or awaiting cashier review — idempotent
  if (stage.status === PaymentStageStatus.VERIFIED || stage.status === PaymentStageStatus.PROOF_SUBMITTED) return plan;

  const project = await Project.findById(plan.projectId);
  if (!project) return null;

  const remaining = stage.remainingBalance > 0 ? stage.remainingBalance : stage.amount;
  const amountPaid = env.NODE_ENV === 'production' ? remaining : 1;

  // Create Payment record — awaiting cashier verification
  const payment = await Payment.create({
    projectId: plan.projectId,
    projectItemId: plan.projectItemId,
    stageId: stage.stageId,
    method: PaymentMethod.QRPH,
    amountPaid,
    status: PaymentStageStatus.PROOF_SUBMITTED,
    referenceNumber: checkoutSessionId,
    creditFromPrevious: 0,
    excessCredit: 0,
  });
  appendPaymentEvidenceVersion(payment, {
    source: 'paymongo_checkout_webhook',
    note: 'Payment captured from PayMongo webhook, pending cashier verification',
  });
  await payment.save();

  // Update stage to awaiting verification
  stage.status = PaymentStageStatus.PROOF_SUBMITTED;

  if (!plan.isImmutable) plan.isImmutable = true;
  await plan.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_PROOF_SUBMITTED,
    actorId: project.customerId,
    targetType: 'payment',
    targetId: payment._id,
    details: { stageId: stage.stageId, amountPaid, verifiedVia: 'paymongo_webhook' },
  });

  // Notify customer that payment is awaiting cashier verification
  await createAndSendNotification(
    project.customerId,
    NotificationCategory.PAYMENT,
    'Payment Received — Awaiting Cashier Verification',
    `Your QRPH payment of ${formatCurrency(amountPaid)} for "${project.title}" — ${stage.label} has been received and is awaiting cashier verification.`,
    buildProjectPaymentsLink(project._id.toString(), plan.projectItemId?.toString()),
  );

  // Notify cashiers to review
  await notifyRole(
    Role.CASHIER,
    NotificationCategory.PAYMENT,
    'QR Payment Awaiting Cashier Verification',
    `QRPH payment of ${formatCurrency(amountPaid)} for "${project.title}" — ${stage.label} needs verification.`,
    `/cashier-queue`,
  );

  emitRoleEvent(Role.CASHIER, 'payments:queue-updated', {
    type: 'payment_submitted',
    paymentId: payment._id.toString(),
    projectId: project._id.toString(),
    stageId: stage.stageId,
    amountPaid,
  });

  return plan;
}

// ⚠️ DEV ONLY: Simulate Stage Payment ──

export async function simulateStagePayment(
  stageId: string,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const plan = await PaymentPlan.findOne({ 'stages.stageId': stageId });
  if (!plan) throw AppError.notFound('Payment stage not found');

  const stage = plan.stages.find(s => s.stageId === stageId);
  if (!stage) throw AppError.notFound('Stage not found');

  if (![PaymentStageStatus.PENDING, PaymentStageStatus.DECLINED].includes(stage.status)) {
    throw AppError.badRequest(
      'This stage is not accepting payments',
      ErrorCode.PAYMENT_STAGE_NOT_ACCEPTING,
      { helpPath: '/help/payments/payment-stage-status-reference#overview' },
    );
  }

  const project = await Project.findById(plan.projectId);
  if (!project) throw AppError.notFound('Project not found');

  const remaining = stage.remainingBalance > 0 ? stage.remainingBalance : stage.amount;

  // Create Payment record — awaiting cashier verification (same as real QR flow)
  const payment = await Payment.create({
    projectId: plan.projectId,
    projectItemId: plan.projectItemId,
    stageId: stage.stageId,
    method: PaymentMethod.QRPH,
    amountPaid: remaining,
    status: PaymentStageStatus.PROOF_SUBMITTED,
    referenceNumber: `SIM-${Date.now()}`,
    creditFromPrevious: 0,
    excessCredit: 0,
  });
  appendPaymentEvidenceVersion(payment, {
    source: 'simulated_checkout',
    note: 'Simulated payment capture for testing',
    actorId,
  });
  await payment.save();

  // Update stage to awaiting verification
  stage.status = PaymentStageStatus.PROOF_SUBMITTED;

  if (!plan.isImmutable) plan.isImmutable = true;
  await plan.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_PROOF_SUBMITTED,
    actorId,
    targetType: 'payment',
    targetId: payment._id,
    details: { stageId: stage.stageId, amountPaid: remaining, verifiedVia: 'simulate' },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify cashiers to review
  await notifyRole(
    Role.CASHIER,
    NotificationCategory.PAYMENT,
    'Simulated Payment Awaiting Verification',
    `Simulated QRPH payment of ${formatCurrency(remaining)} for stage "${stage.label}" needs verification.`,
    `/cashier-queue`,
  );

  emitRoleEvent(Role.CASHIER, 'payments:queue-updated', {
    type: 'payment_submitted',
    paymentId: payment._id.toString(),
    projectId: project._id.toString(),
    stageId: stage.stageId,
    amountPaid: remaining,
  });

  return { payment };
}

// ── Cashier: Record Cash Payment (auto-verified) ──

export async function recordCashPayment(
  stageId: string,
  amountPaid: number,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const plan = await PaymentPlan.findOne({ 'stages.stageId': stageId });
  if (!plan) throw AppError.notFound('Payment stage not found');

  const stage = plan.stages.find(s => s.stageId === stageId);
  if (!stage) throw AppError.notFound('Stage not found');

  if (![PaymentStageStatus.PENDING, PaymentStageStatus.DECLINED].includes(stage.status)) {
    throw AppError.badRequest(
      'This stage is not accepting payments',
      ErrorCode.PAYMENT_STAGE_NOT_ACCEPTING,
      { helpPath: '/help/payments/payment-stage-status-reference#overview' },
    );
  }

  const project = await Project.findById(plan.projectId);
  if (!project) throw AppError.notFound('Project not found');

  const receiptNumber = await generateNextReceiptNumber();
  const payment = await Payment.create({
    projectId: plan.projectId,
    projectItemId: plan.projectItemId,
    stageId: stage.stageId,
    method: PaymentMethod.CASH,
    amountPaid,
    status: PaymentStageStatus.VERIFIED,
    verifiedBy: actorId as unknown as Types.ObjectId,
    verifiedAt: new Date(),
    receiptNumber,
    creditFromPrevious: 0,
    excessCredit: 0,
  });

  // Generate receipt PDF
  const cashCustomer = await User.findById(project.customerId);
  const cashVerifier = await User.findById(actorId);
  const cashTotalPaid = plan.stages.reduce((sum, s) => sum + s.amountPaid, 0) + amountPaid;
  const cashCustomerAddr = cashCustomer?.addressData
    ? [cashCustomer.addressData.street, cashCustomer.addressData.barangay, cashCustomer.addressData.city, cashCustomer.addressData.province, cashCustomer.addressData.zip].filter(Boolean).join(', ')
    : (cashCustomer as any)?.address || '';
  const cashReceipt = await generateAndUploadReceipt({
    receiptNumber,
    customerName: cashCustomer ? `${cashCustomer.firstName} ${cashCustomer.lastName}` : 'Customer',
    customerEmail: cashCustomer?.email || '',
    customerAddress: cashCustomerAddr,
    projectTitle: project.title,
    stageName: stage.label,
    amountPaid,
    paymentMethod: 'cash',
    creditApplied: 0,
    excessCredit: 0,
    verifiedByName: cashVerifier ? `${cashVerifier.firstName} ${cashVerifier.lastName}` : 'Cashier',
    verifiedAt: payment.verifiedAt!,
    totalProjectCost: plan.totalAmount,
    totalPaid: cashTotalPaid,
    totalOutstanding: Math.max(0, plan.totalAmount - cashTotalPaid),
  });
  if (cashReceipt.key) payment.receiptKey = cashReceipt.key;

  // Update stage
  const totalPaid = stage.amountPaid + amountPaid;
  const remaining = stage.amount - totalPaid;

  if (remaining <= 0) {
    stage.status = PaymentStageStatus.VERIFIED;
    stage.amountPaid = totalPaid;
    stage.remainingBalance = 0;
    const excess = Math.abs(remaining);
    if (excess > 0) {
      payment.excessCredit = excess;
      await applyExcessCredit(plan, excess);
    }
  } else {
    stage.amountPaid = totalPaid;
    stage.remainingBalance = remaining;
  }

  if (!plan.isImmutable) plan.isImmutable = true;

  appendPaymentEvidenceVersion(payment, {
    source: 'cashier_record_cash',
    note: 'Cash payment directly recorded and verified by cashier',
    actorId,
  });
  await payment.save();

  await plan.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_VERIFIED,
    actorId,
    targetType: 'payment',
    targetId: payment._id,
    details: { stageId: stage.stageId, amountPaid, method: 'cash', receiptNumber },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    project.customerId,
    NotificationCategory.PAYMENT,
    'Cash Payment Recorded',
    `A cash payment of ${formatCurrency(amountPaid)} for "${project.title}" — ${stage.label} has been recorded. Receipt: ${receiptNumber}`,
    buildProjectPaymentsLink(project._id.toString(), plan.projectItemId?.toString()),
  );

  if (cashCustomer) {
    await sendPaymentVerifiedEmail(cashCustomer.email, {
      amount: formatCurrency(amountPaid),
      stageLabel: stage.label,
      receiptNumber,
      projectId: project._id.toString(),
      paymentStageId: stage.stageId,
    }, cashReceipt.buffer.length > 0 ? cashReceipt.buffer : undefined);
  }

  await handleInitialFabricationPaymentVerified(
    project,
    plan,
    plan.projectItemId?.toString(),
  );

  emitRoleEvent(Role.CASHIER, 'payments:queue-updated', {
    type: 'cash_payment_recorded',
    paymentId: payment._id.toString(),
    projectId: project._id.toString(),
    stageId: stage.stageId,
    amountPaid,
  });

  return { payment, receiptNumber };
}

// ── Get Receipt Download URL ──

export async function getReceiptDownloadUrl(
  paymentId: string,
  actorId: string,
  actorRoles: Role[],
) {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw AppError.notFound('Payment not found');
  if (!payment.receiptKey) throw AppError.badRequest('No receipt available for this payment');

  await assertPaymentProjectAccess(payment.projectId.toString(), actorId, actorRoles);

  const url = await generateDownloadUrl(payment.receiptKey);
  return { url, key: payment.receiptKey };
}

// ── Cashier: List Overdue Payments ──

export async function listOverduePayments() {
  const plans = await PaymentPlan.find({
    'stages': {
      $elemMatch: {
        activatedAt: { $ne: null },
        status: { $in: [PaymentStageStatus.PENDING, PaymentStageStatus.DECLINED] },
      },
    },
  }).populate('projectId', 'title customerId');

  const overdueStages: Array<{
    projectId: string;
    projectTitle: string;
    customerId: string;
    customerName: string;
    stageId: string;
    stageLabel: string;
    amount: number;
    activatedAt: Date;
    daysSinceActivation: number;
    remindersSent: number;
    escalatedToCashier: boolean;
  }> = [];

  const now = new Date();

  for (const plan of plans) {
    const project = plan.projectId as any;
    if (!project?._id) continue;

    const customer = await User.findById(project.customerId).select('firstName lastName');
    const customerName = customer ? `${customer.firstName} ${customer.lastName}` : 'Unknown';

    for (const stage of plan.stages) {
      if (
        !stage.activatedAt ||
        stage.status === PaymentStageStatus.VERIFIED ||
        stage.status === PaymentStageStatus.PROOF_SUBMITTED
      ) {
        continue;
      }

      const daysSinceActivation = Math.floor(
        (now.getTime() - new Date(stage.activatedAt).getTime()) / (1000 * 60 * 60 * 24),
      );

      overdueStages.push({
        projectId: project._id.toString(),
        projectTitle: project.title,
        customerId: project.customerId.toString(),
        customerName,
        stageId: stage.stageId,
        stageLabel: stage.label,
        amount: stage.amount,
        activatedAt: stage.activatedAt,
        daysSinceActivation,
        remindersSent: stage.remindersSent,
        escalatedToCashier: stage.escalatedToCashier,
      });
    }
  }

  // Sort by most overdue first
  overdueStages.sort((a, b) => b.daysSinceActivation - a.daysSinceActivation);
  return overdueStages;
}
