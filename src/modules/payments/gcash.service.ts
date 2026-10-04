import mongoose, { type ClientSession } from 'mongoose';
import { Appointment, Payment, PaymentPlan, Project, AuditLog, SlotLock } from '../../models/index.js';
import type { IPayment } from '../../models/Payment.js';
import { AppError } from '../../utils/appError.js';
import { AppointmentStatus, AppointmentType, PaymentMethod, PaymentStageStatus, Role, AuditAction, NotificationCategory } from '../../utils/constants.js';
import { getConfigValue } from '../config/config.service.js';
import { validatePaymentImage } from '../uploads/upload.service.js';
import { assertBookingReadyForGcashApproval, completePaidOcularBooking } from '../appointments/appointments.service.js';
import { createAndSendNotification, notifyRole, emitRoleEvent, emitUserEvent } from '../notifications/socket.service.js';
import { handleInitialFabricationPaymentVerified, issueGcashReceipt } from './payments.service.js';
import type { GcashTarget, SubmitGcashInput } from './gcash.validation.js';
import { gcashSettingsSchema } from './gcash.validation.js';

const DUPLICATE_REFERENCE_MESSAGE = 'This GCash reference number has already been used. Please check your payment details.';

export async function resolveGcashTarget(target: GcashTarget, customerId: string, session?: ClientSession, readOnly = false) {
  if (target.bookingId) {
    const booking = await Appointment.findById(target.bookingId).session(session ?? null);
    if (!booking) throw AppError.notFound('Booking not found');
    if (booking.customerId.toString() !== customerId) throw AppError.forbidden('You can only pay for your own booking');
    if (booking.type !== AppointmentType.OCULAR || (!readOnly && ['cancelled', 'completed', 'no_show'].includes(booking.status))) {
      throw AppError.badRequest('This booking does not accept payment');
    }
    const amount = booking.ocularFee ?? booking.ocularFeeBreakdown?.total ?? 0;
    if (amount <= 0) throw AppError.badRequest('No payment is required for this booking');
    return { booking, amount, stageId: `ocular-${booking._id}`, key: `booking:${booking._id}`, reference: booking.appointmentNumber || booking._id.toString() };
  }
  const plan = await PaymentPlan.findOne({ 'stages.stageId': target.stageId }).session(session ?? null);
  if (!plan) throw AppError.notFound('Payment stage not found');
  const project = await Project.findById(plan.projectId).session(session ?? null);
  if (!project) throw AppError.notFound('Project not found');
  if (project.customerId.toString() !== customerId) throw AppError.forbidden('You can only pay for your own project');
  if (!readOnly && ['cancelled', 'draft', 'submitted', 'blueprint'].includes(project.status)) throw AppError.badRequest('Project does not accept payment');
  const stage = plan.stages.find((item) => item.stageId === target.stageId)!;
  const amount = Math.max(0, Math.round((stage.amount - stage.amountPaid - stage.creditApplied) * 100) / 100);
  return { plan, project, stage, amount, stageId: stage.stageId, key: `stage:${stage.stageId}`, reference: project.projectNumber || project._id.toString() };
}

export async function getGcashContext(target: GcashTarget, customerId: string) {
  const scope = await resolveGcashTarget(target, customerId, undefined, true);
  const attempts = await Payment.find(target.bookingId ? { bookingId: target.bookingId } : { stageId: target.stageId })
    .populate('verifiedBy', 'firstName lastName').populate('rejectedBy', 'firstName lastName').sort({ createdAt: -1 });
  const rawSettings = await getConfigValue('gcash_payment', { accountName: '', accountNumber: '', qrCodeKey: '' });
  const settings = gcashSettingsSchema.safeParse(rawSettings);
  const paid = scope.booking?.ocularFeePaid || scope.stage?.status === PaymentStageStatus.VERIFIED;
  const pending = scope.booking?.ocularFeeStatus === 'proof_submitted' || scope.stage?.status === PaymentStageStatus.PROOF_SUBMITTED;
  return {
    reference: scope.reference, amountRequired: scope.amount,
    paymentStatus: paid ? 'paid' : pending ? 'pending_verification' : attempts[0]?.paymentStatus === 'rejected' ? 'rejected' : 'unpaid',
    bookingStatus: scope.booking ? scope.booking.bookingStatus || (scope.booking.status === AppointmentStatus.CONFIRMED ? 'confirmed' : 'pending_payment') : undefined,
    merchant: 'RMV Stainless Steel Fabrication and Construction Services',
    settings: settings.success ? settings.data : { accountName: '', accountNumber: '', qrCodeKey: '' },
    attempts,
  };
}

export async function submitGcash(input: SubmitGcashInput, customerId: string) {
  const settings = gcashSettingsSchema.safeParse(await getConfigValue('gcash_payment', {}));
  if (!settings.success || (!settings.data.accountNumber && !settings.data.qrCodeKey)) throw AppError.badRequest('RMV GCash payment information has not been configured');
  if (input.proofKey) {
    if (!input.proofKey.startsWith(`payment-proofs/${customerId}/`) || !/\.(png|jpe?g|webp)$/i.test(input.proofKey)) {
      throw AppError.forbidden('Upload your own payment screenshot');
    }
    if (!await validatePaymentImage(input.proofKey)) throw AppError.badRequest('Upload a valid payment screenshot up to 5 MB');
  }
  let payment: IPayment | undefined;
  await Payment.init();
  const recordSubmission = async (session: ClientSession, duplicateFromRace = false) => {
    const scope = await resolveGcashTarget(input, customerId, session);
    if (scope.booking?.ocularFeePaid || scope.stage?.status === PaymentStageStatus.VERIFIED) throw AppError.badRequest('Payment is already paid');
    if (scope.amount <= 0) throw AppError.badRequest('No payment is required');
    // Rejected attempts also count as used references and stay in the audit history.
    const reusedReference = duplicateFromRace || Boolean(await Payment.exists({ method: PaymentMethod.GCASH,
      $or: [{ referenceNumber: input.referenceNumber }, { gcashReferenceNumber: input.referenceNumber }],
    }).session(session));
    const awaitingReview = scope.booking?.ocularFeeStatus === 'proof_submitted' || scope.stage?.status === PaymentStageStatus.PROOF_SUBMITTED;
    if (awaitingReview && !reusedReference) throw AppError.conflict('A payment is already awaiting verification');
    const status = reusedReference ? PaymentStageStatus.DECLINED : PaymentStageStatus.PROOF_SUBMITTED;
    const [created] = await Payment.create([{
      bookingId: scope.booking?._id, projectId: scope.project?._id, projectItemId: scope.plan?.projectItemId,
      customerId, stageId: scope.stageId, method: PaymentMethod.GCASH,
      amountRequired: scope.amount, amountPaid: input.amountPaid, referenceNumber: input.referenceNumber,
      // A flagged duplicate must not contend with the original reference or active submission.
      ...(reusedReference ? { duplicateReference: true, rejectionReason: 'Duplicate reference number',
        declineReason: 'Duplicate reference number', rejectedAt: new Date(), rejectedBy: null, rejectionSource: 'system' }
        : { gcashReferenceNumber: input.referenceNumber, activeSubmissionKey: scope.key }),
      paymentDate: new Date(input.paymentDate), proofKey: input.proofKey,
      paymentStatus: reusedReference ? 'rejected' : 'pending_verification', status,
      evidenceTrail: [{ version: 1, source: reusedReference ? 'system_duplicate_reference_rejection' : 'customer_gcash_submission', status,
        method: PaymentMethod.GCASH, amountPaid: input.amountPaid, referenceNumber: input.referenceNumber,
        proofKey: input.proofKey, actorId: customerId, capturedAt: new Date(),
        ...(reusedReference ? { note: 'Duplicate reference number' } : {}) }],
    }], { session });
    payment = created;
    if (scope.booking && !awaitingReview) {
      scope.booking.ocularFeePaymentMethod = PaymentMethod.GCASH;
      scope.booking.ocularFeeStatus = reusedReference ? 'declined' : 'proof_submitted';
      // Verification evidence belongs to Payment, which has customer/cashier access controls.
      scope.booking.ocularFeeReferenceNumber = undefined;
      scope.booking.ocularFeeProofKey = undefined;
      scope.booking.ocularFeeDeclineReason = reusedReference ? 'Duplicate reference number' : undefined;
      scope.booking.paymentStatus = reusedReference ? 'rejected' : 'pending_verification';
      scope.booking.bookingStatus = 'pending_payment';
      await scope.booking.save({ session });
    } else if (scope.stage && !awaitingReview) {
      scope.stage.status = status;
      await scope.plan!.save({ session });
    } else if (scope.booking) {
      scope.booking.bookingStatus = 'pending_payment';
      await scope.booking.save({ session });
    }
    await AuditLog.create([{ action: reusedReference ? AuditAction.PAYMENT_DECLINED : AuditAction.PAYMENT_PROOF_SUBMITTED,
      actorId: customerId, targetType: 'payment', targetId: created!._id,
      details: { method: 'gcash', amountRequired: scope.amount, amountSubmitted: input.amountPaid,
        ...(reusedReference ? { reason: 'Duplicate reference number', rejectionSource: 'system' } : {}) } }], { session });
  };
  try {
    await mongoose.connection.transaction((session) => recordSubmission(session));
  } catch (error) {
    const conflict = error as { code?: number; keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown>; message?: string };
    if (conflict.code !== 11000) throw error;
    const referenceConflict = conflict.keyPattern?.gcashReferenceNumber || conflict.keyValue?.gcashReferenceNumber || conflict.message?.includes('gcashReferenceNumber_1')
      || await Payment.exists({ method: PaymentMethod.GCASH,
        $or: [{ referenceNumber: input.referenceNumber }, { gcashReferenceNumber: input.referenceNumber }],
      }).session(null);
    if (referenceConflict) {
      // The first transaction rolled back. Persist the race loser as a separate rejected attempt.
      await mongoose.connection.transaction((session) => recordSubmission(session, true));
    } else throw AppError.conflict('This GCash reference has already been submitted, or this payment is awaiting verification');
  }
  const duplicate = payment!.duplicateReference;
  await notifyRole(Role.CASHIER, NotificationCategory.PAYMENT, duplicate ? 'Duplicate GCash Reference Flagged' : 'GCash Payment Submitted',
    duplicate ? 'A rejected GCash attempt used a duplicate reference. Review the flagged payment history.' : 'A GCash payment is waiting for verification.', '/payments?tab=cashier-queue');
  emitRoleEvent(Role.CASHIER, 'payments:queue-updated', { type: duplicate ? 'gcash_duplicate_rejected' : 'gcash_submitted', paymentId: payment!._id.toString() });
  if (duplicate) throw AppError.conflict(DUPLICATE_REFERENCE_MESSAGE);
  return payment!;
}

export async function selectCash(target: GcashTarget, customerId: string) {
  await mongoose.connection.transaction(async (session) => {
    const scope = await resolveGcashTarget(target, customerId, session);
    if (scope.booking?.ocularFeePaid || scope.stage?.status === PaymentStageStatus.VERIFIED) throw AppError.badRequest('Payment is already paid');
    if (scope.booking?.ocularFeeStatus === 'proof_submitted' || scope.stage?.status === PaymentStageStatus.PROOF_SUBMITTED) throw AppError.conflict('Wait for the cashier to review the submitted payment');
    if (scope.booking) {
      scope.booking.ocularFeePaymentMethod = PaymentMethod.CASH;
      scope.booking.ocularFeeStatus = 'cash_pending';
      scope.booking.paymentStatus = 'unpaid';
      scope.booking.bookingStatus = 'pending_payment';
      await scope.booking.save({ session });
    } else {
      scope.stage!.status = PaymentStageStatus.PENDING;
      await scope.plan!.save({ session });
    }
    const existing = await Payment.exists({ stageId: scope.stageId, method: PaymentMethod.CASH, paymentStatus: 'unpaid' }).session(session);
    if (!existing) await Payment.create([{ bookingId: scope.booking?._id, projectId: scope.project?._id, projectItemId: scope.plan?.projectItemId,
      customerId, stageId: scope.stageId, method: PaymentMethod.CASH, amountRequired: scope.amount, amountPaid: 0,
      status: PaymentStageStatus.PENDING, paymentStatus: 'unpaid' }], { session });
  });
  return { paymentMethod: 'cash', paymentStatus: 'unpaid' };
}

export async function recordBookingCash(bookingId: string, cashierId: string, roles: Role[]) {
  const payment = await Payment.findOne({ bookingId, method: PaymentMethod.CASH, paymentStatus: 'unpaid' });
  if (!payment) throw AppError.notFound('Cash payment selection not found');
  return reviewGcash(payment._id.toString(), cashierId, roles, 'paid', undefined, undefined, true);
}

export async function reviewGcash(paymentId: string, cashierId: string, roles: Role[], decision: 'paid' | 'rejected', reason?: string, signatureKey?: string, recordCash = false) {
  if (!roles.includes(Role.CASHIER)) throw AppError.forbidden('Only a cashier can verify GCash payments');
  if (decision === 'rejected' && !reason?.trim()) throw AppError.badRequest('A rejection reason is required');
  let reviewed: IPayment | undefined;
  let bookingConfirmedNow = false;
  await mongoose.connection.transaction(async (session) => {
    const payment = await Payment.findById(paymentId).session(session);
    if (!payment || payment.method !== (recordCash ? PaymentMethod.CASH : PaymentMethod.GCASH)) throw AppError.notFound('Payment not found');
    if (payment.paymentStatus !== (recordCash ? 'unpaid' : 'pending_verification')) throw AppError.conflict('This payment has already been reviewed');
    if (decision === 'paid' && payment.duplicateReference) throw AppError.conflict(DUPLICATE_REFERENCE_MESSAGE);
    const scope = await resolveGcashTarget(payment.bookingId ? { bookingId: payment.bookingId.toString() } : { stageId: payment.stageId }, payment.customerId!.toString(), session);
    if (scope.booking?.ocularFeePaid || scope.stage?.status === PaymentStageStatus.VERIFIED) throw AppError.conflict('Payment is already paid');
    if (recordCash) {
      if (!scope.booking || scope.booking.ocularFeePaymentMethod !== PaymentMethod.CASH || scope.booking.ocularFeeStatus !== 'cash_pending') throw AppError.badRequest('Booking is not awaiting cash collection');
      payment.amountPaid = scope.amount;
      payment.amountRequired = scope.amount;
      payment.paymentDate = new Date();
    }
    if (!recordCash && scope.booking && scope.booking.ocularFeeStatus !== 'proof_submitted') throw AppError.conflict('Booking is no longer awaiting GCash verification');
    if (!recordCash && scope.stage && scope.stage.status !== PaymentStageStatus.PROOF_SUBMITTED) throw AppError.conflict('Stage is no longer awaiting GCash verification');
    if (decision === 'paid' && Math.round(payment.amountPaid * 100) !== Math.round(scope.amount * 100)) {
      throw AppError.badRequest('Submitted amount must match the required amount. Reject this payment so the customer can correct it.');
    }
    payment.paymentStatus = decision;
    payment.status = decision === 'paid' ? PaymentStageStatus.VERIFIED : PaymentStageStatus.DECLINED;
    payment.activeSubmissionKey = undefined;
    const now = new Date();
    if (decision === 'paid') {
      payment.verifiedBy = new mongoose.Types.ObjectId(cashierId);
      payment.verifiedAt = now;
      payment.cashierSignatureKey = signatureKey;
    } else {
      payment.rejectedBy = new mongoose.Types.ObjectId(cashierId);
      payment.rejectedAt = now;
      payment.rejectionReason = reason!.trim();
      payment.rejectionSource = 'cashier';
      payment.duplicateReference = reason!.trim() === 'Duplicate reference number';
      payment.declineReason = reason!.trim();
    }
    payment.evidenceTrail.push({ version: payment.evidenceTrail.length + 1, source: 'cashier_gcash_review', status: payment.status,
      method: payment.method, amountPaid: payment.amountPaid, proofKey: payment.proofKey, referenceNumber: payment.referenceNumber,
      actorId: new mongoose.Types.ObjectId(cashierId), capturedAt: now, note: reason?.trim() || 'Approved by cashier' });
    if (scope.booking) {
      scope.booking.ocularFeePaid = decision === 'paid';
      scope.booking.ocularFeeStatus = decision === 'paid' ? 'verified' : 'declined';
      scope.booking.paymentStatus = decision;
      scope.booking.bookingStatus = decision === 'paid' ? 'confirmed' : 'pending_payment';
      scope.booking.ocularFeeDeclineReason = decision === 'rejected' ? reason!.trim() : undefined;
      if (decision === 'paid') {
        bookingConfirmedNow = scope.booking.status === AppointmentStatus.REQUESTED;
        if (!recordCash || bookingConfirmedNow) await assertBookingReadyForGcashApproval(scope.booking);
        if (!scope.booking.salesStaffId || !scope.booking.customerLocation) throw AppError.badRequest('Booking needs an assigned sales staff member and location before approval');
        const lock = await SlotLock.findOne({ date: scope.booking.date, slotCode: scope.booking.slotCode, salesId: scope.booking.salesStaffId }).session(session);
        if (lock && lock.appointmentId?.toString() !== scope.booking._id.toString()) throw AppError.conflict('Booking slot is no longer available');
        if (lock) { lock.confirmed = true; await lock.save({ session }); }
        else await SlotLock.create([{ date: scope.booking.date, slotCode: scope.booking.slotCode, salesId: scope.booking.salesStaffId,
          appointmentId: scope.booking._id, lockedBy: cashierId, confirmed: true, expiresAt: now }], { session });
        if (bookingConfirmedNow) scope.booking.status = AppointmentStatus.CONFIRMED;
        scope.booking.confirmedBy = new mongoose.Types.ObjectId(cashierId);
        scope.booking.ocularFeeVerifiedBy = new mongoose.Types.ObjectId(cashierId);
      }
      await scope.booking.save({ session });
    } else {
      scope.stage!.status = payment.status;
      if (decision === 'paid') {
        scope.stage!.amountPaid += payment.amountPaid;
        scope.stage!.remainingBalance = 0;
        scope.plan!.isImmutable = true;
      }
      await scope.plan!.save({ session });
    }
    await payment.save({ session });
    await AuditLog.create([{ action: decision === 'paid' ? AuditAction.PAYMENT_VERIFIED : AuditAction.PAYMENT_DECLINED,
      actorId: cashierId, targetType: 'payment', targetId: payment._id, details: { decision, reason } }], { session });
    reviewed = payment;
  });
  reviewed!.$session(null);
  emitUserEvent(reviewed!.customerId!.toString(), 'payments:queue-updated', { type: 'payment_reviewed', paymentId });
  emitRoleEvent(Role.CASHIER, 'payments:queue-updated', { type: 'gcash_reviewed', paymentId });
  if (decision === 'paid') {
    await issueGcashReceipt(reviewed!);
    if (reviewed!.bookingId && bookingConfirmedNow) {
      const booking = await Appointment.findById(reviewed!.bookingId);
      if (booking) await completePaidOcularBooking(booking);
    }
    if (reviewed!.projectId) {
      const project = await Project.findById(reviewed!.projectId);
      const plan = await PaymentPlan.findOne({ 'stages.stageId': reviewed!.stageId });
      if (project && plan) await handleInitialFabricationPaymentVerified(project, plan, reviewed!.projectItemId?.toString());
    }
  }
  await createAndSendNotification(reviewed!.customerId!, NotificationCategory.PAYMENT,
    decision === 'paid' ? 'Payment Approved' : 'Payment Verification Failed',
    decision === 'paid' ? 'Your payment is paid and has been approved by the cashier.' : `Reason: ${reason!.trim()}`,
    reviewed!.bookingId ? `/appointments/${reviewed!.bookingId}/pay-ocular-fee` : `/projects/${reviewed!.projectId}/payments`);
  return reviewed!;
}
