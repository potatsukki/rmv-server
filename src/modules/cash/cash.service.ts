import {
  CashCollection, CashDiscrepancy, Appointment, AuditLog,
} from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import { CashCollectionStatus, AuditAction, NotificationCategory, Role, AppointmentStatus } from '../../utils/constants.js';
import { createAndSendNotification, notifyRole } from '../notifications/socket.service.js';
import { formatCurrency } from '../../utils/helpers.js';
import type {
  RecordCashCollectionInput,
  ReceiveCashInput,
  ResolveDiscrepancyInput,
} from './cash.validation.js';
import type { Types } from 'mongoose';

// ── Sales Staff: Record Cash Collection ──

export async function recordCashCollection(
  input: RecordCashCollectionInput,
  salesStaffId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(input.appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  // Only allow recording when appointment is on_the_way or completed
  const allowedStatuses = [AppointmentStatus.ON_THE_WAY, AppointmentStatus.COMPLETED];
  if (!allowedStatuses.includes(appointment.status as AppointmentStatus)) {
    throw AppError.badRequest(
      'You can only record cash payment when the appointment status is "On The Way" or "Completed".',
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Hard-block: if this is for a cash_pending ocular fee, amount must match exactly
  if (appointment.ocularFeeStatus === 'cash_pending' && appointment.ocularFee) {
    const expected = appointment.ocularFee;
    if (Math.abs(input.amountCollected - expected) > 0.01) {
      throw AppError.badRequest(
        `Amount must match the ocular fee of ${formatCurrency(expected)}. You entered ${formatCurrency(input.amountCollected)}.`,
      );
    }
  }

  const collection = await CashCollection.create({
    appointmentId: input.appointmentId,
    salesStaffId,
    customerId: appointment.customerId,
    amountCollected: input.amountCollected,
    notes: input.notes,
    photoKey: input.photoKey,
    status: CashCollectionStatus.COLLECTED,
  });

  // If this was a cash_pending ocular fee, mark it as proof_submitted
  if (appointment.ocularFeeStatus === 'cash_pending') {
    appointment.ocularFeeStatus = 'proof_submitted';
    appointment.ocularFeePaymentMethod = 'cash' as any;
    await appointment.save();
  }

  await AuditLog.create({
    action: AuditAction.CASH_COLLECTED,
    actorId: salesStaffId,
    targetType: 'cash_collection',
    targetId: collection._id,
    details: { amountCollected: input.amountCollected, appointmentId: input.appointmentId },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify cashier
  await notifyRole(
    Role.CASHIER,
    NotificationCategory.PAYMENT,
    'Cash Collection Recorded',
    `Sales staff collected ${formatCurrency(input.amountCollected)} for appointment.`,
    `/cash/${collection._id}`,
  );

  return collection;
}

// ── Cashier: Receive Cash ──

export async function receiveCash(
  collectionId: string,
  input: ReceiveCashInput,
  cashierId: string,
  ip?: string,
  ua?: string,
) {
  const collection = await CashCollection.findById(collectionId);
  if (!collection) throw AppError.notFound('Cash collection not found');

  if (collection.status !== CashCollectionStatus.COLLECTED) {
    throw AppError.badRequest('Cash has already been processed');
  }

  collection.receivedBy = cashierId as unknown as Types.ObjectId;
  collection.amountReceived = input.amountReceived;
  collection.receivedAt = new Date();

  const difference = collection.amountCollected - input.amountReceived;

  if (Math.abs(difference) > 0.01) {
    // Discrepancy detected
    collection.status = CashCollectionStatus.DISCREPANCY;
    await collection.save();

    const discrepancy = await CashDiscrepancy.create({
      cashCollectionId: collection._id,
      appointmentId: collection.appointmentId,
      salesStaffId: collection.salesStaffId,
      cashierId,
      amountCollected: collection.amountCollected,
      amountReceived: input.amountReceived,
      difference,
    });

    await AuditLog.create({
      action: AuditAction.CASH_DISCREPANCY,
      actorId: cashierId,
      targetType: 'cash_discrepancy',
      targetId: discrepancy._id,
      details: { difference, amountCollected: collection.amountCollected, amountReceived: input.amountReceived },
      ipAddress: ip,
      userAgent: ua,
    });

    // Notify admin
    await notifyRole(
      Role.ADMIN,
      NotificationCategory.SYSTEM,
      'Cash Discrepancy',
      `Discrepancy of ${formatCurrency(Math.abs(difference))} detected. Collected: ${formatCurrency(collection.amountCollected)}, Received: ${formatCurrency(input.amountReceived)}`,
      `/cash/discrepancies/${discrepancy._id}`,
    );
    // The sales staff who handed over the cash learns about the difference too.
    await createAndSendNotification(
      collection.salesStaffId,
      NotificationCategory.PAYMENT,
      'Cash Turnover Discrepancy',
      `The cashier received ${formatCurrency(input.amountReceived)} of the ${formatCurrency(collection.amountCollected)} you collected. An admin will review the difference.`,
      '/cash',
    );

    return { collection, discrepancy };
  }

  // No discrepancy
  collection.status = CashCollectionStatus.RECEIVED;
  await collection.save();

  await AuditLog.create({
    action: AuditAction.CASH_RECEIVED,
    actorId: cashierId,
    targetType: 'cash_collection',
    targetId: collection._id,
    details: { amountReceived: input.amountReceived },
    ipAddress: ip,
    userAgent: ua,
  });

  await createAndSendNotification(
    collection.salesStaffId,
    NotificationCategory.PAYMENT,
    'Cash Received by Cashier',
    `The cashier received the ${formatCurrency(input.amountReceived)} you collected.`,
    '/cash',
  );

  return { collection };
}

// ── Admin: Resolve Discrepancy ──

export async function resolveDiscrepancy(
  discrepancyId: string,
  input: ResolveDiscrepancyInput,
  resolvedBy: string,
  ip?: string,
  ua?: string,
) {
  const discrepancy = await CashDiscrepancy.findById(discrepancyId);
  if (!discrepancy) throw AppError.notFound('Discrepancy not found');

  if (discrepancy.resolved) {
    throw AppError.badRequest('Discrepancy already resolved');
  }

  discrepancy.resolved = true;
  discrepancy.resolvedBy = resolvedBy as unknown as Types.ObjectId;
  discrepancy.resolvedAt = new Date();
  discrepancy.resolutionNotes = input.resolutionNotes;
  await discrepancy.save();

  // Update cash collection status
  await CashCollection.findByIdAndUpdate(discrepancy.cashCollectionId, {
    status: CashCollectionStatus.RECEIVED,
  });

  await AuditLog.create({
    action: AuditAction.CASH_RECEIVED,
    actorId: resolvedBy,
    targetType: 'cash_discrepancy',
    targetId: discrepancy._id,
    details: { resolutionNotes: input.resolutionNotes },
    ipAddress: ip,
    userAgent: ua,
  });

  return discrepancy;
}

// ── List Collections ──

export async function listCashCollections(query: {
  status?: string;
  salesStaffId?: string;
  page?: string;
  limit?: string;
}, actorId: string, actorRoles: Role[]) {
  const page = parseInt(query.page || '1');
  const limit = Math.min(parseInt(query.limit || '20'), 100);
  const filter: Record<string, unknown> = {};

  // Sales staff see only their own
  if (actorRoles.includes(Role.SALES_STAFF) && !actorRoles.some(r => [Role.ADMIN, Role.CASHIER].includes(r))) {
    filter.salesStaffId = actorId;
  }

  if (query.status) filter.status = query.status;
  if (query.salesStaffId && !filter.salesStaffId) filter.salesStaffId = query.salesStaffId;

  const [collections, total] = await Promise.all([
    CashCollection.find(filter)
      .populate('salesStaffId', 'firstName lastName')
      .populate('customerId', 'firstName lastName')
      .populate('receivedBy', 'firstName lastName')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    CashCollection.countDocuments(filter),
  ]);

  return collections;
}

// ── List Discrepancies ──

export async function listDiscrepancies(query: {
  resolved?: string;
  page?: string;
  limit?: string;
}) {
  const page = parseInt(query.page || '1');
  const limit = Math.min(parseInt(query.limit || '20'), 100);
  const filter: Record<string, unknown> = {};

  if (query.resolved !== undefined) filter.resolved = query.resolved === 'true';

  const [discrepancies, total] = await Promise.all([
    CashDiscrepancy.find(filter)
      .populate('salesStaffId', 'firstName lastName')
      .populate('cashierId', 'firstName lastName')
      .populate('resolvedBy', 'firstName lastName')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    CashDiscrepancy.countDocuments(filter),
  ]);

  return discrepancies;
}

// ── List Pending Cash Appointments (for Sales Staff) ──

export async function listPendingCashAppointments(actorId: string, actorRoles: Role[]) {
  const filter: Record<string, unknown> = {
    ocularFeeStatus: 'cash_pending',
  };

  // Sales staff see only their own assigned appointments
  if (actorRoles.includes(Role.SALES_STAFF) && !actorRoles.some(r => [Role.ADMIN, Role.CASHIER].includes(r))) {
    filter.salesStaffId = actorId;
  }

  const appointments = await Appointment.find(filter)
    .populate('customerId', 'firstName lastName email phone')
    .populate('salesStaffId', 'firstName lastName')
    .sort({ date: 1 })
    .lean();

  return appointments.map((a: any) => {
    const customer = a.customerId && typeof a.customerId === 'object' ? a.customerId : null;
    const salesStaff = a.salesStaffId && typeof a.salesStaffId === 'object' ? a.salesStaffId : null;
    return {
      _id: a._id,
      date: a.date,
      slotCode: a.slotCode,
      status: a.status,
      type: a.type,
      ocularFee: a.ocularFee,
      ocularFeeStatus: a.ocularFeeStatus,
      ocularFeeBreakdown: a.ocularFeeBreakdown,
      formattedAddress: a.formattedAddress || a.customerAddress,
      customerId: customer?._id || a.customerId,
      customerName: customer ? `${customer.firstName} ${customer.lastName}` : undefined,
      customerEmail: customer?.email,
      customerPhone: customer?.phone,
      salesStaffId: salesStaff?._id || a.salesStaffId,
      salesStaffName: salesStaff ? `${salesStaff.firstName} ${salesStaff.lastName}` : undefined,
    };
  });
}
