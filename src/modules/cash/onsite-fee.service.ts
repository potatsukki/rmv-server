import type { Types } from 'mongoose';
import {
  Appointment, AuditLog, CashCollection, Payment, Project, User, generateNextCollectionNumber,
} from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import {
  AppointmentStatus, AppointmentType, AuditAction, CashCollectionStatus, NotificationCategory,
  PaymentMethod, PaymentStageStatus, Role,
} from '../../utils/constants.js';
import { formatCurrency } from '../../utils/helpers.js';
import { emitRoleEvent, emitUserEvent, notifyRoleExcept, notifyUsers } from '../notifications/socket.service.js';
import { issueGcashReceipt } from '../payments/payments.service.js';
import { issueFeeReceipt, recordDesignFeePayment } from '../projects/design-fee.service.js';
import type { ICashCollection } from '../../models/CashCollection.js';

/**
 * On-site cash: during the ocular visit the sales staff takes the customer's cash for the ocular fee
 * (outside NCR) or the design fee. The fee is paid at once (the report / blueprint can continue) and
 * the customer gets an acknowledgement with a Collection No. The sales staff never issues the
 * official receipt: the cashier does, on receiving the cash in Cash Flow (cash.service receiveCash).
 */
export const ONSITE_CASH_SOURCE = 'sales_staff_onsite_cash';

/** The sales staff is at the site (or has just finished the visit). */
const ONSITE_OCULAR_STATUSES: string[] = [
  AppointmentStatus.ARRIVED_AT_SITE,
  AppointmentStatus.IN_PROGRESS,
  AppointmentStatus.COMPLETED,
];

export interface OnsiteCashInput {
  /** The sales staff confirms the customer acknowledged in person that the fee is non-refundable. */
  customerAcknowledgedInPerson?: boolean;
  notes?: string;
}

/** "Manila date and time" for the acknowledgement. */
function acknowledgedAt(now: Date) {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(now);
}

/** The acknowledgement the customer gets right away (not an official receipt). */
function acknowledgementMessage(collector: string, amount: number, fee: string, collectionNumber: string, at: Date) {
  return `Payment received by ${collector} – ${formatCurrency(amount)} ${fee}, Collection No. ${collectionNumber}, ${acknowledgedAt(at)}. `
    + 'Your official receipt follows once the RMV cashier records it.';
}

async function staffName(userId: string) {
  const user = await User.findById(userId).select('firstName lastName');
  return user ? `${user.firstName} ${user.lastName}`.trim() : 'The sales staff';
}

async function logCollection(collectionId: Types.ObjectId, actorId: string, details: Record<string, unknown>, ip?: string, ua?: string) {
  await AuditLog.create({
    action: AuditAction.CASH_COLLECTED,
    actorId,
    targetType: 'cash_collection',
    targetId: collectionId,
    details,
    ipAddress: ip,
    userAgent: ua,
  });
}

// ── Ocular fee ──

export async function collectOcularFeeOnSite(
  appointmentId: string,
  salesStaffId: string,
  input: OnsiteCashInput,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');
  if (appointment.type !== AppointmentType.OCULAR) {
    throw AppError.badRequest('Only an ocular visit has an ocular fee');
  }
  if (appointment.salesStaffId?.toString() !== salesStaffId) {
    throw AppError.forbidden('Only the sales staff assigned to this ocular visit can record its payment', ErrorCode.FORBIDDEN);
  }
  if (!ONSITE_OCULAR_STATUSES.includes(appointment.status)) {
    throw AppError.badRequest(
      'Record the cash at the site (visit In Progress) or after the visit is completed.',
      ErrorCode.VALIDATION_ERROR,
    );
  }
  const amount = appointment.ocularFee ?? appointment.ocularFeeBreakdown?.total ?? 0;
  if (amount <= 0) throw AppError.badRequest('This ocular visit has no fee to collect');
  if (appointment.ocularFeePaid) {
    throw AppError.conflict('The ocular fee is already paid', ErrorCode.DUPLICATE_ENTRY);
  }
  if (appointment.ocularFeeStatus === 'proof_submitted') {
    throw AppError.conflict('The customer sent an online payment for this fee. Wait for the cashier to verify or reject it first.');
  }
  const alreadyAcknowledged = Boolean(appointment.ocularFeeNonRefundableAckAt);
  if (!alreadyAcknowledged && !input.customerAcknowledgedInPerson) {
    throw AppError.badRequest(
      'The customer must acknowledge that the ocular fee is non-refundable before it is recorded',
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const now = new Date();
  // Claim the unpaid fee atomically so the cashier and the sales staff cannot both record it.
  const claimed = await Appointment.findOneAndUpdate(
    { _id: appointment._id, ocularFeePaid: { $ne: true }, ocularFeeStatus: { $ne: 'proof_submitted' } },
    {
      $set: {
        ocularFeePaid: true,
        ocularFeeStatus: 'verified',
        ocularFeePaymentMethod: PaymentMethod.CASH,
        paymentStatus: 'paid',
        bookingStatus: 'confirmed',
        ocularFeeVerifiedBy: salesStaffId,
        ...(alreadyAcknowledged ? {} : { ocularFeeNonRefundableAckAt: now }),
      },
      $unset: { ocularFeeDeclineReason: 1 },
    },
    { new: true },
  );
  if (!claimed) throw AppError.conflict('The ocular fee is already paid', ErrorCode.DUPLICATE_ENTRY);

  // Settle the cash payment the customer may have chosen online, or start one now.
  const note = input.notes?.trim() || 'Cash received by the sales staff during the ocular visit';
  let payment = await Payment.findOne({ bookingId: appointment._id, method: PaymentMethod.CASH, paymentStatus: 'unpaid' });
  if (!payment) {
    payment = new Payment({
      bookingId: appointment._id,
      customerId: appointment.customerId,
      stageId: `ocular-${appointment._id}`,
      method: PaymentMethod.CASH,
      amountRequired: amount,
      amountPaid: 0,
      status: PaymentStageStatus.PENDING,
      paymentStatus: 'unpaid',
    });
  }
  payment.amountRequired = amount;
  payment.amountPaid = amount;
  payment.paymentDate = now;
  payment.paymentStatus = 'paid';
  payment.status = PaymentStageStatus.VERIFIED;
  payment.verifiedBy = salesStaffId as unknown as Types.ObjectId;
  payment.verifiedAt = now;
  payment.evidenceTrail.push({
    version: payment.evidenceTrail.length + 1,
    source: ONSITE_CASH_SOURCE,
    status: PaymentStageStatus.VERIFIED,
    method: PaymentMethod.CASH,
    amountPaid: amount,
    note,
    actorId: salesStaffId as unknown as Types.ObjectId,
    capturedAt: now,
  });
  await payment.save();

  const collectionNumber = await generateNextCollectionNumber(now);
  const collection = await CashCollection.create({
    appointmentId: appointment._id,
    salesStaffId,
    customerId: appointment.customerId,
    feeType: 'ocular_fee',
    collectionNumber,
    paymentId: payment._id,
    amountCollected: amount,
    notes: input.notes?.trim() || undefined,
    status: CashCollectionStatus.COLLECTED,
  });
  await logCollection(collection._id, salesStaffId, {
    feeType: 'ocular_fee', appointmentId: appointment._id.toString(), amountCollected: amount, collectionNumber,
  }, ip, ua);

  const collector = await staffName(salesStaffId);
  const reference = appointment.appointmentNumber || 'the ocular visit';
  await notifyUsers(
    [appointment.customerId],
    NotificationCategory.PAYMENT,
    'Ocular Fee Payment Received',
    acknowledgementMessage(collector, amount, `ocular fee for ${reference}`, collectionNumber, now),
    `/appointments/${appointment._id}`,
    { excludeUserId: salesStaffId },
  );
  await notifyRoleExcept(
    Role.CASHIER,
    NotificationCategory.PAYMENT,
    'Cash to Receive',
    `${collector} collected the ${formatCurrency(amount)} ocular fee for ${reference} in cash (${collectionNumber}). Receive it in Cash Flow to issue the official receipt.`,
    '/cash',
    salesStaffId,
  );
  emitRoleEvent(Role.CASHIER, 'payments:queue-updated', { type: 'onsite_cash_collected', paymentId: payment._id.toString() });
  emitUserEvent(appointment.customerId.toString(), 'payments:queue-updated', { type: 'payment_reviewed', paymentId: payment._id.toString() });

  return { appointment: claimed, payment, collectionNumber, collection };
}

// ── Cashier: official receipt for cash a sales staff collected ──

/**
 * Issues the official receipt for an on-site collection once the cashier has the cash (Receive Cash,
 * or the admin resolving a discrepancy). `issuerId` is the cashier whose name the receipt carries.
 * Older collections without a linked payment, or already receipted, are left as they are.
 */
export async function issueCollectionReceipt(collection: ICashCollection, issuerId: string): Promise<string | undefined> {
  if (!collection.paymentId || collection.receiptNumber) return collection.receiptNumber;

  let receiptNumber: string | undefined;
  if (collection.feeType === 'design_fee') {
    receiptNumber = await issueFeeReceipt(collection.paymentId, issuerId);
  } else {
    const payment = await Payment.findById(collection.paymentId);
    if (!payment) return undefined;
    if (!payment.receiptNumber) await issueGcashReceipt(payment, issuerId);
    receiptNumber = payment.receiptNumber;
  }
  if (!receiptNumber) return undefined;

  collection.receiptNumber = receiptNumber;
  await collection.save();

  const fee = collection.feeType === 'design_fee' ? 'design fee' : 'ocular fee';
  const link = collection.projectId ? `/projects/${collection.projectId}/payments` : `/appointments/${collection.appointmentId}`;
  await notifyUsers(
    [collection.customerId],
    NotificationCategory.PAYMENT,
    'Official Receipt Issued',
    `Your official receipt ${receiptNumber} for the ${formatCurrency(collection.amountCollected)} ${fee}`
      + `${collection.collectionNumber ? ` (Collection No. ${collection.collectionNumber})` : ''} is ready.`,
    link,
  );
  return receiptNumber;
}

// ── Design fee ──

export async function collectDesignFeeOnSite(
  projectId: string,
  salesStaffId: string,
  input: OnsiteCashInput,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId).select('salesStaffId customerId ocularAppointmentId title projectNumber');
  if (!project) throw AppError.notFound('Project not found');
  if (!project.ocularAppointmentId) {
    throw AppError.badRequest('This project has no ocular visit. Record the design fee at the RMV cashier.');
  }
  const ocular = await Appointment.findById(project.ocularAppointmentId).select('salesStaffId');
  // The project's sales staff, or the staff who took the (handed-over) ocular visit.
  const allowed = [project.salesStaffId, ocular?.salesStaffId].some((id) => id?.toString() === salesStaffId);
  if (!allowed) {
    throw AppError.forbidden('Only the sales staff of this project or its ocular visit can record the design fee', ErrorCode.FORBIDDEN);
  }

  const result = await recordDesignFeePayment(
    projectId,
    { method: PaymentMethod.CASH, customerAcknowledgedInPerson: input.customerAcknowledgedInPerson },
    salesStaffId,
    ip,
    ua,
    { source: ONSITE_CASH_SOURCE, issueReceipt: false },
  );
  const amount = result.project.designFee?.amount ?? result.payment.amountPaid;

  const now = new Date();
  const collectionNumber = await generateNextCollectionNumber(now);
  const collection = await CashCollection.create({
    appointmentId: project.ocularAppointmentId,
    salesStaffId,
    customerId: project.customerId,
    feeType: 'design_fee',
    collectionNumber,
    projectId: project._id,
    paymentId: result.payment._id,
    amountCollected: amount,
    notes: input.notes?.trim() || undefined,
    status: CashCollectionStatus.COLLECTED,
  });
  await logCollection(collection._id, salesStaffId, {
    feeType: 'design_fee', projectId: project._id.toString(), amountCollected: amount, collectionNumber,
  }, ip, ua);

  const collector = await staffName(salesStaffId);
  await notifyUsers(
    [project.customerId],
    NotificationCategory.PAYMENT,
    'Design Fee Payment Received',
    `${acknowledgementMessage(collector, amount, `design fee for "${project.title}"`, collectionNumber, now)} The engineer can now start your blueprint.`,
    `/projects/${project._id}/payments`,
    { excludeUserId: salesStaffId },
  );
  await notifyRoleExcept(
    Role.CASHIER,
    NotificationCategory.PAYMENT,
    'Cash to Receive',
    `${collector} collected the ${formatCurrency(amount)} design fee for "${project.title}" in cash (${collectionNumber}). Receive it in Cash Flow to issue the official receipt.`,
    '/cash',
    salesStaffId,
  );

  return { project: result.project, payment: result.payment, collectionNumber, collection };
}
